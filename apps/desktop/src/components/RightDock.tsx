import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  Plus,
  RotateCcw,
  SquareTerminal,
  X,
} from "lucide-react";
import { useAppStore } from "../lib/stores/app-store";
import { setSidebarPref } from "../lib/sidebar-prefs";
import { PiMark } from "./PiMark";
import {
  ExtensionTerminal,
  cancelExtensionTerminal,
} from "../features/dock/ExtensionTerminal";
import {
  ShellTerminal,
  shellTerminalLabel,
  type ShellTerminalStatus,
} from "../features/dock/ShellTerminal";

type DockTabId = `shell:${number}` | `extension:${string}`;

type ShellDockTab = {
  id: number;
  generation: number;
  cwd: string;
  status: ShellTerminalStatus | null;
};

const DOCK_WIDTH_KEY = "pideck.dock.width.v1";
const DEFAULT_DOCK_WIDTH = 460;
const MIN_DOCK_WIDTH = 460;
const MAX_DOCK_WIDTH = 720;
const MIN_TAB_WIDTH = 96;
const TAB_GAP = 4;
const TAB_CONTROL_WIDTH = 28;

function shellTabId(id: number): DockTabId {
  return `shell:${id}`;
}

function extensionTabId(requestId: string): DockTabId {
  return `extension:${requestId}`;
}

function shellTitle(tab: ShellDockTab): string {
  const title = tab.status?.title ?? "Shell";
  const cwd = shellTerminalLabel(tab.status?.cwd ?? tab.cwd);
  return `${title} - ${cwd}`;
}

export function visibleDockTabLimit(availableWidth: number, tabCount: number): number {
  if (tabCount <= 0) return 0;
  const widthWithoutMenu = Math.max(0, availableWidth - TAB_CONTROL_WIDTH - TAB_GAP);
  const allTabsWidth = tabCount * MIN_TAB_WIDTH + Math.max(0, tabCount - 1) * TAB_GAP;
  if (allTabsWidth <= widthWithoutMenu) return tabCount;

  const widthWithMenu = Math.max(
    0,
    availableWidth - TAB_CONTROL_WIDTH * 2 - TAB_GAP * 2,
  );
  return Math.max(
    1,
    Math.min(tabCount, Math.floor((widthWithMenu + TAB_GAP) / (MIN_TAB_WIDTH + TAB_GAP))),
  );
}

export function partitionDockTabs<T extends string>(
  tabIds: readonly T[],
  activeTab: T | null,
  visibleLimit: number,
): { visible: T[]; overflow: T[] } {
  const limit = Math.max(0, Math.min(tabIds.length, visibleLimit));
  if (tabIds.length <= limit) return { visible: [...tabIds], overflow: [] };
  const visible = tabIds.slice(0, limit);
  if (activeTab && tabIds.includes(activeTab) && !visible.includes(activeTab) && limit > 0) {
    visible[limit - 1] = activeTab;
  }
  return {
    visible,
    overflow: tabIds.filter((tabId) => !visible.includes(tabId)),
  };
}

export function clampDockWidth(width: number, viewportWidth = 1280): number {
  const responsiveMax = Math.max(
    DEFAULT_DOCK_WIDTH,
    Math.min(MAX_DOCK_WIDTH, viewportWidth - 360),
  );
  if (!Number.isFinite(width)) return Math.min(DEFAULT_DOCK_WIDTH, responsiveMax);
  return Math.min(responsiveMax, Math.max(MIN_DOCK_WIDTH, Math.round(width)));
}

function initialDockWidth(): number {
  const viewportWidth = typeof window === "undefined" ? 1280 : window.innerWidth;
  try {
    const stored = Number(globalThis.localStorage?.getItem(DOCK_WIDTH_KEY));
    return clampDockWidth(stored || DEFAULT_DOCK_WIDTH, viewportWidth);
  } catch {
    return clampDockWidth(DEFAULT_DOCK_WIDTH, viewportWidth);
  }
}

export function RightDock() {
  const dockOpen = useAppStore((state) => state.dockOpen);
  const panel = useAppStore((state) => state.extensionTerminal);
  const workspaceCwd = useAppStore((state) => state.workspace?.canonicalCwd ?? null);
  const setDockOpen = useAppStore((state) => state.setDockOpen);
  const pushNotification = useAppStore((state) => state.pushNotification);
  const [activeTab, setActiveTab] = useState<DockTabId | null>(
    panel ? extensionTabId(panel.requestId) : null,
  );
  const [shellTabs, setShellTabs] = useState<ShellDockTab[]>([]);
  const [extensionClosing, setExtensionClosing] = useState<string | null>(null);
  const [dockWidth, setDockWidth] = useState(initialDockWidth);
  const [resizing, setResizing] = useState(false);
  const [visibleTabLimit, setVisibleTabLimit] = useState(Number.MAX_SAFE_INTEGER);
  const nextShellId = useRef(1);
  const nextShellGeneration = useRef(1);
  const resizeStart = useRef<{ pointerId: number; x: number; width: number } | null>(
    null,
  );
  const tabBarRef = useRef<HTMLDivElement>(null);
  const dockWidthRef = useRef(dockWidth);
  dockWidthRef.current = dockWidth;
  const dockTabIds: DockTabId[] = [
    ...shellTabs.map((tab) => shellTabId(tab.id)),
    ...(panel ? [extensionTabId(panel.requestId)] : []),
  ];
  const { visible: visibleTabIds, overflow: overflowTabIds } = partitionDockTabs(
    dockTabIds,
    activeTab,
    visibleTabLimit,
  );

  useEffect(() => {
    if (panel) {
      setExtensionClosing(null);
      setActiveTab(extensionTabId(panel.requestId));
      return;
    }
    setExtensionClosing(null);
    setActiveTab((current) => {
      if (!current?.startsWith("extension:")) return current;
      const fallback = shellTabs[shellTabs.length - 1];
      return fallback ? shellTabId(fallback.id) : null;
    });
  }, [panel?.requestId]);

  useEffect(() => {
    const tabBar = tabBarRef.current;
    if (!tabBar) return;
    const updateLimit = (width: number) => {
      setVisibleTabLimit(visibleDockTabLimit(width, dockTabIds.length));
    };
    updateLimit(tabBar.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) updateLimit(entry.contentRect.width);
    });
    observer.observe(tabBar);
    return () => observer.disconnect();
  }, [dockTabIds.length]);

  const toggle = () => {
    const next = !dockOpen;
    setDockOpen(next);
    setSidebarPref("pideck.dock.open", next);
  };

  const createShell = () => {
    if (!workspaceCwd) return;
    const id = nextShellId.current++;
    const generation = nextShellGeneration.current++;
    setShellTabs((current) => [
      ...current,
      { id, generation, cwd: workspaceCwd, status: null },
    ]);
    setActiveTab(shellTabId(id));
  };

  const closeShell = (id: number) => {
    const index = shellTabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    const next = shellTabs.filter((tab) => tab.id !== id);
    setShellTabs(next);
    if (activeTab !== shellTabId(id)) return;
    const fallback = next[Math.min(index, next.length - 1)];
    setActiveTab(
      fallback
        ? shellTabId(fallback.id)
        : panel
          ? extensionTabId(panel.requestId)
          : null,
    );
  };

  const restartShell = (id: number) => {
    const generation = nextShellGeneration.current++;
    setShellTabs((current) =>
      current.map((tab) =>
        tab.id === id ? { ...tab, generation, status: null } : tab,
      ),
    );
    setActiveTab(shellTabId(id));
  };

  const closeExtension = async () => {
    if (!panel || extensionClosing === panel.requestId) return;
    const requestId = panel.requestId;
    setExtensionClosing(requestId);
    const error = await cancelExtensionTerminal(panel);
    if (error) {
      setExtensionClosing((current) => (current === requestId ? null : current));
      pushNotification(error, "error");
      return;
    }
    window.setTimeout(() => {
      if (useAppStore.getState().extensionTerminal?.requestId !== requestId) return;
      setExtensionClosing((current) => (current === requestId ? null : current));
      pushNotification(
        "Extension did not respond to close; use the panel's own exit shortcut",
        "warning",
      );
    }, 1_500);
  };

  const finishResize = (target: HTMLDivElement, pointerId: number) => {
    if (resizeStart.current?.pointerId !== pointerId) return;
    resizeStart.current = null;
    setResizing(false);
    try {
      globalThis.localStorage?.setItem(DOCK_WIDTH_KEY, String(dockWidthRef.current));
    } catch {
      /* ignore unavailable localStorage */
    }
    if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
  };

  return (
    <aside
      style={{ width: dockWidth, marginRight: dockOpen ? 0 : -dockWidth }}
      className={`relative flex shrink-0 flex-col border-l border-border bg-sidebar ${
        resizing ? "transition-none" : "transition-[margin-right] duration-200 ease-out"
      }`}
    >
      {dockOpen && (
        <div
          role="separator"
          tabIndex={0}
          aria-label="Resize terminal panel"
          aria-orientation="vertical"
          aria-valuemin={MIN_DOCK_WIDTH}
          aria-valuemax={MAX_DOCK_WIDTH}
          aria-valuenow={dockWidth}
          className="absolute -left-1 top-0 z-30 h-full w-2 cursor-col-resize touch-none hover:bg-accent/20"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            resizeStart.current = {
              pointerId: event.pointerId,
              x: event.clientX,
              width: dockWidth,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
            setResizing(true);
          }}
          onPointerMove={(event) => {
            const start = resizeStart.current;
            if (!start || start.pointerId !== event.pointerId) return;
            const next = clampDockWidth(
              start.width + start.x - event.clientX,
              window.innerWidth,
            );
            dockWidthRef.current = next;
            setDockWidth(next);
          }}
          onPointerUp={(event) => finishResize(event.currentTarget, event.pointerId)}
          onPointerCancel={(event) => finishResize(event.currentTarget, event.pointerId)}
          onLostPointerCapture={() => {
            resizeStart.current = null;
            setResizing(false);
          }}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const delta = event.key === "ArrowLeft" ? 20 : -20;
            const next = clampDockWidth(dockWidth + delta, window.innerWidth);
            dockWidthRef.current = next;
            setDockWidth(next);
            try {
              globalThis.localStorage?.setItem(DOCK_WIDTH_KEY, String(next));
            } catch {
              /* ignore unavailable localStorage */
            }
          }}
        />
      )}

      <button
        type="button"
        title={dockOpen ? "Collapse panel" : "Open panel"}
        aria-label={dockOpen ? "Collapse right panel" : "Open right panel"}
        aria-expanded={dockOpen}
        className={`absolute -left-4 top-1/2 z-40 flex h-12 w-4 -translate-y-1/2 items-center justify-center rounded-l-md border border-r-0 border-border bg-surface-raised hover:text-foreground ${
          !dockOpen && panel ? "text-accent" : "text-muted"
        }`}
        onClick={toggle}
      >
        {dockOpen ? <ChevronRight size={12} /> : <ChevronLeft size={12} />}
      </button>

      <div
        data-tauri-drag-region
        className="flex h-11 shrink-0 items-center border-b border-border pl-2 pr-[180px]"
      >
        <div ref={tabBarRef} className="flex min-w-0 flex-1 items-center gap-1 self-stretch">
          <div className="flex min-w-0 items-end self-stretch gap-1 overflow-hidden pt-1.5">
          {shellTabs
            .filter((tab) => visibleTabIds.includes(shellTabId(tab.id)))
            .map((tab) => {
            const tabId = shellTabId(tab.id);
            const active = activeTab === tabId;
            const restartable =
              tab.status?.state === "exited" || tab.status?.state === "error";
            return (
              <div
                key={tab.id}
                className={`flex h-full w-44 min-w-[96px] shrink items-center border-b-2 text-xs ${
                  active
                    ? "border-accent text-foreground"
                    : "border-transparent text-muted hover:text-foreground"
                }`}
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch pl-2"
                  title={shellTitle(tab)}
                  aria-label={shellTitle(tab)}
                  onClick={() => setActiveTab(tabId)}
                >
                  {tab.status?.state === "starting" ? (
                    <LoaderCircle size={13} className="shrink-0 animate-spin" />
                  ) : (
                    <SquareTerminal size={13} className="shrink-0" />
                  )}
                  <span className="truncate">{shellTitle(tab)}</span>
                </button>
                {restartable && (
                  <button
                    type="button"
                    title="Restart shell"
                    aria-label={`Restart ${shellTitle(tab)}`}
                    className="shrink-0 p-1 text-muted hover:text-foreground"
                    onClick={() => restartShell(tab.id)}
                  >
                    <RotateCcw size={12} />
                  </button>
                )}
                <button
                  type="button"
                  title="Close shell"
                  aria-label={`Close ${shellTitle(tab)}`}
                  className="shrink-0 p-1 text-muted hover:text-foreground"
                  onClick={() => closeShell(tab.id)}
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}

          {panel && visibleTabIds.includes(extensionTabId(panel.requestId)) && (
            <div
              className={`flex h-full w-40 min-w-[96px] shrink items-center border-b-2 text-xs ${
                activeTab === extensionTabId(panel.requestId)
                  ? "border-accent text-foreground"
                  : "border-transparent text-muted hover:text-foreground"
              }`}
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch pl-2"
                title={panel.title ?? "Extension"}
                aria-label={panel.title ?? "Extension"}
                onClick={() => setActiveTab(extensionTabId(panel.requestId))}
              >
                <SquareTerminal size={13} className="shrink-0" />
                <span className="truncate">{panel.title ?? "Extension"}</span>
              </button>
              <button
                type="button"
                title="Close extension panel"
                aria-label={`Close ${panel.title ?? "extension panel"}`}
                disabled={extensionClosing === panel.requestId}
                className="shrink-0 p-1 text-muted hover:text-foreground disabled:opacity-60"
                onClick={() => void closeExtension()}
              >
                {extensionClosing === panel.requestId ? (
                  <LoaderCircle size={12} className="animate-spin" />
                ) : (
                  <X size={12} />
                )}
              </button>
            </div>
          )}
          </div>

          {overflowTabIds.length > 0 && (
            <details className="relative shrink-0">
              <summary
                title="More tabs"
                aria-label="More tabs"
                className="flex size-7 cursor-pointer list-none items-center justify-center rounded text-muted hover:bg-surface-overlay hover:text-foreground [&::-webkit-details-marker]:hidden"
              >
                <ChevronDown size={14} />
              </summary>
              <div className="absolute right-0 top-8 z-50 w-52 overflow-hidden rounded border border-border bg-surface-raised py-1 shadow-lg">
                {overflowTabIds.map((tabId) => {
                  const shell = shellTabs.find((tab) => shellTabId(tab.id) === tabId);
                  const label = shell ? shellTitle(shell) : (panel?.title ?? "Extension");
                  const closing = !shell && extensionClosing === panel?.requestId;
                  return (
                    <div key={tabId} className="flex items-center text-muted hover:bg-surface-overlay">
                      <button
                        type="button"
                        title={label}
                        className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:text-foreground"
                        onClick={(event) => {
                          setActiveTab(tabId);
                          event.currentTarget.closest("details")?.removeAttribute("open");
                        }}
                      >
                        <SquareTerminal size={13} className="shrink-0" />
                        <span className="truncate">{label}</span>
                      </button>
                      <button
                        type="button"
                        title={shell ? "Close shell" : "Close extension panel"}
                        aria-label={`Close ${label}`}
                        disabled={closing}
                        className="mr-1 flex size-6 shrink-0 items-center justify-center rounded hover:bg-surface-raised hover:text-foreground disabled:opacity-60"
                        onClick={() => {
                          if (shell) closeShell(shell.id);
                          else void closeExtension();
                        }}
                      >
                        {closing ? (
                          <LoaderCircle size={12} className="animate-spin" />
                        ) : (
                          <X size={12} />
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            </details>
          )}

          <button
            type="button"
            title="New terminal"
            aria-label="New terminal"
            disabled={!workspaceCwd}
            className="flex size-7 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-overlay hover:text-foreground disabled:opacity-40"
            onClick={createShell}
          >
            <Plus size={14} />
          </button>

        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {shellTabs.map((tab) => (
          <ShellTerminal
            key={`${tab.id}:${tab.generation}`}
            cwd={tab.cwd}
            generation={tab.generation}
            visible={activeTab === shellTabId(tab.id)}
            onStatus={(status) =>
              setShellTabs((current) =>
                current.map((candidate) =>
                  candidate.id === tab.id && candidate.generation === tab.generation
                    ? { ...candidate, status }
                    : candidate,
                ),
              )
            }
          />
        ))}
        {panel && (
          <ExtensionTerminal visible={activeTab === extensionTabId(panel.requestId)} />
        )}
        {dockTabIds.length === 0 && (
          <div className="flex min-h-0 flex-1 items-center justify-center">
            <div className="pointer-events-none flex select-none flex-col items-center gap-3 text-center">
              <PiMark className="size-16" />
              <p className="m-0 text-xs text-muted">点击上方 "+" 创建新页面</p>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
