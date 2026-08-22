/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DEFAULT_EXTENSION_UI_SETTINGS } from "@pideck/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../lib/stores/app-store";
import { resetExtensionDeckV1GateForTests } from "../../lib/extension-deck-gate";
import { RightDock } from "../../components/RightDock";

const trusted = {
  invocationKind: "command" as const,
  extensionId: "pi-subagents",
  extensionDisplayName: "Subagents",
  sourceKind: "package" as const,
  commandName: "fleet",
};

const context = {
  expectedHostInstanceId: "h1",
  expectedWorkspaceId: "w1",
  expectedWorkspaceRevision: 1,
  expectedSessionId: "s1",
  expectedSessionRevision: 1,
};

vi.mock("../../features/dock/ExtensionTerminal", () => ({
  ExtensionTerminal: ({ visible = true }: { visible?: boolean }) => (
    <div data-testid="extension-terminal" hidden={!visible} />
  ),
  cancelExtensionTerminal: vi.fn(async () => null),
  forceCloseExtensionTerminal: vi.fn(async () => null),
}));

vi.mock("../../features/dock/ShellTerminal", () => ({
  ShellTerminal: () => null,
  shellTerminalLabel: (cwd: string) => cwd,
}));

vi.mock("../../features/dock/BrowserPanel", () => ({
  BrowserPanel: () => null,
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  globalThis.ResizeObserver = ResizeObserverStub as typeof ResizeObserver;
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: {},
    configurable: true,
  });
  useAppStore.setState({
    dockOpen: true,
    extensionTerminal: null,
    extensionWidgets: {},
    extensionStatuses: {},
    extensionStatusOrigins: {},
    desktopSettings: {
      theme: "system",
      language: "en",
      restoreLastSession: true,
      autoRestartHostOnce: true,
      extensionDecisionPresentation: "auto",
      terminalProfile: "auto",
      extensionUi: DEFAULT_EXTENSION_UI_SETTINGS,
    },
  });
});

afterEach(() => {
  cleanup();
  resetExtensionDeckV1GateForTests();
  vi.unstubAllGlobals();
});

function startCustom(overlay?: boolean) {
  useAppStore.getState().openExtensionTerminal({
    requestId: "req-1",
    title: "Inspector",
    cols: 80,
    rows: 24,
    origin: trusted,
    overlay,
    context,
  });
}

describe("RightDock extension-deck-v1", () => {
  it("uses one Extensions tab for docked custom and never mounts the legacy request tab", () => {
    resetExtensionDeckV1GateForTests(true);
    act(() => startCustom(false));
    render(<RightDock />);

    expect(screen.getByRole("tab", { name: "Extensions" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Inspector" })).not.toBeInTheDocument();
    expect(screen.getAllByTestId("extension-terminal")).toHaveLength(1);
    expect(document.querySelector("#dock-tab-extension:req-1")).toBeNull();
    expect(document.querySelector("[data-extension-dock-area]")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Close pi-subagents Custom UI" }),
    ).toBeInTheDocument();
  });

  it("closes a docked custom terminal from its slot tab", async () => {
    resetExtensionDeckV1GateForTests(true);
    const { cancelExtensionTerminal } = await import("../dock/ExtensionTerminal");
    act(() => startCustom(false));
    render(<RightDock />);

    await userEvent.click(screen.getByRole("button", { name: "Close pi-subagents Custom UI" }));
    expect(cancelExtensionTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "req-1" }),
    );
  });

  it("keeps legacy per-request tabs when the gate is off and ignores saved profiles", () => {
    resetExtensionDeckV1GateForTests(false);
    useAppStore.getState().setDesktopSettings({
      theme: "system",
      language: "en",
      restoreLastSession: true,
      autoRestartHostOnce: true,
      extensionDecisionPresentation: "auto",
      terminalProfile: "auto",
      extensionUi: {
        ...DEFAULT_EXTENSION_UI_SETTINGS,
        presentations: {
          "pi-subagents": {
            custom: { home: { kind: "float", rect: { x: 0.2, y: 0.2, width: 300, height: 180 } } },
          },
        },
      },
    });
    act(() => startCustom(false));
    render(<RightDock />);

    expect(screen.queryByRole("tab", { name: "Extensions" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Inspector" })).toBeInTheDocument();
    expect(screen.getAllByTestId("extension-terminal")).toHaveLength(1);
    expect(document.querySelector("[data-extension-dock-area]")).toBeNull();
  });

  it("shows the Extensions tab only while the current session has docked content", () => {
    resetExtensionDeckV1GateForTests(true);
    render(<RightDock />);
    expect(screen.queryByRole("tab", { name: "Extensions" })).not.toBeInTheDocument();

    act(() => {
      useAppStore.getState().setExtensionWidget({
        key: "fleet",
        widget: ["ready"],
        origin: trusted,
        hostInstanceId: "h1",
        workspaceId: "w1",
        workspaceRevision: 1,
        sessionId: "s1",
        sessionRevision: 1,
      });
      useAppStore.getState().setDesktopSettings({
        theme: "system",
        language: "en",
        restoreLastSession: true,
        autoRestartHostOnce: true,
        extensionDecisionPresentation: "auto",
        terminalProfile: "auto",
        extensionUi: {
          ...DEFAULT_EXTENSION_UI_SETTINGS,
          presentations: {
            "pi-subagents": {
              widget: { home: { kind: "dock", group: "primary", order: 0 } },
            },
          },
        },
      });
    });

    expect(screen.getByRole("tab", { name: "Extensions" })).toBeInTheDocument();
    expect(screen.getByText("ready")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Close .+ Widget/ })).not.toBeInTheDocument();

    act(() => {
      useAppStore.getState().setExtensionWidget({
        key: "fleet",
        widget: null,
        origin: trusted,
        hostInstanceId: "h1",
        workspaceId: "w1",
        workspaceRevision: 1,
        sessionId: "s1",
        sessionRevision: 1,
      });
    });

    expect(screen.queryByRole("tab", { name: "Extensions" })).not.toBeInTheDocument();
    expect(
      useAppStore.getState().desktopSettings?.extensionUi?.presentations["pi-subagents"]?.widget
        ?.home,
    ).toMatchObject({ kind: "dock" });
  });

  it("keeps builtin tabs and never places Files in an Extension group", async () => {
    resetExtensionDeckV1GateForTests(true);
    const user = (await import("@testing-library/user-event")).default.setup();
    render(<RightDock />);
    await user.click(screen.getByRole("button", { name: "Open Files" }));
    act(() => startCustom(false));

    expect(screen.getByRole("tab", { name: "Files" })).toBeInTheDocument();
    expect(
      screen.queryByRole("tab", { name: "Extensions" }) ??
        screen.getByRole("button", { name: "Extensions" }),
    ).toBeTruthy();
    expect(document.querySelector("[data-extension-dock-area]")?.textContent ?? "").not.toMatch(
      /Files/,
    );
  });

  it("keeps two groups, keyboard movement, and a secondary edge without a third group", async () => {
    resetExtensionDeckV1GateForTests(true);
    const review = {
      invocationKind: "command" as const,
      extensionId: "pi-review",
      extensionDisplayName: "Review",
      sourceKind: "package" as const,
      commandName: "review",
    };
    act(() => {
      useAppStore.getState().setDesktopSettings({
        theme: "system",
        language: "en",
        restoreLastSession: true,
        autoRestartHostOnce: true,
        extensionDecisionPresentation: "auto",
        terminalProfile: "auto",
        extensionUi: {
          ...DEFAULT_EXTENSION_UI_SETTINGS,
          presentations: {
            "pi-subagents": {
              widget: { home: { kind: "dock", group: "primary", order: 0 } },
            },
            "pi-review": {
              widget: { home: { kind: "dock", group: "primary", order: 1 } },
            },
          },
        },
      });
      useAppStore.getState().setExtensionWidget({
        key: "fleet",
        widget: ["fleet-ready"],
        origin: trusted,
        hostInstanceId: "h1",
        workspaceId: "w1",
        workspaceRevision: 1,
        sessionId: "s1",
        sessionRevision: 1,
      });
      useAppStore.getState().setExtensionWidget({
        key: "review",
        widget: ["review-ready"],
        origin: review,
        hostInstanceId: "h1",
        workspaceId: "w1",
        workspaceRevision: 1,
        sessionId: "s1",
        sessionRevision: 1,
      });
    });
    const user = (await import("@testing-library/user-event")).default.setup();
    render(<RightDock />);

    const firstTab = screen.getByRole("tab", { name: "pi-subagents Widget" });
    const secondTab = screen.getByRole("tab", { name: "pi-review Widget" });
    expect(document.querySelectorAll("[data-extension-dock-group]")).toHaveLength(1);
    expect(document.querySelector("[data-extension-dock-edge='secondary']")).toBeInTheDocument();

    firstTab.focus();
    await user.keyboard("{ArrowRight}");
    expect(secondTab).toHaveAttribute("aria-selected", "true");

    const transfer = {
      data: {} as Record<string, string>,
      setData(type: string, value: string) {
        this.data[type] = value;
      },
      getData(type: string) {
        return this.data[type] ?? "";
      },
    };
    const panel = document.querySelector('[data-extension-slot="pi-review:widget"]');
    const edge = document.querySelector("[data-extension-dock-edge='secondary']");
    expect(panel).toBeTruthy();
    expect(edge).toBeTruthy();
    fireEvent.dragStart(panel!, { dataTransfer: transfer });
    fireEvent.drop(edge!, { dataTransfer: transfer });

    await waitFor(() => {
      expect(document.querySelectorAll("[data-extension-dock-group]")).toHaveLength(2);
    });
    expect(document.querySelector("[data-extension-dock-edge='secondary']")).toBeNull();
    expect(
      useAppStore.getState().desktopSettings?.extensionUi?.presentations["pi-review"]?.widget?.home,
    ).toMatchObject({ kind: "dock", group: "secondary" });
  });

  it("closes custom content without deleting the global profile", () => {
    resetExtensionDeckV1GateForTests(true);
    useAppStore.getState().setDesktopSettings({
      theme: "system",
      language: "en",
      restoreLastSession: true,
      autoRestartHostOnce: true,
      extensionDecisionPresentation: "auto",
      terminalProfile: "auto",
      extensionUi: {
        ...DEFAULT_EXTENSION_UI_SETTINGS,
        presentations: {
          "pi-subagents": {
            custom: { home: { kind: "dock", group: "primary", order: 0 } },
          },
        },
      },
    });
    act(() => startCustom(false));
    render(<RightDock />);
    expect(screen.getByRole("tab", { name: "Extensions" })).toBeInTheDocument();

    act(() => {
      useAppStore.getState().closeExtensionTerminal("req-1");
    });
    expect(screen.queryByRole("tab", { name: "Extensions" })).not.toBeInTheDocument();
    expect(
      useAppStore.getState().desktopSettings?.extensionUi?.presentations["pi-subagents"]?.custom
        ?.home,
    ).toMatchObject({ kind: "dock", group: "primary" });
  });

  it("does not rewrite builtin dock preferences when rolling back to legacy tabs", async () => {
    resetExtensionDeckV1GateForTests(true);
    const user = (await import("@testing-library/user-event")).default.setup();
    const view = render(<RightDock />);
    await user.click(screen.getByRole("button", { name: "Open Files" }));
    expect(screen.getByRole("tab", { name: "Files" })).toBeInTheDocument();
    expect(useAppStore.getState().dockOpen).toBe(true);
    view.unmount();

    resetExtensionDeckV1GateForTests(false);
    useAppStore.getState().setDesktopSettings({
      theme: "system",
      language: "en",
      restoreLastSession: true,
      autoRestartHostOnce: true,
      extensionDecisionPresentation: "auto",
      terminalProfile: "auto",
      extensionUi: {
        ...DEFAULT_EXTENSION_UI_SETTINGS,
        presentations: {
          "pi-subagents": {
            custom: { home: { kind: "float", rect: { x: 0.2, y: 0.2, width: 300, height: 180 } } },
          },
        },
      },
    });
    act(() => startCustom(false));
    render(<RightDock />);
    expect(useAppStore.getState().dockOpen).toBe(true);
    expect(screen.getByRole("tab", { name: "Inspector" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Extensions" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "New dock page" }));
    expect(screen.getByRole("menuitem", { name: "Files" })).toBeInTheDocument();
    expect(
      useAppStore.getState().desktopSettings?.extensionUi?.presentations["pi-subagents"]?.custom
        ?.home.kind,
    ).toBe("float");
  });
});
