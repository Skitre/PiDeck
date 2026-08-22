/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireBrowserOcclusion,
  resetBrowserOcclusionForTests,
} from "../../lib/browser-occlusion";
import { useAppStore } from "../../lib/stores/app-store";

type TestBrowserEvent = {
  payload: {
    surfaceId: string;
    kind: "load" | "title";
    url?: string;
    loading?: boolean;
  };
};

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  openSystem: vi.fn(),
  unlisten: vi.fn(),
  listeners: [] as Array<(event: TestBrowserEvent) => void>,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: mocks.openSystem }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_event: string, listener: (event: TestBrowserEvent) => void) => {
    mocks.listeners.push(listener);
    return mocks.unlisten;
  }),
}));

import { BrowserPanel } from "./BrowserPanel";

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

function emitBrowserEvent(payload: TestBrowserEvent["payload"]) {
  const listener = mocks.listeners.at(-1);
  if (!listener) throw new Error("browser event listener is not registered");
  listener({ payload });
}

beforeEach(() => {
  useAppStore.setState({ page: "chat", desktopSettings: { language: "en" } as never });
  mocks.invoke.mockReset();
  mocks.openSystem.mockReset().mockResolvedValue(undefined);
  mocks.unlisten.mockReset();
  mocks.listeners.length = 0;
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: {},
    configurable: true,
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 100,
    y: 80,
    top: 80,
    left: 100,
    right: 500,
    bottom: 380,
    width: 400,
    height: 300,
    toJSON: () => ({}),
  });
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "browser_surface_create") {
      return { surfaceId: "dock-browser-7", url: "about:blank" };
    }
    if (command === "browser_surface_navigate") return "https://example.com/";
    return undefined;
  });
});

afterEach(async () => {
  cleanup();
  resetBrowserOcclusionForTests();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

describe("BrowserPanel native lifecycle", () => {
  it("localizes browser controls in Chinese", async () => {
    useAppStore.setState({ desktopSettings: { language: "zh" } as never });
    render(<BrowserPanel id={7} visible blocked={false} onTitle={vi.fn()} />);

    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("browser_surface_create", expect.anything()),
    );
    expect(screen.getByRole("region", { name: "浏览器" })).toBeVisible();
    expect(screen.getByRole("button", { name: "后退" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "前进" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "重新加载" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "浏览器地址" })).toHaveAttribute(
      "placeholder",
      "搜索或输入网址",
    );
  });

  it("loads an initial URL and keeps the native snapshot authoritative", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "browser_surface_create") {
        return { surfaceId: "dock-browser-7", url: "https://example.com/path/" };
      }
      return undefined;
    });
    render(
      <BrowserPanel
        id={7}
        initialUrl="https://example.com/path"
        visible
        blocked={false}
        onTitle={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        "browser_surface_create",
        expect.objectContaining({ url: "https://example.com/path" }),
      ),
    );
    expect(screen.getByRole("textbox", { name: "Browser address" })).toHaveValue(
      "https://example.com/path/",
    );
  });

  it("offers the system browser when initial surface creation fails", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "browser_surface_create") throw new Error("surface unavailable");
      return undefined;
    });
    const user = userEvent.setup();
    render(
      <BrowserPanel
        id={7}
        initialUrl="https://example.com/fallback"
        visible
        blocked={false}
        onTitle={vi.fn()}
      />,
    );

    expect(await screen.findByText("surface unavailable")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Open in system browser" }));
    await waitFor(() =>
      expect(mocks.openSystem).toHaveBeenCalledWith("https://example.com/fallback"),
    );
  });

  it("creates lazily, hides behind overlays, navigates, and closes", async () => {
    const user = userEvent.setup();
    const onTitle = vi.fn();
    const view = render(<BrowserPanel id={7} visible={false} blocked={false} onTitle={onTitle} />);
    expect(mocks.invoke).not.toHaveBeenCalledWith("browser_surface_create", expect.anything());

    view.rerender(<BrowserPanel id={7} visible blocked={false} onTitle={onTitle} />);
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        "browser_surface_create",
        expect.objectContaining({
          surfaceId: "dock-browser-7",
          visible: true,
          bounds: { x: 100, y: 80, width: 400, height: 300, devicePixelRatio: 1 },
        }),
      ),
    );

    await user.type(screen.getByRole("textbox", { name: "Browser address" }), "example.com{Enter}");
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("browser_surface_navigate", {
        surfaceId: "dock-browser-7",
        url: "https://example.com",
      }),
    );

    view.rerender(<BrowserPanel id={7} visible blocked onTitle={onTitle} />);
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("browser_surface_set_visible", {
        surfaceId: "dock-browser-7",
        visible: false,
      }),
    );

    view.rerender(<BrowserPanel id={7} visible blocked={false} onTitle={onTitle} />);
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("browser_surface_set_visible", {
        surfaceId: "dock-browser-7",
        visible: true,
      }),
    );
    useAppStore.getState().setPage("settings");
    view.rerender(<BrowserPanel id={7} visible blocked={false} onTitle={onTitle} />);
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("browser_surface_set_visible", {
        surfaceId: "dock-browser-7",
        visible: false,
      }),
    );
    mocks.invoke.mockClear();
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(mocks.invoke).not.toHaveBeenCalledWith("browser_surface_set_bounds", expect.anything());

    view.unmount();
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("browser_surface_close", {
        surfaceId: "dock-browser-7",
      }),
    );
  });

  it("keeps Finished authoritative when navigate resolves afterward", async () => {
    const user = userEvent.setup();
    const navigate = deferred<string>();
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "browser_surface_create") {
        return { surfaceId: "dock-browser-7", url: "about:blank" };
      }
      if (command === "browser_surface_navigate") return navigate.promise;
      return undefined;
    });
    render(<BrowserPanel id={7} visible blocked={false} onTitle={vi.fn()} />);
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("browser_surface_create", expect.anything()),
    );
    await waitFor(() => expect(mocks.listeners).toHaveLength(1));

    await user.type(screen.getByRole("textbox", { name: "Browser address" }), "example.com{Enter}");
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("browser_surface_navigate", {
        surfaceId: "dock-browser-7",
        url: "https://example.com",
      }),
    );

    act(() => {
      emitBrowserEvent({
        surfaceId: "dock-browser-7",
        kind: "load",
        url: "https://example.com/",
        loading: true,
      });
    });
    expect(screen.getByRole("button", { name: "Stop loading" })).toBeInTheDocument();

    act(() => {
      emitBrowserEvent({
        surfaceId: "dock-browser-7",
        kind: "load",
        url: "https://example.com/",
        loading: false,
      });
    });
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();

    await act(async () => {
      navigate.resolve("https://example.com/");
      await navigate.promise;
    });

    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
  });

  it("clears optimistic loading when navigate rejects", async () => {
    const user = userEvent.setup();
    const navigate = deferred<string>();
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "browser_surface_create") {
        return { surfaceId: "dock-browser-7", url: "about:blank" };
      }
      if (command === "browser_surface_navigate") return navigate.promise;
      return undefined;
    });
    render(<BrowserPanel id={7} visible blocked={false} onTitle={vi.fn()} />);
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("browser_surface_create", expect.anything()),
    );

    await user.type(screen.getByRole("textbox", { name: "Browser address" }), "example.com{Enter}");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Stop loading" })).toBeInTheDocument(),
    );

    await act(async () => {
      navigate.reject(new Error("navigation failed"));
      await navigate.promise.catch(() => undefined);
    });

    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
  });

  it("hides the native surface until the last occlusion owner releases", async () => {
    render(<BrowserPanel id={7} visible blocked={false} onTitle={vi.fn()} />);
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("browser_surface_create", expect.anything()),
    );

    const releaseModal = acquireBrowserOcclusion("extension-ui-modal");
    const releaseSettings = acquireBrowserOcclusion("settings");
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("browser_surface_set_visible", {
        surfaceId: "dock-browser-7",
        visible: false,
      }),
    );

    releaseModal();
    mocks.invoke.mockClear();
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      "browser_surface_set_visible",
      expect.objectContaining({ visible: true }),
    );

    releaseSettings();
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("browser_surface_set_visible", {
        surfaceId: "dock-browser-7",
        visible: true,
      }),
    );
  });
});
