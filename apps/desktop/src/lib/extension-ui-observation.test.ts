import { DEFAULT_EXTENSION_UI_SETTINGS } from "@pideck/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "./stores/app-store";
import {
  observeExtensionUiFamily,
  observeExtensionUiHostEvent,
  observedExtensionDisplayName,
  observedFamilyFromHostEvent,
  resetObservedExtensionDisplayNames,
} from "./extension-ui-observation";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  isTauri: mocks.isTauri,
}));

const trustedOrigin = {
  invocationKind: "tool" as const,
  extensionId: "ext_review",
  extensionDisplayName: "Review",
  sourceKind: "package" as const,
  toolName: "ask",
  toolCallId: "call-1",
};

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.isTauri.mockReset();
  mocks.isTauri.mockReturnValue(false);
  resetObservedExtensionDisplayNames();
  useAppStore.getState().setDesktopSettings({
    theme: "dark",
    restoreLastSession: true,
    autoRestartHostOnce: true,
    extensionDecisionPresentation: "auto",
    terminalProfile: "auto",
    extensionUi: DEFAULT_EXTENSION_UI_SETTINGS,
  });
  useAppStore.getState().clearNotifications();
});

describe("observedFamilyFromHostEvent", () => {
  it("maps only the four presentation families and ignores chrome events", () => {
    expect(
      observedFamilyFromHostEvent("extensionUi.widgetChanged", { key: "fleet", widget: ["row"] }),
    ).toBe("widget");
    expect(
      observedFamilyFromHostEvent("extensionUi.widgetChanged", { key: "fleet", widget: null }),
    ).toBeNull();
    expect(observedFamilyFromHostEvent("extensionUi.statusChanged", { text: "ready" })).toBe(
      "status",
    );
    expect(observedFamilyFromHostEvent("extensionUi.statusChanged", { text: "" })).toBeNull();
    expect(
      observedFamilyFromHostEvent("extensionUi.customStarted", {
        requestId: "00000000-0000-4000-8000-000000000005",
        cols: 80,
        rows: 24,
      }),
    ).toBe("custom");
    expect(
      observedFamilyFromHostEvent("extensionUi.request", {
        requestId: "00000000-0000-4000-8000-000000000005",
        kind: "confirm",
      }),
    ).toBe("blockingDialog");
    expect(
      observedFamilyFromHostEvent("extensionUi.notification", { message: "hi", level: "info" }),
    ).toBeNull();
    expect(
      observedFamilyFromHostEvent("extensionUi.messageRendered", {
        entryId: "e1",
        render: null,
      }),
    ).toBeNull();
    expect(
      observedFamilyFromHostEvent("extensionUi.customClosed", {
        requestId: "00000000-0000-4000-8000-000000000005",
      }),
    ).toBeNull();
  });
});

describe("observeExtensionUiFamily", () => {
  it("writes only the first trusted Extension/family pair and keeps clears", async () => {
    expect(await observeExtensionUiFamily({ invocationKind: "unknown" }, "widget")).toBe(false);
    expect(await observeExtensionUiFamily(undefined, "widget")).toBe(false);
    expect(useAppStore.getState().desktopSettings?.extensionUi).toEqual(
      DEFAULT_EXTENSION_UI_SETTINGS,
    );

    expect(await observeExtensionUiFamily(trustedOrigin, "widget", 100)).toBe(true);
    expect(observedExtensionDisplayName("ext_review")).toBe("Review");
    const afterFirst = useAppStore.getState().desktopSettings?.extensionUi;
    expect(afterFirst?.observedCapabilities.ext_review).toEqual({
      families: ["widget"],
      lastSeenAt: 100,
      displayName: "Review",
    });

    expect(await observeExtensionUiFamily(trustedOrigin, "widget", 200)).toBe(false);
    expect(useAppStore.getState().desktopSettings?.extensionUi).toEqual(afterFirst);

    expect(await observeExtensionUiFamily(trustedOrigin, "status", 300)).toBe(true);
    expect(
      useAppStore.getState().desktopSettings?.extensionUi?.observedCapabilities.ext_review,
    ).toEqual({
      families: ["widget", "status"],
      lastSeenAt: 300,
      displayName: "Review",
    });
  });

  it("keeps the persisted display name after a memory-only restart and fills a missing name", async () => {
    expect(await observeExtensionUiFamily(trustedOrigin, "widget", 100)).toBe(true);
    resetObservedExtensionDisplayNames();
    expect(observedExtensionDisplayName("ext_review")).toBe("Review");

    useAppStore.getState().setDesktopSettings({
      theme: "dark",
      restoreLastSession: true,
      autoRestartHostOnce: true,
      extensionDecisionPresentation: "auto",
      terminalProfile: "auto",
      extensionUi: {
        ...DEFAULT_EXTENSION_UI_SETTINGS,
        observedCapabilities: {
          ext_review: { families: ["widget"], lastSeenAt: 100 },
        },
      },
    });
    resetObservedExtensionDisplayNames();
    expect(observedExtensionDisplayName("ext_review")).toBe("ext_review");
    expect(await observeExtensionUiFamily(trustedOrigin, "widget", 400)).toBe(true);
    expect(
      useAppStore.getState().desktopSettings?.extensionUi?.observedCapabilities.ext_review,
    ).toEqual({
      families: ["widget"],
      lastSeenAt: 100,
      displayName: "Review",
    });
    resetObservedExtensionDisplayNames();
    expect(observedExtensionDisplayName("ext_review")).toBe("Review");
  });

  it("does not write again for replayed host events", async () => {
    mocks.isTauri.mockReturnValue(true);
    mocks.invoke.mockImplementation(
      async (_command: string, args: { patch?: { extensionUi?: unknown } }) => ({
        theme: "dark",
        restoreLastSession: true,
        autoRestartHostOnce: true,
        extensionDecisionPresentation: "auto",
        terminalProfile: "auto",
        extensionUi: args.patch?.extensionUi,
      }),
    );

    observeExtensionUiHostEvent("extensionUi.widgetChanged", {
      key: "fleet",
      widget: ["row"],
      origin: trustedOrigin,
    });
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
    observeExtensionUiHostEvent("extensionUi.widgetChanged", {
      key: "fleet",
      widget: ["row"],
      origin: trustedOrigin,
    });
    observeExtensionUiHostEvent("extensionUi.widgetChanged", {
      key: "fleet",
      widget: null,
      origin: trustedOrigin,
    });
    await Promise.resolve();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(
      useAppStore.getState().desktopSettings?.extensionUi?.observedCapabilities.ext_review
        ?.families,
    ).toEqual(["widget"]);
  });
});
