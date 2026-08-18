import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import defaultCapability from "../../src-tauri/capabilities/default.json";
import macosConfig from "../../src-tauri/tauri.macos.conf.json";
import baseConfig from "../../src-tauri/tauri.conf.json";
import windowsConfig from "../../src-tauri/tauri.windows.conf.json";

type WindowConfig = {
  title: string;
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  resizable: boolean;
  decorations: boolean;
  dragDropEnabled: boolean;
  transparent?: boolean;
  shadow?: boolean;
  backgroundColor: string;
  windowEffects?: {
    effects: string[];
    state?: string;
    radius?: number;
  };
};

const baseWindow = baseConfig.app.windows[0] as WindowConfig;
const macosWindow = macosConfig.app.windows[0] as WindowConfig;
const windowsWindow = windowsConfig.app.windows[0] as WindowConfig;
const cargoManifest = readFileSync(new URL("../../src-tauri/Cargo.toml", import.meta.url), "utf8");

describe("native window platform configuration", () => {
  it("allows the intercepted close flow to destroy the main window", () => {
    expect(defaultCapability.webviews).toContain("main");
    expect(defaultCapability.permissions).toEqual(
      expect.arrayContaining([
        "core:window:allow-close",
        "core:window:allow-destroy",
        "core:window:allow-hide",
      ]),
    );
  });

  it("pins the upstream Windows child-WebView focus restoration", () => {
    for (const packageName of ["tauri-runtime-wry", "tauri-runtime", "tauri-utils"]) {
      expect(cargoManifest).toContain(
        `${packageName} = { git = "https://github.com/tauri-apps/tauri", rev = "08acfb3fa04945a6a4f822d66c7556111d9385aa" }`,
      );
    }
    expect(cargoManifest).not.toContain("vendor/tauri-runtime-wry");
  });

  it("keeps the Cargo-managed macOS private API feature allowlisted in shared config", () => {
    expect(baseConfig.app.macOSPrivateApi).toBe(true);
  });

  it.each([
    ["macOS", macosWindow],
    ["Windows", windowsWindow],
  ])("keeps the shared window contract in the %s override", (_platform, platformWindow) => {
    expect({
      title: platformWindow.title,
      width: platformWindow.width,
      height: platformWindow.height,
      minWidth: platformWindow.minWidth,
      minHeight: platformWindow.minHeight,
      resizable: platformWindow.resizable,
      decorations: platformWindow.decorations,
      dragDropEnabled: platformWindow.dragDropEnabled,
    }).toEqual({
      title: baseWindow.title,
      width: baseWindow.width,
      height: baseWindow.height,
      minWidth: baseWindow.minWidth,
      minHeight: baseWindow.minHeight,
      resizable: baseWindow.resizable,
      decorations: baseWindow.decorations,
      dragDropEnabled: baseWindow.dragDropEnabled,
    });
    expect(platformWindow).toMatchObject({
      transparent: true,
      shadow: true,
      backgroundColor: "#00000000",
    });
  });

  it("uses semantic behind-window material on macOS", () => {
    expect(macosWindow.windowEffects).toEqual({
      effects: ["underWindowBackground"],
      state: "followsWindowActiveState",
      radius: 12,
    });
  });

  it("uses Windows Acrylic without macOS-only effect fields", () => {
    expect(windowsWindow.windowEffects).toEqual({ effects: ["acrylic"] });
  });
});
