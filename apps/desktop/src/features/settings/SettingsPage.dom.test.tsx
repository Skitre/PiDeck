/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../lib/stores/app-store";
import { SettingsPage } from "./SettingsPage";
import { hostClient } from "../../lib/bridge/host-client";

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
  extensionDecisionPresentation: "legacy-modal" as const,
};

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriMocks.invoke,
  isTauri: tauriMocks.isTauri,
}));

beforeEach(() => {
  tauriMocks.invoke.mockReset();
  tauriMocks.invoke.mockRejectedValue(new Error("Tauri unavailable"));
  tauriMocks.isTauri.mockReset();
  tauriMocks.isTauri.mockReturnValue(false);
  useAppStore.getState().setHost(null);
  useAppStore.getState().setProvidersDirty(false);
  useAppStore.getState().clearNotifications();
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
  useAppStore.getState().setProvidersDirty(false);
  useAppStore.getState().setDesktopSettings(null);
  document.documentElement.removeAttribute("data-interface-density");
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-theme-family");
  document.documentElement.classList.remove("light", "dark");
  document.documentElement.style.removeProperty("--conversation-font-size");
  document.documentElement.style.removeProperty("--code-font-size");
  vi.restoreAllMocks();
});

describe("SettingsPage navigation guard", () => {
  it("places the Settings identity and active section title in separate columns", () => {
    const { container } = render(<SettingsPage initialSection="general" />);

    const shell = container.querySelector("[data-settings-shell]");
    const sidebar = container.querySelector("[data-settings-sidebar]");
    const sidebarHeader = container.querySelector("[data-settings-sidebar-header]");
    const content = container.querySelector("[data-settings-content]");

    expect(shell?.firstElementChild).toBe(sidebar);
    expect(sidebarHeader?.parentElement).toBe(sidebar);
    expect(content?.parentElement).toBe(shell);
    expect(
      within(sidebarHeader as HTMLElement).getByLabelText("Back to conversation"),
    ).toBeInTheDocument();
    expect(sidebarHeader).toHaveTextContent("Back to conversation");
    expect(
      within(sidebarHeader as HTMLElement).getByRole("heading", { name: "Settings" }),
    ).toBeInTheDocument();
    expect(
      within(content as HTMLElement).getByRole("heading", { name: "General" }),
    ).toBeInTheDocument();
    expect(sidebarHeader).not.toHaveClass("border-b");
    expect(content?.querySelector("header")).not.toHaveClass("border-b");
  });

  it("places Shortcuts last in the settings sidebar", () => {
    render(<SettingsPage initialSection="general" />);

    const navigation = screen.getByRole("navigation");
    expect(
      within(navigation)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["General", "Appearance", "Providers", "Packages", "Usage", "Host", "Shortcuts"]);
  });

  it("keeps startup controls in General and moves interface controls to Appearance", async () => {
    const user = userEvent.setup();
    render(<SettingsPage initialSection="general" />);

    expect(screen.getByText("Startup")).toBeInTheDocument();
    expect(screen.getByText("Restore last session")).toBeInTheDocument();
    expect(screen.getByText("Auto-restart Pi Host")).toBeInTheDocument();
    expect(screen.queryByLabelText(/Theme/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Language/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("spinbutton", { name: "Conversation width" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Appearance" }));

    expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Appearance" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("button", { name: "Appearance" })).toHaveAttribute(
      "data-state",
      "active",
    );
    expect(screen.getByRole("button", { name: "General" })).toHaveAttribute(
      "data-state",
      "inactive",
    );
    expect(screen.getByRole("group", { name: "Theme style" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Color mode" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Language" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Interface density" })).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "Conversation width" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Conversation font size" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Code font size" })).toBeInTheDocument();
    expect(screen.queryByText("Restore last session")).not.toBeInTheDocument();
  });

  it("persists density and typography controls and applies them immediately", async () => {
    const user = userEvent.setup();
    render(<SettingsPage initialSection="appearance" />);

    const density = screen.getByRole("group", { name: "Interface density" });
    await user.click(within(density).getByRole("button", { name: "Compact" }));
    await waitFor(() =>
      expect(useAppStore.getState().desktopSettings?.interfaceDensity).toBe("compact"),
    );
    expect(document.documentElement.dataset.interfaceDensity).toBe("compact");

    await user.click(screen.getByRole("button", { name: "Increase Conversation font size" }));
    await waitFor(() =>
      expect(useAppStore.getState().desktopSettings?.conversationFontSize).toBe(15),
    );
    expect(document.documentElement.style.getPropertyValue("--conversation-font-size")).toBe(
      "15px",
    );

    await user.click(screen.getByRole("button", { name: "Increase Code font size" }));
    await waitFor(() => expect(useAppStore.getState().desktopSettings?.codeFontSize).toBe(13));
    expect(document.documentElement.style.getPropertyValue("--code-font-size")).toBe("13px");
    expect(screen.getByText("Readable conversation text with inline code.")).toBeInTheDocument();
    expect(screen.getByText("15px")).toBeInTheDocument();
    expect(screen.getByText("13px")).toBeInTheDocument();
  });

  it("persists the theme family separately from the color mode", async () => {
    const user = userEvent.setup();
    render(<SettingsPage initialSection="appearance" />);
    const themeStyle = screen.getByRole("group", { name: "Theme style" });
    const pideck = within(themeStyle).getByRole("button", { name: "PiDeck" });
    const vercel = within(themeStyle).getByRole("button", { name: "Vercel" });
    const apple = within(themeStyle).getByRole("button", { name: "Apple" });

    expect(pideck).toHaveAttribute("aria-pressed", "true");
    expect(pideck).toHaveAttribute("data-state", "active");
    expect(vercel).toHaveAttribute("aria-pressed", "false");
    expect(vercel).toHaveAttribute("data-state", "inactive");
    expect(apple).toHaveAttribute("aria-pressed", "false");
    expect(apple).toHaveAttribute("data-state", "inactive");

    await user.click(vercel);
    await waitFor(() => expect(useAppStore.getState().desktopSettings?.themeFamily).toBe("vercel"));
    expect(document.documentElement.dataset.themeFamily).toBe("vercel");
    expect(vercel).toHaveAttribute("aria-pressed", "true");
    expect(vercel).toHaveAttribute("data-state", "active");
    expect(pideck).toHaveAttribute("data-state", "inactive");

    await user.click(apple);
    await waitFor(() => expect(useAppStore.getState().desktopSettings?.themeFamily).toBe("apple"));
    expect(document.documentElement.dataset.themeFamily).toBe("apple");
    expect(apple).toHaveAttribute("aria-pressed", "true");
    expect(apple).toHaveAttribute("data-state", "active");
    expect(vercel).toHaveAttribute("data-state", "inactive");

    await user.click(
      within(screen.getByRole("group", { name: "Color mode" })).getByRole("button", {
        name: "Light",
      }),
    );
    await waitFor(() => expect(useAppStore.getState().desktopSettings?.theme).toBe("light"));
    expect(useAppStore.getState().desktopSettings?.themeFamily).toBe("apple");
    expect(document.documentElement).toHaveClass("light");
    expect(document.documentElement.dataset.themeFamily).toBe("apple");
  });

  it("switches sections directly when the Providers form is clean", async () => {
    const user = userEvent.setup();
    render(<SettingsPage initialSection="providers" />);

    expect(screen.getByText("No Providers configured yet.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "General" }));
    expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument();
  });

  it("offers the Host section with runtime info split out of General", async () => {
    const user = userEvent.setup();
    render(<SettingsPage initialSection="general" />);

    expect(screen.getByText("Auto-restart Pi Host")).toBeInTheDocument();
    expect(screen.queryByText("Capabilities")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Host" }));
    expect(screen.getByRole("heading", { name: "Host" })).toBeInTheDocument();
    expect(screen.getByText("Capabilities")).toBeInTheDocument();
    expect(screen.getByText("Host not connected.")).toBeInTheDocument();
  });

  it("offers a persistent Shortcuts section generated from the command registry", async () => {
    const user = userEvent.setup();
    render(<SettingsPage initialSection="general" />);

    await user.click(screen.getByRole("button", { name: "Shortcuts" }));

    expect(screen.getByRole("heading", { name: "Keyboard shortcuts" })).toBeInTheDocument();
    expect(screen.getByText("New session")).toBeInTheDocument();
    expect(screen.getByText("Ctrl+N")).toBeInTheDocument();
    expect(screen.getByText("Show keyboard shortcuts")).toBeInTheDocument();
    expect(screen.getByText("Ctrl+/")).toBeInTheDocument();

    const resetAll = screen.getByRole("button", { name: "Restore defaults" });
    expect(resetAll.parentElement).toHaveAttribute("data-settings-header-actions");
    expect(resetAll.closest("header")).toHaveAttribute("data-settings-section-header");
  });

  it("asks before leaving Providers with unsaved changes and keeps the section on cancel", async () => {
    const user = userEvent.setup();
    render(<SettingsPage initialSection="providers" />);
    useAppStore.getState().setProvidersDirty(true);

    await user.click(screen.getByRole("button", { name: "General" }));
    expect(
      screen.getByRole("heading", { name: "Discard unsaved Provider changes?" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("No Providers configured yet.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "General" }));
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument();
  });

  it("switches the interface to Chinese from the Appearance language control", async () => {
    const user = userEvent.setup();
    render(<SettingsPage initialSection="appearance" />);

    expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument();

    await user.click(
      within(screen.getByRole("group", { name: "Language" })).getByRole("button", {
        name: "中文",
      }),
    );

    expect(screen.getByRole("button", { name: "通用" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "外观" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "主机" })).toBeInTheDocument();
    expect(screen.getByText("界面")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "General" })).not.toBeInTheDocument();
  });

  it("validates and persists the conversation width from Appearance settings", async () => {
    const user = userEvent.setup();
    render(<SettingsPage initialSection="appearance" />);

    const input = screen.getByRole("spinbutton", { name: "Conversation width" });
    expect(input).toHaveValue(668);

    await user.clear(input);
    await user.type(input, "559");
    await user.tab();

    expect(screen.getByRole("alert")).toHaveTextContent("Enter a whole number of at least 560px.");
    expect(useAppStore.getState().desktopSettings?.conversationContentWidth).toBeUndefined();

    await user.click(input);
    await user.clear(input);
    await user.type(input, "920");
    await user.tab();

    await waitFor(() =>
      expect(useAppStore.getState().desktopSettings?.conversationContentWidth).toBe(920),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("defaults busy send to follow-up and persists steer", async () => {
    const user = userEvent.setup();
    render(<SettingsPage initialSection="general" />);

    const select = screen.getByLabelText("Send while running");
    expect(select).toHaveValue("followUp");

    await user.selectOptions(select, "steer");
    await waitFor(() =>
      expect(useAppStore.getState().desktopSettings?.busySendBehavior).toBe("steer"),
    );
    expect(select).toHaveValue("steer");
  });

  it("synchronizes automatic presentation and offers one-click legacy rollback", async () => {
    const user = userEvent.setup();
    useAppStore.getState().setHost(CONNECTED_HOST);
    const request = vi.spyOn(hostClient, "request").mockResolvedValue({
      ok: true,
      result: { extensionDecisionPresentation: "auto" },
    } as never);
    render(<SettingsPage initialSection="general" />);

    const select = screen.getByLabelText("Extension prompt presentation");
    expect(select).toHaveValue("legacy-modal");

    await user.selectOptions(select, "auto");
    await waitFor(() =>
      expect(useAppStore.getState().desktopSettings?.extensionDecisionPresentation).toBe("auto"),
    );
    expect(request).toHaveBeenNthCalledWith(
      1,
      "extensionUi.configure",
      { expectedHostInstanceId: CONNECTED_HOST.hostInstanceId },
      { extensionDecisionPresentation: "auto" },
    );
    expect(select).toHaveValue("auto");

    await user.selectOptions(select, "legacy-modal");
    await waitFor(() =>
      expect(useAppStore.getState().desktopSettings?.extensionDecisionPresentation).toBe(
        "legacy-modal",
      ),
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "extensionUi.configure",
      { expectedHostInstanceId: CONNECTED_HOST.hostInstanceId },
      { extensionDecisionPresentation: "legacy-modal" },
    );
    expect(select).toHaveValue("legacy-modal");
  });

  it("keeps the previous setting and reports a rejected desktop patch", async () => {
    const user = userEvent.setup();
    tauriMocks.isTauri.mockReturnValue(true);
    tauriMocks.invoke.mockImplementation(async (command: string) => {
      if (command === "shell_terminal_profiles") {
        return {
          profiles: [],
          automaticProfile: { id: "auto", label: "Automatic", path: "/bin/sh" },
        };
      }
      throw new Error("disk full");
    });
    render(<SettingsPage initialSection="appearance" />);

    await user.click(
      within(screen.getByRole("group", { name: "Color mode" })).getByRole("button", {
        name: "Light",
      }),
    );

    await waitFor(() =>
      expect(tauriMocks.invoke).toHaveBeenCalledWith("desktop_settings_patch", {
        patch: { theme: "light" },
      }),
    );
    expect(useAppStore.getState().desktopSettings?.theme).toBe("system");
    expect(
      useAppStore
        .getState()
        .notifications.some((notification) => notification.message.includes("disk full")),
    ).toBe(true);
  });

  it("guards the close button while dirty and closes once confirmed via the overlay owner", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<SettingsPage initialSection="providers" onClose={onClose} />);
    useAppStore.getState().setProvidersDirty(true);

    // The overlay owner decides what "close" means; SettingsPage just forwards.
    await user.click(screen.getByRole("button", { name: "Back to conversation" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
