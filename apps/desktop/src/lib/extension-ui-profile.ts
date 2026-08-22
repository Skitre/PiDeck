import {
  sanitizeExtensionUiSettings,
  type ExtensionSurfaceFamily,
  type ExtensionUiSettings,
  type PresentationHome,
} from "@pideck/protocol";
import { persistExtensionUiSettings } from "./desktop-settings";

export type ExtensionUiUndoEntry = {
  previous: ExtensionUiSettings;
  message: string;
};

let undoEntry: ExtensionUiUndoEntry | null = null;
const listeners = new Set<() => void>();

function emitUndo(): void {
  for (const listener of listeners) listener();
}

export function getExtensionUiUndo(): ExtensionUiUndoEntry | null {
  return undoEntry;
}

export function subscribeExtensionUiUndo(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function clearExtensionUiUndo(): void {
  if (!undoEntry) return;
  undoEntry = null;
  emitUndo();
}

export function withFamilyHome(
  settings: ExtensionUiSettings,
  extensionId: string,
  family: ExtensionSurfaceFamily,
  home: PresentationHome | undefined,
): ExtensionUiSettings {
  const profile = { ...(settings.presentations[extensionId] ?? {}) };
  if (!home) delete profile[family];
  else profile[family] = { home };
  const presentations = { ...settings.presentations };
  if (Object.keys(profile).length === 0) delete presentations[extensionId];
  else presentations[extensionId] = profile;
  return sanitizeExtensionUiSettings({ ...settings, presentations });
}

export async function commitExtensionUiSettings(input: {
  update: (current: ExtensionUiSettings) => ExtensionUiSettings;
  message: string;
}): Promise<ExtensionUiSettings> {
  let previous: ExtensionUiSettings | null = null;
  const next = await persistExtensionUiSettings((current) => {
    previous = current;
    return input.update(current);
  });
  if (previous && JSON.stringify(previous) !== JSON.stringify(next)) {
    undoEntry = { previous, message: input.message };
    emitUndo();
  }
  return next;
}

export async function commitExtensionPresentationHome(input: {
  extensionId: string;
  family: ExtensionSurfaceFamily;
  home: PresentationHome | undefined;
  message: string;
}): Promise<ExtensionUiSettings | null> {
  return commitExtensionUiSettings({
    update: (current) => withFamilyHome(current, input.extensionId, input.family, input.home),
    message: input.message,
  });
}

export function forgetExtensionUiIdentity(
  settings: ExtensionUiSettings,
  extensionId: string,
): ExtensionUiSettings {
  const presentations = { ...settings.presentations };
  delete presentations[extensionId];
  const observedCapabilities = { ...settings.observedCapabilities };
  delete observedCapabilities[extensionId];
  return sanitizeExtensionUiSettings({ ...settings, presentations, observedCapabilities });
}

export async function undoExtensionUiSettings(): Promise<ExtensionUiSettings | null> {
  const entry = undoEntry;
  if (!entry) return null;
  undoEntry = null;
  emitUndo();
  return persistExtensionUiSettings(() => entry.previous);
}
