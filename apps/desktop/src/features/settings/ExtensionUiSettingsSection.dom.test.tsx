/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_EXTENSION_UI_SETTINGS } from "@pideck/protocol";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import { resetObservedExtensionDisplayNames } from "../../lib/extension-ui-observation";
import { SettingsPage } from "./SettingsPage";

const CONNECTED_HOST = {
  protocolVersion: 1 as const,
  hostInstanceId: "11111111-1111-4111-8111-111111111111",
  workspaceId: null,
  workspaceRevision: 0,
  sessionId: null,
  sessionRevision: 0,
  packageRevision: 0,
  sdkVersion: "0.84.2",
  nodeVersion: "v24.18.0",
  agentDir: "/agent",
  phase: "waitingForWorkspace" as const,
  capabilities: {
    packageUpdateCheck: false,
    extensionUi: true as const,
    sessionExport: true,
  },
  modelConfigHealth: {
    state: "ok" as const,
    source: "ModelRegistry.getError" as const,
  },
  extensionDecisionPresentation: "auto" as const,
};

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriMocks.invoke,
  isTauri: tauriMocks.isTauri,
}));

const observedSettings = {
  theme: "system" as const,
  language: "en" as const,
  restoreLastSession: true,
  autoRestartHostOnce: true,
  extensionDecisionPresentation: "auto" as const,
  terminalProfile: "auto" as const,
  extensionUi: {
    version: 1 as const,
    presentations: {},
    dock: { direction: "row" as const, secondaryEnabled: false },
    observedCapabilities: {
      ext_review: {
        families: ["widget" as const, "blockingDialog" as const],
        lastSeenAt: 10,
        displayName: "Review",
      },
    },
  },
};

beforeEach(() => {
  tauriMocks.invoke.mockReset();
  tauriMocks.invoke.mockRejectedValue(new Error("Tauri unavailable"));
  tauriMocks.isTauri.mockReset();
  tauriMocks.isTauri.mockReturnValue(false);
  useAppStore.getState().setHost(CONNECTED_HOST);
  useAppStore.getState().clearNotifications();
  resetObservedExtensionDisplayNames();
  useAppStore.getState().setDesktopSettings(observedSettings);
});

afterEach(() => {
  cleanup();
  resetObservedExtensionDisplayNames();
  useAppStore.getState().setHost(null);
  useAppStore.getState().setDesktopSettings(null);
  vi.restoreAllMocks();
});

describe("Extension UI settings", () => {
  it("lists only observed families and only their legal homes", () => {
    render(<SettingsPage initialSection="extensionUi" />);

    expect(screen.getByText("Review")).toBeInTheDocument();
    expect(screen.getByLabelText("Widget Show in")).toBeInTheDocument();
    expect(screen.getByLabelText("Blocking requests Show in")).toBeInTheDocument();
    expect(screen.queryByLabelText("Status Show in")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Custom UI Show in")).not.toBeInTheDocument();

    const widgetSelect = screen.getByLabelText("Widget Show in");
    expect(
      Array.from(widgetSelect.querySelectorAll("option")).map((option) => option.value),
    ).toEqual([
      "followExtension",
      "aboveComposer",
      "belowComposer",
      "dockPrimary",
      "dockSecondary",
      "float",
      "hidden",
    ]);
    const blockingSelect = screen.getByLabelText("Blocking requests Show in");
    expect(
      Array.from(blockingSelect.querySelectorAll("option")).map((option) => option.value),
    ).toEqual(["followHost", "inline", "modal"]);
    expect(screen.getByText(/High-risk requests stay modal/)).toBeInTheDocument();
  });

  it("shows an empty hint before any family is observed", () => {
    useAppStore.getState().setDesktopSettings({
      ...observedSettings,
      extensionUi: DEFAULT_EXTENSION_UI_SETTINGS,
    });
    render(<SettingsPage initialSection="extensionUi" />);
    expect(screen.getByRole("heading", { name: "Extension UI" })).toBeInTheDocument();
    expect(
      screen.getByText(/After an Extension uses a widget, status, custom UI, or blocking request/),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Widget Show in")).not.toBeInTheDocument();
  });

  it("persists a widget home without configuring Host and projects only dialog overrides", async () => {
    const user = userEvent.setup();
    const request = vi.spyOn(hostClient, "request").mockResolvedValue({
      ok: true,
      result: {
        extensionDecisionPresentation: "auto",
        extensionDialogPresentationOverrides: {},
      },
    } as never);
    render(<SettingsPage initialSection="extensionUi" />);

    await user.selectOptions(screen.getByLabelText("Widget Show in"), "float");
    await waitFor(() =>
      expect(
        useAppStore.getState().desktopSettings?.extensionUi?.presentations.ext_review?.widget?.home
          .kind,
      ).toBe("float"),
    );
    expect(request).not.toHaveBeenCalled();

    await user.selectOptions(screen.getByLabelText("Blocking requests Show in"), "inline");
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "extensionUi.configure",
        { expectedHostInstanceId: CONNECTED_HOST.hostInstanceId },
        {
          extensionDecisionPresentation: "auto",
          extensionDialogPresentationOverrides: { ext_review: "inline" },
        },
      ),
    );
    expect(request.mock.calls[0]?.[2]).not.toHaveProperty("extensionUi");
    expect(JSON.stringify(request.mock.calls.at(-1)?.[2] ?? {})).not.toContain("float");
  });

  it("resets preferences while keeping the observed capability row", async () => {
    const user = userEvent.setup();
    useAppStore.getState().setDesktopSettings({
      ...observedSettings,
      extensionUi: {
        ...observedSettings.extensionUi,
        presentations: {
          ext_review: {
            widget: { home: { kind: "hidden" } },
            blockingDialog: { home: { kind: "inline" } },
          },
        },
      },
    });
    vi.spyOn(hostClient, "request").mockResolvedValue({
      ok: true,
      result: {
        extensionDecisionPresentation: "auto",
        extensionDialogPresentationOverrides: {},
      },
    } as never);
    render(<SettingsPage initialSection="extensionUi" />);

    await user.click(screen.getByRole("button", { name: "Reset Extension UI defaults" }));
    await waitFor(() =>
      expect(
        useAppStore.getState().desktopSettings?.extensionUi?.presentations.ext_review,
      ).toBeUndefined(),
    );
    expect(
      useAppStore.getState().desktopSettings?.extensionUi?.observedCapabilities.ext_review,
    ).toEqual({
      families: ["widget", "blockingDialog"],
      lastSeenAt: 10,
      displayName: "Review",
    });
    expect(screen.getByText("Review")).toBeInTheDocument();
  });

  it("forgets observed capabilities and the presentation profile together", async () => {
    const user = userEvent.setup();
    useAppStore.getState().setDesktopSettings({
      ...observedSettings,
      extensionUi: {
        ...observedSettings.extensionUi,
        presentations: {
          ext_review: {
            widget: { home: { kind: "hidden" } },
            blockingDialog: { home: { kind: "inline" } },
          },
        },
      },
    });
    vi.spyOn(hostClient, "request").mockResolvedValue({
      ok: true,
      result: {
        extensionDecisionPresentation: "auto",
        extensionDialogPresentationOverrides: {},
      },
    } as never);
    render(<SettingsPage initialSection="extensionUi" />);

    await user.click(screen.getByRole("button", { name: "Forget UI settings" }));
    await waitFor(() =>
      expect(
        useAppStore.getState().desktopSettings?.extensionUi?.observedCapabilities.ext_review,
      ).toBeUndefined(),
    );
    expect(
      useAppStore.getState().desktopSettings?.extensionUi?.presentations.ext_review,
    ).toBeUndefined();
    expect(screen.queryByText("Review")).not.toBeInTheDocument();
    expect(
      screen.getByText(/After an Extension uses a widget, status, custom UI, or blocking request/),
    ).toBeInTheDocument();
  });
});
