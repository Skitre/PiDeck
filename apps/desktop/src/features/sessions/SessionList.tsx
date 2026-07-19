import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronDown,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import { persistDesktopSettings } from "../../lib/desktop-settings";
import {
  captureRequestGeneration,
  activeSessionContext,
  isCurrentRequestGeneration,
  mergeHostIdentity,
  nullableSessionContext,
  workspaceContext,
} from "../../lib/bridge/host-context";
import type { SessionSnapshot, SessionSummary } from "@pideck/protocol";
import {
  sessionCatalogItems,
  type SessionCatalogEntry,
  type SessionRuntimeState,
} from "../../lib/stores/session-catalog";

export type SessionFilter = "active" | "archived";

type SessionConfirmAction =
  | { kind: "delete"; item: SessionCatalogEntry }
  | { kind: "cleanup"; count: number };

export function includeActiveSession(
  items: SessionSummary[],
  active: SessionSnapshot | null,
): SessionSummary[] {
  if (!active?.sessionPath) return items;
  const listed = items.find((item) => item.sessionId === active.sessionId);
  const current: SessionSummary = {
    sessionId: active.sessionId,
    sessionPath: active.sessionPath,
    name: active.name,
    cwd: active.cwd,
    updatedAt: listed?.updatedAt ?? Date.now(),
    messageCount: active.messages.length,
  };
  return [current, ...items.filter((item) => item.sessionId !== active.sessionId)];
}

export function sessionDisplayName(item: Pick<SessionSummary, "name">): string {
  return item.name?.trim() || "新会话";
}

export function sessionRuntimeLabel(state: SessionRuntimeState): string {
  return state;
}

/** Dot color class for states worth surfacing; quiet states render nothing. */
export function sessionStatusDotClass(state: SessionRuntimeState): string | null {
  switch (state) {
    case "running":
    case "starting":
      return "bg-success animate-pulse";
    case "queued":
      return "bg-warning";
    case "error":
      return "bg-danger";
    default:
      return null;
  }
}

export function filterSessionItems(
  items: SessionCatalogEntry[],
  query: string,
  filter: SessionFilter,
): SessionCatalogEntry[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return items.filter((item) => {
    if (filter === "archived" ? !item.archived : item.archived) return false;
    if (!normalizedQuery) return true;
    return [sessionDisplayName(item), item.cwd, item.sessionId]
      .join("\n")
      .toLocaleLowerCase()
      .includes(normalizedQuery);
  });
}

export function canReloadSession(
  item: SessionCatalogEntry,
  session: SessionSnapshot | null,
): boolean {
  return Boolean(
    !item.archived &&
      session?.sessionId === item.sessionId &&
      session.sessionPath &&
      session.isIdle,
  );
}

export function shouldRetrySessionList(error: {
  code?: string;
  retryable?: boolean;
}): boolean {
  return error.code === "SERVICE_GRAPH_BUSY" && error.retryable === true;
}

export async function requestSessionListWithRetry<
  T extends
    | { ok: true }
    | { ok: false; error: { code?: string; retryable?: boolean } },
>(
  request: () => Promise<T>,
  wait: (delayMs: number) => Promise<unknown> = (delayMs) =>
    new Promise((resolve) => setTimeout(resolve, delayMs)),
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await request();
    if (response.ok || !shouldRetrySessionList(response.error) || attempt === 4) {
      return response;
    }
    await wait(80 * (attempt + 1));
  }
}

export function SessionList({
  showCreateAction = true,
  collapsed = false,
  onToggleCollapsed,
}: {
  showCreateAction?: boolean;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}) {
  const host = useAppStore((s) => s.host);
  const workspace = useAppStore((s) => s.workspace);
  const session = useAppStore((s) => s.session);
  const connecting = useAppStore((s) => s.connecting);
  const rehydrating = useAppStore((s) => s.rehydrating);
  const desynchronized = useAppStore((s) => s.desynchronized);
  const sessionCatalog = useAppStore((s) => s.sessionCatalog);
  const setSession = useAppStore((s) => s.applySessionSnapshot);
  const replaceSessionCatalog = useAppStore((s) => s.replaceSessionCatalog);
  const clearSessionCatalog = useAppStore((s) => s.clearSessionCatalog);
  const setSessionRuntimeState = useAppStore((s) => s.setSessionRuntimeState);
  const pushNotification = useAppStore((s) => s.pushNotification);
  const [sessionMutationPending, setSessionMutationPending] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SessionFilter>("active");
  const [controlsOpen, setControlsOpen] = useState(false);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [menuSessionId, setMenuSessionId] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<SessionConfirmAction | null>(null);
  const refreshRequest = useRef(0);
  const mutationRequest = useRef(0);
  const itemsWorkspaceId = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (!host || !workspace?.servicesReady) {
      refreshRequest.current += 1;
      itemsWorkspaceId.current = null;
      clearSessionCatalog();
      return;
    }
    if (connecting || rehydrating || desynchronized) {
      refreshRequest.current += 1;
      return;
    }
    if (itemsWorkspaceId.current !== workspace.id) {
      itemsWorkspaceId.current = workspace.id;
    }
    const request = ++refreshRequest.current;
    const expectedHostId = host.hostInstanceId;
    const expectedWorkspaceId = workspace.id;
    const expectedWorkspaceRevision = workspace.revision;
    try {
      const res = await requestSessionListWithRetry(() =>
        hostClient.request(
          "session.list",
          workspaceContext(host, workspace),
          null,
        ),
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
  }, [
    clearSessionCatalog,
    connecting,
    desynchronized,
    host,
    rehydrating,
    replaceSessionCatalog,
    workspace,
  ]);

  useEffect(() => {
    void refresh();
  }, [refresh, session?.sessionId, session?.name]);

  useEffect(() => {
    if (editingSessionId && editingSessionId !== session?.sessionId) {
      setEditingSessionId(null);
      setNameDraft("");
    }
  }, [editingSessionId, session?.sessionId]);

  useEffect(() => {
    if (!menuSessionId) return;
    const closeMenu = (event: PointerEvent) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest("[data-session-menu]")
      ) {
        setMenuSessionId(null);
      }
    };
    document.addEventListener("pointerdown", closeMenu);
    return () => document.removeEventListener("pointerdown", closeMenu);
  }, [menuSessionId]);

  async function createSession() {
    if (!host || !workspace || sessionMutationPending) return;
    const request = ++mutationRequest.current;
    const generation = captureRequestGeneration(host);
    setSessionMutationPending(true);
    try {
      const res = await hostClient.request(
        "session.create",
        nullableSessionContext(host, workspace),
        {},
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
        pushNotification(res.error?.message ?? "Create session failed", "error");
        return;
      }
      setSession(res.result);
      const currentHost = useAppStore.getState().host;
      if (currentHost) {
        const nextHost = mergeHostIdentity(currentHost, res);
        if (nextHost) useAppStore.getState().setHost(nextHost);
      }
    } finally {
      if (request === mutationRequest.current) setSessionMutationPending(false);
    }
  }

  async function openSession(path: string) {
    if (!host || !workspace || sessionMutationPending) return;
    if (session?.sessionPath === path) return;
    const request = ++mutationRequest.current;
    const generation = captureRequestGeneration(host);
    const target = sessionCatalogItems(sessionCatalog).find(
      (item) => item.sessionPath === path,
    );
    const previousRuntimeState = target?.runtimeState;
    if (target && target.runtimeState !== "running" && target.runtimeState !== "queued") {
      setSessionRuntimeState(target.sessionId, "starting");
    }
    setSessionMutationPending(true);
    try {
      const res = await hostClient.request(
        "session.open",
        nullableSessionContext(host, workspace),
        { sessionPath: path },
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
        if (target) {
          if (res.error?.code === "AGENT_BUSY" && previousRuntimeState) {
            setSessionRuntimeState(target.sessionId, previousRuntimeState);
          } else {
            setSessionRuntimeState(
              target.sessionId,
              "error",
              res.error?.message ?? "Open session failed",
            );
          }
        }
        pushNotification(res.error?.message ?? "Open session failed", "error");
        return;
      }
      setSession(res.result);
      const currentHost = useAppStore.getState().host;
      if (currentHost) {
        const nextHost = mergeHostIdentity(currentHost, res);
        if (nextHost) useAppStore.getState().setHost(nextHost);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Open session failed";
      if (target) setSessionRuntimeState(target.sessionId, "error", message);
      pushNotification(message, "error");
    } finally {
      if (request === mutationRequest.current) setSessionMutationPending(false);
    }
  }

  function beginRename(item: SessionCatalogEntry) {
    if (item.sessionId !== session?.sessionId || sessionMutationPending) return;
    setEditingSessionId(item.sessionId);
    setNameDraft(sessionDisplayName(item));
  }

  function cancelRename() {
    setEditingSessionId(null);
    setNameDraft("");
  }

  async function renameSession() {
    if (!host || !workspace || !session || sessionMutationPending) return;
    if (editingSessionId !== session.sessionId) return;
    const name = nameDraft.trim();
    if (!name) {
      pushNotification("Session name cannot be empty", "error");
      return;
    }
    const request = ++mutationRequest.current;
    const generation = captureRequestGeneration(host);
    setSessionMutationPending(true);
    try {
      const res = await hostClient.request(
        "session.setName",
        activeSessionContext(host, workspace, session),
        { name },
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
        pushNotification(res.error?.message ?? "Rename session failed", "error");
        return;
      }
      setSession(res.result);
      cancelRename();
    } catch (error) {
      pushNotification(
        error instanceof Error ? error.message : "Rename session failed",
        "error",
      );
    } finally {
      if (request === mutationRequest.current) setSessionMutationPending(false);
    }
  }

  async function runSessionFileAction(
    method: "session.archive" | "session.restore" | "session.delete",
    item: SessionCatalogEntry,
  ) {
    if (!host || !workspace || sessionMutationPending) return;
    const request = ++mutationRequest.current;
    const generation = captureRequestGeneration(host);
    setSessionMutationPending(true);
    setMenuSessionId(null);
    try {
      const res = await hostClient.request(method, workspaceContext(host, workspace), {
        sessionId: item.sessionId,
        sessionPath: item.sessionPath,
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
        pushNotification(res.error?.message ?? "Session file operation failed", "error");
        return;
      }
      if (method === "session.archive") {
        const lastSessionPath = useAppStore.getState().desktopSettings?.lastSessionPath;
        if (
          lastSessionPath &&
          lastSessionPath.toLocaleLowerCase() === item.sessionPath.toLocaleLowerCase()
        ) {
          await persistDesktopSettings({ lastSessionPath: null });
        }
      }
      await refresh();
      pushNotification(
        method === "session.archive"
          ? "Session archived"
          : method === "session.restore"
            ? "Session restored"
            : "Session permanently deleted",
        "success",
      );
      if (method === "session.delete") setConfirmAction(null);
    } catch (error) {
      pushNotification(
        error instanceof Error ? error.message : "Session file operation failed",
        "error",
      );
    } finally {
      if (request === mutationRequest.current) setSessionMutationPending(false);
    }
  }

  async function cleanupArchivedSessions() {
    if (!host || !workspace || sessionMutationPending) return;
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
        pushNotification(res.error?.message ?? "Archive cleanup failed", "error");
        return;
      }
      await refresh();
      setConfirmAction(null);
      pushNotification(
        res.result.failedCount > 0
          ? `Deleted ${res.result.deletedCount} Sessions; ${res.result.failedCount} failed`
          : `Deleted ${res.result.deletedCount} archived Sessions`,
        res.result.failedCount > 0 ? "warning" : "success",
      );
    } catch (error) {
      pushNotification(
        error instanceof Error ? error.message : "Archive cleanup failed",
        "error",
      );
    } finally {
      if (request === mutationRequest.current) setSessionMutationPending(false);
    }
  }

  async function reloadSessionFromDisk() {
    if (!host || !workspace || !session || sessionMutationPending || !session.isIdle) {
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
        pushNotification(res.error?.message ?? "Session reload failed", "error");
        return;
      }
      setSession(res.result);
      const currentHost = useAppStore.getState().host;
      if (currentHost) {
        const nextHost = mergeHostIdentity(currentHost, res);
        if (nextHost) useAppStore.getState().setHost(nextHost);
      }
      pushNotification("Session reloaded from disk", "success");
    } catch (error) {
      pushNotification(
        error instanceof Error ? error.message : "Session reload failed",
        "error",
      );
    } finally {
      if (request === mutationRequest.current) setSessionMutationPending(false);
    }
  }

  const allItems = sessionCatalogItems(sessionCatalog);
  const visibleItems = filterSessionItems(allItems, query, filter);
  const archivedCount = allItems.filter((item) => item.archived).length;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex h-8 items-center justify-between px-2">
        {onToggleCollapsed ? (
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-expanded={!collapsed}
            title={collapsed ? "Expand conversations" : "Collapse conversations"}
            className="group flex min-w-0 items-center gap-1 text-[11px] font-medium text-muted transition-colors hover:text-foreground"
          >
            <span>Recent conversations</span>
            <ChevronDown
              size={12}
              className={`opacity-0 transition-all group-hover:opacity-100 ${
                collapsed ? "rotate-180" : ""
              }`}
            />
          </button>
        ) : (
          <span className="text-[11px] font-medium text-muted">Recent conversations</span>
        )}
        <div className="flex items-center gap-0.5">
          {archivedCount > 0 && (
            <button
              type="button"
              title={`Clear ${archivedCount} archived Sessions`}
              aria-label="Clear archived sessions"
              className="rounded p-1 text-muted hover:bg-surface-overlay hover:text-danger"
              onClick={() => setConfirmAction({ kind: "cleanup", count: archivedCount })}
              disabled={sessionMutationPending}
            >
              <Trash2 size={13} />
            </button>
          )}
          <button
            type="button"
            title="Search and filter conversations"
            aria-label="Search and filter conversations"
            className="rounded p-1 text-muted hover:bg-surface-overlay hover:text-foreground"
            onClick={() => setControlsOpen((open) => !open)}
          >
            <Search size={14} />
          </button>
          {showCreateAction && <button
            type="button"
            title="New session"
            className="rounded p-1 text-muted hover:bg-surface-overlay hover:text-foreground"
            onClick={() => void createSession()}
            disabled={!workspace?.servicesReady || sessionMutationPending}
          >
            <Plus size={14} />
          </button>}
        </div>
      </div>
      {collapsed ? null : (
        <>
      {!workspace?.servicesReady && (
        <p className="px-1 text-xs text-muted">Select and trust a workspace first.</p>
      )}
      {workspace?.servicesReady && (controlsOpen || Boolean(query) || filter !== "active") && (
        <div className="flex gap-1 px-1">
          <label className="relative min-w-0 flex-1">
            <Search
              size={13}
              className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted"
            />
            <input
              type="search"
              aria-label="Search sessions"
              placeholder="Search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-7 w-full rounded-md border border-border bg-surface pl-7 pr-2 text-xs outline-none focus:border-accent"
            />
          </label>
          <div
            role="group"
            aria-label="Filter sessions"
            className="flex h-7 shrink-0 overflow-hidden rounded-md border border-border text-xs"
          >
            <button
              type="button"
              onClick={() => setFilter("active")}
              aria-pressed={filter === "active"}
              className={`px-2 transition-colors ${
                filter === "active"
                  ? "bg-surface-overlay text-foreground"
                  : "bg-surface text-muted hover:text-foreground"
              }`}
            >
              Active
            </button>
            <button
              type="button"
              onClick={() => setFilter("archived")}
              aria-pressed={filter === "archived"}
              className={`border-l border-border px-2 transition-colors ${
                filter === "archived"
                  ? "bg-surface-overlay text-foreground"
                  : "bg-surface text-muted hover:text-foreground"
              }`}
            >
              {archivedCount > 0 ? `Archived (${archivedCount})` : "Archived"}
            </button>
          </div>
        </div>
      )}
      <ul className="flex flex-col gap-0.5">
        {visibleItems.map((item) => {
          const active = !item.archived && session?.sessionId === item.sessionId;
          const editing = active && editingSessionId === item.sessionId;
          const canReload = canReloadSession(item, session);
          const canArchive =
            !item.archived &&
            (item.runtimeState === "inactive" || item.runtimeState === "error");
          return (
            <li
              key={item.sessionId}
              className={`group flex h-9 items-center rounded-md text-sm ${
                active ? "bg-surface-overlay text-foreground" : "hover:bg-surface-overlay/70"
              }`}
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
                    aria-label="Session name"
                    value={nameDraft}
                    maxLength={120}
                    onChange={(event) => setNameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") cancelRename();
                    }}
                    className="h-7 min-w-0 flex-1 rounded border border-accent bg-surface px-1.5 text-xs text-foreground outline-none"
                  />
                  <button
                    type="submit"
                    title="Save name"
                    disabled={sessionMutationPending || !nameDraft.trim()}
                    className="rounded p-1 text-accent hover:bg-surface-overlay disabled:opacity-40"
                  >
                    <Check size={14} />
                  </button>
                  <button
                    type="button"
                    title="Cancel rename"
                    onClick={cancelRename}
                    disabled={sessionMutationPending}
                    className="rounded p-1 text-muted hover:bg-surface-overlay hover:text-foreground disabled:opacity-40"
                  >
                    <X size={14} />
                  </button>
                </form>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => void openSession(item.sessionPath)}
                    disabled={sessionMutationPending || !item.sessionPath || item.archived}
                    className="min-w-0 flex-1 px-2.5 py-2 text-left disabled:opacity-50"
                    title={
                      item.runtimeState === "error" && item.lastError
                        ? `${sessionDisplayName(item)} — ${item.lastError}`
                        : sessionDisplayName(item)
                    }
                  >
                    <div className="flex min-w-0 items-center gap-1.5">
                      {(() => {
                        const dot = item.archived
                          ? null
                          : sessionStatusDotClass(item.runtimeState);
                        return dot ? (
                          <span
                            aria-label={sessionRuntimeLabel(item.runtimeState)}
                            className={`size-1.5 shrink-0 rounded-full ${dot}`}
                          />
                        ) : null;
                      })()}
                      <span className={`truncate ${active ? "font-medium" : ""}`}>
                        {sessionDisplayName(item)}
                      </span>
                    </div>
                  </button>
                  {active && (
                    <button
                      type="button"
                      title={session?.isIdle ? "Rename session" : "Finish the current run before renaming"}
                      aria-label="Rename session"
                      onClick={() => beginRename(item)}
                      disabled={sessionMutationPending || !session?.isIdle}
                      className="mr-1 rounded p-1 text-muted hover:bg-surface hover:text-foreground disabled:opacity-30"
                    >
                      <Pencil size={13} />
                    </button>
                  )}
                  <div className="relative mr-1" data-session-menu>
                      <button
                        type="button"
                        title="Session actions"
                        aria-label="Session actions"
                        aria-expanded={menuSessionId === item.sessionId}
                        onClick={() =>
                          setMenuSessionId((current) =>
                            current === item.sessionId ? null : item.sessionId,
                          )
                        }
                        disabled={sessionMutationPending}
                        className="rounded p-1 text-muted hover:bg-surface hover:text-foreground disabled:opacity-30"
                      >
                        <MoreHorizontal size={14} />
                      </button>
                      {menuSessionId === item.sessionId && (
                        <div className="absolute right-0 top-7 z-20 min-w-28 rounded-md border border-border bg-surface-raised p-1 shadow-lg">
                          {item.archived ? (
                            <>
                              <button
                                type="button"
                                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-surface-overlay"
                                onClick={() =>
                                  void runSessionFileAction("session.restore", item)
                                }
                              >
                                <ArchiveRestore size={13} />
                                Restore
                              </button>
                              <button
                                type="button"
                                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-danger hover:bg-surface-overlay"
                                onClick={() => {
                                  setMenuSessionId(null);
                                  setConfirmAction({ kind: "delete", item });
                                }}
                              >
                                <Trash2 size={13} />
                                Delete
                              </button>
                            </>
                          ) : active ? (
                            <button
                              type="button"
                              title={
                                canReload
                                  ? "Reload Session from disk"
                                  : "Wait for the Session run to finish before reloading"
                              }
                              disabled={!canReload}
                              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-surface-overlay disabled:cursor-not-allowed disabled:opacity-40"
                              onClick={() => void reloadSessionFromDisk()}
                            >
                              <RefreshCw size={13} />
                              Reload
                            </button>
                          ) : (
                            <button
                              type="button"
                              title={
                                canArchive
                                  ? "Archive Session"
                                  : "Wait for the Session run to finish before archiving"
                              }
                              disabled={!canArchive}
                              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-surface-overlay disabled:cursor-not-allowed disabled:opacity-40"
                              onClick={() =>
                                void runSessionFileAction("session.archive", item)
                              }
                            >
                              <Archive size={13} />
                              Archive
                            </button>
                          )}
                        </div>
                      )}
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ul>
      {workspace?.servicesReady && allItems.length > 0 && visibleItems.length === 0 && (
        <p className="px-2 py-3 text-center text-xs text-muted">No matching sessions</p>
      )}
      {confirmAction && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="session-delete-title"
            className="w-full max-w-sm rounded-lg border border-border bg-surface-raised p-5 shadow-xl"
          >
            <h2 id="session-delete-title" className="text-base font-semibold">
              {confirmAction.kind === "delete"
                ? "Permanently delete Session?"
                : "Clear archived Sessions?"}
            </h2>
            <p className="mt-2 text-sm text-muted">
              {confirmAction.kind === "delete"
                ? `“${sessionDisplayName(confirmAction.item)}” will be removed from disk. This cannot be undone.`
                : `${confirmAction.count} archived Sessions will be removed from disk. This cannot be undone.`}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                autoFocus
                type="button"
                className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-overlay"
                onClick={() => setConfirmAction(null)}
                disabled={sessionMutationPending}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded-md bg-danger px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-50"
                onClick={() => {
                  if (confirmAction.kind === "delete") {
                    void runSessionFileAction("session.delete", confirmAction.item);
                  } else {
                    void cleanupArchivedSessions();
                  }
                }}
                disabled={sessionMutationPending}
              >
                Delete permanently
              </button>
            </div>
          </div>
        </div>
      )}
        </>
      )}
    </div>
  );
}
