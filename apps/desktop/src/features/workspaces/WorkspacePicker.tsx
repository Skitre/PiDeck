import { ChevronDown, Folder, FolderPlus, LoaderCircle, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SessionSnapshot } from "@pideck/protocol";
import { CollapsibleRegion } from "../../components/CollapsibleRegion";
import { sessionStatusDotClass } from "../sessions/session-list-policy";
import { useAppStore } from "../../lib/stores/app-store";
import {
  runtimeStateFromSnapshot,
  type SessionCatalogState,
  type SessionRuntimeState,
} from "../../lib/stores/session-catalog";
import { hostClient } from "../../lib/bridge/host-client";
import {
  notifyDesktopSettingsSaveFailure,
  persistDesktopSettings,
} from "../../lib/desktop-settings";
import { sidebarPref, setSidebarPref } from "../../lib/sidebar-prefs";
import { useT } from "../../lib/i18n/use-t";
import {
  captureRequestGeneration,
  isCurrentRequestGeneration,
  workspaceContext,
} from "../../lib/bridge/host-context";

export function workspaceDisplayName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? "Workspace";
}

/** Renderer path identity uses only Host-canonical strings. */
function samePath(a: string, b: string): boolean {
  return a === b;
}

export function addKnownWorkspace(list: string[], path: string): string[] {
  return list.some((entry) => samePath(entry, path)) ? list : [...list, path];
}

export function removeKnownWorkspace(list: string[], path: string): string[] {
  return list.filter((entry) => !samePath(entry, path));
}

export function replaceKnownWorkspace(
  list: string[],
  requestedPath: string,
  canonicalPath: string,
): string[] {
  const next = list.map((entry) => (samePath(entry, requestedPath) ? canonicalPath : entry));
  if (!next.some((entry) => samePath(entry, canonicalPath))) next.push(canonicalPath);
  return next.filter((entry, index) => next.indexOf(entry) === index);
}

function isCurrentWorkspacePath(
  path: string,
  workspace: { cwd: string; canonicalCwd: string } | null,
): boolean {
  return Boolean(
    workspace && (samePath(path, workspace.canonicalCwd) || samePath(path, workspace.cwd)),
  );
}

function snapshotBelongsToWorkspace(
  snapshotCwd: string,
  path: string,
  workspace: { cwd: string; canonicalCwd: string } | null,
): boolean {
  if (samePath(snapshotCwd, path)) return true;
  return (
    isCurrentWorkspacePath(path, workspace) &&
    (samePath(snapshotCwd, workspace!.canonicalCwd) || samePath(snapshotCwd, workspace!.cwd))
  );
}

function preferVisibleRuntime(
  current: SessionRuntimeState | null,
  next: SessionRuntimeState,
): SessionRuntimeState | null {
  if (next === "running") return "running";
  if (next === "queued" && current !== "running") return "queued";
  if (next === "error" && current !== "running" && current !== "queued") return "error";
  return current;
}

/** Live Session indicator for a sidebar Workspace row. Parked drafts keep other Workspaces visible. */
export function workspaceLiveRuntimeState(args: {
  path: string;
  workspace: { cwd: string; canonicalCwd: string } | null;
  session: SessionSnapshot | null;
  catalog: SessionCatalogState;
  drafts: Record<string, SessionSnapshot>;
}): SessionRuntimeState | null {
  let visible: SessionRuntimeState | null = null;
  const current = isCurrentWorkspacePath(args.path, args.workspace);
  if (current) {
    if (args.session) {
      visible = preferVisibleRuntime(visible, runtimeStateFromSnapshot(args.session));
    }
    for (const entry of Object.values(args.catalog.entries)) {
      visible = preferVisibleRuntime(visible, entry.runtimeState);
    }
  }
  for (const draft of Object.values(args.drafts)) {
    if (!snapshotBelongsToWorkspace(draft.cwd, args.path, args.workspace)) continue;
    visible = preferVisibleRuntime(visible, runtimeStateFromSnapshot(draft));
  }
  return visible;
}

// Stable fallback: a fresh [] per render makes the zustand selector loop.
const NO_WORKSPACES: string[] = [];

export function WorkspacePicker() {
  const t = useT();
  const host = useAppStore((s) => s.host);
  const workspace = useAppStore((s) => s.workspace);
  const session = useAppStore((s) => s.session);
  const sessionCatalog = useAppStore((s) => s.sessionCatalog);
  const transcriptDrafts = useAppStore((s) => s.transcriptDrafts);
  const knownWorkspaces = useAppStore((s) => s.desktopSettings?.knownWorkspaces ?? NO_WORKSPACES);
  const switchTarget = useAppStore((s) => s.workspaceSwitchTarget);
  const setWorkspace = useAppStore((s) => s.setWorkspace);
  const setSession = useAppStore((s) => s.setSession);
  const pushNotification = useAppStore((s) => s.pushNotification);
  const [pending, setPending] = useState(false);
  const [collapsed, setCollapsed] = useState(() =>
    sidebarPref("pideck.sidebar.workspacesCollapsed"),
  );
  const requestRef = useRef(0);

  function toggleCollapsed() {
    setCollapsed((current) => {
      setSidebarPref("pideck.sidebar.workspacesCollapsed", !current);
      return !current;
    });
  }

  const currentCwd = workspace?.canonicalCwd ?? null;
  const requestedCwd = workspace?.cwd ?? null;

  // Self-heal: whatever workspace is active (restored, picked, or set by the
  // host) always appears in the persistent list.
  useEffect(() => {
    if (!currentCwd) return;
    const next = replaceKnownWorkspace(knownWorkspaces, requestedCwd ?? currentCwd, currentCwd);
    if (
      next.length === knownWorkspaces.length &&
      next.every((entry, index) => entry === knownWorkspaces[index])
    ) {
      return;
    }
    void persistDesktopSettings({
      knownWorkspaces: next,
    }).catch(notifyDesktopSettingsSaveFailure);
  }, [currentCwd, knownWorkspaces, requestedCwd]);

  async function switchTo(cwd: string) {
    if (!host || pending) return;
    if (currentCwd && samePath(currentCwd, cwd)) return;

    const request = ++requestRef.current;
    const generation = captureRequestGeneration(host);
    setPending(true);
    useAppStore.getState().setWorkspaceSwitchTarget(cwd);
    try {
      const res = await hostClient.request(
        "workspace.setCurrent",
        workspaceContext(host, workspace),
        { cwd },
        60_000,
      );

      if (
        request !== requestRef.current ||
        !isCurrentRequestGeneration(useAppStore.getState().host, generation)
      ) {
        return;
      }
      if (!res.ok) {
        pushNotification(res.error?.message ?? t("notifSetWorkspaceFailed"), "error");
        return;
      }

      const result = res.result;
      // workspace.changed / session.snapshot events land before this response
      // resolves; re-applying identical snapshots re-renders the chat and
      // sidebar a second time. Apply only what the event stream has not.
      const appliedWorkspace = useAppStore.getState().workspace;
      if (
        appliedWorkspace === null ||
        appliedWorkspace.id !== result.workspace.id ||
        appliedWorkspace.revision !== result.workspace.revision
      ) {
        setWorkspace(result.workspace);
      }
      const responseSession = result.session;
      if (responseSession) {
        const appliedSession = useAppStore.getState().session;
        if (
          appliedSession === null ||
          appliedSession.sessionId !== responseSession.sessionId ||
          appliedSession.revision !== responseSession.revision
        ) {
          setSession(responseSession);
        }
      }
      useAppStore.getState().setHost({
        ...host,
        workspaceId: res.workspaceId,
        workspaceRevision: res.workspaceRevision,
        sessionId: res.sessionId,
        sessionRevision: res.sessionRevision,
        packageRevision: res.packageRevision,
      });
    } finally {
      if (request === requestRef.current) {
        setPending(false);
        useAppStore.getState().setWorkspaceSwitchTarget(null);
      }
    }
  }

  async function pickAndAdd() {
    if (!host || pending) return;
    let cwd: string | null = null;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") cwd = selected;
    } catch {
      cwd = window.prompt(t("workspacesEnterPath")) || null;
    }
    if (!cwd) return;
    await switchTo(cwd);
  }

  function removeFromList(path: string) {
    void persistDesktopSettings({
      knownWorkspaces: removeKnownWorkspace(knownWorkspaces, path),
    }).catch(notifyDesktopSettingsSaveFailure);
  }

  // Render the active workspace even before self-heal persists it.
  const listed = currentCwd ? addKnownWorkspace(knownWorkspaces, currentCwd) : knownWorkspaces;

  return (
    <section>
      <div className="mb-1 flex h-7 items-center justify-between px-2">
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          aria-controls="workspace-list-region"
          title={collapsed ? t("workspacesExpand") : t("workspacesCollapse")}
          className="group flex min-w-0 items-center gap-1 text-[11px] font-medium text-muted transition-colors hover:text-foreground"
        >
          <span>{t("workspacesTitle")}</span>
          <ChevronDown
            size={12}
            className={`opacity-0 transition-all group-hover:opacity-100 ${
              collapsed ? "-rotate-90" : ""
            }`}
          />
        </button>
        <button
          type="button"
          onClick={() => void pickAndAdd()}
          disabled={!host || pending}
          className="flex size-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground disabled:opacity-40"
          title={t("workspacesAdd")}
          aria-label={t("workspacesAdd")}
        >
          <Plus size={15} />
        </button>
      </div>
      <CollapsibleRegion open={!collapsed} id="workspace-list-region">
        {listed.length === 0 ? (
          <button
            type="button"
            onClick={() => void pickAndAdd()}
            disabled={!host || pending}
            className="interface-density-nav-row flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-sm text-muted transition-colors hover:bg-surface-overlay hover:text-foreground disabled:opacity-40"
          >
            <FolderPlus size={16} />
            <span>{pending ? t("workspacesOpening") : t("workspacesAdd")}</span>
          </button>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {listed.map((path) => {
              const active = Boolean(currentCwd && samePath(currentCwd, path));
              const liveRuntime = workspaceLiveRuntimeState({
                path,
                workspace,
                session,
                catalog: sessionCatalog,
                drafts: transcriptDrafts,
              });
              const liveDot = liveRuntime ? sessionStatusDotClass(liveRuntime) : null;
              return (
                <li
                  key={path}
                  className={`interface-density-nav-row group flex h-9 items-center rounded-md text-[13px] ${
                    active ? "bg-surface-overlay font-medium" : "hover:bg-surface-overlay/70"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => void switchTo(path)}
                    disabled={!host || pending || active}
                    className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left disabled:cursor-default"
                    title={`${workspaceDisplayName(path)}\n${path}`}
                    aria-current={active ? "true" : undefined}
                  >
                    {pending && switchTarget !== null && samePath(switchTarget, path) ? (
                      <LoaderCircle size={16} className="shrink-0 animate-spin text-muted" />
                    ) : (
                      <Folder
                        size={16}
                        className={`shrink-0 ${active ? "text-accent" : "text-muted"}`}
                      />
                    )}
                    <span className="min-w-0 flex-1 truncate">{workspaceDisplayName(path)}</span>
                    {liveDot ? (
                      <span
                        className={`size-1.5 shrink-0 rounded-full ${liveDot} ${
                          active ? "" : "group-hover:opacity-0"
                        }`}
                        title={t("sessionsRunningInBackground")}
                        aria-label={t("sessionsRunningInBackground")}
                      />
                    ) : (
                      active && (
                        <span
                          className={`size-1.5 shrink-0 rounded-full ${
                            workspace?.servicesReady ? "bg-success" : "bg-warning"
                          }`}
                        />
                      )
                    )}
                  </button>
                  {!active && (
                    <button
                      type="button"
                      onClick={() => removeFromList(path)}
                      disabled={pending}
                      className="mr-1 hidden rounded p-1 text-muted hover:bg-surface hover:text-foreground group-hover:block"
                      title={t("workspacesRemoveTitle")}
                      aria-label={t("workspacesRemoveAria", { name: workspaceDisplayName(path) })}
                    >
                      <X size={13} />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CollapsibleRegion>
    </section>
  );
}
