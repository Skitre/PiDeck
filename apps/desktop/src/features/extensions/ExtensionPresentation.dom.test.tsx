/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_EXTENSION_UI_SETTINGS } from "@pideck/protocol";
import { useAppStore } from "../../lib/stores/app-store";
import { ChatPage } from "../chat/ChatPage";
import {
  clearExtensionUiUndo,
  commitExtensionPresentationHome,
  getExtensionUiUndo,
} from "../../lib/extension-ui-profile";
import { EXTENSION_UI_UNDO_TOAST_MS } from "./ExtensionPresentationMounts";

const trusted = {
  invocationKind: "command" as const,
  extensionId: "pi-subagents",
  extensionDisplayName: "Subagents",
  sourceKind: "package" as const,
  commandName: "fleet",
};

const BASE_SETTINGS = {
  theme: "system" as const,
  language: "en" as const,
  restoreLastSession: true,
  autoRestartHostOnce: true,
  extensionDecisionPresentation: "auto" as const,
  terminalProfile: "auto" as const,
  extensionUi: DEFAULT_EXTENSION_UI_SETTINGS,
};

function session(id: string, revision = 1) {
  return {
    sessionId: id,
    cwd: "/p",
    revision,
    isStreaming: false,
    isIdle: true,
    isCompacting: false,
    isRetrying: false,
    thinkingLevel: "off" as const,
    autoCompactionEnabled: false,
    autoRetryEnabled: false,
    steeringMode: "all" as const,
    followUpMode: "all" as const,
    pending: { revision: 0, steering: [], followUp: [] },
    messages: [{ role: "user" as const, content: "hi" }],
    tools: {
      revision: 1,
      workspaceId: "w",
      sessionId: id,
      sessionRevision: revision,
      tools: [],
      active: [],
    },
  };
}

function mountWidget(overrides?: { placement?: "aboveEditor" | "belowEditor" }) {
  useAppStore.getState().setExtensionWidget({
    key: "fleet",
    widget: ["ready"],
    placement: overrides?.placement,
    origin: trusted,
    hostInstanceId: "h1",
    workspaceId: "w",
    workspaceRevision: 1,
    sessionId: "s1",
    sessionRevision: 1,
  });
}

beforeEach(() => {
  vi.stubGlobal("innerWidth", 1200);
  vi.stubGlobal("innerHeight", 800);
  clearExtensionUiUndo();
  useAppStore.getState().setWorkspace({
    id: "22222222-2222-4222-8222-222222222222",
    cwd: "/workspace",
    canonicalCwd: "/workspace",
    revision: 1,
    servicesReady: true,
  });
  useAppStore.getState().applySessionSnapshot(session("s1"));
  useAppStore.getState().setDesktopSettings(BASE_SETTINGS);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  clearExtensionUiUndo();
  useAppStore.setState({ collapsedExtensionWidgetKeys: {} });
  useAppStore.getState().setWorkspace(null);
  useAppStore.getState().applySessionSnapshot(null);
  useAppStore.getState().setDesktopSettings(null);
  useAppStore.getState().setPage("chat");
  vi.unstubAllGlobals();
});

describe("Extension presentation mounts", () => {
  it("places follow-extension widgets on composer anchors and keeps them read-only", () => {
    mountWidget({ placement: "belowEditor" });
    useAppStore.getState().setExtensionStatus("fleet", "running", trusted);
    render(<ChatPage />);

    const below = document.querySelector("[data-extension-anchor='belowComposer']");
    const above = document.querySelector("[data-extension-anchor='aboveComposer']");
    const rail = document.querySelector("[data-extension-status-rail]");
    expect(below).toHaveTextContent("ready");
    expect(above).toBeNull();
    expect(rail).toHaveTextContent("running");
    expect(
      document.querySelector("[data-composer-surface] [data-extension-status-rail]"),
    ).toBeNull();
    const host = document.querySelector("[data-extension-widget-anchor]");
    expect(host?.contains(rail)).toBe(true);
    expect(document.querySelector("[data-composer-surface]")?.contains(rail)).toBe(false);
    expect(below?.querySelector("pre")).toHaveAttribute("aria-readonly", "true");
    expect(below?.querySelector("input,textarea")).toBeNull();
    expect(document.querySelector("[data-widget-popover]")).toBeNull();
  });

  it("keeps status chips out of the widget anchor and preserves Extension characters", () => {
    mountWidget({ placement: "aboveEditor" });
    useAppStore.getState().setExtensionStatus("mcp", "🔌 MCP: 1 server enabled", {
      ...trusted,
      extensionId: "mcp",
      extensionDisplayName: "MCP",
    });
    useAppStore.getState().setExtensionStatus("brainstorm", "🧠 brainstorm", {
      ...trusted,
      extensionId: "brainstorm",
      extensionDisplayName: "Brainstorm",
    });
    render(<ChatPage />);

    const above = document.querySelector("[data-extension-anchor='aboveComposer']");
    const rail = document.querySelector("[data-extension-status-rail]");
    expect(above).toHaveTextContent("ready");
    expect(above).not.toHaveTextContent("MCP");
    expect(above).not.toHaveTextContent("🧠");
    expect(rail).toHaveTextContent("🔌 MCP: 1 server enabled");
    expect(rail).toHaveTextContent("🧠 brainstorm");
    expect(rail?.textContent).not.toMatch(/mcp\s+🔌/i);
    expect(rail?.textContent).not.toMatch(/brainstorm\s+🧠/i);
    expect(rail?.className).not.toMatch(/bg-/);
    expect(
      document.querySelector("[data-composer-surface] [data-extension-status-rail]"),
    ).toBeNull();
    const host = document.querySelector("[data-extension-widget-anchor]");
    const surface = document.querySelector("[data-composer-surface]");
    expect(host?.contains(above)).toBe(true);
    expect(host?.contains(rail)).toBe(true);
    expect(host?.contains(surface)).toBe(true);
    expect(
      [...(host?.children ?? [])].map((node) =>
        node.hasAttribute("data-extension-anchor")
          ? "anchor"
          : node.hasAttribute("data-extension-status-rail")
            ? "status"
            : node.hasAttribute("data-composer-surface")
              ? "composer"
              : node.tagName,
      ),
    ).toEqual(expect.arrayContaining(["anchor", "status", "composer"]));
    expect(
      [...(host?.children ?? [])].findIndex((node) =>
        node.hasAttribute("data-extension-status-rail"),
      ),
    ).toBeGreaterThan(
      [...(host?.children ?? [])].findIndex((node) => node.hasAttribute("data-extension-anchor")),
    );
    expect(
      [...(host?.children ?? [])].findIndex((node) =>
        node.hasAttribute("data-extension-status-rail"),
      ),
    ).toBeLessThan(
      [...(host?.children ?? [])].findIndex((node) => node.hasAttribute("data-composer-surface")),
    );
  });

  it("compacts the composer widget card once every widget is collapsed", async () => {
    mountWidget({ placement: "aboveEditor" });
    render(<ChatPage />);

    const above = document.querySelector("[data-extension-anchor='aboveComposer']");
    expect(above).toHaveAttribute("data-extension-anchor-collapsed", "false");
    expect(above).toHaveClass("max-h-40");

    await userEvent.click(screen.getByRole("button", { name: "Collapse extension widget fleet" }));

    const collapsed = document.querySelector("[data-extension-anchor='aboveComposer']");
    expect(collapsed).toHaveAttribute("data-extension-anchor-collapsed", "true");
    expect(collapsed).toHaveClass("py-0");
    expect(collapsed).not.toHaveClass("max-h-40");
    expect(screen.getByRole("button", { name: "Expand extension widget fleet" })).toHaveClass(
      "h-5",
    );
  });

  it("persists a completed float drag and offers session-global Undo", async () => {
    useAppStore.getState().setDesktopSettings({
      ...BASE_SETTINGS,
      extensionUi: {
        ...DEFAULT_EXTENSION_UI_SETTINGS,
        presentations: {
          "pi-subagents": {
            widget: {
              home: { kind: "float", rect: { x: 0.2, y: 0.2, width: 300, height: 180 } },
            },
          },
        },
      },
    });
    mountWidget();
    render(<ChatPage />);

    const dialog = screen.getByRole("dialog", { name: "pi-subagents Widget" });
    expect(dialog).toHaveAttribute("aria-modal", "false");
    const title = dialog.querySelector(".cursor-grab")!;
    fireEvent.pointerDown(title, { pointerId: 1, clientX: 400, clientY: 200 });
    fireEvent.pointerMove(dialog, { pointerId: 1, clientX: 460, clientY: 240 });
    expect(
      useAppStore.getState().desktopSettings?.extensionUi?.presentations["pi-subagents"]?.widget
        ?.home,
    ).toMatchObject({
      kind: "float",
      rect: { x: 0.2, y: 0.2 },
    });
    await userEvent.click(screen.getByRole("button", { name: "Pin pi-subagents Widget" }));

    await waitFor(() =>
      expect(
        useAppStore.getState().desktopSettings?.extensionUi?.presentations["pi-subagents"]?.widget
          ?.home,
      ).toMatchObject({ kind: "float", pinned: true }),
    );
    expect(screen.getByText(/Applies to all sessions/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(
        useAppStore.getState().desktopSettings?.extensionUi?.presentations["pi-subagents"]?.widget
          ?.home,
      ).toMatchObject({ kind: "float", rect: { x: 0.2, y: 0.2, width: 300, height: 180 } }),
    );
    expect(
      useAppStore.getState().desktopSettings?.extensionUi?.presentations["pi-subagents"]?.widget
        ?.home,
    ).not.toMatchObject({ pinned: true });
  });

  it("resizes a float from the edge and does not treat the gesture as a dock drop", async () => {
    useAppStore.getState().setDesktopSettings({
      ...BASE_SETTINGS,
      extensionUi: {
        ...DEFAULT_EXTENSION_UI_SETTINGS,
        presentations: {
          "pi-subagents": {
            widget: {
              home: { kind: "float", rect: { x: 0.2, y: 0.2, width: 300, height: 180 } },
            },
          },
        },
      },
    });
    mountWidget();
    render(<ChatPage />);

    const dialog = screen.getByRole("dialog", { name: "pi-subagents Widget" });
    const handle = dialog.querySelector("[data-extension-resize='se']");
    expect(handle).toBeTruthy();
    fireEvent.pointerDown(handle!, { pointerId: 2, clientX: 540, clientY: 340 });
    fireEvent.pointerMove(handle!, { pointerId: 2, clientX: 600, clientY: 380 });
    expect(dialog).toHaveStyle({ width: "360px", height: "220px" });

    const drop = document.createElement("div");
    drop.setAttribute("data-extension-drop", "dock-primary");
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => drop,
    });
    fireEvent.pointerUp(handle!, { pointerId: 2, clientX: 600, clientY: 380 });

    await waitFor(() =>
      expect(
        useAppStore.getState().desktopSettings?.extensionUi?.presentations["pi-subagents"]?.widget
          ?.home,
      ).toMatchObject({ kind: "float", rect: { width: 360, height: 220 } }),
    );
  });

  it("dismisses the undo toast without reversing the change", async () => {
    await commitExtensionPresentationHome({
      extensionId: "pi-subagents",
      family: "widget",
      home: { kind: "dock", group: "primary", order: 0 },
      message: "Subagents Widget now opens in Extensions Dock",
    });
    render(<ChatPage />);
    expect(screen.getByText(/Applies to all sessions/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(document.querySelector("[data-extension-ui-undo]")).toBeNull();
    expect(getExtensionUiUndo()).toBeNull();
    expect(
      useAppStore.getState().desktopSettings?.extensionUi?.presentations["pi-subagents"]?.widget
        ?.home,
    ).toMatchObject({ kind: "dock", group: "primary", order: 0 });
  });

  it("auto-dismisses the undo toast after a short delay", async () => {
    vi.useFakeTimers();
    await commitExtensionPresentationHome({
      extensionId: "pi-subagents",
      family: "widget",
      home: { kind: "dock", group: "primary", order: 0 },
      message: "Subagents Widget now opens in Extensions Dock",
    });
    render(<ChatPage />);
    expect(document.querySelector("[data-extension-ui-undo]")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(EXTENSION_UI_UNDO_TOAST_MS);
    });
    expect(document.querySelector("[data-extension-ui-undo]")).toBeNull();
    expect(getExtensionUiUndo()).toBeNull();
    expect(
      useAppStore.getState().desktopSettings?.extensionUi?.presentations["pi-subagents"]?.widget
        ?.home,
    ).toMatchObject({ kind: "dock", group: "primary", order: 0 });
  });

  it("replaces live float content on session switch without loading a layout", () => {
    useAppStore.getState().setDesktopSettings({
      ...BASE_SETTINGS,
      extensionUi: {
        ...DEFAULT_EXTENSION_UI_SETTINGS,
        presentations: {
          "pi-subagents": {
            widget: {
              home: { kind: "float", rect: { x: 0.7, y: 0.1, width: 300, height: 180 } },
            },
          },
        },
      },
    });
    mountWidget();
    render(<ChatPage />);
    expect(screen.getByRole("dialog", { name: "pi-subagents Widget" })).toBeInTheDocument();

    act(() => {
      useAppStore.getState().applySessionSnapshot(session("s2"));
    });

    expect(screen.queryByRole("dialog", { name: "pi-subagents Widget" })).not.toBeInTheDocument();
    expect(
      useAppStore.getState().desktopSettings?.extensionUi?.presentations["pi-subagents"]?.widget
        ?.home,
    ).toMatchObject({ kind: "float", rect: { x: 0.7, y: 0.1 } });
    expect(document.querySelector("[data-chat-page]")).toBeInTheDocument();
  });

  it("hides Extension floats while Settings is open", () => {
    useAppStore.getState().setDesktopSettings({
      ...BASE_SETTINGS,
      extensionUi: {
        ...DEFAULT_EXTENSION_UI_SETTINGS,
        presentations: {
          "pi-subagents": {
            widget: {
              home: { kind: "float", rect: { x: 0.7, y: 0.1, width: 300, height: 180 } },
            },
          },
        },
      },
    });
    mountWidget();
    render(<ChatPage />);
    expect(document.querySelector("[data-extension-float-layer]")).toBeInTheDocument();
    act(() => {
      useAppStore.getState().setPage("settings");
    });
    expect(document.querySelector("[data-extension-float-layer]")).toBeNull();
  });

  it("does not remount builtin chat chrome when only Extension content changes", () => {
    render(<ChatPage />);
    const page = document.querySelector("[data-chat-page]");
    act(() => {
      mountWidget({ placement: "aboveEditor" });
    });
    expect(document.querySelector("[data-chat-page]")).toBe(page);
    expect(document.querySelector("[data-extension-anchor='aboveComposer']")).toBeInTheDocument();
  });
});
