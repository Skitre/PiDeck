import { PanelRightClose, PanelRightOpen, SquareTerminal, X } from "lucide-react";
import { useAppStore } from "../lib/stores/app-store";
import { setSidebarPref } from "../lib/sidebar-prefs";
import {
  ExtensionTerminal,
  cancelExtensionTerminal,
} from "../features/dock/ExtensionTerminal";

/**
 * Right dock — collapsible side panel. Hosts the extension terminal tab
 * (ui.custom panels from /mcp etc.); future tabs (browser, file tree) slot
 * into the same header. Auto-opens when a panel starts and restores its
 * previous state when the panel closes (see app-store).
 *
 * The terminal content stays mounted while collapsed so a live panel's
 * xterm buffer survives manual collapse/expand.
 */
export function RightDock() {
  const dockOpen = useAppStore((s) => s.dockOpen);
  const panel = useAppStore((s) => s.extensionTerminal);
  const setDockOpen = useAppStore((s) => s.setDockOpen);

  const toggle = () => {
    const next = !dockOpen;
    setDockOpen(next);
    setSidebarPref("pideck.dock.open", next);
  };

  return (
    <aside
      className={`flex shrink-0 flex-col border-l border-border bg-sidebar ${
        dockOpen ? "w-[420px]" : "w-9"
      }`}
    >
      {dockOpen ? (
        <div
          data-tauri-drag-region
          className="flex h-10 shrink-0 items-center gap-2 border-b border-border pl-3 pr-[140px]"
        >
          <SquareTerminal size={14} className="pointer-events-none text-muted" />
          <span className="pointer-events-none truncate text-xs font-medium text-muted">
            {panel?.title ?? "Terminal"}
          </span>
          <div className="ml-auto flex items-center gap-1">
            {panel && (
              <button
                type="button"
                title="Close extension panel"
                aria-label="Close extension panel"
                className="rounded p-1 text-muted hover:bg-surface-overlay hover:text-foreground"
                onClick={() => void cancelExtensionTerminal(panel)}
              >
                <X size={14} />
              </button>
            )}
            <button
              type="button"
              title="Collapse panel"
              aria-label="Collapse right panel"
              className="rounded p-1 text-muted hover:bg-surface-overlay hover:text-foreground"
              onClick={toggle}
            >
              <PanelRightClose size={14} />
            </button>
          </div>
        </div>
      ) : (
        <div className="flex shrink-0 justify-center pt-10">
          <button
            type="button"
            title="Open panel"
            aria-label="Open right panel"
            className={`rounded p-1.5 hover:bg-surface-overlay hover:text-foreground ${
              panel ? "text-accent" : "text-muted"
            }`}
            onClick={toggle}
          >
            <PanelRightOpen size={15} />
          </button>
        </div>
      )}
      <div className={dockOpen ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
        <ExtensionTerminal />
      </div>
    </aside>
  );
}
