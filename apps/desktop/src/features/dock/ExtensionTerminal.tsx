import { useEffect, useRef } from "react";
import {
  useAppStore,
  type ExtensionTerminalState,
} from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import { activeSessionContext } from "../../lib/bridge/host-context";
import {
  clearExtensionTerminal,
  subscribeExtensionTerminal,
} from "../../lib/chat/extension-terminal-bus";

function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function xtermTheme() {
  return {
    background: cssVar("--color-sidebar", "#151716"),
    foreground: cssVar("--color-foreground", "#eef0ee"),
    cursor: cssVar("--color-accent", "#df6b35"),
    cursorAccent: cssVar("--color-sidebar", "#151716"),
    selectionBackground: cssVar("--color-surface-overlay", "#252826"),
  };
}

/**
 * Use the freshest identity for the panel's session — the host migrates
 * pending panels across revision bumps, so a stale captured context would
 * fail checkIdentity even though the panel is still alive.
 */
function panelContext(panel: ExtensionTerminalState) {
  const s = useAppStore.getState();
  if (
    s.host &&
    s.workspace &&
    s.session &&
    s.session.sessionId === panel.context.expectedSessionId
  ) {
    return activeSessionContext(s.host, s.workspace, s.session);
  }
  return panel.context;
}

/** Cancel the live panel (dock close button). The host emits customClosed on success. */
export async function cancelExtensionTerminal(panel: ExtensionTerminalState): Promise<void> {
  try {
    const res = await hostClient.request("extensionUi.respond", panelContext(panel), {
      requestId: panel.requestId,
      status: "cancelled",
    });
    if (!res.ok) {
      useAppStore.getState().closeExtensionTerminal(panel.requestId);
    }
  } catch {
    useAppStore.getState().closeExtensionTerminal(panel.requestId);
  }
}

export function ExtensionTerminal() {
  const panel = useAppStore((s) => s.extensionTerminal);

  if (!panel) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-xs text-muted">
        Extension panels (e.g. /mcp) will open here.
      </div>
    );
  }
  return <TerminalView key={panel.requestId} panel={panel} />;
}

function TerminalView({ panel }: { panel: ExtensionTerminalState }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    let cleanup: (() => void) | undefined;

    // xterm is loaded lazily: it is only needed once an extension opens a
    // panel, and keeping it out of the startup bundle keeps first paint fast.
    void Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
      import("@xterm/xterm/css/xterm.css"),
    ]).then(([{ Terminal }, { FitAddon }]) => {
      if (cancelled) return;

      const term = new Terminal({
        cols: panel.cols,
        rows: panel.rows,
        fontFamily: cssVar(
          "--font-mono",
          '"Cascadia Code", Consolas, ui-monospace, monospace',
        ),
        fontSize: 13,
        cursorBlink: false,
        scrollback: 5000,
        theme: xtermTheme(),
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(container);

      const sendResize = (cols: number, rows: number) => {
        hostClient
          .request("extensionUi.customResize", panelContext(panel), {
            requestId: panel.requestId,
            cols,
            rows,
          })
          .catch(() => {});
      };
      const dataSub = term.onData((data) => {
        if (!data) return;
        hostClient
          .request("extensionUi.customInput", panelContext(panel), {
            requestId: panel.requestId,
            data,
          })
          .catch(() => {});
      });
      const resizeSub = term.onResize(({ cols, rows }) => sendResize(cols, rows));
      const unsubscribeFrames = subscribeExtensionTerminal(panel.requestId, (chunk) => {
        term.write(chunk);
      });

      const observer = new ResizeObserver(() => {
        try {
          fit.fit();
        } catch {
          /* container may be zero-sized mid-transition */
        }
      });
      observer.observe(container);
      try {
        fit.fit();
      } catch {
        /* ignore */
      }
      if (term.cols !== panel.cols || term.rows !== panel.rows) {
        sendResize(term.cols, term.rows);
      }
      term.focus();

      cleanup = () => {
        observer.disconnect();
        dataSub.dispose();
        resizeSub.dispose();
        unsubscribeFrames();
        term.dispose();
      };
    });

    return () => {
      cancelled = true;
      cleanup?.();
      clearExtensionTerminal(panel.requestId);
    };
  }, [panel.requestId]);

  return <div ref={containerRef} className="min-h-0 flex-1 pl-2 pt-2" />;
}
