import {
  trustedExtensionId,
  type ExtensionSurfaceFamily,
  type ExtensionUiOrigin,
  type ExtensionUiSettings,
  type PresentationHome,
} from "@pideck/protocol";
import {
  applyLiveFloatCap,
  resolveExtensionPresentation,
  type ExtensionPresentationHint,
  type ResolvedPresentation,
} from "./extension-ui-resolver";

export type LiveWidgetContent = {
  key: string;
  widget: unknown;
  placement?: "aboveEditor" | "belowEditor";
  origin?: ExtensionUiOrigin;
};

export type LiveStatusContent = {
  key: string;
  text: string;
  origin?: ExtensionUiOrigin;
};

export type LiveCustomContent = {
  requestId: string;
  title?: string;
  origin?: ExtensionUiOrigin;
  overlay?: boolean;
};

export type PresentationSlotMount = {
  home: PresentationHome;
  widgets?: LiveWidgetContent[];
  statuses?: LiveStatusContent[];
  custom?: LiveCustomContent;
};

export type ExtensionPresentationSlot = {
  slotId: string;
  extensionId?: string;
  family: Exclude<ExtensionSurfaceFamily, "blockingDialog">;
  source: ResolvedPresentation["source"];
  mounts: PresentationSlotMount[];
};

function slotId(extensionId: string | undefined, family: string, fallbackKey?: string): string {
  if (extensionId) return `${extensionId}:${family}`;
  return `unknown:${family}:${fallbackKey ?? "default"}`;
}

function compareSlotIds(left: ExtensionPresentationSlot, right: ExtensionPresentationSlot): number {
  const leftId = left.extensionId ?? `\uFFFF${left.slotId}`;
  const rightId = right.extensionId ?? `\uFFFF${right.slotId}`;
  return leftId.localeCompare(rightId) || left.family.localeCompare(right.family);
}

function applyCapToSlots(slots: ExtensionPresentationSlot[]): ExtensionPresentationSlot[] {
  let liveFloats = 0;
  return slots.map((slot) => ({
    ...slot,
    mounts: slot.mounts.map((mount) => {
      const home = applyLiveFloatCap(mount.home, liveFloats);
      if (home.kind === "float") liveFloats += 1;
      return { ...mount, home };
    }),
  }));
}

function partitionWidgets(widgets: LiveWidgetContent[]): {
  above: LiveWidgetContent[];
  below: LiveWidgetContent[];
} {
  const above: LiveWidgetContent[] = [];
  const below: LiveWidgetContent[] = [];
  for (const widget of widgets) {
    if (widget.placement === "belowEditor") below.push(widget);
    else above.push(widget);
  }
  return { above, below };
}

function widgetSlot(
  widgets: LiveWidgetContent[],
  settings: ExtensionUiSettings,
  extensionId?: string,
  fallbackKey?: string,
): ExtensionPresentationSlot {
  const hint: ExtensionPresentationHint | undefined = widgets[0]?.placement
    ? { placement: widgets[0].placement }
    : undefined;
  const resolved = resolveExtensionPresentation({
    family: "widget",
    settings,
    extensionId,
    hint,
  });
  if (resolved.source === "profile") {
    return {
      slotId: slotId(extensionId, "widget", fallbackKey),
      extensionId,
      family: "widget",
      source: resolved.source,
      mounts: [{ home: resolved.home, widgets }],
    };
  }
  const { above, below } = partitionWidgets(widgets);
  const mounts: PresentationSlotMount[] = [];
  if (above.length > 0) {
    mounts.push({ home: { kind: "anchor", slot: "aboveComposer" }, widgets: above });
  }
  if (below.length > 0) {
    mounts.push({ home: { kind: "anchor", slot: "belowComposer" }, widgets: below });
  }
  return {
    slotId: slotId(extensionId, "widget", fallbackKey),
    extensionId,
    family: "widget",
    source: resolved.source,
    mounts: mounts.length > 0 ? mounts : [{ home: resolved.home, widgets }],
  };
}

export function buildExtensionPresentationSlots(input: {
  settings: ExtensionUiSettings;
  widgets: readonly LiveWidgetContent[];
  statuses: readonly LiveStatusContent[];
  custom?: LiveCustomContent | null;
}): ExtensionPresentationSlot[] {
  const slots: ExtensionPresentationSlot[] = [];
  const widgetsById = new Map<string | undefined, LiveWidgetContent[]>();
  for (const widget of input.widgets) {
    const extensionId = trustedExtensionId(widget.origin);
    const bucket = widgetsById.get(extensionId) ?? [];
    bucket.push(widget);
    widgetsById.set(extensionId, bucket);
  }
  for (const [extensionId, widgets] of widgetsById) {
    if (extensionId) {
      slots.push(widgetSlot(widgets, input.settings, extensionId));
      continue;
    }
    for (const widget of widgets) {
      slots.push(widgetSlot([widget], input.settings, undefined, widget.key));
    }
  }

  const statusesById = new Map<string | undefined, LiveStatusContent[]>();
  for (const status of input.statuses) {
    const extensionId = trustedExtensionId(status.origin);
    const bucket = statusesById.get(extensionId) ?? [];
    bucket.push(status);
    statusesById.set(extensionId, bucket);
  }
  for (const [extensionId, statuses] of statusesById) {
    if (extensionId) {
      const resolved = resolveExtensionPresentation({
        family: "status",
        settings: input.settings,
        extensionId,
      });
      slots.push({
        slotId: slotId(extensionId, "status"),
        extensionId,
        family: "status",
        source: resolved.source,
        mounts: [{ home: resolved.home, statuses }],
      });
      continue;
    }
    for (const status of statuses) {
      const resolved = resolveExtensionPresentation({
        family: "status",
        settings: input.settings,
      });
      slots.push({
        slotId: slotId(undefined, "status", status.key),
        family: "status",
        source: resolved.source,
        mounts: [{ home: resolved.home, statuses: [status] }],
      });
    }
  }

  if (input.custom) {
    const extensionId = trustedExtensionId(input.custom.origin);
    const resolved = resolveExtensionPresentation({
      family: "custom",
      settings: input.settings,
      extensionId,
      hint: { overlay: input.custom.overlay },
    });
    slots.push({
      slotId: slotId(extensionId, "custom", input.custom.requestId),
      extensionId,
      family: "custom",
      source: resolved.source,
      mounts: [{ home: resolved.home, custom: input.custom }],
    });
  }

  return applyCapToSlots(slots.sort(compareSlotIds));
}

function flattenPresentationMounts(slots: readonly ExtensionPresentationSlot[]): Array<{
  slot: ExtensionPresentationSlot;
  mount: PresentationSlotMount;
}> {
  return slots.flatMap((slot) => slot.mounts.map((mount) => ({ slot, mount })));
}

export function countLiveFloatMounts(slots: readonly ExtensionPresentationSlot[]): number {
  return flattenPresentationMounts(slots).filter(({ mount }) => mount.home.kind === "float").length;
}

export function mountsForHome(
  slots: readonly ExtensionPresentationSlot[],
  match: (home: PresentationHome) => boolean,
): Array<{ slot: ExtensionPresentationSlot; mount: PresentationSlotMount }> {
  return flattenPresentationMounts(slots).filter(({ mount }) => match(mount.home));
}
