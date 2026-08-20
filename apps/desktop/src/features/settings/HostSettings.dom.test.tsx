/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostStatusSnapshot } from "@pideck/protocol";
import type { AppUpdateInstallProgress } from "../../lib/updater";
import { useAppStore } from "../../lib/stores/app-store";
import { HostSettings } from "./HostSettings";

const invokeMock = vi.fn(async () => undefined);
const openMock = vi.fn<() => Promise<string | null>>();
const checkForAppUpdateMock = vi.fn<() => Promise<unknown>>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...(args as [])),
  isTauri: () => true,
}));
vi.mock("@tauri-apps/api/app", () => ({
  getVersion: async () => "9.9.9",
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openMock(...(args as [])),
}));
vi.mock("../../lib/updater", () => ({
  checkForAppUpdate: () => checkForAppUpdateMock(),
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
  invokeMock.mockClear();
  openMock.mockReset();
  checkForAppUpdateMock.mockReset();
  useAppStore.getState().setHost(host());
  useAppStore.getState().clearNotifications();
  useAppStore.getState().setHostFatal(null);
  useAppStore.getState().setAppUpdatePhase({ state: "idle" });
});

afterEach(() => {
  cleanup();
  useAppStore.getState().setHost(null);
  useAppStore.getState().setAppUpdatePhase({ state: "idle" });
  vi.restoreAllMocks();
});

describe("HostSettings", () => {
  it("renders capabilities as human-readable states, covering every advertised key", () => {
    render(<HostSettings />);

    expect(screen.getByText("Package update checks")).toBeInTheDocument();
    expect(screen.getByText("Extension UI")).toBeInTheDocument();
    expect(screen.getByText("Session export")).toBeInTheDocument();
    expect(screen.getAllByText("Enabled")).toHaveLength(2);
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.queryByText(/packageUpdateCheck:/)).not.toBeInTheDocument();
  });

  it("shows the app version in the About block", async () => {
    render(<HostSettings />);
    expect(await screen.findByText("9.9.9")).toBeInTheDocument();
  });

  it("requires a confirmation before restarting the Host", async () => {
    const user = userEvent.setup();
    render(<HostSettings />);

    await user.click(screen.getByRole("button", { name: "Restart Host" }));
    const dialog = screen.getByRole("dialog", { name: "Restart Pi Host?" });
    expect(dialog).toHaveTextContent("Any running agent turn is stopped immediately");

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(invokeMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Restart Host" }));
    const reopened = screen.getByRole("dialog", { name: "Restart Pi Host?" });
    await user.click(within(reopened).getByRole("button", { name: "Restart Host" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("pi_host_restart"));
  });

  it("reports up to date after a manual check that finds nothing", async () => {
    const user = userEvent.setup();
    checkForAppUpdateMock.mockResolvedValue(null);
    render(<HostSettings />);

    await user.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText("PiDeck is up to date.")).toBeInTheDocument();
    expect(checkForAppUpdateMock).toHaveBeenCalledTimes(1);
  });

  it("offers install-and-restart when a manual check finds an update", async () => {
    const user = userEvent.setup();
    const install = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("disk full"));
    checkForAppUpdateMock.mockResolvedValue({ version: "0.2.0", install });
    render(<HostSettings />);

    await user.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText("Version 0.2.0 is available.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Download and restart" }));
    expect(install).toHaveBeenCalledTimes(1);
    // A failed install keeps the update offer instead of losing it.
    expect(await screen.findByRole("button", { name: "Download and restart" })).toBeEnabled();
    expect(
      useAppStore
        .getState()
        .notifications.some((item) => item.message.includes("Update install failed")),
    ).toBe(true);
  });

  it("keeps downloading and restores progress after the settings page remounts", async () => {
    const user = userEvent.setup();
    let reportProgress!: (progress: AppUpdateInstallProgress) => void;
    let rejectInstall!: (reason?: unknown) => void;
    const install = vi.fn(
      (onProgress?: (progress: AppUpdateInstallProgress) => void) =>
        new Promise<void>((_resolve, reject) => {
          reportProgress = onProgress!;
          rejectInstall = reject;
        }),
    );
    checkForAppUpdateMock.mockResolvedValue({ version: "0.2.0", install });

    const firstView = render(<HostSettings />);
    await user.click(screen.getByRole("button", { name: "Check for updates" }));
    await user.click(await screen.findByRole("button", { name: "Download and restart" }));

    const indeterminate = screen.getByRole("progressbar", { name: "Downloading update…" });
    expect(indeterminate).not.toHaveAttribute("aria-valuenow");
    expect(
      screen.getByText("You can leave Settings; the update will continue in the background."),
    ).toBeInTheDocument();

    act(() => {
      reportProgress({ phase: "downloading", downloadedBytes: 50, totalBytes: 100 });
    });
    expect(screen.getByRole("progressbar", { name: "50% downloaded" })).toHaveAttribute(
      "aria-valuenow",
      "50",
    );

    firstView.unmount();
    act(() => {
      reportProgress({ phase: "downloading", downloadedBytes: 75, totalBytes: 100 });
    });

    render(<HostSettings />);
    expect(screen.getByRole("progressbar", { name: "75% downloaded" })).toHaveAttribute(
      "aria-valuenow",
      "75",
    );
    expect(screen.getByRole("button", { name: "Downloading update…" })).toBeDisabled();
    expect(install).toHaveBeenCalledTimes(1);

    await act(async () => {
      rejectInstall(new Error("network gone"));
    });
    expect(await screen.findByRole("button", { name: "Download and restart" })).toBeEnabled();
  });

  it("surfaces a failed update check as a notification and stays retryable", async () => {
    const user = userEvent.setup();
    checkForAppUpdateMock.mockRejectedValue(new Error("feed unreachable"));
    render(<HostSettings />);

    await user.click(screen.getByRole("button", { name: "Check for updates" }));
    await waitFor(() =>
      expect(
        useAppStore
          .getState()
          .notifications.some((item) => item.message.includes("Update check failed")),
      ).toBe(true),
    );
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeEnabled();
  });

  it("changes the agent directory through the folder picker", async () => {
    const user = userEvent.setup();
    useAppStore.getState().setDesktopSettings({
      theme: "dark",
      restoreLastSession: true,
      autoRestartHostOnce: true,
      extensionDecisionPresentation: "legacy-modal",
      terminalProfile: "auto",
    });
    openMock.mockResolvedValue("/new/agent-dir");
    invokeMock.mockResolvedValueOnce({
      theme: "dark",
      restoreLastSession: true,
      autoRestartHostOnce: true,
      terminalProfile: "auto",
      agentDir: "/new/agent-dir",
    } as never);

    render(<HostSettings />);
    await user.click(screen.getByRole("button", { name: "Change agent directory…" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("desktop_settings_patch", {
        patch: { agentDir: "/new/agent-dir" },
      }),
    );
    expect(
      useAppStore
        .getState()
        .notifications.some((item) => item.message.includes("restart Pi Host to apply")),
    ).toBe(true);
  });
});
