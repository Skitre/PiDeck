import { DEFAULT_EXTENSION_UI_SETTINGS, MAX_EXTENSION_UI_FLOATS } from "@pideck/protocol";
import { describe, expect, it } from "vitest";
import { DEFAULT_CUSTOM_FLOAT_RECT } from "./extension-ui-resolver";
import { buildExtensionPresentationSlots, countLiveFloatMounts } from "./extension-ui-slots";

const trusted = {
  invocationKind: "command" as const,
  extensionId: "pi-subagents",
  extensionDisplayName: "Subagents",
  sourceKind: "package" as const,
  commandName: "fleet",
};

const other = {
  ...trusted,
  extensionId: "ext-other",
  extensionDisplayName: "Other",
};

describe("buildExtensionPresentationSlots", () => {
  it("aggregates trusted widget keys into one family slot and splits follow-extension anchors", () => {
    const slots = buildExtensionPresentationSlots({
      settings: DEFAULT_EXTENSION_UI_SETTINGS,
      widgets: [
        { key: "fleet", widget: ["a"], placement: "aboveEditor", origin: trusted },
        { key: "inspector", widget: ["b"], placement: "belowEditor", origin: trusted },
      ],
      statuses: [],
    });
    expect(slots).toHaveLength(1);
    expect(slots[0]?.slotId).toBe("pi-subagents:widget");
    expect(slots[0]?.mounts.map((mount) => mount.home)).toEqual([
      { kind: "anchor", slot: "aboveComposer" },
      { kind: "anchor", slot: "belowComposer" },
    ]);
  });

  it("applies a forced widget home to every live key from that Extension", () => {
    const slots = buildExtensionPresentationSlots({
      settings: {
        ...DEFAULT_EXTENSION_UI_SETTINGS,
        presentations: {
          "pi-subagents": {
            widget: {
              home: { kind: "float", rect: { x: 0.7, y: 0.1, width: 300, height: 180 } },
            },
          },
        },
      },
      widgets: [
        { key: "fleet", widget: ["a"], placement: "aboveEditor", origin: trusted },
        { key: "inspector", widget: ["b"], placement: "belowEditor", origin: trusted },
      ],
      statuses: [],
    });
    expect(slots[0]?.mounts).toHaveLength(1);
    expect(slots[0]?.mounts[0]?.home.kind).toBe("float");
    expect(slots[0]?.mounts[0]?.widgets?.map((widget) => widget.key)).toEqual([
      "fleet",
      "inspector",
    ]);
  });

  it("keeps unknown-origin widgets on defaults and does not share a profile slot", () => {
    const slots = buildExtensionPresentationSlots({
      settings: {
        ...DEFAULT_EXTENSION_UI_SETTINGS,
        presentations: {
          "pi-subagents": {
            widget: { home: { kind: "dock", group: "primary", order: 1 } },
          },
        },
      },
      widgets: [{ key: "legacy", widget: ["x"], origin: { invocationKind: "unknown" } }],
      statuses: [],
    });
    expect(slots[0]?.extensionId).toBeUndefined();
    expect(slots[0]?.slotId).toBe("unknown:widget:legacy");
    expect(slots[0]?.mounts[0]?.home).toEqual({ kind: "anchor", slot: "aboveComposer" });
  });

  it("never floats status or places it below the composer", () => {
    const slots = buildExtensionPresentationSlots({
      settings: {
        ...DEFAULT_EXTENSION_UI_SETTINGS,
        presentations: {
          "pi-subagents": {
            status: {
              home: { kind: "float", rect: { x: 0.2, y: 0.2, width: 200, height: 80 } },
            },
          },
        },
      },
      widgets: [],
      statuses: [{ key: "fleet", text: "running", origin: trusted }],
    });
    expect(slots[0]?.family).toBe("status");
    expect(slots[0]?.mounts[0]?.home).toEqual({ kind: "anchor", slot: "aboveComposer" });
  });

  it("resolves custom overlay to float and absent overlay to dock", () => {
    expect(
      buildExtensionPresentationSlots({
        settings: DEFAULT_EXTENSION_UI_SETTINGS,
        widgets: [],
        statuses: [],
        custom: { requestId: "r1", overlay: true, origin: trusted },
      })[0]?.mounts[0]?.home,
    ).toEqual({ kind: "float", rect: DEFAULT_CUSTOM_FLOAT_RECT });
    expect(
      buildExtensionPresentationSlots({
        settings: DEFAULT_EXTENSION_UI_SETTINGS,
        widgets: [],
        statuses: [],
        custom: { requestId: "r1", origin: trusted },
      })[0]?.mounts[0]?.home,
    ).toEqual({ kind: "dock", group: "primary", order: 0 });
  });

  it("caps live floats at eight and leaves later slots in dock", () => {
    const presentations = Object.fromEntries(
      Array.from({ length: MAX_EXTENSION_UI_FLOATS + 1 }, (_, index) => [
        `ext-${index}`,
        {
          widget: {
            home: { kind: "float" as const, rect: { x: 0.1, y: 0.1, width: 200, height: 120 } },
          },
        },
      ]),
    );
    const slots = buildExtensionPresentationSlots({
      settings: { ...DEFAULT_EXTENSION_UI_SETTINGS, presentations },
      widgets: Array.from({ length: MAX_EXTENSION_UI_FLOATS + 1 }, (_, index) => ({
        key: `w-${index}`,
        widget: [index],
        origin: { ...other, extensionId: `ext-${index}`, extensionDisplayName: `E${index}` },
      })),
      statuses: [],
    });
    expect(countLiveFloatMounts(slots)).toBe(MAX_EXTENSION_UI_FLOATS);
    expect(slots.at(-1)?.mounts[0]?.home).toEqual({ kind: "dock", group: "primary", order: 0 });
  });
});
