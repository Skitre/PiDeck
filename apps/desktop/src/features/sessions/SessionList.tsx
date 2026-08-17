import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronDown,
  CircleAlert,
  Copy,
  FileOutput,
  FolderOpen,
  MessageCircleQuestion,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useRef, useState } from "react";
import { tCurrent, useT } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import { deriveExtensionUiWaitingBySession } from "../../lib/stores/extension-ui-state";
import { hostClient } from "../../lib/bridge/host-client";
import { persistDesktopSettings } from "../../lib/desktop-settings";
import {
  prioritizePinnedSessions,
  readPinnedSessionIds,
  writePinnedSessionIds,
} from "../../lib/session-pins";
import {
  captureRequestGeneration,
  activeSessionContext,
  isCurrentRequestGeneration,
  mergeHostIdentity,
  nullableSessionContext,
  workspaceContext,
} from "../../lib/bridge/host-context";
import {
  LatestSessionOpenQueue,
  requestSessionOpenWithRetry,
  SESSION_OPEN_TIMEOUT_MS,
} from "../../lib/bridge/session-open-request";
import { sessionCatalogItems, type SessionCatalogEntry } from "../../lib/stores/session-catalog";
import { useImeComposition } from "../../lib/use-ime-composition";
import { createNewSession } from "../../lib/commands/actions";
import { CollapsibleRegion } from "../../components/CollapsibleRegion";
import { contextMenuTrigger, openContextMenu } from "../../lib/context-menu";
import { shouldKeepNativeContextMenu } from "../../lib/context-menu-policy";
import { requestExport } from "../../lib/export-actions";
import { deleteSessionDrafts } from "../../lib/draft-persistence";
import {
  canArchiveSession,
  canDeleteSession,
  canReloadSession,
  canRenameSession,
  filterSessionItems,
  removedArchivedSessionIds,
  requestSessionRpcWithRetry,
  sessionDisplayName,
  sessionRuntimeLabel,
  sessionStatusDotClass,
  shouldClearLastSessionPath,
  type SessionFilter,
} from "./session-list-policy";

type SessionConfirmAction =
  { kind: "delete"; item: SessionCatalogEntry } | { kind: "cleanup"; count: number };

export function SessionList({
  showCreateAction = true,
  collapsed = false,
  onToggleCollapsed,
}: {
  showCreateAction?: boolean;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}) {
  const t = useT();
  const host = useAppStore((s) => s.host);
  const workspace = useAppStore((s) => s.workspace);
  const session = useAppStore((s) => s.session);
  const connecting = useAppStore((s) => s.connecting);
  const rehydrating = useAppStore((s) => s.rehydrating);
  const desynchronized = useAppStore((s) => s.desynchronized);
  const hostFatal = useAppStore((s) => s.hostFatal);
  const workspaceSwitchTarget = useAppStore((s) => s.workspaceSwitchTarget);
  const sessionCatalog = useAppStore((s) => s.sessionCatalog);
  const extensionUiRequest = useAppStore((s) => s.extensionUiRequest);
  const extensionUiQueue = useAppStore((s) => s.extensionUiQueue);
  const setSession = useAppStore((s) => s.applySessionSnapshot);
  const replaceSessionCatalog = useAppStore((s) => s.replaceSessionCatalog);
  const clearSessionCatalog = useAppStore((s) => s.clearSessionCatalog);
  const setSessionRuntimeState = useAppStore((s) => s.setSessionRuntimeState);
  const updateSessionCatalogInfo = useAppStore((s) => s.updateSessionCatalogInfo);
  const pushNotification = useAppStore((s) => s.pushNotification);
  const [sessionMutationPending, setSessionMutationPending] = useState(false);
  const [sessionOpenPending, setSessionOpenPending] = useState(false);
  const [filter, setFilter] = useState<SessionFilter>("active");
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [menuSessionId, setMenuSessionId] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number } | null>(null);
  const [confirmAction, setConfirmAction] = useState<SessionConfirmAction | null>(null);
  const [extensionUiExpiryTick, setExtensionUiExpiryTick] = useState(0);
  const ime = useImeComposition();
  const [pinnedSessionIds, setPinnedSessionIds] = useState<string[]>(() =>
    readPinnedSessionIds(useAppStore.getState().workspace?.id),
  );
  const sessionOpenBlocked =
    connecting ||
    rehydrating ||
    desynchronized ||
    Boolean(hostFatal) ||
    workspaceSwitchTarget !== null;
  const sessionMutationBlocked = sessionMutationPending || sessionOpenPending || sessionOpenBlocked;
  const refreshRequest = useRef(0);
  const mutationRequest = useRef(0);
  const itemsWorkspaceId = useRef<string | null>(null);
  const mounted = useRef(true);
  const performSessionOpenRef = useRef(performSessionOpen);
  performSessionOpenRef.current = performSessionOpen;
  const sessionOpenQueue = useRef<LatestSessionOpenQueue | null>(null);
  if (!sessionOpenQueue.current) {
    sessionOpenQueue.current = new LatestSessionOpenQueue(
      (path, isSuperseded) => performSessionOpenRef.current(path, isSuperseded),
      (running) => {
        if (mounted.current) setSessionOpenPending(running);
      },
      (error) => {
        const message = error instanceof Error ? error.message : tCurrent("notifOpenSessionFailed");
        useAppStore.getState().pushNotification(message, "error");
      },
    );
  }

  const refresh = useCallback(async () => {
    const currentAtStart = useAppStore.getState();
    const currentHost = currentAtStart.host;
    const currentWorkspace = currentAtStart.workspace;
    if (!currentHost || !currentWorkspace?.servicesReady) {
      refreshRequest.current += 1;
      itemsWorkspaceId.current = null;
      clearSessionCatalog();
      return;
    }
    if (
      currentAtStart.connecting ||
      currentAtStart.rehydrating ||
      currentAtStart.desynchronized ||
      currentAtStart.workspaceSwitchTarget
    ) {
      refreshRequest.current += 1;
      return;
    }
    if (itemsWorkspaceId.current !== currentWorkspace.id) {
      itemsWorkspaceId.current = currentWorkspace.id;
    }
    const request = ++refreshRequest.current;
    const expectedHostId = currentHost.hostInstanceId;
    const expectedWorkspaceId = currentWorkspace.id;
    const expectedWorkspaceRevision = currentWorkspace.revision;
    try {
      const res = await requestSessionRpcWithRetry(() =>
        hostClient.request("session.list", workspaceContext(currentHost, currentWorkspace), null),
      );
      const current = useAppStore.getState();
      if (
        request !== refreshRequest.current ||
        current.host?.hostInstanceId !== expectedHostId ||
        current.workspace?.id !== expectedWorkspaceId ||
        current.workspace?.revision !== expectedWorkspaceRevision
      ) {
        return;
      }
      if (res.ok) {
        itemsWorkspaceId.current = expectedWorkspaceId;
        replaceSessionCatalog(expectedWorkspaceId, res.result.items);
      }
    } catch {
      return;
    }
  }, [clearSessionCatalog, replaceSessionCatalog]);

  useEffect(() => {
    void refresh();
  }, [
    connecting,
    desynchronized,
    host?.hostInstanceId,
    refresh,
    rehydrating,
    workspace?.id,
    workspace?.revision,
    workspace?.servicesReady,
    workspaceSwitchTarget,
  ]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sessionOpenQueue.current?.clearPending();
    };
  }, []);

  useEffect(() => {
    // A recovery epoch (connecting/desynchronized/fatal) invalidates queued
    // intents and supersedes the running open, so its busy retries cannot
    // outlive the epoch and land on the Host after the recovery rehydrate.
    if (sessionOpenBlocked) sessionOpenQueue.current?.clearPending();
  }, [sessionOpenBlocked]);

  useEffect(() => {
    sessionOpenQueue.current?.clearPending();
    setPinnedSessionIds(readPinnedSessionIds(workspace?.id));
    setEditingSessionId(null);
    setNameDraft("");
    setMenuSessionId(null);
    setMenuPosition(null);
  }, [workspace?.id]);

  useEffect(() => {
    if (!menuSessionId) return;
    const closeSessionMenu = () => {
      setMenuSessionId(null);
      setMenuPosition(null);
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest("[data-session-menu]")) {
        closeSessionMenu();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("resize", closeSessionMenu);
    window.addEventListener("scroll", closeSessionMenu, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("resize", closeSessionMenu);
      window.removeEventListener("scroll", closeSessionMenu, true);
    };
  }, [menuSessionId]);

  useEffect(() => {
    const now = Date.now();
    const nextExpiry = [extensionUiRequest, ...extensionUiQueue]
      .flatMap((request) =>
        request?.expiresAt !== undefined && request.expiresAt > now ? [request.expiresAt] : [],
      )
      .sort((left, right) => left - right)[0];
    if (nextExpiry === undefined) return;
    const timer = window.setTimeout(
      () => setExtensionUiExpiryTick((current) => current + 1),
      Math.max(0, nextExpiry - now) + 1,
    );
    return () => window.clearTimeout(timer);
  }, [extensionUiExpiryTick, extensionUiQueue, extensionUiRequest]);

  async function createSession() {
    if (!host || !workspace || sessionMutationBlocked) return;
    const request = ++mutationRequest.current;
    setSessionMutationPending(true);
    try {
      await createNewSession();
    } finally {
      if (request === mutationRequest.current) setSessionMutationPending(false);
    }
  }

  /** Create and adopt a fresh session; false when it failed or the request was superseded. */
  async function requestFreshSession(request: number): Promise<boolean> {
    const { host: startHost, workspace: startWorkspace } = useAppStore.getState();
    if (!startHost || !startWorkspace) return false;
    const generation = captureRequestGeneration(startHost);
    const res = await requestSessionRpcWithRetry(() =>
      hostClient.request("session.create", nullableSessionContext(startHost, startWorkspace), {}),
    );
    // The create's own session.snapshot push may advance the session generation
    // before this response resolves, so only host and workspace are validated here.
    if (
      request !== mutationRequest.current ||
      !isCurrentRequestGeneration(useAppStore.getState().host, generation)
    ) {
      return false;
    }
    if (!res.ok) {
      pushNotification(
        res.error?.code === "SESSION_LIMIT"
          ? t("sessionsLimitReached")
          : (res.error?.message ?? t("notifCreateSessionFailed")),
        "error",
      );
      return false;
    }
    // Reused-pristine creates return the already-active snapshot, and normal
    // creates push a session.snapshot event first — skip the duplicate apply.
    const appliedSession = useAppStore.getState().session;
    const alreadyApplied =
      appliedSession !== null &&
      appliedSession.sessionId === res.result.sessionId &&
      appliedSession.revision === res.result.revision;
    if (!alreadyApplied) setSession(res.result);
    const currentHost = useAppStore.getState().host;
    if (currentHost) {
      const nextHost = mergeHostIdentity(currentHost, res);
      if (nextHost) useAppStore.getState().setHost(nextHost);
    }
    return true;
  }

  function openSession(path: string) {
    const current = useAppStore.getState();
    if (!current.host || !current.workspace || sessionMutationPending || sessionOpenBlocked) {
      return;
    }
    if (!sessionOpenQueue.current?.isRunning() && current.session?.sessionPath === path) {
      return;
    }
    sessionOpenQueue.current?.enqueue(path);
  }

  async function performSessionOpen(path: string, isSuperseded: () => boolean): Promise<void> {
    const currentAtStart = useAppStore.getState();
    const currentHost = currentAtStart.host;
    const currentWorkspace = currentAtStart.workspace;
    if (
      !currentHost ||
      !currentWorkspace ||
      currentAtStart.connecting ||
      currentAtStart.rehydrating ||
      currentAtStart.desynchronized ||
      currentAtStart.session?.sessionPath === path
    ) {
      return;
    }
    const request = ++mutationRequest.current;
    const generation = captureRequestGeneration(currentHost);
    const target = sessionCatalogItems(currentAtStart.sessionCatalog).find(
      (item) => item.sessionPath === path,
    );
    try {
      const authorization = {
        expectedHostInstanceId: currentHost.hostInstanceId,
        expectedWorkspaceId: currentWorkspace.id,
        expectedWorkspaceRevision: currentWorkspace.revision,
      };
      const res = await requestSessionOpenWithRetry(
        () => {
          // The intent is "open this path"; the session generation is only an
          // optimistic-concurrency ticket. Re-read it each attempt so a busy
          // retry that follows another mutation's commit is not rejected as a
          // stale revision.
          const latest = useAppStore.getState().host;
          return hostClient.request(
            "session.open",
            {
              ...authorization,
              expectedSessionId: latest?.sessionId ?? null,
              expectedSessionRevision: latest?.sessionRevision ?? 0,
            },
            { sessionPath: path },
            SESSION_OPEN_TIMEOUT_MS,
          );
        },
        undefined,
        () => {
          const current = useAppStore.getState();
          return (
            !isSuperseded() &&
            current.host?.hostInstanceId === authorization.expectedHostInstanceId &&
            current.workspace?.id === authorization.expectedWorkspaceId &&
            current.workspace?.revision === authorization.expectedWorkspaceRevision
          );
        },
      );
      if (!res) return;
      // The Host session.snapshot advances session generation before this RPC
      // resolves. Requiring the captured session identity would drop the only
      // apply when that event is late, so the click appears to do nothing.
      if (
        request !== mutationRequest.current ||
        !isCurrentRequestGeneration(useAppStore.getState().host, generation)
      ) {
        return;
      }
      if (!res.ok) {
        if (isSuperseded()) return;
        if (target && res.error?.retryable !== true) {
          setSessionRuntimeState(
            target.sessionId,
            "error",
            res.error?.message ?? t("notifOpenSessionFailed"),
          );
        }
        pushNotification(
          res.error?.code === "SESSION_LIMIT"
            ? t("sessionsLimitReached")
            : (res.error?.message ?? t("notifOpenSessionFailed")),
          res.error?.retryable === true ? "warning" : "error",
        );
        return;
      }
      // The Host already pushed this snapshot as a session.snapshot event before
      // the response resolved; applying it again would rebuild the transcript a
      // second time. Apply only when the event has not landed.
      const appliedSession = useAppStore.getState().session;
      const alreadyApplied =
        appliedSession !== null &&
        appliedSession.sessionId === res.result.sessionId &&
        appliedSession.revision === res.result.revision;
      if (!alreadyApplied) setSession(res.result);
      const latestHost = useAppStore.getState().host;
      if (latestHost) {
        const nextHost = mergeHostIdentity(latestHost, res);
        if (nextHost) useAppStore.getState().setHost(nextHost);
      }
    } catch (error) {
      if (isSuperseded()) return;
      const message = error instanceof Error ? error.message : t("notifOpenSessionFailed");
      if (target) setSessionRuntimeState(target.sessionId, "error", message);
      pushNotification(message, "error");
    }
  }

  function beginRename(item: SessionCatalogEntry) {
    if (!canRenameSession(item, session) || sessionMutationBlocked) return;
    setMenuSessionId(null);
    setEditingSessionId(item.sessionId);
    setNameDraft(sessionDisplayName(item, t("sessionsUntitled")));
  }

  function cancelRename() {
    setEditingSessionId(null);
    setNameDraft("");
  }

  async function renameSession() {
    if (!host || !workspace || !editingSessionId || sessionMutationBlocked) return;
    const item = sessionCatalogItems(sessionCatalog).find(
      (entry) => entry.sessionId === editingSessionId,
    );
    if (!item || !canRenameSession(item, session)) return;
    const name = nameDraft.trim();
    if (!name) {
      pushNotification(t("notifSessionNameEmpty"), "error");
      return;
    }
    const request = ++mutationRequest.current;
    const generation = captureRequestGeneration(host);
    setSessionMutationPending(true);
    try {
      const res = await hostClient.request("session.rename", workspaceContext(host, workspace), {
        sessionId: item.sessionId,
        sessionPath: item.sessionPath,
        name,
      });
      if (
        request !== mutationRequest.current ||
        !isCurrentRequestGeneration(useAppStore.getState().host, generation, {
          session: true,
        })
      ) {
        return;
      }
      if (!res.ok) {
        pushNotification(res.error?.message ?? t("notifRenameFailed"), "error");
        return;
      }
      updateSessionCatalogInfo(res.result.sessionId, res.result.name);
      if (res.result.session) setSession(res.result.session);
      cancelRename();
    } catch (error) {
      pushNotification(error instanceof Error ? error.message : t("notifRenameFailed"), "error");
    } finally {
      if (request === mutationRequest.current) setSessionMutationPending(false);
    }
  }

  function togglePinnedSession(item: SessionCatalogEntry) {
    if (!workspace) return;
    setPinnedSessionIds((current) => {
      const next = current.includes(item.sessionId)
        ? current.filter((sessionId) => sessionId !== item.sessionId)
        : [...current, item.sessionId];
      writePinnedSessionIds(workspace.id, next);
      return next;
    });
    setMenuSessionId(null);
  }

  function removePinnedSessions(sessionIds: readonly string[]) {
    if (!workspace || sessionIds.length === 0) return;
    const removed = new Set(sessionIds);
    setPinnedSessionIds((current) => {
      const next = current.filter((sessionId) => !removed.has(sessionId));
      writePinnedSessionIds(workspace.id, next);
      return next;
    });
  }

  async function runSessionFileAction(
    method: "session.archive" | "session.restore",
    item: SessionCatalogEntry,
  ) {
    if (!host || !workspace || sessionMutationBlocked) return;
    const currentSession = useAppStore.getState().session;
    if (method === "session.archive" && !canArchiveSession(item, currentSession)) {
      pushNotification(t("sessionsArchiveWait"), "warning");
      setMenuSessionId(null);
      return;
    }
    const request = ++mutationRequest.current;
    setSessionMutationPending(true);
    setMenuSessionId(null);
    try {
      if (
        method === "session.archive" &&
        currentSession?.sessionId === item.sessionId &&
        !(await requestFreshSession(request))
      ) {
        return;
      }
      const { host: latestHost, workspace: latestWorkspace } = useAppStore.getState();
      if (!latestHost || !latestWorkspace) return;
      const generation = captureRequestGeneration(latestHost);
      const res = await requestSessionRpcWithRetry(() =>
        hostClient.request(method, workspaceContext(latestHost, latestWorkspace), {
          sessionId: item.sessionId,
          sessionPath: item.sessionPath,
        }),
      );
      if (
        request !== mutationRequest.current ||
        !isCurrentRequestGeneration(useAppStore.getState().host, generation, {
          session: true,
        })
      ) {
        return;
      }
      if (!res.ok) {
        pushNotification(res.error?.message ?? t("notifSessionFileOpFailed"), "error");
        return;
      }
      if (method === "session.archive") {
        const lastSessionPath = useAppStore.getState().desktopSettings?.lastSessionPath;
        if (lastSessionPath && shouldClearLastSessionPath(lastSessionPath, item.sessionPath)) {
          await persistDesktopSettings({ lastSessionPath: null });
        }
      }
      await refresh();
      pushNotification(
        method === "session.archive" ? t("notifSessionArchived") : t("notifSessionRestored"),
        "success",
      );
    } catch (error) {
      pushNotification(
        error instanceof Error ? error.message : t("notifSessionFileOpFailed"),
        "error",
      );
    } finally {
      if (request === mutationRequest.current) setSessionMutationPending(false);
    }
  }

  async function deleteSessionPermanently(item: SessionCatalogEntry) {
    if (!host || !workspace || sessionMutationBlocked) return;
    const currentSession = useAppStore.getState().session;
    if (!canDeleteSession(item, currentSession)) {
      pushNotification(t("sessionsDeleteWait"), "warning");
      setConfirmAction(null);
      return;
    }

    const request = ++mutationRequest.current;
    setSessionMutationPending(true);
    setMenuSessionId(null);
    try {
      if (
        !item.archived &&
        currentSession?.sessionId === item.sessionId &&
        !(await requestFreshSession(request))
      ) {
        return;
      }
      const { host: latestHost, workspace: latestWorkspace } = useAppStore.getState();
      if (!latestHost || !latestWorkspace) return;
      const generation = captureRequestGeneration(latestHost);
      const deleted = await requestSessionRpcWithRetry(() =>
        hostClient.request("session.delete", workspaceContext(latestHost, latestWorkspace), {
          sessionId: item.sessionId,
          sessionPath: item.sessionPath,
        }),
      );
      if (
        request !== mutationRequest.current ||
        !isCurrentRequestGeneration(useAppStore.getState().host, generation, {
          session: true,
        })
      ) {
        return;
      }
      if (!deleted.ok) {
        if (deleted.error?.code === "SESSION_NOT_FOUND") {
          deleteSessionDrafts(latestWorkspace.canonicalCwd, [item.sessionId]);
          await refresh();
          removePinnedSessions([item.sessionId]);
          setConfirmAction(null);
          pushNotification(t("notifSessionGone"), "warning");
          return;
        }
        pushNotification(deleted.error?.message ?? t("notifSessionDeleteFailed"), "error");
        return;
      }

      deleteSessionDrafts(latestWorkspace.canonicalCwd, [item.sessionId]);

      const lastSessionPath = useAppStore.getState().desktopSettings?.lastSessionPath;
      if (lastSessionPath && shouldClearLastSessionPath(lastSessionPath, item.sessionPath)) {
        await persistDesktopSettings({ lastSessionPath: null });
      }
      await refresh();
      removePinnedSessions([item.sessionId]);
      setConfirmAction(null);
      pushNotification(t("notifSessionDeleted"), "success");
    } catch (error) {
      pushNotification(
        error instanceof Error ? error.message : t("notifSessionDeleteFailed"),
        "error",
      );
    } finally {
      if (request === mutationRequest.current) setSessionMutationPending(false);
    }
  }

  async function cleanupArchivedSessions() {
    if (!host || !workspace || sessionMutationBlocked) return;
    const sessionsBeforeCleanup = sessionCatalogItems(useAppStore.getState().sessionCatalog);
    const cleanupWorkspace = {
      hostInstanceId: host.hostInstanceId,
      workspaceId: workspace.id,
      workspaceRevision: workspace.revision,
      canonicalCwd: workspace.canonicalCwd,
    };
    const request = ++mutationRequest.current;
    const generation = captureRequestGeneration(host);
    setSessionMutationPending(true);
    try {
      const res = await hostClient.request(
        "session.cleanupArchived",
        workspaceContext(host, workspace),
        null,
      );
      if (
        request !== mutationRequest.current ||
        !isCurrentRequestGeneration(useAppStore.getState().host, generation, {
          session: true,
        })
      ) {
        return;
      }
      if (!res.ok) {
        pushNotification(res.error?.message ?? t("notifCleanupFailed"), "error");
        return;
      }
      await refresh();
      const current = useAppStore.getState();
      if (
        request !== mutationRequest.current ||
        current.host?.hostInstanceId !== cleanupWorkspace.hostInstanceId ||
        current.workspace?.id !== cleanupWorkspace.workspaceId ||
        current.workspace?.revision !== cleanupWorkspace.workspaceRevision
      ) {
        return;
      }
      const removedSessionIds = removedArchivedSessionIds(
        sessionsBeforeCleanup,
        sessionCatalogItems(current.sessionCatalog),
      );
      deleteSessionDrafts(cleanupWorkspace.canonicalCwd, removedSessionIds);
      removePinnedSessions(removedSessionIds);
      setConfirmAction(null);
      pushNotification(
        res.result.failedCount > 0
          ? t("notifCleanupPartial", {
              deleted: res.result.deletedCount,
              failed: res.result.failedCount,
            })
          : t("notifCleanupDone", { deleted: res.result.deletedCount }),
        res.result.failedCount > 0 ? "warning" : "success",
      );
    } catch (error) {
      pushNotification(error instanceof Error ? error.message : t("notifCleanupFailed"), "error");
    } finally {
      if (request === mutationRequest.current) setSessionMutationPending(false);
    }
  }

  async function reloadSessionFromDisk() {
    if (!host || !workspace || !session || sessionMutationBlocked || !session.isIdle) {
      return;
    }
    const request = ++mutationRequest.current;
    const generation = captureRequestGeneration(host);
    setSessionMutationPending(true);
    setMenuSessionId(null);
    try {
      const res = await hostClient.request(
        "session.reload",
        activeSessionContext(host, workspace, session),
        null,
      );
      if (
        request !== mutationRequest.current ||
        !isCurrentRequestGeneration(useAppStore.getState().host, generation, {
          session: true,
        })
      ) {
        return;
      }
      if (!res.ok) {
        pushNotification(res.error?.message ?? t("notifSessionReloadFailed"), "error");
        return;
      }
      setSession(res.result);
      const currentHost = useAppStore.getState().host;
      if (currentHost) {
        const nextHost = mergeHostIdentity(currentHost, res);
        if (nextHost) useAppStore.getState().setHost(nextHost);
      }
      pushNotification(t("notifSessionReloaded"), "success");
    } catch (error) {
      pushNotification(
        error instanceof Error ? error.message : t("notifSessionReloadFailed"),
        "error",
      );
    } finally {
      if (request === mutationRequest.current) setSessionMutationPending(false);
    }
  }

  const allItems = prioritizePinnedSessions(sessionCatalogItems(sessionCatalog), pinnedSessionIds);
  const visibleItems = filterSessionItems(allItems, filter);
  const archivedCount = allItems.filter((item) => item.archived).length;
  const showArchivedToggle = archivedCount > 0 || filter === "archived";
  const extensionUiWaitingBySession = deriveExtensionUiWaitingBySession(
    extensionUiRequest,
    extensionUiQueue,
    Date.now(),
  );

  return (
    <div className="flex flex-col gap-1">
      <div className="flex h-8 items-center justify-between px-2">
        {onToggleCollapsed ? (
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-expanded={!collapsed}
            aria-controls="session-list-region"
            title={collapsed ? t("sessionsExpand") : t("sessionsCollapse")}
            className="group flex min-w-0 items-center gap-1 text-[11px] font-medium text-muted transition-colors hover:text-foreground"
          >
            <span>{t("sessionsRecent")}</span>
            <ChevronDown
              size={12}
              className={`opacity-0 transition-all group-hover:opacity-100 ${
                collapsed ? "rotate-180" : ""
              }`}
            />
          </button>
        ) : (
          <span className="text-[11px] font-medium text-muted">{t("sessionsRecent")}</span>
        )}
        <div className="flex items-center gap-0.5">
          {filter === "archived" && archivedCount > 0 && (
            <button
              type="button"
              title={t("sessionsClearArchivedTitle", { count: archivedCount })}
              aria-label={t("sessionsClearArchivedAria")}
              className="rounded p-1 text-muted hover:bg-surface-overlay hover:text-danger"
              onClick={() => setConfirmAction({ kind: "cleanup", count: archivedCount })}
              disabled={sessionMutationBlocked}
            >
              <Trash2 size={13} />
            </button>
          )}
          {showArchivedToggle && (
            <button
              type="button"
              aria-pressed={filter === "archived"}
              title={
                filter === "archived"
                  ? t("sessionsShowActiveTitle")
                  : t("sessionsShowArchivedTitle", { count: archivedCount })
              }
              aria-label={
                filter === "archived"
                  ? t("sessionsShowActiveTitle")
                  : t("sessionsShowArchivedTitle", { count: archivedCount })
              }
              className={`rounded p-1 transition-colors ${
                filter === "archived"
                  ? "bg-selection text-selection-foreground"
                  : "text-muted hover:bg-surface-overlay hover:text-foreground"
              }`}
              onClick={() => setFilter(filter === "archived" ? "active" : "archived")}
            >
              <Archive size={13} />
            </button>
          )}
          {showCreateAction && (
            <button
              type="button"
              title={t("sessionsNew")}
              className="rounded p-1 text-muted hover:bg-surface-overlay hover:text-foreground"
              onClick={() => void createSession()}
              disabled={!workspace?.servicesReady || sessionMutationBlocked}
            >
              <Plus size={14} />
            </button>
          )}
        </div>
      </div>
      <CollapsibleRegion open={!collapsed} id="session-list-region">
        <>
          {!workspace?.servicesReady && (
            <p className="px-1 text-xs text-muted">{t("sessionsSelectWorkspaceFirst")}</p>
          )}
          <ul className="flex flex-col gap-0.5">
            {visibleItems.map((item) => {
              const active = !item.archived && session?.sessionId === item.sessionId;
              const editing = editingSessionId === item.sessionId;
              const menuOpen = menuSessionId === item.sessionId;
              const pinned = pinnedSessionIds.includes(item.sessionId);
              const canRename = canRenameSession(item, session);
              const canDelete = canDeleteSession(item, session);
              const canReload = canReloadSession(item, session);
              const canArchive = canArchiveSession(item, session);
              const statusDot = item.archived ? null : sessionStatusDotClass(item.runtimeState);
              const decisionWaiting = item.archived
                ? undefined
                : extensionUiWaitingBySession[item.sessionId];
              const decisionWaitingLabel = decisionWaiting
                ? t(
                    decisionWaiting.hasHighRisk
                      ? "sessionsDecisionWaitingHighRisk"
                      : "sessionsDecisionWaiting",
                    { count: decisionWaiting.count },
                  )
                : undefined;
              return (
                <li
                  key={item.sessionId}
                  data-ui="nav-item"
                  data-state={active ? "active" : "inactive"}
                  className={`interface-density-nav-row group flex h-9 items-center rounded-md text-[13px] ${
                    active
                      ? "theme-nav-active bg-nav-active text-nav-active-foreground"
                      : "hover:bg-surface-overlay/70"
                  }`}
                  onContextMenu={(event) => {
                    if (shouldKeepNativeContextMenu(event.nativeEvent)) return;
                    if (
                      event.target instanceof Element &&
                      event.target.closest("input, textarea, [contenteditable='true']")
                    ) {
                      return;
                    }
                    event.preventDefault();
                    event.stopPropagation();
                    setMenuSessionId(null);
                    setMenuPosition(null);
                    openContextMenu({
                      x: event.clientX,
                      y: event.clientY,
                      trigger: contextMenuTrigger(event.target),
                      items: [
                        {
                          id: "session.open",
                          label: t("menuOpenSession"),
                          disabled:
                            item.archived ||
                            !item.sessionPath ||
                            sessionMutationPending ||
                            sessionOpenBlocked,
                          onSelect: () => openSession(item.sessionPath),
                        },
                        {
                          id: "session.rename",
                          label: t("sessionsRename"),
                          icon: Pencil,
                          disabled: !canRename,
                          onSelect: () => beginRename(item),
                        },
                        {
                          id: "session.pin",
                          label: pinned ? t("sessionsUnpin") : t("sessionsPin"),
                          icon: pinned ? PinOff : Pin,
                          onSelect: () => togglePinnedSession(item),
                        },
                        {
                          id: item.archived ? "session.restore" : "session.archive",
                          label: item.archived ? t("sessionsRestore") : t("sessionsArchive"),
                          icon: item.archived ? ArchiveRestore : Archive,
                          separatorBefore: true,
                          disabled: !item.archived && !canArchive,
                          onSelect: () =>
                            runSessionFileAction(
                              item.archived ? "session.restore" : "session.archive",
                              item,
                            ),
                        },
                        {
                          id: "session.exportHtml",
                          label: t("statsExportHtml"),
                          icon: FileOutput,
                          disabled: !active || !session?.isIdle,
                          onSelect: () => requestExport("html"),
                        },
                        {
                          id: "session.exportJsonl",
                          label: t("statsExportJsonl"),
                          icon: FileOutput,
                          disabled: !active || !session?.isIdle,
                          onSelect: () => requestExport("jsonl"),
                        },
                        {
                          id: "session.reveal",
                          label: t("menuRevealSession"),
                          icon: FolderOpen,
                          separatorBefore: true,
                          onSelect: async () => {
                            try {
                              const { invoke } = await import("@tauri-apps/api/core");
                              await invoke("desktop_open_path", {
                                path: item.sessionPath,
                                mode: "reveal",
                              });
                            } catch {
                              pushNotification(t("sessionsRevealFailed"), "warning");
                            }
                          },
                        },
                        {
                          id: "session.copyPath",
                          label: t("menuCopySessionPath"),
                          icon: Copy,
                          onSelect: async () => {
                            try {
                              await navigator.clipboard.writeText(item.sessionPath);
                              pushNotification(t("sessionsPathCopied"), "info");
                            } catch {
                              pushNotification(t("sessionsCopyPathFailed"), "warning");
                            }
                          },
                        },
                        {
                          id: "session.delete",
                          label: t("commonDelete"),
                          icon: Trash2,
                          danger: true,
                          separatorBefore: true,
                          disabled: !canDelete,
                          onSelect: () => setConfirmAction({ kind: "delete", item }),
                        },
                      ],
                    });
                  }}
                >
                  {editing ? (
                    <form
                      className="flex min-w-0 flex-1 items-center gap-1 px-1.5 py-1"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void renameSession();
                      }}
                    >
                      <input
                        autoFocus
                        aria-label={t("sessionsNameAria")}
                        value={nameDraft}
                        maxLength={120}
                        onChange={(event) => setNameDraft(event.target.value)}
                        onCompositionStart={ime.onCompositionStart}
                        onCompositionEnd={ime.onCompositionEnd}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && ime.isImeKey(event)) {
                            event.preventDefault();
                            return;
                          }
                          if (event.key === "Escape") cancelRename();
                        }}
                        className="h-7 min-w-0 flex-1 rounded border border-accent bg-surface px-1.5 text-xs text-foreground outline-none"
                      />
                      <button
                        type="submit"
                        title={t("sessionsSaveName")}
                        disabled={sessionMutationBlocked || !nameDraft.trim()}
                        className="rounded p-1 text-accent hover:bg-surface-overlay disabled:opacity-40"
                      >
                        <Check size={14} />
                      </button>
                      <button
                        type="button"
                        title={t("sessionsCancelRename")}
                        onClick={cancelRename}
                        disabled={sessionMutationBlocked}
                        className="rounded p-1 text-muted hover:bg-surface-overlay hover:text-foreground disabled:opacity-40"
                      >
                        <X size={14} />
                      </button>
                    </form>
                  ) : (
                    <>
                      <button
                        type="button"
                        aria-current={active ? "page" : undefined}
                        onClick={() => openSession(item.sessionPath)}
                        disabled={
                          sessionMutationPending ||
                          sessionOpenBlocked ||
                          !item.sessionPath ||
                          item.archived
                        }
                        className="min-w-0 flex-1 px-2.5 py-2 text-left"
                        title={
                          item.runtimeState === "error" && item.lastError
                            ? `${sessionDisplayName(item, t("sessionsUntitled"))} — ${item.lastError}`
                            : !active &&
                                (item.runtimeState === "running" || item.runtimeState === "queued")
                              ? `${sessionDisplayName(item, t("sessionsUntitled"))} — ${t("sessionsRunningInBackground")}`
                              : sessionDisplayName(item, t("sessionsUntitled"))
                        }
                      >
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span
                            className={`min-w-0 flex-1 truncate ${active ? "font-medium" : ""}`}
                          >
                            {sessionDisplayName(item, t("sessionsUntitled"))}
                          </span>
                          {pinned && (
                            <Pin
                              size={10}
                              aria-label={t("sessionsPinned")}
                              className="shrink-0 text-muted"
                            />
                          )}
                          {decisionWaiting && decisionWaitingLabel ? (
                            <span
                              aria-label={decisionWaitingLabel}
                              title={decisionWaitingLabel}
                              data-session-decision-count={decisionWaiting.count}
                              className={`ml-auto inline-flex h-5 shrink-0 items-center gap-1 rounded border px-1.5 text-[10px] tabular-nums ${
                                decisionWaiting.hasHighRisk
                                  ? "border-warning/40 bg-warning/10 text-warning"
                                  : "border-border bg-surface text-muted"
                              }`}
                            >
                              {decisionWaiting.hasHighRisk ? (
                                <CircleAlert size={11} aria-hidden="true" />
                              ) : (
                                <MessageCircleQuestion size={11} aria-hidden="true" />
                              )}
                              <span aria-hidden="true">{decisionWaiting.count}</span>
                            </span>
                          ) : null}
                        </div>
                      </button>
                      <div
                        className="relative mr-1 flex size-[22px] shrink-0 items-center justify-center"
                        data-session-menu
                      >
                        {statusDot && (
                          <span
                            aria-label={sessionRuntimeLabel(item.runtimeState)}
                            className={`pointer-events-none absolute flex size-1.5 transition-opacity ${
                              menuOpen
                                ? "opacity-0"
                                : "opacity-100 group-hover:opacity-0 group-focus-within:opacity-0"
                            }`}
                          >
                            <span className={`size-1.5 rounded-full ${statusDot}`} />
                          </span>
                        )}
                        <button
                          type="button"
                          title={t("sessionsActionsTitle")}
                          aria-label={t("sessionsActionsTitle")}
                          aria-expanded={menuOpen}
                          onClick={(event) => {
                            if (menuOpen) {
                              setMenuSessionId(null);
                              setMenuPosition(null);
                              return;
                            }
                            const rect = event.currentTarget.getBoundingClientRect();
                            const menuWidth = 144;
                            const menuHeight = 166;
                            const viewportPadding = 8;
                            const below = rect.bottom + 4;
                            setMenuPosition({
                              left: Math.max(
                                viewportPadding,
                                Math.min(
                                  rect.right - menuWidth,
                                  window.innerWidth - menuWidth - viewportPadding,
                                ),
                              ),
                              top:
                                below + menuHeight <= window.innerHeight - viewportPadding
                                  ? below
                                  : Math.max(viewportPadding, rect.top - menuHeight - 4),
                            });
                            setMenuSessionId(item.sessionId);
                          }}
                          disabled={sessionMutationBlocked}
                          className={`rounded p-1 text-muted transition-opacity hover:bg-surface hover:text-foreground ${
                            menuOpen
                              ? "opacity-100 disabled:opacity-30"
                              : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:disabled:opacity-30 group-focus-within:disabled:opacity-30"
                          }`}
                        >
                          <MoreHorizontal size={14} />
                        </button>
                        {menuOpen &&
                          menuPosition &&
                          createPortal(
                            <div
                              className="theme-floating-surface fixed z-50 w-36 rounded-md border border-border bg-surface-raised p-1 shadow-lg"
                              style={menuPosition}
                              data-session-menu
                            >
                              <button
                                type="button"
                                title={
                                  canRename ? t("sessionsRenameTitle") : t("sessionsRenameWait")
                                }
                                disabled={!canRename}
                                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-surface-overlay disabled:cursor-not-allowed disabled:opacity-40"
                                onClick={() => beginRename(item)}
                              >
                                <Pencil size={13} />
                                {t("sessionsRename")}
                              </button>
                              <button
                                type="button"
                                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-surface-overlay"
                                onClick={() => togglePinnedSession(item)}
                              >
                                {pinned ? <PinOff size={13} /> : <Pin size={13} />}
                                {pinned ? t("sessionsUnpin") : t("sessionsPin")}
                              </button>
                              <button
                                type="button"
                                title={
                                  canReload
                                    ? t("sessionsReloadTitle")
                                    : active
                                      ? t("sessionsReloadWait")
                                      : t("sessionsReloadOnlyActive")
                                }
                                disabled={!canReload}
                                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-surface-overlay disabled:cursor-not-allowed disabled:opacity-40"
                                onClick={() => void reloadSessionFromDisk()}
                              >
                                <RefreshCw size={13} />
                                {t("sessionsReload")}
                              </button>
                              <div className="my-1 border-t border-border" />
                              <button
                                type="button"
                                title={
                                  item.archived
                                    ? t("sessionsRestoreTitle")
                                    : canArchive
                                      ? t("sessionsArchiveTitle")
                                      : t("sessionsArchiveWait")
                                }
                                disabled={!item.archived && !canArchive}
                                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-surface-overlay disabled:cursor-not-allowed disabled:opacity-40"
                                onClick={() =>
                                  void runSessionFileAction(
                                    item.archived ? "session.restore" : "session.archive",
                                    item,
                                  )
                                }
                              >
                                {item.archived ? (
                                  <ArchiveRestore size={13} />
                                ) : (
                                  <Archive size={13} />
                                )}
                                {item.archived ? t("sessionsRestore") : t("sessionsArchive")}
                              </button>
                              <button
                                type="button"
                                title={
                                  canDelete ? t("sessionsDeleteTitle") : t("sessionsDeleteWait")
                                }
                                disabled={!canDelete}
                                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-danger hover:bg-surface-overlay disabled:cursor-not-allowed disabled:opacity-40"
                                onClick={() => {
                                  setMenuSessionId(null);
                                  setConfirmAction({ kind: "delete", item });
                                }}
                              >
                                <Trash2 size={13} />
                                {t("commonDelete")}
                              </button>
                            </div>,
                            document.body,
                          )}
                      </div>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
          {workspace?.servicesReady && allItems.length > 0 && visibleItems.length === 0 && (
            <p className="px-2 py-3 text-center text-xs text-muted">{t("sessionsNoMatch")}</p>
          )}
          {confirmAction &&
            createPortal(
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="session-delete-title"
                  data-session-confirm
                  className="theme-floating-surface w-full max-w-sm rounded-lg border border-border bg-surface-raised p-5 shadow-xl"
                >
                  <h2 id="session-delete-title" className="text-base font-semibold">
                    {confirmAction.kind === "delete"
                      ? t("sessionsDeleteConfirmTitle")
                      : t("sessionsCleanupConfirmTitle")}
                  </h2>
                  <p className="mt-2 text-sm text-muted">
                    {confirmAction.kind === "delete"
                      ? t("sessionsDeleteConfirmBody", {
                          name: sessionDisplayName(confirmAction.item, t("sessionsUntitled")),
                        })
                      : t("sessionsCleanupConfirmBody", { count: confirmAction.count })}
                  </p>
                  <div className="mt-4 flex justify-end gap-2">
                    <button
                      autoFocus
                      type="button"
                      className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-overlay"
                      onClick={() => setConfirmAction(null)}
                      disabled={sessionMutationBlocked}
                    >
                      {t("commonCancel")}
                    </button>
                    <button
                      type="button"
                      className="rounded-md bg-danger px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-50"
                      onClick={() => {
                        if (confirmAction.kind === "delete") {
                          void deleteSessionPermanently(confirmAction.item);
                        } else {
                          void cleanupArchivedSessions();
                        }
                      }}
                      disabled={sessionMutationBlocked}
                    >
                      {t("sessionsDeletePermanently")}
                    </button>
                  </div>
                </div>
              </div>,
              document.body,
            )}
        </>
      </CollapsibleRegion>
    </div>
  );
}
