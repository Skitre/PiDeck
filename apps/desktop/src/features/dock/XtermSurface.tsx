import { useEffect, useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import { resolveWindowControlsPlatform } from "../../components/WindowControls";
import { terminalClipboardKeyHandler } from "./terminal-clipboard";
import { ClipboardCopy, ClipboardPaste, Eraser, TextSelect } from "lucide-react";
import { contextMenuTrigger, openContextMenu } from "../../lib/context-menu";
import { shouldKeepNativeContextMenu } from "../../lib/context-menu-policy";
import { useT } from "../../lib/i18n/use-t";
import { formatCommandChord } from "../../lib/commands/keymap";
import { readClipboardText } from "../../lib/desktop-clipboard";

type Cleanup = () => void | Promise<void>;
type FontLoader = {
  load: (font: string, text?: string) => Promise<unknown>;
};

const TERMINAL_FONT_SIZE = 12;

export type XtermSurfaceProps = {
  sessionKey: string;
  visible: boolean;
  initialCols?: number;
  initialRows?: number;
  cursorBlink?: boolean;
  connect: (terminal: Terminal) => void | Cleanup | Promise<void | Cleanup>;
};

function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

async function waitForTerminalFont(
  fontLoader: FontLoader | undefined,
  fontFamily: string,
  fontSize: number,
): Promise<void> {
  if (!fontLoader) return;
  try {
    await fontLoader.load(`${fontSize}px ${fontFamily}`, "W");
  } catch {
    // Keep the terminal usable when a bundled or system font cannot be loaded.
  }
}

function applyCspNonceToXtermStyles(container: HTMLElement): void {
  const nonce = document.querySelector<HTMLStyleElement>("style[nonce]")?.nonce;
  if (!nonce) return;

  for (const style of container.querySelectorAll<HTMLStyleElement>(".xterm-screen > style")) {
    if (style.nonce === nonce) continue;
    const parent = style.parentNode;
    if (!parent) continue;
    const nextSibling = style.nextSibling;
    parent.removeChild(style);
    style.nonce = nonce;
    parent.insertBefore(style, nextSibling);
  }
}

function xtermTheme() {
  return {
    background: cssVar("--color-surface-inset", "#151716"),
    foreground: cssVar("--color-foreground", "#eef0ee"),
    cursor: cssVar("--color-accent", "#df6b35"),
    cursorAccent: cssVar("--color-surface-inset", "#151716"),
    selectionBackground: cssVar("--color-control-hover", "#252826"),
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
  const t = useT();
  const isMac = resolveWindowControlsPlatform() === "macos";
  const containerRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<(() => void) | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const connectRef = useRef(connect);
  connectRef.current = connect;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    let connectionCleanup: Cleanup | undefined;
    let observer: ResizeObserver | undefined;
    let themeObserver: MutationObserver | undefined;
    let terminal: Terminal | undefined;

    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]).then(
      async ([{ Terminal }, { FitAddon }]) => {
        if (cancelled) return;

        const fontFamily = cssVar(
          "--font-mono",
          '"Cascadia Code", Consolas, ui-monospace, monospace',
        );
        await waitForTerminalFont(document.fonts, fontFamily, TERMINAL_FONT_SIZE);
        if (cancelled) return;

        terminal = new Terminal({
          cols: initialCols,
          rows: initialRows,
          fontFamily,
          fontSize: TERMINAL_FONT_SIZE,
          letterSpacing: 0,
          cursorBlink,
          scrollback: 10_000,
          theme: xtermTheme(),
        });
        const fit = new FitAddon();
        terminal.loadAddon(fit);
        terminal.attachCustomKeyEventHandler(
          terminalClipboardKeyHandler({
            terminal,
            isMac,
          }),
        );
        terminal.open(container);
        applyCspNonceToXtermStyles(container);
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

        // The theme is read from CSS variables at creation time; follow both
        // the effective color mode and theme family so open terminals recolor live.
        themeObserver = new MutationObserver(() => {
          if (terminal) terminal.options.theme = xtermTheme();
        });
        themeObserver.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["class", "data-theme-family"],
        });

        try {
          const cleanup = await connectRef.current(terminal);
          if (cancelled) {
            if (typeof cleanup === "function") await cleanup();
          } else {
            if (typeof cleanup === "function") connectionCleanup = cleanup;
            if (visibleRef.current) terminal.focus();
          }
        } catch (error) {
          if (!cancelled) {
            terminal.writeln(`\r\n${error instanceof Error ? error.message : String(error)}`);
          }
        }
      },
    );

    return () => {
      cancelled = true;
      observer?.disconnect();
      themeObserver?.disconnect();
      fitRef.current = null;
      terminalRef.current = null;
      void connectionCleanup?.();
      terminal?.dispose();
    };
  }, [sessionKey, initialCols, initialRows, cursorBlink, isMac]);

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
      onContextMenu={(event) => {
        if (shouldKeepNativeContextMenu(event.nativeEvent)) return;
        event.preventDefault();
        event.stopPropagation();
        const terminal = terminalRef.current;
        openContextMenu({
          x: event.clientX,
          y: event.clientY,
          trigger: contextMenuTrigger(event.target),
          items: [
            {
              id: "terminal.copy",
              label: t("menuCopy"),
              icon: ClipboardCopy,
              chordHint: formatCommandChord("mod+c", isMac),
              disabled: !terminal?.hasSelection(),
              onSelect: () =>
                terminal?.hasSelection()
                  ? navigator.clipboard.writeText(terminal.getSelection())
                  : undefined,
            },
            {
              id: "terminal.paste",
              label: t("menuPaste"),
              icon: ClipboardPaste,
              chordHint: formatCommandChord("mod+v", isMac),
              onSelect: async () => {
                const text = await readClipboardText();
                if (text) terminal?.paste(text);
              },
            },
            {
              id: "terminal.selectAll",
              label: t("menuSelectAll"),
              icon: TextSelect,
              chordHint: formatCommandChord("mod+a", isMac),
              separatorBefore: true,
              onSelect: () => terminal?.selectAll(),
            },
            {
              id: "terminal.clear",
              label: t("menuClearTerminal"),
              icon: Eraser,
              onSelect: () => terminal?.clear(),
            },
          ],
        });
      }}
    />
  );
}
