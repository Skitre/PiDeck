import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Pin, X } from "lucide-react";
import type { PresentationHome } from "@pideck/protocol";
import { observedExtensionDisplayName } from "../../lib/extension-ui-observation";
import {
  clampAndSnapFloatRect,
  floatRectToPixels,
  pixelsToNormalizedFloatRect,
  readBrowserExclusionRect,
  resizeFloatRect,
  type FloatResizeEdge,
  type PixelRect,
} from "../../lib/extension-ui-float-geometry";
import {
  extensionUiFamilyMessageKey,
  extensionUiHomeMessageKey,
} from "../../lib/extension-ui-home-message";
import { isExtensionDeckV1Enabled } from "../../lib/extension-deck-gate";
import { useLiveExtensionPresentationSlots } from "../../lib/extension-ui-live-slots";
import {
  clearExtensionUiUndo,
  commitExtensionPresentationHome,
  getExtensionUiUndo,
  subscribeExtensionUiUndo,
  undoExtensionUiSettings,
} from "../../lib/extension-ui-profile";
import {
  mountsForHome,
  type ExtensionPresentationSlot,
  type PresentationSlotMount,
} from "../../lib/extension-ui-slots";
import { useAppStore } from "../../lib/stores/app-store";
import { useT } from "../../lib/i18n/use-t";
import { notifyDesktopSettingsSaveFailure } from "../../lib/desktop-settings";
import { cancelExtensionTerminal, forceCloseExtensionTerminal } from "../dock/ExtensionTerminal";
import { ExtensionTerminal } from "../dock/ExtensionTerminal";
import { statusChipText } from "../../lib/extension-ui-status-text";
import { ExtensionStatusRows, ExtensionWidgetRows } from "./ExtensionWidgetContent";

function usePresentationSlots(): ExtensionPresentationSlot[] {
  return useLiveExtensionPresentationSlots();
}

async function persistHome(
  slot: ExtensionPresentationSlot,
  home: PresentationHome,
  message: string,
): Promise<void> {
  if (!slot.extensionId) return;
  try {
    await commitExtensionPresentationHome({
      extensionId: slot.extensionId,
      family: slot.family,
      home,
      message,
    });
  } catch (error) {
    notifyDesktopSettingsSaveFailure(error);
  }
}

function SlotBody({ mount }: { mount: PresentationSlotMount }) {
  if (mount.widgets?.length) return <ExtensionWidgetRows widgets={mount.widgets} />;
  if (mount.statuses?.length) return <ExtensionStatusRows statuses={mount.statuses} />;
  if (mount.custom) return <ExtensionTerminal visible />;
  return null;
}

export function ExtensionStatusChipRail() {
  const t = useT();
  const slots = usePresentationSlots();
  const chips = mountsForHome(
    slots,
    (home) => home.kind === "anchor" && home.slot === "aboveComposer",
  ).flatMap(({ slot, mount }) =>
    slot.family === "status"
      ? (mount.statuses ?? []).map((entry) => ({
          id: `${slot.slotId}:${entry.key}`,
          label: statusChipText(entry.key, entry.text),
        }))
      : [],
  );
  if (chips.length === 0) return null;
  return (
    <div
      data-extension-status-rail
      aria-label={t("extensionUiStatusAbove")}
      className="mb-1 max-h-[2.25rem] overflow-hidden px-1 text-[10px] leading-3 text-muted"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {chips.map((chip) => (
          <span key={chip.id} className="min-w-0 max-w-[18rem] truncate" title={chip.label}>
            {chip.label}
          </span>
        ))}
      </div>
    </div>
  );
}

export function ExtensionAnchorSlots({ slot }: { slot: "aboveComposer" | "belowComposer" }) {
  const t = useT();
  const slots = usePresentationSlots();
  const collapsedWidgetKeys = useAppStore((state) => state.collapsedExtensionWidgetKeys);
  const mounts = mountsForHome(
    slots,
    (home) => home.kind === "anchor" && home.slot === slot,
  ).filter(({ mount }) => Boolean(mount.widgets?.length));
  if (mounts.length === 0) return null;
  const collapsed = mounts.every(({ mount }) =>
    (mount.widgets ?? []).every((widget) => collapsedWidgetKeys[widget.key] === true),
  );
  const label =
    slot === "belowComposer" ? t("extensionUiAnchorBelow") : t("extensionUiAnchorAbove");
  return (
    <div
      className={`mb-1 overflow-auto rounded-md border border-border bg-surface-raised ${
        collapsed ? "px-2 py-0" : "max-h-40 px-2.5 py-0.5"
      }`}
      data-extension-anchor={slot}
      data-extension-anchor-collapsed={collapsed ? "true" : "false"}
      data-extension-drop={slot}
      aria-label={label}
    >
      {mounts.map(({ slot: presentation, mount }) => (
        <div key={`${presentation.slotId}:${slot}`} data-extension-slot={presentation.slotId}>
          <SlotBody mount={mount} />
        </div>
      ))}
    </div>
  );
}

export function ExtensionDockStrip() {
  const t = useT();
  const slots = usePresentationSlots();
  if (isExtensionDeckV1Enabled()) {
    return (
      <div
        className="sr-only"
        data-extension-dock
        data-extension-drop="dock-primary"
        aria-hidden="true"
      />
    );
  }
  const docked = mountsForHome(slots, (home) => home.kind === "dock").filter(
    ({ mount }) => !mount.custom,
  );
  if (docked.length === 0) {
    return (
      <div
        className="sr-only"
        data-extension-dock
        data-extension-drop="dock-primary"
        aria-hidden="true"
      />
    );
  }
  return (
    <div
      className="shrink-0 border-b border-border bg-surface-raised px-3 py-2"
      data-extension-dock
      data-extension-drop="dock-primary"
      aria-label={t("extensionUiDockArea")}
    >
      <div className="flex flex-col gap-2">
        {docked.map(({ slot, mount }) => (
          <div key={slot.slotId} data-extension-slot={slot.slotId}>
            <SlotBody mount={mount} />
          </div>
        ))}
      </div>
    </div>
  );
}

export function ExtensionFloatLayer() {
  const page = useAppStore((state) => state.page);
  const slots = usePresentationSlots();
  const floats = mountsForHome(slots, (home) => home.kind === "float");
  if (page !== "chat" || floats.length === 0) return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-30" data-extension-float-layer>
      {floats.map(({ slot, mount }) => (
        <ExtensionFloatShell key={slot.slotId} slot={slot} mount={mount} />
      ))}
    </div>
  );
}

const FLOAT_RESIZE_HANDLES: { edge: FloatResizeEdge; className: string }[] = [
  {
    edge: "n",
    className: "absolute inset-x-3 top-0 z-20 h-1.5 cursor-n-resize touch-none hover:bg-accent/25",
  },
  {
    edge: "s",
    className: "absolute inset-x-3 bottom-0 z-20 h-1.5 cursor-s-resize touch-none hover:bg-accent/25",
  },
  {
    edge: "e",
    className:
      "absolute bottom-3 right-0 top-8 z-20 w-1.5 cursor-e-resize touch-none hover:bg-accent/25",
  },
  {
    edge: "w",
    className:
      "absolute bottom-3 left-0 top-8 z-20 w-1.5 cursor-w-resize touch-none hover:bg-accent/25",
  },
  {
    edge: "ne",
    className: "absolute right-0 top-8 z-30 size-2.5 cursor-ne-resize touch-none",
  },
  {
    edge: "nw",
    className: "absolute left-0 top-0 z-30 size-2.5 cursor-nw-resize touch-none",
  },
  {
    edge: "se",
    className: "absolute bottom-0 right-0 z-30 size-3.5 cursor-se-resize touch-none",
  },
  {
    edge: "sw",
    className: "absolute bottom-0 left-0 z-30 size-2.5 cursor-sw-resize touch-none",
  },
];

function samePixelRect(left: PixelRect, right: PixelRect): boolean {
  return (
    left.left === right.left &&
    left.top === right.top &&
    left.width === right.width &&
    left.height === right.height
  );
}

function homeFromDropTarget(target: EventTarget | null): PresentationHome | null {
  const element =
    target instanceof Element ? target.closest<HTMLElement>("[data-extension-drop]") : null;
  const drop = element?.dataset.extensionDrop;
  if (drop === "dock-primary") return { kind: "dock", group: "primary", order: 0 };
  if (drop === "dock-secondary") return { kind: "dock", group: "secondary", order: 0 };
  if (drop === "aboveComposer") return { kind: "anchor", slot: "aboveComposer" };
  if (drop === "belowComposer") return { kind: "anchor", slot: "belowComposer" };
  return null;
}

function ExtensionFloatShell({
  slot,
  mount,
}: {
  slot: ExtensionPresentationSlot;
  mount: PresentationSlotMount;
}) {
  const t = useT();
  const home = mount.home.kind === "float" ? mount.home : null;
  const name = slot.extensionId ? observedExtensionDisplayName(slot.extensionId) : slot.slotId;
  const family = t(extensionUiFamilyMessageKey(slot.family));
  const label = t("extensionUiFloatLabel", { name, family });
  const restoreFocus = useRef<HTMLElement | null>(
    typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null),
  );
  const [pixel, setPixel] = useState<PixelRect>(() =>
    clampAndSnapFloatRect(
      home
        ? floatRectToPixels(home.rect, { width: window.innerWidth, height: window.innerHeight })
        : { left: 80, top: 80, width: 360, height: 240 },
      { width: window.innerWidth, height: window.innerHeight },
      readBrowserExclusionRect(),
    ),
  );
  const pixelRef = useRef(pixel);
  pixelRef.current = pixel;
  const drag = useRef<{
    pointerId: number;
    originX: number;
    originY: number;
    start: PixelRect;
    mode: "move" | "resize";
    edge: FloatResizeEdge;
  } | null>(null);
  const documentDrag = useRef<(() => void) | null>(null);

  useEffect(() => {
    const restore = restoreFocus.current;
    if (slot.family === "custom") {
      const dialog = document.querySelector<HTMLElement>(`[data-extension-float="${slot.slotId}"]`);
      dialog?.focus();
    }
    return () => {
      documentDrag.current?.();
      restore?.focus?.();
    };
  }, [slot.family, slot.slotId]);

  if (!home) return null;

  const persistRect = async (next: PixelRect, nextHome?: PresentationHome) => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const clamped = clampAndSnapFloatRect(next, viewport, readBrowserExclusionRect());
    pixelRef.current = clamped;
    setPixel(clamped);
    const resolved =
      nextHome ??
      ({
        kind: "float",
        rect: pixelsToNormalizedFloatRect(clamped, viewport),
        ...(home.pinned !== undefined ? { pinned: home.pinned } : {}),
      } satisfies PresentationHome);
    await persistHome(slot, resolved, t(extensionUiHomeMessageKey(resolved), { name, family }));
  };

  const applyPointerDelta = (pointerId: number, clientX: number, clientY: number) => {
    const session = drag.current;
    if (!session || session.pointerId !== pointerId) return;
    const dx = clientX - session.originX;
    const dy = clientY - session.originY;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const excluded = readBrowserExclusionRect();
    const next =
      session.mode === "resize"
        ? resizeFloatRect(session.start, session.edge, dx, dy, viewport, excluded)
        : clampAndSnapFloatRect(
            {
              ...session.start,
              left: session.start.left + dx,
              top: session.start.top + dy,
            },
            viewport,
            excluded,
          );
    pixelRef.current = next;
    setPixel(next);
  };

  const finishPointer = (pointerId: number, clientX: number, clientY: number, target: EventTarget | null) => {
    const session = drag.current;
    if (!session || session.pointerId !== pointerId) return;
    drag.current = null;
    documentDrag.current?.();
    documentDrag.current = null;
    const current = pixelRef.current;
    if (session.mode === "move") {
      const drop = homeFromDropTarget(document.elementFromPoint?.(clientX, clientY) ?? target);
      if (drop && (slot.family === "widget" || (slot.family === "custom" && drop.kind === "dock"))) {
        void persistRect(current, drop);
        return;
      }
    }
    if (samePixelRect(current, session.start)) return;
    void persistRect(current);
  };

  const onPointerDown = (
    event: ReactPointerEvent,
    mode: "move" | "resize",
    edge: FloatResizeEdge = "se",
  ) => {
    if (slot.family !== "widget" && slot.family !== "custom") return;
    if (mode === "resize") {
      event.preventDefault();
      event.stopPropagation();
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      start: pixelRef.current,
      mode,
      edge,
    };
    documentDrag.current?.();
    const move = (native: PointerEvent) => applyPointerDelta(native.pointerId, native.clientX, native.clientY);
    const up = (native: PointerEvent) => finishPointer(native.pointerId, native.clientX, native.clientY, native.target);
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", up);
    documentDrag.current = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", up);
    };
  };

  const onPointerMove = (event: ReactPointerEvent) => {
    applyPointerDelta(event.pointerId, event.clientX, event.clientY);
  };

  const onPointerUp = (event: ReactPointerEvent) => {
    finishPointer(event.pointerId, event.clientX, event.clientY, event.target);
  };

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label={label}
      tabIndex={-1}
      data-extension-float={slot.slotId}
      data-extension-pinned={home.pinned === true ? "true" : "false"}
      className="pointer-events-auto absolute flex flex-col overflow-hidden rounded-lg border border-border bg-surface-raised shadow-xl motion-reduce:transition-none"
      style={{ left: pixel.left, top: pixel.top, width: pixel.width, height: pixel.height }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onKeyDown={(event) => {
        if (
          event.key !== "ArrowLeft" &&
          event.key !== "ArrowRight" &&
          event.key !== "ArrowUp" &&
          event.key !== "ArrowDown"
        ) {
          return;
        }
        event.preventDefault();
        const step = event.shiftKey ? 16 : 8;
        const next = { ...pixel };
        if (event.shiftKey) {
          if (event.key === "ArrowRight") next.width += step;
          if (event.key === "ArrowLeft") next.width -= step;
          if (event.key === "ArrowDown") next.height += step;
          if (event.key === "ArrowUp") next.height -= step;
        } else {
          if (event.key === "ArrowRight") next.left += step;
          if (event.key === "ArrowLeft") next.left -= step;
          if (event.key === "ArrowDown") next.top += step;
          if (event.key === "ArrowUp") next.top -= step;
        }
        setPixel(
          clampAndSnapFloatRect(
            next,
            { width: window.innerWidth, height: window.innerHeight },
            readBrowserExclusionRect(),
          ),
        );
      }}
      onKeyUp={(event) => {
        if (event.key.startsWith("Arrow")) void persistRect(pixel);
      }}
    >
      <div
        className="flex h-8 shrink-0 cursor-grab items-center gap-2 border-b border-border px-2"
        onPointerDown={(event) => onPointerDown(event, "move")}
      >
        <span className="min-w-0 flex-1 truncate text-xs text-muted">{label}</span>
        <button
          type="button"
          aria-label={
            home.pinned
              ? t("extensionUiFloatUnpin", { name, family })
              : t("extensionUiFloatPin", { name, family })
          }
          className={`relative z-40 flex size-6 items-center justify-center rounded ${home.pinned ? "text-accent" : "text-muted"}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() =>
            void persistHome(
              slot,
              { ...home, pinned: !home.pinned },
              t(extensionUiHomeMessageKey(home), { name, family }),
            )
          }
        >
          <Pin size={13} />
        </button>
        <button
          type="button"
          aria-label={t("extensionUiFloatClose", { name, family })}
          className="relative z-40 flex size-6 items-center justify-center rounded text-muted hover:text-foreground"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => {
            if (slot.family === "custom" && mount.custom) {
              const panel = useAppStore.getState().extensionTerminal;
              if (panel) {
                void cancelExtensionTerminal(panel).then((error) => {
                  if (error) void forceCloseExtensionTerminal(panel);
                });
              }
              return;
            }
            void persistHome(
              slot,
              { kind: "hidden" },
              t("extensionUiMovedToHidden", { name, family }),
            );
          }}
        >
          <X size={13} />
        </button>
      </div>
      <div className="relative z-0 min-h-0 flex-1 overflow-auto px-3 py-2">
        <SlotBody mount={mount} />
      </div>
      {FLOAT_RESIZE_HANDLES.map(({ edge, className }) => (
        <div
          key={edge}
          role="separator"
          data-extension-resize={edge}
          aria-label={t("extensionUiFloatResize", { name, family })}
          title={t("extensionUiFloatResize", { name, family })}
          className={className}
          onPointerDown={(event) => onPointerDown(event, "resize", edge)}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          {edge === "se" ? (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute bottom-0.5 right-0.5 size-2 border-b-2 border-r-2 border-muted"
            />
          ) : null}
        </div>
      ))}
    </div>
  );
}

export const EXTENSION_UI_UNDO_TOAST_MS = 6_000;

export function ExtensionUiUndoToast() {
  const t = useT();
  const entry = useSyncExternalStore(subscribeExtensionUiUndo, getExtensionUiUndo, () => null);

  useEffect(() => {
    if (!entry) return;
    const timer = window.setTimeout(() => {
      clearExtensionUiUndo();
    }, EXTENSION_UI_UNDO_TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [entry]);

  if (!entry) return null;
  return (
    <div
      role="status"
      data-extension-ui-undo
      className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-border bg-surface-raised px-3 py-2 text-xs shadow-xl"
    >
      <span>
        {entry.message}
        <span className="ml-2 text-muted">{t("extensionUiUndoAppliesToAllSessions")}</span>
      </span>
      <button
        type="button"
        className="rounded border border-border px-2 py-0.5 font-medium hover:bg-surface-overlay"
        onClick={() => {
          void undoExtensionUiSettings().catch(notifyDesktopSettingsSaveFailure);
        }}
      >
        {t("extensionUiUndo")}
      </button>
      <button
        type="button"
        title={t("commonClose")}
        aria-label={t("commonClose")}
        className="flex size-6 items-center justify-center rounded text-muted hover:bg-surface-overlay hover:text-foreground"
        onClick={() => clearExtensionUiUndo()}
      >
        <X size={13} />
      </button>
    </div>
  );
}
