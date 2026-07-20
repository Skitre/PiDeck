import { ChevronLeft, ChevronRight, SquareTerminal, X } from "lucide-react";
import { useAppStore } from "../lib/stores/app-store";
import { setSidebarPref } from "../lib/sidebar-prefs";
import {
  ExtensionTerminal,
  cancelExtensionTerminal,
} from "../features/dock/ExtensionTerminal";

/**
 * Right dock — hosts the extension terminal (ui.custom panels from /mcp
 * etc.); future tabs (browser, file tree) slot into the same header.
 *
 * The aside is always mounted at full width (so a live panel's xterm buffer
 * survives collapse) and slides in/out via an animated negative right
 * margin — collapsed it sits past the window's right edge, clipped by the
 * app root's overflow-hidden, with only the chevron tab on its left border
 * peeking into the window as the open control. Expansion is inward: the
 * chat column yields smoothly during the slide.
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
      className={`relative flex w-[420px] shrink-0 flex-col border-l border-border bg-sidebar transition-[margin-right] duration-200 ease-out ${
        dockOpen ? "mr-0" : "-mr-[420px]"
      }`}
    >
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
        className="flex h-11 shrink-0 items-center gap-2 border-b border-border pl-3 pr-[140px]"
      >
        <SquareTerminal size={14} className="pointer-events-none text-muted" />
        <span className="pointer-events-none truncate text-xs font-medium text-muted">
          {panel?.title ?? "Terminal"}
        </span>
        {panel && (
          <button
            type="button"
            title="Close extension panel"
            aria-label="Close extension panel"
            className="ml-auto rounded p-1 text-muted hover:bg-surface-overlay hover:text-foreground"
            onClick={() => void cancelExtensionTerminal(panel)}
          >
            <X size={14} />
          </button>
        )}
      </div>
      <ExtensionTerminal />
    </aside>
  );
}
