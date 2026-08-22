import type {
  ExtensionSurfaceFamily,
  ExtensionUiOrigin,
  HostEventName,
  HostEventPayloadMap,
} from "@pideck/protocol";
import {
  isTrustedExtensionUiOrigin,
  sanitizeExtensionDisplayName,
  trustedExtensionId,
} from "@pideck/protocol";
import {
  canonicalExtensionUiSettings,
  notifyDesktopSettingsSaveFailure,
  persistExtensionUiSettings,
} from "./desktop-settings";
import { useAppStore } from "./stores/app-store";

const displayNames = new Map<string, string>();

export function observedExtensionDisplayName(extensionId: string): string {
  return (
    displayNames.get(extensionId) ??
    canonicalExtensionUiSettings(useAppStore.getState().desktopSettings).observedCapabilities[
      extensionId
    ]?.displayName ??
    extensionId
  );
}

export function resetObservedExtensionDisplayNames(): void {
  displayNames.clear();
}

export function forgetObservedExtensionDisplayName(extensionId: string): void {
  displayNames.delete(extensionId);
}

function rememberExtensionDisplayName(origin: ExtensionUiOrigin | undefined): void {
  if (!isTrustedExtensionUiOrigin(origin)) return;
  const name = sanitizeExtensionDisplayName(origin.extensionDisplayName);
  if (name) displayNames.set(origin.extensionId, name);
}

export function observedFamilyFromHostEvent(
  event: HostEventName,
  payload: unknown,
): ExtensionSurfaceFamily | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  switch (event) {
    case "extensionUi.widgetChanged":
      return record.widget !== null && record.widget !== undefined ? "widget" : null;
    case "extensionUi.statusChanged":
      return typeof record.text === "string" && record.text.length > 0 ? "status" : null;
    case "extensionUi.customStarted":
      return "custom";
    case "extensionUi.request":
      return "blockingDialog";
    default:
      return null;
  }
}

export async function observeExtensionUiFamily(
  origin: ExtensionUiOrigin | undefined,
  family: ExtensionSurfaceFamily,
  now = Date.now(),
): Promise<boolean> {
  const extensionId = trustedExtensionId(origin);
  if (!extensionId) return false;
  rememberExtensionDisplayName(origin);
  const displayName = isTrustedExtensionUiOrigin(origin)
    ? sanitizeExtensionDisplayName(origin.extensionDisplayName)
    : undefined;
  const current = canonicalExtensionUiSettings(useAppStore.getState().desktopSettings);
  const entry = current.observedCapabilities[extensionId];
  const familyKnown = Boolean(entry?.families.includes(family));
  const nameUnchanged = !displayName || entry?.displayName === displayName;
  if (familyKnown && nameUnchanged) {
    return false;
  }
  await persistExtensionUiSettings((settings) => {
    const existing = settings.observedCapabilities[extensionId];
    const families = existing?.families.includes(family)
      ? existing.families
      : existing
        ? [...existing.families, family]
        : [family];
    const nextName = displayName ?? existing?.displayName;
    if (existing && families === existing.families && existing.displayName === nextName) {
      return settings;
    }
    return {
      ...settings,
      observedCapabilities: {
        ...settings.observedCapabilities,
        [extensionId]: {
          families,
          lastSeenAt: existing?.families.includes(family) ? existing.lastSeenAt : now,
          ...(nextName ? { displayName: nextName } : {}),
        },
      },
    };
  });
  return true;
}

export function observeExtensionUiHostEvent<E extends HostEventName>(
  event: E,
  payload: HostEventPayloadMap[E] | unknown,
): void {
  const family = observedFamilyFromHostEvent(event, payload);
  if (!family) return;
  const origin =
    payload && typeof payload === "object" && "origin" in payload
      ? (payload as { origin?: ExtensionUiOrigin }).origin
      : undefined;
  void observeExtensionUiFamily(origin, family).catch((error) => {
    notifyDesktopSettingsSaveFailure(error);
  });
}
