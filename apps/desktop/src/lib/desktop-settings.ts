import type { DesktopSettings } from "@pi-desktop/protocol";
import { useAppStore } from "./stores/app-store";

export type DesktopSettingsUpdate = Omit<
  Partial<DesktopSettings>,
  "defaultWorkspace" | "lastWorkspace" | "lastSessionPath" | "agentDir"
> & {
  defaultWorkspace?: string | null;
  lastWorkspace?: string | null;
  lastSessionPath?: string | null;
  agentDir?: string | null;
};

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

function applyLocalPatch(
  current: DesktopSettings,
  patch: DesktopSettingsUpdate,
): DesktopSettings {
  const next = { ...current } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else if (value !== undefined) next[key] = value;
  }
  return next as DesktopSettings;
}

async function writeDesktopSettings(patch: DesktopSettingsUpdate): Promise<void> {
  const current = useAppStore.getState().desktopSettings;
  if (!current) return;
  const nextLocal = applyLocalPatch(current, patch);
  if (JSON.stringify(nextLocal) === JSON.stringify(current)) return;

  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const next = await invoke<DesktopSettings>("desktop_settings_patch", { patch });
    useAppStore.getState().setDesktopSettings(next);
  } catch {
    useAppStore.getState().setDesktopSettings(nextLocal);
  }
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
