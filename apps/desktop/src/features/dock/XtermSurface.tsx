import { useEffect, useRef } from "react";
import type { Terminal } from "@xterm/xterm";

type Cleanup = () => void | Promise<void>;

export type XtermSurfaceProps = {
  sessionKey: string;
  visible: boolean;
  initialCols?: number;
  initialRows?: number;
  cursorBlink?: boolean;
  connect: (terminal: Terminal) => void | Cleanup | Promise<void | Cleanup>;
};

export function cssVar(name: string, fallback: string): string {
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

export function XtermSurface({
  sessionKey,
  visible,
  initialCols = 100,
  initialRows = 32,
  cursorBlink = true,
  connect,
}: XtermSurfaceProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<(() => void) | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const connectRef = useRef(connect);
  connectRef.current = connect;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    let connectionCleanup: Cleanup | undefined;
    let observer: ResizeObserver | undefined;
    let terminal: Terminal | undefined;

    void Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
      import("@xterm/xterm/css/xterm.css"),
    ]).then(async ([{ Terminal }, { FitAddon }]) => {
      if (cancelled) return;

      terminal = new Terminal({
        cols: initialCols,
        rows: initialRows,
        fontFamily: cssVar(
          "--font-mono",
          '"Cascadia Code", Consolas, ui-monospace, monospace',
        ),
        fontSize: 12,
        letterSpacing: 0,
        cursorBlink,
        scrollback: 10_000,
        theme: xtermTheme(),
      });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(container);
      terminalRef.current = terminal;
      fitRef.current = () => {
        try {
          fit.fit();
        } catch {
          /* container can be zero-sized while the dock is hidden */
        }
      };

      observer = new ResizeObserver(() => fitRef.current?.());
      observer.observe(container);
      fitRef.current();

      try {
        const cleanup = await connectRef.current(terminal);
        if (cancelled) {
          if (typeof cleanup === "function") await cleanup();
        } else {
          if (typeof cleanup === "function") connectionCleanup = cleanup;
          terminal.focus();
        }
      } catch (error) {
        if (!cancelled) {
          terminal.writeln(`\r\n${error instanceof Error ? error.message : String(error)}`);
        }
      }
    });

    return () => {
      cancelled = true;
      observer?.disconnect();
      fitRef.current = null;
      terminalRef.current = null;
      void connectionCleanup?.();
      terminal?.dispose();
    };
  }, [sessionKey, initialCols, initialRows, cursorBlink]);

  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() => {
      fitRef.current?.();
      terminalRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [visible]);

  return (
    <div
      ref={containerRef}
      className={`${visible ? "flex" : "hidden"} min-h-0 flex-1 pl-2 pt-2`}
    />
  );
}
