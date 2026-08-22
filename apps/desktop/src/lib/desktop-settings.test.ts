import { DEFAULT_EXTENSION_UI_SETTINGS } from "@pideck/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "./stores/app-store";
import {
  canonicalExtensionUiSettings,
  persistDesktopSettings,
  persistExtensionUiSettings,
  recentDesktopLocationPatch,
  resetNativeExtensionUiCompatForTests,
} from "./desktop-settings";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  isTauri: mocks.isTauri,
}));

const initialSettings = {
  theme: "dark" as const,
  language: "en" as const,
  restoreLastSession: true,
  autoRestartHostOnce: true,
  extensionDecisionPresentation: "legacy-modal" as const,
  terminalProfile: "auto" as const,
  extensionUi: DEFAULT_EXTENSION_UI_SETTINGS,
};

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.isTauri.mockReset();
  resetNativeExtensionUiCompatForTests();
  useAppStore.getState().setDesktopSettings(initialSettings);
});

describe("recentDesktopLocationPatch", () => {
  it("persists both the active workspace and session", () => {
    expect(recentDesktopLocationPatch("C:/workspace", "C:/sessions/current.jsonl")).toEqual({
      lastWorkspace: "C:/workspace",
      lastSessionPath: "C:/sessions/current.jsonl",
    });
  });

  it("clears a session from the previous workspace", () => {
    expect(recentDesktopLocationPatch("C:/next", null)).toEqual({
      lastWorkspace: "C:/next",
      lastSessionPath: null,
    });
  });
});

describe("persistDesktopSettings", () => {
  it("keeps a Tauri write failure observable without applying an optimistic patch", async () => {
    mocks.isTauri.mockReturnValue(true);
    mocks.invoke.mockRejectedValue(new Error("disk full"));

    await expect(persistDesktopSettings({ theme: "light" })).rejects.toThrow("disk full");

    expect(mocks.invoke).toHaveBeenCalledWith("desktop_settings_patch", {
      patch: { theme: "light" },
    });
    expect(useAppStore.getState().desktopSettings).toEqual(initialSettings);
  });

  it("uses the local patch only outside Tauri", async () => {
    mocks.isTauri.mockReturnValue(false);

    await persistDesktopSettings({ theme: "light" });

    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(useAppStore.getState().desktopSettings).toEqual({
      ...initialSettings,
      theme: "light",
    });
  });

  it("persists validated appearance preferences outside Tauri", async () => {
    mocks.isTauri.mockReturnValue(false);

    await persistDesktopSettings({
      themeFamily: "vercel",
      interfaceDensity: "compact",
      conversationFontSize: 17,
      codeFontSize: 15,
    });

    expect(useAppStore.getState().desktopSettings).toEqual({
      ...initialSettings,
      themeFamily: "vercel",
      interfaceDensity: "compact",
      conversationFontSize: 17,
      codeFontSize: 15,
    });

    await persistDesktopSettings({ themeFamily: "apple" });
    expect(useAppStore.getState().desktopSettings?.themeFamily).toBe("apple");

    await persistDesktopSettings({ busySendBehavior: "steer" });
    expect(useAppStore.getState().desktopSettings?.busySendBehavior).toBe("steer");
  });

  it("applies shortcut override maps through the browser settings path", async () => {
    mocks.isTauri.mockReturnValue(false);

    await persistDesktopSettings({
      shortcutOverrides: {
        "session.new": "mod+shift+n",
        "chat.stop": null,
      },
    });

    expect(useAppStore.getState().desktopSettings?.shortcutOverrides).toEqual({
      "session.new": "mod+shift+n",
      "chat.stop": null,
    });
  });

  it("uses the same runtime value constraints outside Tauri", async () => {
    mocks.isTauri.mockReturnValue(false);

    await expect(persistDesktopSettings({ theme: "neon" } as never)).rejects.toThrow(
      "Invalid desktop theme",
    );
    await expect(persistDesktopSettings({ themeFamily: "neon" } as never)).rejects.toThrow(
      "Invalid desktop theme family",
    );
    await expect(persistDesktopSettings({ futureSetting: true } as never)).rejects.toThrow(
      "Unknown desktop settings field",
    );
    await expect(
      persistDesktopSettings({ busySendBehavior: "interrupt" } as never),
    ).rejects.toThrow("Invalid busy send behavior");
    await expect(persistDesktopSettings({ interfaceDensity: "dense" } as never)).rejects.toThrow(
      "Invalid interface density",
    );
    await expect(persistDesktopSettings({ conversationFontSize: 11 })).rejects.toThrow(
      "conversationFontSize must be an integer between 12 and 18",
    );
    await expect(persistDesktopSettings({ codeFontSize: 19 })).rejects.toThrow(
      "codeFontSize must be an integer between 10 and 18",
    );

    expect(useAppStore.getState().desktopSettings).toEqual(initialSettings);
  });

  it("clears an optional language through the browser settings path", async () => {
    mocks.isTauri.mockReturnValue(false);

    await persistDesktopSettings({ language: null });

    const withoutLanguage = Object.fromEntries(
      Object.entries(initialSettings).filter(([key]) => key !== "language"),
    );
    expect(useAppStore.getState().desktopSettings).toEqual(withoutLanguage);
  });

  it("accepts a later write after a rejected queued write", async () => {
    mocks.isTauri.mockReturnValue(true);
    mocks.invoke
      .mockRejectedValueOnce(new Error("permission denied"))
      .mockResolvedValueOnce({ ...initialSettings, theme: "light" });

    await expect(persistDesktopSettings({ theme: "system" })).rejects.toThrow("permission denied");
    await expect(persistDesktopSettings({ theme: "light" })).resolves.toBeUndefined();

    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().desktopSettings).toEqual({
      ...initialSettings,
      theme: "light",
    });
  });

  it("hydrates missing extensionUi to V1 defaults and rejects invalid snapshots", async () => {
    mocks.isTauri.mockReturnValue(false);
    useAppStore.getState().setDesktopSettings({
      theme: "dark",
      restoreLastSession: true,
      autoRestartHostOnce: true,
      extensionDecisionPresentation: "auto",
      terminalProfile: "auto",
    });
    expect(canonicalExtensionUiSettings(useAppStore.getState().desktopSettings)).toEqual(
      DEFAULT_EXTENSION_UI_SETTINGS,
    );
    expect(useAppStore.getState().desktopSettings?.extensionUi).toEqual(
      DEFAULT_EXTENSION_UI_SETTINGS,
    );

    await expect(
      persistDesktopSettings({
        extensionUi: { version: 2, presentations: {}, dock: {}, observedCapabilities: {} },
      } as never),
    ).rejects.toThrow("Invalid extensionUi settings");
    await expect(
      persistDesktopSettings({
        extensionUi: {
          version: 1,
          presentations: {
            ext_a: {
              status: { home: { kind: "float", rect: { x: 0, y: 0, width: 1, height: 1 } } },
            },
          },
          dock: { direction: "row", secondaryEnabled: false },
          observedCapabilities: {},
        },
      }),
    ).rejects.toThrow("Invalid extensionUi settings");
  });

  it("writes one complete validated extensionUi snapshot and no-ops equal updates", async () => {
    mocks.isTauri.mockReturnValue(true);
    const next = {
      version: 1 as const,
      presentations: {
        ext_review: {
          blockingDialog: { home: { kind: "inline" as const } },
        },
      },
      dock: { direction: "row" as const, secondaryEnabled: false },
      observedCapabilities: {
        ext_review: { families: ["blockingDialog" as const], lastSeenAt: 10 },
      },
    };
    mocks.invoke.mockResolvedValue({ ...initialSettings, extensionUi: next });

    await persistExtensionUiSettings(() => next);
    expect(mocks.invoke).toHaveBeenCalledWith("desktop_settings_patch", {
      patch: { extensionUi: next },
    });
    expect(useAppStore.getState().desktopSettings?.extensionUi).toEqual(next);

    mocks.invoke.mockClear();
    await persistExtensionUiSettings((current) => current);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("applies concurrent functional extensionUi updates to the latest queued snapshot", async () => {
    mocks.isTauri.mockReturnValue(false);

    await Promise.all([
      persistExtensionUiSettings((current) => ({
        ...current,
        observedCapabilities: {
          ...current.observedCapabilities,
          ext_a: { families: ["widget"], lastSeenAt: 1 },
        },
      })),
      persistExtensionUiSettings((current) => ({
        ...current,
        observedCapabilities: {
          ...current.observedCapabilities,
          ext_b: { families: ["status"], lastSeenAt: 2 },
        },
      })),
    ]);

    expect(useAppStore.getState().desktopSettings?.extensionUi?.observedCapabilities).toEqual({
      ext_a: { families: ["widget"], lastSeenAt: 1 },
      ext_b: { families: ["status"], lastSeenAt: 2 },
    });
  });

  it("keeps extensionUi locally when the native shell rejects the new field", async () => {
    mocks.isTauri.mockReturnValue(true);
    mocks.invoke.mockRejectedValue(new Error("unknown desktop settings field: extensionUi"));
    const next = {
      ...DEFAULT_EXTENSION_UI_SETTINGS,
      observedCapabilities: {
        ext_review: { families: ["widget" as const], lastSeenAt: 10 },
      },
    };

    await persistExtensionUiSettings(() => next);
    expect(useAppStore.getState().desktopSettings?.extensionUi).toEqual(next);

    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue({ ...initialSettings, theme: "light" });
    await persistDesktopSettings({ theme: "light" });
    expect(mocks.invoke).toHaveBeenCalledWith("desktop_settings_patch", {
      patch: { theme: "light" },
    });
    expect(useAppStore.getState().desktopSettings?.theme).toBe("light");
    expect(useAppStore.getState().desktopSettings?.extensionUi).toEqual(next);
  });
});
