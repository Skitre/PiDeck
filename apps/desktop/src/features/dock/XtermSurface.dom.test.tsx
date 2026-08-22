/** @vitest-environment jsdom */

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  constructTerminal: vi.fn(),
  fit: vi.fn(),
  terminal: {
    attachCustomKeyEventHandler: vi.fn(),
    dispose: vi.fn(),
    focus: vi.fn(),
    hasSelection: vi.fn(() => false),
    loadAddon: vi.fn(),
    open: vi.fn(),
    options: {} as { theme?: Record<string, string> },
    paste: vi.fn(),
    selectAll: vi.fn(),
    clear: vi.fn(),
    getSelection: vi.fn(() => ""),
    writeln: vi.fn(),
  },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: function MockTerminal(options: unknown) {
    mocks.constructTerminal(options);
    return mocks.terminal;
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: function MockFitAddon() {
    return { fit: mocks.fit };
  },
}));

vi.mock("../../components/WindowControls", () => ({
  resolveWindowControlsPlatform: () => "windows",
}));

vi.mock("../../lib/i18n/use-t", () => ({
  useT: () => (key: string) => key,
}));

vi.mock("./terminal-clipboard", () => ({
  terminalClipboardKeyHandler: () => vi.fn(),
}));

import { XtermSurface } from "./XtermSurface";

class ResizeObserverStub {
  observe() {}
  disconnect() {}
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function setFontLoader(load: (font: string, text?: string) => Promise<unknown>) {
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { load },
  });
}

function renderSurface() {
  return render(
    <XtermSurface
      sessionKey="terminal-test"
      visible={false}
      connect={vi.fn(async () => undefined)}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.terminal.open.mockReset();
  mocks.terminal.options = {};
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  document.documentElement.style.setProperty("--font-mono", '"Test Mono", monospace');
  document.documentElement.removeAttribute("data-theme-family");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.documentElement.style.removeProperty("--font-mono");
  for (const property of [
    "--color-surface-inset",
    "--color-foreground",
    "--color-accent",
    "--color-control-hover",
  ]) {
    document.documentElement.style.removeProperty(property);
  }
  document.documentElement.removeAttribute("data-theme-family");
  Reflect.deleteProperty(document, "fonts");
});

describe("XtermSurface font readiness", () => {
  it("applies the current Tauri style nonce to xterm runtime styles", async () => {
    setFontLoader(vi.fn().mockResolvedValue([]));
    const trustedStyle = document.createElement("style");
    trustedStyle.nonce = "tauri-style-nonce";
    document.head.appendChild(trustedStyle);

    const dimensionsStyle = document.createElement("style");
    dimensionsStyle.textContent = ".xterm-rows span { display: inline-block; }";
    const themeStyle = document.createElement("style");
    themeStyle.textContent = '.xterm-rows { font-family: "Test Mono"; }';
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    screen.append(dimensionsStyle, themeStyle);
    const insertBefore = vi.spyOn(screen, "insertBefore");
    mocks.terminal.open.mockImplementation((container: HTMLElement) => {
      container.appendChild(screen);
    });

    try {
      renderSurface();

      await waitFor(() => expect(mocks.terminal.open).toHaveBeenCalledTimes(1));
      expect(dimensionsStyle.nonce).toBe("tauri-style-nonce");
      expect(themeStyle.nonce).toBe("tauri-style-nonce");
      expect(insertBefore).toHaveBeenCalledTimes(2);
      expect(Array.from(screen.querySelectorAll(":scope > style"))).toEqual([
        dimensionsStyle,
        themeStyle,
      ]);
    } finally {
      trustedStyle.remove();
    }
  });

  it("waits for the terminal font before constructing xterm", async () => {
    const fontReady = deferred<unknown>();
    const load = vi.fn(() => fontReady.promise);
    setFontLoader(load);

    renderSurface();

    await waitFor(() => {
      expect(load).toHaveBeenCalledWith('12px "Test Mono", monospace', "W");
    });
    expect(mocks.constructTerminal).not.toHaveBeenCalled();

    await act(async () => {
      fontReady.resolve([]);
      await fontReady.promise;
    });

    await waitFor(() => expect(mocks.constructTerminal).toHaveBeenCalledTimes(1));
    expect(mocks.terminal.open).toHaveBeenCalledTimes(1);
    expect(mocks.fit).toHaveBeenCalled();
  });

  it("falls back to constructing xterm when font loading fails", async () => {
    setFontLoader(vi.fn().mockRejectedValue(new Error("font unavailable")));

    renderSurface();

    await waitFor(() => expect(mocks.constructTerminal).toHaveBeenCalledTimes(1));
    expect(mocks.terminal.open).toHaveBeenCalledTimes(1);
  });

  it("does not steal focus while its surface is hidden", async () => {
    setFontLoader(vi.fn().mockResolvedValue([]));

    const view = renderSurface();
    await waitFor(() => expect(mocks.constructTerminal).toHaveBeenCalledTimes(1));
    expect(mocks.terminal.focus).not.toHaveBeenCalled();

    view.rerender(
      <XtermSurface
        sessionKey="terminal-test"
        visible
        connect={vi.fn(async () => undefined)}
      />,
    );
    await waitFor(() => expect(mocks.terminal.focus).toHaveBeenCalledTimes(1));
  });

  it("recolors an open terminal when only the theme family changes", async () => {
    setFontLoader(vi.fn().mockResolvedValue([]));
    const root = document.documentElement;
    root.style.setProperty("--color-surface-inset", "#17171b");
    root.style.setProperty("--color-foreground", "#edeef0");
    root.style.setProperty("--color-accent", "#df6b35");
    root.style.setProperty("--color-control-hover", "#27272d");

    renderSurface();
    await waitFor(() => expect(mocks.constructTerminal).toHaveBeenCalledTimes(1));

    root.style.setProperty("--color-surface-inset", "#111111");
    root.style.setProperty("--color-foreground", "#f0f0f0");
    root.style.setProperty("--color-accent", "#ffffff");
    root.style.setProperty("--color-control-hover", "#1f1f1f");
    root.dataset.themeFamily = "vercel";

    await waitFor(() =>
      expect(mocks.terminal.options.theme).toEqual({
        background: "#111111",
        foreground: "#f0f0f0",
        cursor: "#ffffff",
        cursorAccent: "#111111",
        selectionBackground: "#1f1f1f",
      }),
    );
  });

  it("does not construct xterm after unmounting while the font is loading", async () => {
    const fontReady = deferred<unknown>();
    const load = vi.fn(() => fontReady.promise);
    setFontLoader(load);

    const surface = renderSurface();
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    surface.unmount();

    await act(async () => {
      fontReady.resolve([]);
      await fontReady.promise;
    });

    expect(mocks.constructTerminal).not.toHaveBeenCalled();
  });
});
