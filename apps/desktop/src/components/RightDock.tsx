import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  FolderTree,
  GitBranch,
  GitCompareArrows,
  Globe2,
  LoaderCircle,
  Plus,
  RotateCcw,
  SquareTerminal,
  X,
} from "lucide-react";
import type { TerminalProfileId } from "@pideck/protocol";
import { useAppStore } from "../lib/stores/app-store";
import { setSidebarPref } from "../lib/sidebar-prefs";
import { PiMark } from "./PiMark";
import {
  ExtensionTerminal,
  cancelExtensionTerminal,
  forceCloseExtensionTerminal,
} from "../features/dock/ExtensionTerminal";
import {
  ShellTerminal,
  shellTerminalLabel,
  type ShellTerminalStatus,
} from "../features/dock/ShellTerminal";
import { FilesPanel } from "../features/dock/FilesPanel";
import { BrowserPanel } from "../features/dock/BrowserPanel";
import { TreePanel } from "../features/dock/TreePanel";
import { ChangesPanel } from "../features/dock/ChangesPanel";
import { subscribeDockBrowser } from "../lib/dock-browser";
import { subscribeChangesPanel } from "../lib/dock-changes";
import { subscribeTreePanel } from "../lib/dock-tree";
import { useT } from "../lib/i18n/use-t";
import { subscribeDockCommands } from "../lib/commands/events";

export type DockTabId =
  "files" | "tree" | "changes" | `browser:${number}` | `shell:${number}` | `extension:${string}`;

type ShellDockTab = {
  id: number;
  generation: number;
  cwd: string;
  profileId: TerminalProfileId;
  status: ShellTerminalStatus | null;
};

type BrowserDockTab = {
  id: number;
  title: string;
  initialUrl: string;
};

const DOCK_WIDTH_KEY = "pideck.dock.width.v1";
const DEFAULT_DOCK_WIDTH = 460;
const MIN_DOCK_WIDTH = 460;
const MAX_DOCK_WIDTH = 720;
const MAX_BROWSER_TABS = 8;
const MIN_TAB_WIDTH = 96;
const TAB_GAP = 4;
const TAB_CONTROL_WIDTH = 28;

function shellTabId(id: number): DockTabId {
  return `shell:${id}`;
}

function browserTabId(id: number): DockTabId {
  return `browser:${id}`;
}

function extensionTabId(requestId: string): DockTabId {
  return `extension:${requestId}`;
}

function shellTitle(tab: ShellDockTab, fallback: string): string {
  const title = tab.status?.title ?? fallback;
  const cwd = shellTerminalLabel(tab.status?.cwd ?? tab.cwd);
  return `${title} - ${cwd}`;
}

export function visibleDockTabLimit(availableWidth: number, tabCount: number): number {
  if (tabCount <= 0) return 0;
  const widthWithoutMenu = Math.max(0, availableWidth - TAB_CONTROL_WIDTH - TAB_GAP);
  const allTabsWidth = tabCount * MIN_TAB_WIDTH + Math.max(0, tabCount - 1) * TAB_GAP;
  if (allTabsWidth <= widthWithoutMenu) return tabCount;
  const widthWithMenu = Math.max(0, availableWidth - TAB_CONTROL_WIDTH * 2 - TAB_GAP * 2);
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
  const responsiveMax = Math.max(DEFAULT_DOCK_WIDTH, Math.min(MAX_DOCK_WIDTH, viewportWidth - 360));
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
  const t = useT();
  const dockOpen = useAppStore((state) => state.dockOpen);
  const panel = useAppStore((state) => state.extensionTerminal);
  const workspaceCwd = useAppStore((state) => state.workspace?.canonicalCwd ?? null);
  const terminalProfile = useAppStore((state) => state.desktopSettings?.terminalProfile ?? "auto");
  const setDockOpen = useAppStore((state) => state.setDockOpen);
  const pushNotification = useAppStore((state) => state.pushNotification);
  const initialExtensionTab = panel ? extensionTabId(panel.requestId) : null;
  const [activeTab, setActiveTab] = useState<DockTabId | null>(initialExtensionTab);
  const [tabOrder, setTabOrder] = useState<DockTabId[]>(
    initialExtensionTab ? [initialExtensionTab] : [],
  );
  const [shellTabs, setShellTabs] = useState<ShellDockTab[]>([]);
  const [browserTabs, setBrowserTabs] = useState<BrowserDockTab[]>([]);
  const [extensionClosing, setExtensionClosing] = useState<string | null>(null);
  const [dockWidth, setDockWidth] = useState(initialDockWidth);
  const [resizing, setResizing] = useState(false);
  const [visibleTabLimit, setVisibleTabLimit] = useState(Number.MAX_SAFE_INTEGER);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [overflowMenuOpen, setOverflowMenuOpen] = useState(false);
  const nextShellId = useRef(1);
  const nextShellGeneration = useRef(1);
  const nextBrowserId = useRef(1);
  const browserTabsRef = useRef<BrowserDockTab[]>([]);
  const resizeStart = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  const tabBarRef = useRef<HTMLDivElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const dockWidthRef = useRef(dockWidth);
  const visibleTabIdsRef = useRef<DockTabId[]>([]);
  dockWidthRef.current = dockWidth;
  browserTabsRef.current = browserTabs;

  const updateBrowserTabs = (updater: (current: BrowserDockTab[]) => BrowserDockTab[]) => {
    const next = updater(browserTabsRef.current);
    browserTabsRef.current = next;
    setBrowserTabs(next);
    return next;
  };

  const closeOrderTab = (tabId: DockTabId) => {
    setTabOrder((current) => {
      const index = current.indexOf(tabId);
      if (index < 0) return current;
      const next = current.filter((candidate) => candidate !== tabId);
      setActiveTab((active) =>
        active === tabId ? (next[Math.min(index, next.length - 1)] ?? null) : active,
      );
      return next;
    });
  };

  const panelRequestId = panel?.requestId ?? null;
  useEffect(() => {
    if (panelRequestId) {
      const tabId = extensionTabId(panelRequestId);
      setExtensionClosing(null);
      setTabOrder((current) => (current.includes(tabId) ? current : [...current, tabId]));
      setActiveTab(tabId);
      return;
    }
    setExtensionClosing(null);
    setTabOrder((current) => {
      const stale = current.find((tabId) => tabId.startsWith("extension:"));
      if (!stale) return current;
      const index = current.indexOf(stale);
      const next = current.filter((tabId) => tabId !== stale);
      setActiveTab((active) =>
        active === stale ? (next[Math.min(index, next.length - 1)] ?? null) : active,
      );
      return next;
    });
  }, [panelRequestId]);

  useEffect(() => {
    if (!addMenuOpen) return;
    const frame = window.requestAnimationFrame(() => {
      addMenuRef.current
        ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
        ?.focus();
    });
    const closeOnPointer = (event: PointerEvent) => {
      if (!addMenuRef.current?.contains(event.target as Node)) setAddMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setAddMenuOpen(false);
      addButtonRef.current?.focus();
    };
    window.addEventListener("pointerdown", closeOnPointer);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("pointerdown", closeOnPointer);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [addMenuOpen]);

  useEffect(() => {
    const tabBar = tabBarRef.current;
    if (!tabBar) return;
    const updateLimit = (width: number) => {
      setVisibleTabLimit(visibleDockTabLimit(width, tabOrder.length));
    };
    updateLimit(tabBar.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) updateLimit(entry.contentRect.width);
    });
    observer.observe(tabBar);
    return () => observer.disconnect();
  }, [tabOrder.length]);

  const { visible: visibleTabIds, overflow: overflowTabIds } = partitionDockTabs(
    tabOrder,
    activeTab,
    visibleTabLimit,
  );
  visibleTabIdsRef.current = visibleTabIds;

  useEffect(
    () =>
      subscribeDockCommands((request) => {
        if (request.kind === "toggle") {
          const open = !useAppStore.getState().dockOpen;
          setDockOpen(open);
          setSidebarPref("pideck.dock.open", open);
          return;
        }
        const tabId = visibleTabIdsRef.current[request.index];
        if (!tabId) return;
        setActiveTab(tabId);
        if (!useAppStore.getState().dockOpen) {
          setDockOpen(true);
          setSidebarPref("pideck.dock.open", true);
        }
      }),
    [setDockOpen],
  );

  const createFiles = () => {
    if (!tabOrder.includes("files")) setTabOrder((current) => [...current, "files"]);
    setActiveTab("files");
    setAddMenuOpen(false);
  };

  const createTree = () => {
    setTabOrder((current) => (current.includes("tree") ? current : [...current, "tree"]));
    setActiveTab("tree");
    setAddMenuOpen(false);
  };

  const createChanges = () => {
    setTabOrder((current) => (current.includes("changes") ? current : [...current, "changes"]));
    setActiveTab("changes");
    setAddMenuOpen(false);
  };

  useEffect(
    () =>
      subscribeTreePanel(() => {
        createTree();
        if (!useAppStore.getState().dockOpen) {
          setDockOpen(true);
          setSidebarPref("pideck.dock.open", true);
        }
        return true;
      }),
    // createTree/setDockOpen are stable within a mount; resubscribing per
    // render would drop queued open requests.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(
    () =>
      subscribeChangesPanel(() => {
        createChanges();
        if (!useAppStore.getState().dockOpen) {
          setDockOpen(true);
          setSidebarPref("pideck.dock.open", true);
        }
        return true;
      }),
    // The singleton handler has no render-owned mutable state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const createBrowserTab = (initialUrl = "about:blank"): boolean => {
    if (browserTabsRef.current.length >= MAX_BROWSER_TABS) return false;
    const id = nextBrowserId.current++;
    updateBrowserTabs((current) => [...current, { id, title: "", initialUrl }]);
    const tabId = browserTabId(id);
    setTabOrder((current) => [...current, tabId]);
    setActiveTab(tabId);
    setAddMenuOpen(false);
    return true;
  };

  const createBrowser = () => {
    createBrowserTab();
  };

  useEffect(
    () =>
      subscribeDockBrowser(({ url }) => {
        if (!createBrowserTab(url)) return false;
        if (!useAppStore.getState().dockOpen) {
          setDockOpen(true);
          setSidebarPref("pideck.dock.open", true);
        }
        return true;
      }),
    // The handler reads browser state through browserTabsRef so rapid requests
    // stay bounded without resubscribing between renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const createShell = () => {
    if (!workspaceCwd) return;
    const id = nextShellId.current++;
    const generation = nextShellGeneration.current++;
    setShellTabs((current) => [
      ...current,
      { id, generation, cwd: workspaceCwd, profileId: terminalProfile, status: null },
    ]);
    const tabId = shellTabId(id);
    setTabOrder((current) => [...current, tabId]);
    setActiveTab(tabId);
    setAddMenuOpen(false);
  };

  const closeShell = (id: number) => {
    const tabId = shellTabId(id);
    setShellTabs((current) => current.filter((tab) => tab.id !== id));
    closeOrderTab(tabId);
  };

  const closeBrowser = (id: number) => {
    updateBrowserTabs((current) => current.filter((tab) => tab.id !== id));
    closeOrderTab(browserTabId(id));
  };

  const restartShell = (id: number) => {
    const generation = nextShellGeneration.current++;
    setShellTabs((current) =>
      current.map((tab) => (tab.id === id ? { ...tab, generation, status: null } : tab)),
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
      void (async () => {
        if (useAppStore.getState().extensionTerminal?.requestId !== requestId) return;
        // Escape didn't land — settle the ui.custom() request host-side.
        const forceError = await forceCloseExtensionTerminal(panel);
        setExtensionClosing((current) => (current === requestId ? null : current));
        if (!forceError) {
          // customClosed will confirm; clear now so the tab close is deterministic.
          useAppStore.getState().closeExtensionTerminal(requestId);
          return;
        }
        if (useAppStore.getState().extensionTerminal?.requestId !== requestId) return;
        pushNotification(t("dockExtensionCloseTimeout"), "warning");
      })();
    }, 1_500);
  };

  const closeTab = (tabId: DockTabId) => {
    if (tabId === "files" || tabId === "tree" || tabId === "changes") {
      closeOrderTab(tabId);
      return;
    }
    if (tabId.startsWith("browser:")) {
      closeBrowser(Number(tabId.slice("browser:".length)));
      return;
    }
    if (tabId.startsWith("shell:")) {
      closeShell(Number(tabId.slice("shell:".length)));
      return;
    }
    void closeExtension();
  };

  const tabInfo = (tabId: DockTabId) => {
    if (tabId === "files") return { label: t("dockFiles"), Icon: FolderTree };
    if (tabId === "tree") return { label: t("dockTree"), Icon: GitBranch };
    if (tabId === "changes") return { label: t("gitChanges"), Icon: GitCompareArrows };
    if (tabId.startsWith("browser:")) {
      const id = Number(tabId.slice("browser:".length));
      return {
        label: browserTabs.find((tab) => tab.id === id)?.title || t("dockBrowser"),
        Icon: Globe2,
      };
    }
    if (tabId.startsWith("shell:")) {
      const id = Number(tabId.slice("shell:".length));
      const shell = shellTabs.find((tab) => tab.id === id);
      return {
        label: shell ? shellTitle(shell, t("dockShell")) : t("dockShell"),
        Icon: SquareTerminal,
      };
    }
    return { label: panel?.title ?? t("dockExtension"), Icon: SquareTerminal };
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
      id="right-dock"
      style={{ width: dockWidth, marginRight: dockOpen ? 0 : -dockWidth }}
      data-right-dock
      data-dock-open={dockOpen ? "true" : "false"}
      className={`relative flex shrink-0 flex-col overflow-hidden border-l border-border bg-surface ${
        resizing ? "transition-none" : "transition-[margin-right] duration-200 ease-out"
      }`}
    >
      {dockOpen && (
        <div
          role="separator"
          tabIndex={0}
          aria-label={t("dockResize")}
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
            const next = clampDockWidth(start.width + start.x - event.clientX, window.innerWidth);
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
            const next = clampDockWidth(
              dockWidth + (event.key === "ArrowLeft" ? 20 : -20),
              window.innerWidth,
            );
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

      <div
        data-tauri-drag-region
        data-dock-header
        className="flex h-11 shrink-0 items-center border-b border-border pl-2 pr-[180px]"
      >
        <div ref={tabBarRef} className="flex min-w-0 flex-1 items-center gap-1 self-stretch">
          <div
            role="tablist"
            aria-label={t("dockPages")}
            data-dock-tab-list
            className="flex min-w-0 items-end gap-1 self-stretch overflow-hidden pt-1.5"
          >
            {visibleTabIds.map((tabId) => {
              const { label, Icon } = tabInfo(tabId);
              const shell = tabId.startsWith("shell:")
                ? shellTabs.find((tab) => shellTabId(tab.id) === tabId)
                : undefined;
              const restartable =
                shell?.status?.state === "exited" || shell?.status?.state === "error";
              const closing =
                tabId.startsWith("extension:") && extensionClosing === panel?.requestId;
              return (
                <div
                  key={tabId}
                  data-ui="tab"
                  data-state={activeTab === tabId ? "active" : "inactive"}
                  className={`flex h-full w-44 min-w-[96px] shrink items-center border-b-2 text-xs ${
                    activeTab === tabId
                      ? "border-accent text-foreground"
                      : "border-transparent text-muted hover:text-foreground"
                  }`}
                >
                  <button
                    type="button"
                    role="tab"
                    id={`dock-tab-${tabId}`}
                    aria-controls={`dock-panel-${tabId}`}
                    aria-selected={activeTab === tabId}
                    className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch pl-2"
                    title={label}
                    aria-label={label}
                    onClick={() => setActiveTab(tabId)}
                  >
                    {shell?.status?.state === "starting" ? (
                      <LoaderCircle size={13} className="shrink-0 animate-spin" />
                    ) : (
                      <Icon size={13} className="shrink-0" />
                    )}
                    <span className="truncate">{label}</span>
                  </button>
                  {restartable && shell && (
                    <button
                      type="button"
                      title={t("dockRestartShell")}
                      aria-label={t("dockRestartNamed", { label })}
                      className="shrink-0 p-1 text-muted hover:text-foreground"
                      onClick={() => restartShell(shell.id)}
                    >
                      <RotateCcw size={12} />
                    </button>
                  )}
                  <button
                    type="button"
                    title={t("dockCloseNamed", { label })}
                    aria-label={t("dockCloseNamed", { label })}
                    disabled={closing}
                    className="shrink-0 p-1 text-muted hover:text-foreground disabled:opacity-60"
                    onClick={() => closeTab(tabId)}
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

          {overflowTabIds.length > 0 && (
            <details
              open={overflowMenuOpen}
              className="relative shrink-0"
              onToggle={(event) => {
                const open = event.currentTarget.open;
                setOverflowMenuOpen(open);
                if (open) setAddMenuOpen(false);
              }}
            >
              <summary
                title={t("dockMoreTabs")}
                aria-label={t("dockMoreTabs")}
                className="flex size-7 cursor-pointer list-none items-center justify-center rounded text-muted hover:bg-surface-overlay hover:text-foreground [&::-webkit-details-marker]:hidden"
              >
                <ChevronDown size={14} />
              </summary>
              <div className="theme-floating-surface interface-density-compact-menu absolute right-0 top-8 z-50 w-56 overflow-hidden rounded border border-border bg-surface-raised py-1 shadow-lg">
                {overflowTabIds.map((tabId) => {
                  const { label, Icon } = tabInfo(tabId);
                  return (
                    <div
                      key={tabId}
                      className="flex items-center text-muted hover:bg-surface-overlay"
                    >
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:text-foreground"
                        onClick={(event) => {
                          setActiveTab(tabId);
                          setOverflowMenuOpen(false);
                          event.currentTarget.closest("details")?.removeAttribute("open");
                        }}
                      >
                        <Icon size={13} className="shrink-0" />
                        <span className="truncate">{label}</span>
                      </button>
                      <button
                        type="button"
                        title={t("dockCloseNamed", { label })}
                        aria-label={t("dockCloseNamed", { label })}
                        className="mr-1 flex size-6 shrink-0 items-center justify-center rounded hover:bg-surface-raised hover:text-foreground"
                        onClick={() => closeTab(tabId)}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  );
                })}
              </div>
            </details>
          )}

          <div ref={addMenuRef} className="relative shrink-0">
            <button
              ref={addButtonRef}
              type="button"
              title={t("dockNewPage")}
              aria-label={t("dockNewPage")}
              aria-haspopup="menu"
              aria-expanded={addMenuOpen}
              className="flex size-7 items-center justify-center rounded text-muted hover:bg-surface-overlay hover:text-foreground"
              onClick={() => {
                setOverflowMenuOpen(false);
                setAddMenuOpen((open) => !open);
              }}
            >
              <Plus size={14} />
            </button>
            {addMenuOpen && (
              <div
                role="menu"
                className={`theme-floating-surface interface-density-menu absolute top-8 z-[70] w-44 overflow-hidden rounded border border-border bg-surface-raised py-1 shadow-lg ${
                  tabOrder.length === 0 ? "left-0" : "right-0"
                }`}
                onKeyDown={(event) => {
                  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                    return;
                  }
                  const items = Array.from(
                    event.currentTarget.querySelectorAll<HTMLButtonElement>(
                      '[role="menuitem"]:not(:disabled)',
                    ),
                  );
                  if (items.length === 0) return;
                  event.preventDefault();
                  const current = items.indexOf(document.activeElement as HTMLButtonElement);
                  const next =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? items.length - 1
                        : event.key === "ArrowDown"
                          ? (current + 1 + items.length) % items.length
                          : (current - 1 + items.length) % items.length;
                  items[next]?.focus();
                }}
              >
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted hover:bg-surface-overlay hover:text-foreground"
                  onClick={createFiles}
                >
                  <FolderTree size={14} />
                  {t("dockFiles")}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted hover:bg-surface-overlay hover:text-foreground"
                  onClick={createTree}
                >
                  <GitBranch size={14} />
                  {t("dockSessionTree")}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={!workspaceCwd}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted hover:bg-surface-overlay hover:text-foreground disabled:opacity-40"
                  onClick={createChanges}
                >
                  <GitCompareArrows size={14} />
                  {t("gitChanges")}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={browserTabs.length >= MAX_BROWSER_TABS}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted hover:bg-surface-overlay hover:text-foreground disabled:opacity-40"
                  onClick={createBrowser}
                >
                  <Globe2 size={14} />
                  {t("dockBrowser")}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={!workspaceCwd}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted hover:bg-surface-overlay hover:text-foreground disabled:opacity-40"
                  onClick={createShell}
                >
                  <SquareTerminal size={14} />
                  {t("dockTerminal")}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {tabOrder.includes("files") && (
          <div
            role="tabpanel"
            id="dock-panel-files"
            aria-labelledby="dock-tab-files"
            className={`min-h-0 flex-1 ${activeTab === "files" ? "flex" : "hidden"}`}
          >
            <FilesPanel visible={activeTab === "files" && dockOpen} />
          </div>
        )}
        {tabOrder.includes("tree") && (
          <div
            role="tabpanel"
            id="dock-panel-tree"
            aria-labelledby="dock-tab-tree"
            className={`min-h-0 flex-1 ${activeTab === "tree" ? "flex" : "hidden"}`}
          >
            <TreePanel visible={activeTab === "tree" && dockOpen} />
          </div>
        )}
        {tabOrder.includes("changes") && (
          <div
            role="tabpanel"
            id="dock-panel-changes"
            aria-labelledby="dock-tab-changes"
            className={`min-h-0 flex-1 ${activeTab === "changes" ? "flex" : "hidden"}`}
          >
            <ChangesPanel visible={activeTab === "changes" && dockOpen} />
          </div>
        )}
        {browserTabs.map((tab) => (
          <div
            key={tab.id}
            role="tabpanel"
            id={`dock-panel-${browserTabId(tab.id)}`}
            aria-labelledby={`dock-tab-${browserTabId(tab.id)}`}
            className={`min-h-0 flex-1 ${activeTab === browserTabId(tab.id) ? "flex" : "hidden"}`}
          >
            <BrowserPanel
              id={tab.id}
              initialUrl={tab.initialUrl}
              visible={activeTab === browserTabId(tab.id) && dockOpen}
              blocked={addMenuOpen || overflowMenuOpen}
              onTitle={(title) =>
                updateBrowserTabs((current) =>
                  current.map((candidate) =>
                    candidate.id === tab.id ? { ...candidate, title } : candidate,
                  ),
                )
              }
            />
          </div>
        ))}
        {shellTabs.map((tab) => (
          <ShellTerminal
            key={`${tab.id}:${tab.generation}`}
            cwd={tab.cwd}
            generation={tab.generation}
            visible={activeTab === shellTabId(tab.id)}
            profileId={tab.profileId}
            onWarning={(message) => pushNotification(message, "warning")}
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
        {panel && <ExtensionTerminal visible={activeTab === extensionTabId(panel.requestId)} />}
        {tabOrder.length === 0 && (
          <div className="flex min-h-0 flex-1 items-center justify-center">
            <div className="flex w-56 flex-col items-center gap-4">
              <PiMark className="size-16" />
              <div className="flex w-full flex-col gap-1">
                <button
                  type="button"
                  aria-label={t("dockOpenNamed", { label: t("dockFiles") })}
                  className="flex h-11 w-full items-center gap-3 rounded-md px-3 text-sm text-muted transition-colors hover:bg-surface-overlay hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus"
                  onClick={createFiles}
                >
                  <FolderTree size={17} className="shrink-0" />
                  <span>{t("dockFiles")}</span>
                </button>
                <button
                  type="button"
                  aria-label={t("dockOpenNamed", { label: t("dockSessionTree") })}
                  className="flex h-11 w-full items-center gap-3 rounded-md px-3 text-sm text-muted transition-colors hover:bg-surface-overlay hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus"
                  onClick={createTree}
                >
                  <GitBranch size={17} className="shrink-0" />
                  <span>{t("dockSessionTree")}</span>
                </button>
                <button
                  type="button"
                  aria-label={t("dockOpenNamed", { label: t("gitChanges") })}
                  title={workspaceCwd ? undefined : t("dockWorkspaceForChanges")}
                  disabled={!workspaceCwd}
                  className="flex h-11 w-full items-center gap-3 rounded-md px-3 text-sm text-muted transition-colors hover:bg-surface-overlay hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus disabled:opacity-40"
                  onClick={createChanges}
                >
                  <GitCompareArrows size={17} className="shrink-0" />
                  <span>{t("gitChanges")}</span>
                </button>
                <button
                  type="button"
                  aria-label={t("dockOpenNamed", { label: t("dockBrowser") })}
                  disabled={browserTabs.length >= MAX_BROWSER_TABS}
                  className="flex h-11 w-full items-center gap-3 rounded-md px-3 text-sm text-muted transition-colors hover:bg-surface-overlay hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus disabled:opacity-40"
                  onClick={createBrowser}
                >
                  <Globe2 size={17} className="shrink-0" />
                  <span>{t("dockBrowser")}</span>
                </button>
                <button
                  type="button"
                  aria-label={t("dockOpenNamed", { label: t("dockTerminal") })}
                  title={
                    workspaceCwd
                      ? t("dockOpenNamed", { label: t("dockTerminal") })
                      : t("dockWorkspaceForTerminal")
                  }
                  disabled={!workspaceCwd}
                  className="flex h-11 w-full items-center gap-3 rounded-md px-3 text-sm text-muted transition-colors hover:bg-surface-overlay hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus disabled:opacity-40"
                  onClick={createShell}
                >
                  <SquareTerminal size={17} className="shrink-0" />
                  <span>{t("dockTerminal")}</span>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
