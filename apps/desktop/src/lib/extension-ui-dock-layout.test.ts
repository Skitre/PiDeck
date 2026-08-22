import { DEFAULT_EXTENSION_UI_SETTINGS } from "@pideck/protocol";
import { describe, expect, it } from "vitest";
import { buildExtensionPresentationSlots } from "./extension-ui-slots";
import {
  collectDockedPresentationSlots,
  hasLiveDockedExtensionContent,
  partitionExtensionDockGroups,
} from "./extension-ui-dock-layout";

const trusted = {
  invocationKind: "command" as const,
  extensionId: "pi-subagents",
  extensionDisplayName: "Subagents",
  sourceKind: "package" as const,
  commandName: "fleet",
};

describe("extension dock layout", () => {
  it("never includes builtin surfaces and caps at two groups", () => {
    const slots = buildExtensionPresentationSlots({
      settings: {
        ...DEFAULT_EXTENSION_UI_SETTINGS,
        presentations: {
          "pi-subagents": {
            widget: { home: { kind: "dock", group: "primary", order: 1 } },
            status: { home: { kind: "dock", group: "secondary", order: 0 } },
          },
        },
      },
      widgets: [{ key: "fleet", widget: ["a"], origin: trusted }],
      statuses: [{ key: "fleet", text: "ready", origin: trusted }],
    });
    const docked = collectDockedPresentationSlots(slots);
    expect(docked.every((item) => item.family === "widget" || item.family === "status")).toBe(true);
    const groups = partitionExtensionDockGroups(docked);
    expect(groups.primary).toHaveLength(1);
    expect(groups.secondary).toHaveLength(1);
    expect(groups.primary[0]?.family).toBe("widget");
    expect(groups.secondary[0]?.family).toBe("status");
  });

  it("promotes secondary to primary when primary is empty", () => {
    const slots = buildExtensionPresentationSlots({
      settings: {
        ...DEFAULT_EXTENSION_UI_SETTINGS,
        presentations: {
          "pi-subagents": {
            custom: { home: { kind: "dock", group: "secondary", order: 0 } },
          },
        },
      },
      widgets: [],
      statuses: [],
      custom: { requestId: "r1", origin: trusted },
    });
    const groups = partitionExtensionDockGroups(collectDockedPresentationSlots(slots));
    expect(groups.primary).toHaveLength(1);
    expect(groups.secondary).toHaveLength(0);
    expect(groups.primary[0]?.family).toBe("custom");
  });

  it("reports no live docked content when only floats or anchors exist", () => {
    const slots = buildExtensionPresentationSlots({
      settings: DEFAULT_EXTENSION_UI_SETTINGS,
      widgets: [{ key: "fleet", widget: ["a"], origin: trusted }],
      statuses: [],
    });
    expect(hasLiveDockedExtensionContent(slots)).toBe(false);
  });
});
