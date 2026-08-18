import {
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  MessageCirclePlus,
  Search,
  Settings,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAppStore, type NavPage } from "../lib/stores/app-store";
import { SessionList } from "../features/sessions/SessionList";
import { useT } from "../lib/i18n/use-t";
import { WorkspacePicker } from "../features/workspaces/WorkspacePicker";
import { sidebarPref, setSidebarPref } from "../lib/sidebar-prefs";
import { PiMark } from "./PiMark";
import { NotificationCenter } from "./NotificationCenter";
import {
  createNewSession,
  isCreateSessionPending,
  subscribeCreateSessionPending,
} from "../lib/commands/actions";
import { requestGlobalSearchOpen, subscribeSidebarToggle } from "../lib/commands/events";

export const SIDEBAR_WIDTH = 268;
export const SIDEBAR_WORKSPACE_PANE_HEIGHT_KEY = "pideck.sidebar.workspacePaneHeight";
export const SIDEBAR_WORKSPACE_PANE_MIN = 72;
const SIDEBAR_SESSION_PANE_MIN = 96;
const SIDEBAR_SPLITTER_HEIGHT = 8;

export function clampWorkspacePaneHeight(height: number, splitHeight: number): number {
  if (!Number.isFinite(height)) return SIDEBAR_WORKSPACE_PANE_MIN;
  const maxHeight =
    Number.isFinite(splitHeight) && splitHeight > 0
      ? Math.max(
          SIDEBAR_WORKSPACE_PANE_MIN,
          splitHeight - SIDEBAR_SESSION_PANE_MIN - SIDEBAR_SPLITTER_HEIGHT,
        )
      : Number.POSITIVE_INFINITY;
  return Math.min(maxHeight, Math.max(SIDEBAR_WORKSPACE_PANE_MIN, Math.round(height)));
}

export function readWorkspacePaneHeight(): number | null {
  try {
    const raw = globalThis.localStorage?.getItem(SIDEBAR_WORKSPACE_PANE_HEIGHT_KEY);
    if (raw == null || raw === "") return null;
    const value = Number(raw);
    return Number.isFinite(value) ? clampWorkspacePaneHeight(value, 0) : null;
  } catch {
    return null;
  }
}

function persistWorkspacePaneHeight(height: number | null): void {
  try {
    if (height == null) {
      globalThis.localStorage?.removeItem(SIDEBAR_WORKSPACE_PANE_HEIGHT_KEY);
      return;
    }
    globalThis.localStorage?.setItem(SIDEBAR_WORKSPACE_PANE_HEIGHT_KEY, String(height));
  } catch {
    /* ignore unavailable localStorage */
  }
}

function NewSessionButton() {
  const t = useT();
  const workspace = useAppStore((s) => s.workspace);
  const [pending, setPending] = useState(isCreateSessionPending);
  useEffect(() => subscribeCreateSessionPending(setPending), []);

  return (
    <button
      type="button"
      onClick={() => void createNewSession()}
      disabled={!workspace?.servicesReady || pending}
      className="theme-sidebar-primary interface-density-primary-row flex h-10 w-full items-center gap-3 rounded-md px-2.5 text-left text-sm font-medium transition-colors hover:bg-surface-overlay disabled:cursor-not-allowed disabled:opacity-40"
    >
      <MessageCirclePlus size={18} className="shrink-0" />
      <span>{pending ? t("sidebarCreating") : t("sidebarNewConversation")}</span>
    </button>
  );
}

export function Sidebar() {
  const page = useAppStore((s) => s.page);
  const setPage = useAppStore((s) => s.setPage);

  return <SidebarLayout page={page} setPage={setPage} />;
}

export function SidebarLayout({
  page,
  setPage,
}: {
  page: NavPage;
  setPage: (page: NavPage) => void;
}) {
  const t = useT();
  const host = useAppStore((s) => s.host);
  const hostFatal = useAppStore((s) => s.hostFatal);
  const connecting = useAppStore((s) => s.connecting);
  const rehydrating = useAppStore((s) => s.rehydrating);
  const desynchronized = useAppStore((s) => s.desynchronized);
  const hostReady = host?.phase === "ready" || host?.phase === "waitingForWorkspace";
  const connectionPending = !hostFatal && (connecting || rehydrating || desynchronized);
  const connectionTitle = hostFatal
    ? t("sidebarHostOffline")
    : connecting
      ? t("sidebarConnecting")
      : desynchronized
        ? t("sidebarResync")
        : rehydrating
          ? t("sidebarLoadingSnapshots")
          : (host?.phase ?? t("sidebarHostOffline"));
  const [sessionsCollapsed, setSessionsCollapsed] = useState(() =>
    sidebarPref("pideck.sidebar.sessionsCollapsed"),
  );
  const [workspacesCollapsed, setWorkspacesCollapsed] = useState(() =>
    sidebarPref("pideck.sidebar.workspacesCollapsed"),
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    sidebarPref("pideck.sidebar.collapsed"),
  );
  const [workspacePaneHeight, setWorkspacePaneHeight] = useState<number | null>(
    readWorkspacePaneHeight,
  );
  const [splitHeight, setSplitHeight] = useState(0);
  const [resizing, setResizing] = useState(false);
  const splitRef = useRef<HTMLDivElement>(null);
  const workspacePaneRef = useRef<HTMLDivElement>(null);
  const workspacePaneHeightRef = useRef(workspacePaneHeight);
  const resizeStart = useRef<{ pointerId: number; y: number; height: number } | null>(null);
  workspacePaneHeightRef.current = workspacePaneHeight;
  const splitEnabled = !workspacesCollapsed;
  const workspaceMaxHeight =
    splitHeight > 0 ? clampWorkspacePaneHeight(Number.POSITIVE_INFINITY, splitHeight) : undefined;

  function toggleSessionsCollapsed() {
    setSessionsCollapsed((current) => {
      setSidebarPref("pideck.sidebar.sessionsCollapsed", !current);
      return !current;
    });
  }

  function toggleWorkspacesCollapsed() {
    setWorkspacesCollapsed((current) => {
      setSidebarPref("pideck.sidebar.workspacesCollapsed", !current);
      return !current;
    });
  }

  function toggleSidebarCollapsed() {
    setSidebarCollapsed((current) => {
      setSidebarPref("pideck.sidebar.collapsed", !current);
      return !current;
    });
  }

  function applyWorkspacePaneHeight(height: number) {
    const next = clampWorkspacePaneHeight(height, splitRef.current?.clientHeight ?? 0);
    workspacePaneHeightRef.current = next;
    setWorkspacePaneHeight(next);
    return next;
  }

  function finishWorkspacePaneResize(target: HTMLDivElement, pointerId: number) {
    if (resizeStart.current?.pointerId !== pointerId) return;
    resizeStart.current = null;
    setResizing(false);
    persistWorkspacePaneHeight(workspacePaneHeightRef.current);
    if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
  }

  useEffect(() => subscribeSidebarToggle(toggleSidebarCollapsed), []);

  useEffect(() => {
    const root = splitRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const sync = () => {
      setSplitHeight(root.clientHeight);
      const current = workspacePaneHeightRef.current;
      if (current == null) return;
      const next = clampWorkspacePaneHeight(current, root.clientHeight);
      if (next !== current) setWorkspacePaneHeight(next);
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  return (
    <aside
      style={{ width: SIDEBAR_WIDTH, marginLeft: sidebarCollapsed ? -SIDEBAR_WIDTH : 0 }}
      data-sidebar
      data-sidebar-collapsed={sidebarCollapsed ? "true" : "false"}
      className="sidebar-edge-shadow relative z-20 flex h-full min-h-0 shrink-0 flex-col border-r border-border bg-sidebar transition-[margin-left] duration-200 ease-out"
    >
      <div className="group/sidebar-edge absolute -right-3 top-0 z-40 h-full w-6">
        <button
          type="button"
          title={sidebarCollapsed ? t("sidebarExpand") : t("sidebarCollapse")}
          aria-label={sidebarCollapsed ? t("sidebarExpand") : t("sidebarCollapse")}
          aria-expanded={!sidebarCollapsed}
          className="absolute left-3 top-1/2 flex h-12 w-4 -translate-y-1/2 items-center justify-center rounded-r-md border border-l-0 border-border bg-surface-raised text-muted opacity-0 shadow-sm transition-opacity group-hover/sidebar-edge:opacity-100 hover:text-foreground focus-visible:opacity-100"
          onClick={toggleSidebarCollapsed}
        >
          {sidebarCollapsed ? <ChevronRight size={12} /> : <ChevronLeft size={12} />}
        </button>
      </div>

      {sidebarCollapsed ? null : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div
            className="flex h-16 shrink-0 items-center gap-3 px-4"
            data-sidebar-header
            data-tauri-drag-region
          >
            <PiMark className="mac-sidebar-brand-mark size-8" />
            <span className="text-[15px] font-semibold" data-sidebar-brand>
              Pi Agent
            </span>
            <div className="ml-auto flex items-center gap-0.5">
              <button
                type="button"
                title={t("commandGlobalSearch")}
                aria-label={t("commandGlobalSearch")}
                disabled={!host}
                className="flex size-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground disabled:opacity-40"
                onClick={requestGlobalSearchOpen}
              >
                <Search size={15} />
              </button>
              <NotificationCenter />
            </div>
          </div>

          <div className="px-2 pb-3 pt-2">
            <NewSessionButton />
          </div>

          <div
            ref={splitRef}
            data-sidebar-split-root
            className={`flex min-h-0 flex-1 flex-col overflow-hidden ${
              resizing ? "select-none" : ""
            }`}
          >
            <div
              ref={workspacePaneRef}
              data-sidebar-workspaces
              style={
                splitEnabled && workspacePaneHeight != null
                  ? { height: workspacePaneHeight }
                  : undefined
              }
              className={
                splitEnabled && workspacePaneHeight != null
                  ? "flex shrink-0 flex-col overflow-hidden border-t border-border px-2 pb-2.5 pt-3"
                  : "flex min-h-0 max-h-[min(40%,15rem)] shrink-0 flex-col overflow-hidden border-t border-border px-2 pb-2.5 pt-3"
              }
            >
              <WorkspacePicker
                collapsed={workspacesCollapsed}
                onToggleCollapsed={toggleWorkspacesCollapsed}
              />
            </div>

            <div
              role="separator"
              tabIndex={splitEnabled ? 0 : -1}
              aria-disabled={splitEnabled ? undefined : true}
              aria-label={t("sidebarSplitResize")}
              aria-orientation="horizontal"
              aria-valuemin={SIDEBAR_WORKSPACE_PANE_MIN}
              aria-valuemax={workspaceMaxHeight}
              aria-valuenow={workspacePaneHeight ?? undefined}
              title={t("sidebarSplitResize")}
              data-sidebar-split
              className={`group relative z-10 h-2 shrink-0 touch-none outline-none ${
                splitEnabled ? "cursor-row-resize" : "pointer-events-none"
              }`}
              onPointerDown={(event) => {
                if (!splitEnabled || event.button !== 0) return;
                event.preventDefault();
                resizeStart.current = {
                  pointerId: event.pointerId,
                  y: event.clientY,
                  height: workspacePaneRef.current?.offsetHeight ?? SIDEBAR_WORKSPACE_PANE_MIN,
                };
                event.currentTarget.setPointerCapture(event.pointerId);
                setResizing(true);
              }}
              onPointerMove={(event) => {
                const start = resizeStart.current;
                if (!start || start.pointerId !== event.pointerId) return;
                applyWorkspacePaneHeight(start.height + event.clientY - start.y);
              }}
              onPointerUp={(event) =>
                finishWorkspacePaneResize(event.currentTarget, event.pointerId)
              }
              onPointerCancel={(event) =>
                finishWorkspacePaneResize(event.currentTarget, event.pointerId)
              }
              onLostPointerCapture={() => {
                resizeStart.current = null;
                setResizing(false);
              }}
              onDoubleClick={() => {
                if (!splitEnabled) return;
                workspacePaneHeightRef.current = null;
                setWorkspacePaneHeight(null);
                persistWorkspacePaneHeight(null);
              }}
              onKeyDown={(event) => {
                if (!splitEnabled || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) {
                  return;
                }
                event.preventDefault();
                const current =
                  workspacePaneHeight ??
                  workspacePaneRef.current?.offsetHeight ??
                  SIDEBAR_WORKSPACE_PANE_MIN;
                persistWorkspacePaneHeight(
                  applyWorkspacePaneHeight(current + (event.key === "ArrowDown" ? 16 : -16)),
                );
              }}
            >
              <span
                aria-hidden="true"
                className="pointer-events-none absolute left-1/2 top-1/2 h-1 w-10 -translate-x-1/2 -translate-y-1/2 rounded-full bg-border/70 transition-colors group-hover:bg-accent group-focus-visible:bg-accent"
              />
            </div>

            {/* Collapsed or not, the header row stays in place below Workspaces. */}
            <div className="scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto px-2 pb-3">
              <SessionList
                showCreateAction={false}
                collapsed={sessionsCollapsed}
                onToggleCollapsed={toggleSessionsCollapsed}
              />
            </div>
          </div>

          <div className="shrink-0 border-t border-border p-2">
            <button
              type="button"
              onClick={() => setPage(page === "chat" ? "settings" : "chat")}
              data-ui="nav-item"
              data-state={page !== "chat" ? "active" : "inactive"}
              className={`interface-density-primary-row flex h-10 w-full items-center gap-3 rounded-md px-2.5 text-left text-sm transition-colors ${
                page !== "chat"
                  ? "theme-nav-active bg-nav-active text-nav-active-foreground"
                  : "text-foreground hover:bg-surface-overlay"
              }`}
            >
              <Settings size={17} />
              <span className="flex-1">{t("settingsTitle")}</span>
              {connectionPending ? (
                <span className="flex shrink-0" title={connectionTitle}>
                  <LoaderCircle size={14} className="animate-spin text-muted" />
                </span>
              ) : (
                <span
                  className={`size-1.5 rounded-full ${
                    hostFatal
                      ? "bg-danger"
                      : hostReady
                        ? "bg-success"
                        : host
                          ? "bg-warning"
                          : "bg-muted"
                  }`}
                  title={connectionTitle}
                />
              )}
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}
