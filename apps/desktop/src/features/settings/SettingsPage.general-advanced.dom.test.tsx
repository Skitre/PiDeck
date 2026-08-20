/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostStatusSnapshot } from "@pideck/protocol";
import { useAppStore } from "../../lib/stores/app-store";
import { SettingsPage } from "./SettingsPage";

const invokeMock = vi.fn(async () => undefined);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...(args as [])),
  isTauri: () => true,
}));

function host(): HostStatusSnapshot {
  return {
    protocolVersion: 1,
    hostInstanceId: "11111111-1111-4111-8111-111111111111",
    workspaceId: null,
    workspaceRevision: 0,
    sessionId: null,
    sessionRevision: 0,
    packageRevision: 1,
    sdkVersion: "0.84.2",
    nodeVersion: "v24.18.0",
    agentDir: "/agent",
    phase: "ready",
    capabilities: {
      packageUpdateCheck: true,
      extensionUi: true,
      sessionExport: false,
    },
    modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
  };
}

beforeEach(() => {
  invokeMock.mockReset();
  useAppStore.getState().setHost(host());
  useAppStore.getState().clearNotifications();
  useAppStore.getState().setHostFatal(null);
  useAppStore.getState().setDesktopSettings({
    theme: "system",
    language: "en",
    restoreLastSession: true,
    autoRestartHostOnce: true,
    extensionDecisionPresentation: "legacy-modal",
    terminalProfile: "auto",
  });
});

afterEach(() => {
  cleanup();
  useAppStore.getState().setHost(null);
  useAppStore.getState().setDesktopSettings(null);
  vi.restoreAllMocks();
});

describe("GeneralSettings advanced block", () => {
  it("renders the More settings group with the restart hint", () => {
    render(<SettingsPage initialSection="general" />);

    expect(screen.getByText("More settings")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open settings.json" })).toBeEnabled();
    expect(screen.getByText("Changes take effect after restarting the Host.")).toBeInTheDocument();
  });

  it("reveals the global settings.json via the desktop_open_path command", async () => {
    const user = userEvent.setup();
    render(<SettingsPage initialSection="general" />);

    await user.click(screen.getByRole("button", { name: "Open settings.json" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("desktop_open_path", {
        path: "/agent/settings.json",
      }),
    );
  });

  it("surfaces a failed reveal as a notification", async () => {
    const user = userEvent.setup();
    invokeMock.mockRejectedValue(new Error("path does not exist"));
    render(<SettingsPage initialSection="general" />);

    await user.click(screen.getByRole("button", { name: "Open settings.json" }));

    await waitFor(() =>
      expect(
        useAppStore
          .getState()
          .notifications.some((item) => item.message.includes("path does not exist")),
      ).toBe(true),
    );
  });

  it("disables the open button while the Host is not connected", () => {
    useAppStore.getState().setHost(null);
    render(<SettingsPage initialSection="general" />);

    expect(screen.getByRole("button", { name: "Open settings.json" })).toBeDisabled();
  });

  it("restarts the Host from the block after confirmation", async () => {
    const user = userEvent.setup();
    render(<SettingsPage initialSection="general" />);

    await user.click(screen.getByRole("button", { name: "Restart Host" }));
    const dialog = screen.getByRole("dialog", { name: "Restart Pi Host?" });
    await user.click(within(dialog).getByRole("button", { name: "Restart Host" }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("pi_host_restart"));
  });
});
