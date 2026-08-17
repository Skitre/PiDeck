import {
  BUSY_SEND_BEHAVIORS,
  DESKTOP_INTERFACE_DENSITIES,
  DESKTOP_LANGUAGES,
  DESKTOP_THEME_FAMILIES,
  DESKTOP_THEMES,
  TERMINAL_PROFILE_IDS,
  type DesktopSettings,
} from "@pideck/protocol";
import {
  MAX_CODE_FONT_SIZE,
  MAX_CONVERSATION_FONT_SIZE,
  MIN_CODE_FONT_SIZE,
  MIN_CONVERSATION_FONT_SIZE,
} from "./appearance-preferences";
import { tCurrent } from "./i18n/use-t";
import { useAppStore } from "./stores/app-store";

export type DesktopSettingsSnapshot = {
  schemaVersion: number;
  settings: DesktopSettings;
  warning?: string;
  recoveredFrom?: string;
};

export type DesktopSettingsUpdate = Omit<
  Partial<DesktopSettings>,
  "defaultWorkspace" | "lastWorkspace" | "lastSessionPath" | "agentDir" | "language"
> & {
  defaultWorkspace?: string | null;
  lastWorkspace?: string | null;
  lastSessionPath?: string | null;
  agentDir?: string | null;
  language?: DesktopSettings["language"] | null;
};

const DESKTOP_SETTINGS_KEYS = new Set([
  "theme",
  "themeFamily",
  "defaultWorkspace",
  "restoreLastSession",
  "lastWorkspace",
  "lastSessionPath",
  "agentDir",
  "autoRestartHostOnce",
  "busySendBehavior",
  "extensionDecisionPresentation",
  "terminalProfile",
  "language",
  "interfaceDensity",
  "conversationContentWidth",
  "conversationFontSize",
  "codeFontSize",
  "knownWorkspaces",
  "shortcutOverrides",
]);
const EXTENSION_DECISION_PRESENTATIONS = ["legacy-modal", "auto", "inline-first"] as const;
const NULLABLE_PATH_KEYS = [
  "defaultWorkspace",
  "lastWorkspace",
  "lastSessionPath",
  "agentDir",
] as const;

function isOneOf(value: unknown, values: readonly string[]): value is string {
  return typeof value === "string" && values.includes(value);
}

function assertDesktopSettingsUpdate(patch: DesktopSettingsUpdate): void {
  const values = patch as Record<string, unknown>;
  for (const key of Object.keys(values)) {
    if (!DESKTOP_SETTINGS_KEYS.has(key)) {
      throw new Error(`Unknown desktop settings field: ${key}`);
    }
  }
  if (values.theme !== undefined && !isOneOf(values.theme, DESKTOP_THEMES)) {
    throw new Error("Invalid desktop theme");
  }
  if (values.themeFamily !== undefined && !isOneOf(values.themeFamily, DESKTOP_THEME_FAMILIES)) {
    throw new Error("Invalid desktop theme family");
  }
  if (
    values.busySendBehavior !== undefined &&
    !isOneOf(values.busySendBehavior, BUSY_SEND_BEHAVIORS)
  ) {
    throw new Error("Invalid busy send behavior");
  }
  if (
    values.extensionDecisionPresentation !== undefined &&
    !isOneOf(values.extensionDecisionPresentation, EXTENSION_DECISION_PRESENTATIONS)
  ) {
    throw new Error("Invalid extension decision presentation");
  }
  if (
    values.terminalProfile !== undefined &&
    !isOneOf(values.terminalProfile, TERMINAL_PROFILE_IDS)
  ) {
    throw new Error("Invalid terminal profile");
  }
  if (
    values.language !== undefined &&
    values.language !== null &&
    !isOneOf(values.language, DESKTOP_LANGUAGES)
  ) {
    throw new Error("Invalid desktop language");
  }
  if (
    values.interfaceDensity !== undefined &&
    !isOneOf(values.interfaceDensity, DESKTOP_INTERFACE_DENSITIES)
  ) {
    throw new Error("Invalid interface density");
  }
  const width = values.conversationContentWidth;
  if (
    width !== undefined &&
    (typeof width !== "number" || !Number.isInteger(width) || width < 560 || width > 0xffff_ffff)
  ) {
    throw new Error("conversationContentWidth must be an integer between 560 and 4294967295");
  }
  for (const [key, min, max] of [
    ["conversationFontSize", MIN_CONVERSATION_FONT_SIZE, MAX_CONVERSATION_FONT_SIZE],
    ["codeFontSize", MIN_CODE_FONT_SIZE, MAX_CODE_FONT_SIZE],
  ] as const) {
    const value = values[key];
    if (
      value !== undefined &&
      (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    ) {
      throw new Error(`${key} must be an integer between ${min} and ${max}`);
    }
  }
  for (const key of ["restoreLastSession", "autoRestartHostOnce"] as const) {
    if (values[key] !== undefined && typeof values[key] !== "boolean") {
      throw new Error(`${key} must be a boolean`);
    }
  }
  for (const key of NULLABLE_PATH_KEYS) {
    if (values[key] !== undefined && values[key] !== null && typeof values[key] !== "string") {
      throw new Error(`${key} must be a string or null`);
    }
  }
  if (
    values.knownWorkspaces !== undefined &&
    (!Array.isArray(values.knownWorkspaces) ||
      !values.knownWorkspaces.every((value) => typeof value === "string"))
  ) {
    throw new Error("knownWorkspaces must be an array of strings");
  }
  if (values.shortcutOverrides !== undefined) {
    const shortcuts = values.shortcutOverrides;
    if (
      typeof shortcuts !== "object" ||
      shortcuts === null ||
      Array.isArray(shortcuts) ||
      !Object.values(shortcuts).every((value) => typeof value === "string" || value === null)
    ) {
      throw new Error("shortcutOverrides must map command ids to strings or null");
    }
  }
}

let settingsWriteQueue: Promise<void> = Promise.resolve();

export function recentDesktopLocationPatch(
  workspacePath: string,
  sessionPath: string | null,
): DesktopSettingsUpdate {
  return {
    lastWorkspace: workspacePath,
    lastSessionPath: sessionPath,
  };
}

function applyLocalPatch(current: DesktopSettings, patch: DesktopSettingsUpdate): DesktopSettings {
  const next = { ...current } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else if (value !== undefined) next[key] = value;
  }
  return next as DesktopSettings;
}

export function notifyDesktopSettingsSaveFailure(error: unknown): void {
  const summary = tCurrent("notifDesktopSettingsSaveFailed");
  const detail =
    error instanceof Error ? error.message.trim() : typeof error === "string" ? error.trim() : "";
  useAppStore.getState().pushNotification(detail ? `${summary}: ${detail}` : summary, "error");
}

async function writeDesktopSettings(patch: DesktopSettingsUpdate): Promise<void> {
  assertDesktopSettingsUpdate(patch);
  const current = useAppStore.getState().desktopSettings;
  if (!current) return;
  const nextLocal = applyLocalPatch(current, patch);
  if (JSON.stringify(nextLocal) === JSON.stringify(current)) return;

  const { invoke, isTauri } = await import("@tauri-apps/api/core");
  if (!isTauri()) {
    useAppStore.getState().setDesktopSettings(nextLocal);
    return;
  }

  const next = await invoke<DesktopSettings>("desktop_settings_patch", { patch });
  useAppStore.getState().setDesktopSettings(next);
}

export function persistDesktopSettings(patch: DesktopSettingsUpdate): Promise<void> {
  settingsWriteQueue = settingsWriteQueue
    .catch(() => undefined)
    .then(() => writeDesktopSettings(patch));
  return settingsWriteQueue;
}

export function persistRecentDesktopLocation(
  workspacePath: string,
  sessionPath: string | null,
): Promise<void> {
  return persistDesktopSettings(recentDesktopLocationPatch(workspacePath, sessionPath));
}
