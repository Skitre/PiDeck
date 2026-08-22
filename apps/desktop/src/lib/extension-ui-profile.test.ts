import { DEFAULT_EXTENSION_UI_SETTINGS } from "@pideck/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "./stores/app-store";
import {
  clearExtensionUiUndo,
  commitExtensionPresentationHome,
  forgetExtensionUiIdentity,
  getExtensionUiUndo,
  undoExtensionUiSettings,
  withFamilyHome,
} from "./extension-ui-profile";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  isTauri: mocks.isTauri,
}));

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.isTauri.mockReset();
  mocks.isTauri.mockReturnValue(false);
  clearExtensionUiUndo();
  useAppStore.getState().setDesktopSettings({
    theme: "dark",
    restoreLastSession: true,
    autoRestartHostOnce: true,
    extensionDecisionPresentation: "auto",
    terminalProfile: "auto",
    extensionUi: DEFAULT_EXTENSION_UI_SETTINGS,
  });
});

describe("extension UI profile writes", () => {
  it("edits one family without moving another family from the same Extension", () => {
    const current = {
      ...DEFAULT_EXTENSION_UI_SETTINGS,
      presentations: {
        "pi-subagents": {
          widget: { home: { kind: "followExtension" as const } },
          status: { home: { kind: "anchor" as const, slot: "aboveComposer" as const } },
        },
      },
    };
    expect(
      withFamilyHome(current, "pi-subagents", "widget", {
        kind: "dock",
        group: "primary",
        order: 1,
      }).presentations["pi-subagents"],
    ).toEqual({
      widget: { home: { kind: "dock", group: "primary", order: 1 } },
      status: { home: { kind: "anchor", slot: "aboveComposer" } },
    });
  });

  it("persists a completed home change and restores it through Undo", async () => {
    await commitExtensionPresentationHome({
      extensionId: "pi-subagents",
      family: "widget",
      home: { kind: "dock", group: "primary", order: 0 },
      message: "pi-subagents Widget now opens in Extensions Dock",
    });
    expect(
      useAppStore.getState().desktopSettings?.extensionUi?.presentations["pi-subagents"],
    ).toEqual({
      widget: { home: { kind: "dock", group: "primary", order: 0 } },
    });
    expect(getExtensionUiUndo()?.message).toBe("pi-subagents Widget now opens in Extensions Dock");

    await undoExtensionUiSettings();
    expect(useAppStore.getState().desktopSettings?.extensionUi).toEqual(
      DEFAULT_EXTENSION_UI_SETTINGS,
    );
    expect(getExtensionUiUndo()).toBeNull();
  });

  it("forgets one Extension profile and its observed capability row", () => {
    const current = {
      ...DEFAULT_EXTENSION_UI_SETTINGS,
      presentations: {
        "pi-subagents": {
          widget: { home: { kind: "hidden" as const } },
        },
        "pi-review": {
          status: { home: { kind: "anchor" as const, slot: "aboveComposer" as const } },
        },
      },
      observedCapabilities: {
        "pi-subagents": { families: ["widget" as const], lastSeenAt: 10 },
        "pi-review": { families: ["status" as const], lastSeenAt: 11 },
      },
    };
    expect(forgetExtensionUiIdentity(current, "pi-subagents")).toEqual({
      ...DEFAULT_EXTENSION_UI_SETTINGS,
      presentations: {
        "pi-review": {
          status: { home: { kind: "anchor", slot: "aboveComposer" } },
        },
      },
      observedCapabilities: {
        "pi-review": { families: ["status"], lastSeenAt: 11 },
      },
    });
  });
});
