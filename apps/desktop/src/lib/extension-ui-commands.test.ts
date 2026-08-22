/** @vitest-environment jsdom */

import { DEFAULT_EXTENSION_UI_SETTINGS } from "@pideck/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetExtensionDeckV1GateForTests } from "./extension-deck-gate";
import {
  activateAdjacentExtensionDockTab,
  canMoveFocusedExtensionSlot,
  focusAdjacentExtensionFloat,
  hasExtensionDockSplit,
  moveFocusedExtensionSlot,
  resetFocusedExtensionFamily,
  resizeExtensionDockSplit,
} from "./extension-ui-commands";
import { clearExtensionUiUndo } from "./extension-ui-profile";
import { useAppStore } from "./stores/app-store";

const trusted = {
  invocationKind: "command" as const,
  extensionId: "pi-subagents",
  extensionDisplayName: "Subagents",
  sourceKind: "package" as const,
  commandName: "fleet",
};

function baseSettings() {
  return {
    theme: "system" as const,
    language: "en" as const,
    restoreLastSession: true,
    autoRestartHostOnce: true,
    extensionDecisionPresentation: "auto" as const,
    terminalProfile: "auto" as const,
    extensionUi: DEFAULT_EXTENSION_UI_SETTINGS,
  };
}

function mountWidget(home?: { kind: "dock"; group: "primary" | "secondary"; order: number }) {
  useAppStore.getState().setDesktopSettings({
    ...baseSettings(),
    extensionUi: {
      ...DEFAULT_EXTENSION_UI_SETTINGS,
      presentations: home ? { "pi-subagents": { widget: { home } } } : {},
    },
  });
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
}

beforeEach(() => {
  resetExtensionDeckV1GateForTests(true);
  clearExtensionUiUndo();
  useAppStore.setState({
    page: "chat",
    extensionWidgets: {},
    extensionStatuses: {},
    extensionStatusOrigins: {},
    extensionTerminal: null,
    desktopSettings: baseSettings(),
  });
});

afterEach(() => {
  document.body.innerHTML = "";
  resetExtensionDeckV1GateForTests();
});

describe("extension UI commands", () => {
  it("moves a focused widget to Dock and refuses an illegal custom anchor home", async () => {
    mountWidget();
    const slot = document.createElement("button");
    slot.dataset.extensionSlot = "pi-subagents:widget";
    document.body.append(slot);
    slot.focus();
    expect(canMoveFocusedExtensionSlot()).toBe(true);

    expect(await moveFocusedExtensionSlot("dockPrimary")).toBe(true);
    expect(
      useAppStore.getState().desktopSettings?.extensionUi?.presentations["pi-subagents"]?.widget
        ?.home,
    ).toMatchObject({ kind: "dock", group: "primary" });

    useAppStore.getState().openExtensionTerminal({
      requestId: "req-1",
      title: "Inspector",
      cols: 80,
      rows: 24,
      origin: trusted,
      context: {
        expectedHostInstanceId: "h1",
        expectedWorkspaceId: "w1",
        expectedWorkspaceRevision: 1,
        expectedSessionId: "s1",
        expectedSessionRevision: 1,
      },
    });
    slot.dataset.extensionSlot = "pi-subagents:custom";
    slot.focus();
    expect(await moveFocusedExtensionSlot("aboveComposer")).toBe(false);
  });

  it("cycles float focus and dock tabs, then resets the focused family", async () => {
    mountWidget({ kind: "dock", group: "primary", order: 0 });
    const first = document.createElement("div");
    first.dataset.extensionFloat = "pi-review:widget";
    first.tabIndex = -1;
    const second = document.createElement("div");
    second.dataset.extensionFloat = "pi-subagents:widget";
    second.tabIndex = -1;
    document.body.append(first, second);
    first.focus();
    expect(focusAdjacentExtensionFloat(1)).toBe(true);
    expect(document.activeElement).toBe(second);

    const group = document.createElement("div");
    group.dataset.extensionDockGroup = "primary";
    const tabA = document.createElement("button");
    tabA.dataset.extensionSlotTab = "pi-subagents:widget";
    tabA.setAttribute("aria-selected", "true");
    const tabB = document.createElement("button");
    tabB.dataset.extensionSlotTab = "pi-review:widget";
    tabB.setAttribute("aria-selected", "false");
    let clicked = "";
    tabB.addEventListener("click", () => {
      clicked = "pi-review:widget";
    });
    group.append(tabA, tabB);
    document.body.append(group);
    tabA.focus();
    expect(activateAdjacentExtensionDockTab(1)).toBe(true);
    expect(clicked).toBe("pi-review:widget");

    tabA.focus();
    expect(await resetFocusedExtensionFamily()).toBe(true);
    expect(
      useAppStore.getState().desktopSettings?.extensionUi?.presentations["pi-subagents"]?.widget,
    ).toBeUndefined();
  });

  it("resizes a live two-group Dock split", async () => {
    const review = {
      invocationKind: "command" as const,
      extensionId: "pi-review",
      extensionDisplayName: "Review",
      sourceKind: "package" as const,
      commandName: "review",
    };
    useAppStore.getState().setDesktopSettings({
      ...baseSettings(),
      extensionUi: {
        ...DEFAULT_EXTENSION_UI_SETTINGS,
        dock: { direction: "row", secondaryEnabled: true, sizes: [0.5, 0.5] },
        presentations: {
          "pi-subagents": { widget: { home: { kind: "dock", group: "primary", order: 0 } } },
          "pi-review": { widget: { home: { kind: "dock", group: "secondary", order: 0 } } },
        },
      },
    });
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
    useAppStore.getState().setExtensionWidget({
      key: "review",
      widget: ["review"],
      origin: review,
      hostInstanceId: "h1",
      workspaceId: "w1",
      workspaceRevision: 1,
      sessionId: "s1",
      sessionRevision: 1,
    });
    expect(hasExtensionDockSplit()).toBe(true);
    expect(await resizeExtensionDockSplit(0.1)).toBe(true);
    expect(useAppStore.getState().desktopSettings?.extensionUi?.dock.sizes).toEqual([0.6, 0.4]);
  });
});
