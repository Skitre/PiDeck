import type { DockGroupId } from "@pideck/protocol";
import type { ExtensionPresentationSlot, PresentationSlotMount } from "./extension-ui-slots";

export type DockedPresentationSlot = {
  slotId: string;
  extensionId?: string;
  family: ExtensionPresentationSlot["family"];
  group: DockGroupId;
  order: number;
  slot: ExtensionPresentationSlot;
  mount: PresentationSlotMount;
};

export function collectDockedPresentationSlots(
  slots: readonly ExtensionPresentationSlot[],
): DockedPresentationSlot[] {
  const collected: DockedPresentationSlot[] = [];
  for (const slot of slots) {
    for (const mount of slot.mounts) {
      if (mount.home.kind !== "dock") continue;
      collected.push({
        slotId: slot.slotId,
        extensionId: slot.extensionId,
        family: slot.family,
        group: mount.home.group,
        order: mount.home.order,
        slot,
        mount,
      });
    }
  }
  return collected.sort(
    (left, right) =>
      left.group.localeCompare(right.group) ||
      left.order - right.order ||
      left.slotId.localeCompare(right.slotId),
  );
}

export function partitionExtensionDockGroups(items: readonly DockedPresentationSlot[]): {
  primary: DockedPresentationSlot[];
  secondary: DockedPresentationSlot[];
} {
  const primary = items.filter((item) => item.group === "primary");
  const secondary = items.filter((item) => item.group === "secondary");
  if (primary.length === 0 && secondary.length > 0) {
    return {
      primary: secondary.map((item) => ({ ...item, group: "primary" })),
      secondary: [],
    };
  }
  return { primary, secondary };
}

export function hasLiveDockedExtensionContent(
  slots: readonly ExtensionPresentationSlot[],
): boolean {
  return collectDockedPresentationSlots(slots).length > 0;
}
