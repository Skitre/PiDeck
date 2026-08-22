import { DEFAULT_EXTENSION_UI_SETTINGS, MAX_EXTENSION_UI_FLOATS } from "@pideck/protocol";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CUSTOM_FLOAT_RECT,
  applyLiveFloatCap,
  defaultHomeForFamily,
  resolveExtensionPresentation,
} from "./extension-ui-resolver";

const empty = DEFAULT_EXTENSION_UI_SETTINGS;

function settingsWithHome(
  extensionId: string,
  family: "widget" | "status" | "custom" | "blockingDialog",
  home: Parameters<typeof resolveExtensionPresentation>[0] extends never
    ? never
    : import("@pideck/protocol").PresentationHome,
) {
  return {
    ...empty,
    presentations: {
      [extensionId]: {
        [family]: { home },
      },
    },
  };
}

describe("resolveExtensionPresentation", () => {
  it("defaults widget to above composer and honors belowEditor hints", () => {
    expect(resolveExtensionPresentation({ family: "widget", settings: empty })).toEqual({
      home: { kind: "anchor", slot: "aboveComposer" },
      source: "default",
    });
    expect(
      resolveExtensionPresentation({
        family: "widget",
        settings: empty,
        hint: { placement: "belowEditor" },
      }),
    ).toEqual({
      home: { kind: "anchor", slot: "belowComposer" },
      source: "hint",
    });
  });

  it("defaults status to above composer and rejects float/below as saved homes", () => {
    expect(resolveExtensionPresentation({ family: "status", settings: empty })).toEqual({
      home: { kind: "anchor", slot: "aboveComposer" },
      source: "default",
    });
    expect(
      resolveExtensionPresentation({
        family: "status",
        settings: settingsWithHome("ext", "status", {
          kind: "float",
          rect: { x: 0.1, y: 0.1, width: 200, height: 120 },
        }),
        extensionId: "ext",
      }),
    ).toEqual({
      home: { kind: "anchor", slot: "aboveComposer" },
      source: "default",
    });
    expect(
      resolveExtensionPresentation({
        family: "status",
        settings: settingsWithHome("ext", "status", {
          kind: "anchor",
          slot: "belowComposer",
        }),
        extensionId: "ext",
      }),
    ).toEqual({
      home: { kind: "anchor", slot: "aboveComposer" },
      source: "default",
    });
  });

  it("defaults custom overlay true to a centered float and absent/false to dock", () => {
    expect(
      resolveExtensionPresentation({
        family: "custom",
        settings: empty,
        hint: { overlay: true },
      }),
    ).toEqual({
      home: { kind: "float", rect: DEFAULT_CUSTOM_FLOAT_RECT },
      source: "hint",
    });
    expect(
      resolveExtensionPresentation({
        family: "custom",
        settings: empty,
        hint: { overlay: false },
      }),
    ).toEqual({
      home: { kind: "dock", group: "primary", order: 0 },
      source: "default",
    });
  });

  it("uses a valid saved profile and treats followExtension as a hint", () => {
    expect(
      resolveExtensionPresentation({
        family: "widget",
        settings: settingsWithHome("pi-subagents", "widget", {
          kind: "float",
          rect: { x: 0.8, y: 0.1, width: 320, height: 200 },
          pinned: true,
        }),
        extensionId: "pi-subagents",
        hint: { placement: "belowEditor" },
      }),
    ).toEqual({
      home: {
        kind: "float",
        rect: { x: 0.8, y: 0.1, width: 320, height: 200 },
        pinned: true,
      },
      source: "profile",
    });
    expect(
      resolveExtensionPresentation({
        family: "widget",
        settings: settingsWithHome("pi-subagents", "widget", { kind: "followExtension" }),
        extensionId: "pi-subagents",
        hint: { placement: "belowEditor" },
      }),
    ).toEqual({
      home: { kind: "anchor", slot: "belowComposer" },
      source: "hint",
    });
  });

  it("does not create a profile-backed resolution for unknown origin", () => {
    const settings = settingsWithHome("pi-subagents", "widget", {
      kind: "dock",
      group: "primary",
      order: 2,
    });
    expect(
      resolveExtensionPresentation({
        family: "widget",
        settings,
        hint: { placement: "aboveEditor" },
      }),
    ).toEqual({
      home: { kind: "anchor", slot: "aboveComposer" },
      source: "hint",
    });
  });

  it("falls a ninth live float through to dock primary", () => {
    const home = defaultHomeForFamily("custom", { overlay: true });
    expect(applyLiveFloatCap(home, MAX_EXTENSION_UI_FLOATS - 1)).toEqual(home);
    expect(applyLiveFloatCap(home, MAX_EXTENSION_UI_FLOATS)).toEqual({
      kind: "dock",
      group: "primary",
      order: 0,
    });
    expect(
      resolveExtensionPresentation({
        family: "custom",
        settings: empty,
        hint: { overlay: true },
        otherLiveFloatCount: MAX_EXTENSION_UI_FLOATS,
      }).home,
    ).toEqual({ kind: "dock", group: "primary", order: 0 });
  });

  it("does not resolve blocking dialogs into deck homes", () => {
    expect(
      resolveExtensionPresentation({
        family: "blockingDialog",
        settings: settingsWithHome("ext", "blockingDialog", { kind: "inline" }),
        extensionId: "ext",
      }),
    ).toEqual({
      home: { kind: "inline" },
      source: "profile",
    });
    expect(defaultHomeForFamily("blockingDialog")).toEqual({ kind: "followHost" });
  });
});
