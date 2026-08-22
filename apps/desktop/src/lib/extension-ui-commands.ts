import {
  MIN_EXTENSION_UI_DOCK_SIZE,
  isPresentationHomeForFamily,
  type DockGroupId,
  type PresentationHome,
} from "@pideck/protocol";
import { canonicalExtensionUiSettings, notifyDesktopSettingsSaveFailure } from "./desktop-settings";
import { isExtensionDeckV1Enabled } from "./extension-deck-gate";
import {
  collectDockedPresentationSlots,
  partitionExtensionDockGroups,
} from "./extension-ui-dock-layout";
import {
  extensionUiFamilyMessageKey,
  extensionUiHomeMessageKey,
} from "./extension-ui-home-message";
import { liveExtensionPresentationSlots } from "./extension-ui-live-slots";
import { observedExtensionDisplayName } from "./extension-ui-observation";
import { isLegalPresentationChoice, presentationHomeFromChoice } from "./extension-ui-presentation";
import { commitExtensionPresentationHome, commitExtensionUiSettings } from "./extension-ui-profile";
import type { ExtensionPresentationSlot } from "./extension-ui-slots";
import { tCurrent } from "./i18n/use-t";
import { useAppStore } from "./stores/app-store";

export type ExtensionSlotMoveChoice =
  "dockPrimary" | "dockSecondary" | "float" | "aboveComposer" | "belowComposer";

function commandRoot(): ParentNode | null {
  return typeof document === "undefined" ? null : document;
}

function readFocusedExtensionSlotId(root: ParentNode | null = commandRoot()): string | null {
  if (!root || typeof document === "undefined") return null;
  const active = document.activeElement;
  if (!(active instanceof Element) || !root.contains(active)) return null;
  const owner = active.closest<HTMLElement>(
    "[data-extension-slot], [data-extension-float], [data-extension-slot-tab]",
  );
  return (
    owner?.dataset.extensionSlot ??
    owner?.dataset.extensionFloat ??
    owner?.dataset.extensionSlotTab ??
    null
  );
}

function slotById(slotId: string | null): ExtensionPresentationSlot | undefined {
  if (!slotId) return undefined;
  return liveExtensionPresentationSlots().find((slot) => slot.slotId === slotId);
}

function focusedMovableSlot(root?: ParentNode | null): ExtensionPresentationSlot | undefined {
  const slot = slotById(readFocusedExtensionSlotId(root));
  if (!slot?.extensionId) return undefined;
  if (slot.family !== "widget" && slot.family !== "custom") return undefined;
  return slot;
}

function persistSlotHome(slot: ExtensionPresentationSlot, home: PresentationHome): Promise<void> {
  if (!slot.extensionId) return Promise.resolve();
  const name = observedExtensionDisplayName(slot.extensionId);
  const family = tCurrent(extensionUiFamilyMessageKey(slot.family));
  return commitExtensionPresentationHome({
    extensionId: slot.extensionId,
    family: slot.family,
    home,
    message: tCurrent(extensionUiHomeMessageKey(home), { name, family }),
  }).then(() => undefined);
}

export function hasLiveExtensionFloats(): boolean {
  return liveExtensionPresentationSlots().some((slot) =>
    slot.mounts.some((mount) => mount.home.kind === "float"),
  );
}

export function canMoveFocusedExtensionSlot(root?: ParentNode | null): boolean {
  return Boolean(focusedMovableSlot(root));
}

export function hasFocusedExtensionDockGroup(root?: ParentNode | null): boolean {
  if (!isExtensionDeckV1Enabled()) return false;
  const focused = readFocusedExtensionSlotId(root);
  const docked = collectDockedPresentationSlots(liveExtensionPresentationSlots());
  if (focused && docked.some((item) => item.slotId === focused)) return true;
  return docked.length > 0;
}

export function hasExtensionDockSplit(): boolean {
  if (!isExtensionDeckV1Enabled()) return false;
  const { secondary } = partitionExtensionDockGroups(
    collectDockedPresentationSlots(liveExtensionPresentationSlots()),
  );
  return secondary.length > 0;
}

export function canResetFocusedExtensionFamily(root?: ParentNode | null): boolean {
  const slot = slotById(readFocusedExtensionSlotId(root));
  return Boolean(slot?.extensionId);
}

export function focusAdjacentExtensionFloat(
  direction: 1 | -1,
  root: ParentNode | null = commandRoot(),
): boolean {
  if (!root) return false;
  const floats = [...root.querySelectorAll<HTMLElement>("[data-extension-float]")];
  if (floats.length === 0) return false;
  const focusedId = readFocusedExtensionSlotId(root);
  const current = Math.max(
    0,
    floats.findIndex((node) => node.dataset.extensionFloat === focusedId),
  );
  const next = floats[(current + direction + floats.length) % floats.length];
  next?.focus();
  return Boolean(next);
}

export async function moveFocusedExtensionSlot(
  choice: ExtensionSlotMoveChoice,
  root?: ParentNode | null,
): Promise<boolean> {
  const slot = focusedMovableSlot(root);
  if (!slot?.extensionId || !isLegalPresentationChoice(slot.family, choice)) return false;
  const settings = canonicalExtensionUiSettings(useAppStore.getState().desktopSettings);
  const current = slot.mounts[0]?.home;
  const home = presentationHomeFromChoice(slot.family, choice, settings, current);
  if (!isPresentationHomeForFamily(slot.family, home)) return false;
  try {
    await persistSlotHome(slot, home);
    return true;
  } catch (error) {
    notifyDesktopSettingsSaveFailure(error);
    return false;
  }
}

export function activateAdjacentExtensionDockTab(
  direction: 1 | -1,
  root: ParentNode | null = commandRoot(),
): boolean {
  if (!root || !isExtensionDeckV1Enabled()) return false;
  const focusedId = readFocusedExtensionSlotId(root);
  const group =
    (focusedId
      ? root.querySelector(`[data-extension-slot-tab="${focusedId}"]`)
      : root.querySelector("[data-extension-slot-tab][aria-selected='true']")
    )?.closest("[data-extension-dock-group]") ?? root.querySelector("[data-extension-dock-group]");
  if (!group) return false;
  const tabs = [...group.querySelectorAll<HTMLElement>("[data-extension-slot-tab]")];
  if (tabs.length === 0) return false;
  const selected = tabs.findIndex(
    (tab) =>
      tab.getAttribute("aria-selected") === "true" || tab.dataset.extensionSlotTab === focusedId,
  );
  const current = selected >= 0 ? selected : 0;
  const next = tabs[(current + direction + tabs.length) % tabs.length];
  next?.click();
  next?.focus();
  return Boolean(next);
}

export async function moveFocusedExtensionDockGroup(
  group: DockGroupId,
  root?: ParentNode | null,
): Promise<boolean> {
  return moveFocusedExtensionSlot(group === "secondary" ? "dockSecondary" : "dockPrimary", root);
}

export async function resizeExtensionDockSplit(delta: number): Promise<boolean> {
  if (!hasExtensionDockSplit()) return false;
  const settings = canonicalExtensionUiSettings(useAppStore.getState().desktopSettings);
  const current = settings.dock.sizes?.[0] ?? 0.5;
  const nextPrimary = Math.min(0.8, Math.max(MIN_EXTENSION_UI_DOCK_SIZE, current + delta));
  const next: [number, number] = [nextPrimary, 1 - nextPrimary];
  if (next[0] === current) return false;
  try {
    await commitExtensionUiSettings({
      update: (latest) => {
        const latestPrimary = latest.dock.sizes?.[0] ?? 0.5;
        const updatedPrimary = Math.min(
          0.8,
          Math.max(MIN_EXTENSION_UI_DOCK_SIZE, latestPrimary + delta),
        );
        return {
          ...latest,
          dock: {
            ...latest.dock,
            secondaryEnabled: true,
            sizes: [updatedPrimary, 1 - updatedPrimary],
          },
        };
      },
      message: tCurrent("extensionUiChangedHome", {
        name: tCurrent("extensionUiDockArea"),
        family: tCurrent("extensionUiSettingsGroup"),
      }),
    });
    return true;
  } catch (error) {
    notifyDesktopSettingsSaveFailure(error);
    return false;
  }
}

export async function resetFocusedExtensionFamily(root?: ParentNode | null): Promise<boolean> {
  const slot = slotById(readFocusedExtensionSlotId(root));
  if (!slot?.extensionId) return false;
  try {
    await commitExtensionPresentationHome({
      extensionId: slot.extensionId,
      family: slot.family,
      home: undefined,
      message: tCurrent("extensionUiChangedHome", {
        name: observedExtensionDisplayName(slot.extensionId),
        family: tCurrent(extensionUiFamilyMessageKey(slot.family)),
      }),
    });
    return true;
  } catch (error) {
    notifyDesktopSettingsSaveFailure(error);
    return false;
  }
}
