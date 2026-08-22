import { DEFAULT_EXTENSION_UI_SETTINGS } from "@pideck/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostClient } from "./bridge/host-client";
import {
  cancelExtensionTerminal,
  forceCloseExtensionTerminal,
} from "../features/dock/ExtensionTerminal";
import { resetExtensionDeckV1GateForTests } from "./extension-deck-gate";
import {
  clearExtensionTerminal,
  pushExtensionTerminalFrame,
  subscribeExtensionTerminal,
} from "./chat/extension-terminal-bus";
import { liveExtensionPresentationSlots } from "./extension-ui-live-slots";
import { useAppStore } from "./stores/app-store";

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

const floatSettings = {
  theme: "system" as const,
  language: "en" as const,
  restoreLastSession: true,
  autoRestartHostOnce: true,
  extensionDecisionPresentation: "auto" as const,
  terminalProfile: "auto" as const,
  extensionUi: {
    ...DEFAULT_EXTENSION_UI_SETTINGS,
    presentations: {
      "pi-subagents": {
        custom: {
          home: { kind: "float" as const, rect: { x: 0.2, y: 0.2, width: 300, height: 180 } },
        },
      },
    },
  },
};

describe.each([true, false])("custom() request lifecycle (extension-deck-v1=%s)", (gateOn) => {
  beforeEach(() => {
    resetExtensionDeckV1GateForTests(gateOn);
    clearExtensionTerminal("req-1");
    useAppStore.setState({
      dockOpen: false,
      extensionTerminal: null,
      desktopSettings: floatSettings,
    });
  });

  afterEach(() => {
    resetExtensionDeckV1GateForTests();
    clearExtensionTerminal("req-1");
    vi.restoreAllMocks();
  });

  it("keeps start/frame/input/resize/close on requestId and preserves the profile", async () => {
    const request = vi.spyOn(hostClient, "request").mockResolvedValue({
      ok: true,
      result: { accepted: true },
    } as never);

    useAppStore.getState().openExtensionTerminal({
      requestId: "req-1",
      title: "Inspector",
      cols: 80,
      rows: 24,
      origin: trusted,
      overlay: false,
      context,
    });

    const panel = useAppStore.getState().extensionTerminal;
    expect(panel?.requestId).toBe("req-1");
    expect(useAppStore.getState().dockOpen).toBe(!gateOn);
    expect(
      liveExtensionPresentationSlots().some((slot) =>
        slot.mounts.some((mount) => mount.custom?.requestId === "req-1"),
      ),
    ).toBe(true);

    const frames: string[] = [];
    const unsubscribe = subscribeExtensionTerminal("req-1", (chunk) => frames.push(chunk));
    pushExtensionTerminalFrame("req-1", "hello");
    expect(frames).toEqual(["hello"]);
    unsubscribe();

    await expect(cancelExtensionTerminal(panel!)).resolves.toBeNull();
    expect(request).toHaveBeenCalledWith("extensionUi.customInput", context, {
      requestId: "req-1",
      data: "\u001b",
    });

    await expect(forceCloseExtensionTerminal(panel!)).resolves.toBeNull();
    expect(request).toHaveBeenCalledWith("extensionUi.respond", context, {
      requestId: "req-1",
      status: "cancelled",
    });

    useAppStore.getState().closeExtensionTerminal("req-1");
    expect(useAppStore.getState().extensionTerminal).toBeNull();
    expect(
      useAppStore.getState().desktopSettings?.extensionUi?.presentations["pi-subagents"]?.custom
        ?.home.kind,
    ).toBe("float");
  });
});
