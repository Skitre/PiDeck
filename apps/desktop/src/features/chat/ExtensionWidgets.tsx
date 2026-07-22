import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import { PanelsTopLeft, X } from "lucide-react";
import { useAppStore } from "../../lib/stores/app-store";

type WidgetPlacement = "aboveEditor" | "belowEditor";

type PlaceableWidget<T> = T & { placement?: WidgetPlacement };

export function partitionExtensionWidgets<T>(
  entries: readonly PlaceableWidget<T>[],
): { aboveEditor: PlaceableWidget<T>[]; belowEditor: PlaceableWidget<T>[] } {
  const aboveEditor: PlaceableWidget<T>[] = [];
  const belowEditor: PlaceableWidget<T>[] = [];

  for (const entry of entries) {
    if (entry.placement === "belowEditor") {
      belowEditor.push(entry);
    } else {
      aboveEditor.push(entry);
    }
  }

  return { aboveEditor, belowEditor };
}

function renderWidget(widget: unknown): string {
  if (typeof widget === "string") return widget;
  if (typeof widget === "number" || typeof widget === "boolean") return String(widget);
  if (Array.isArray(widget) && widget.every((line) => typeof line === "string")) {
    return widget.join("\n");
  }
  return JSON.stringify(widget, null, 2);
}

type WidgetAnchorRect = {
  top: number;
  bottom: number;
  left: number;
  width: number;
};

export type WidgetPopoverPosition = {
  side: "above" | "below";
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
};

export type WidgetPopoverLayout = {
  above: WidgetPopoverPosition | null;
  below: WidgetPopoverPosition | null;
  combined: WidgetPopoverPosition | null;
};

export function calculateWidgetPopoverPosition({
  anchor,
  viewportWidth,
  viewportHeight,
  preferredPlacement,
  compact,
}: {
  anchor: WidgetAnchorRect;
  viewportWidth: number;
  viewportHeight: number;
  preferredPlacement: WidgetPlacement;
  compact: boolean;
}): WidgetPopoverPosition {
  const margin = 8;
  const gap = 8;
  const availableWidth = Math.max(1, viewportWidth - margin * 2);
  const width = Math.min(Math.max(1, anchor.width), availableWidth);
  const left = Math.min(
    Math.max(anchor.left, margin),
    Math.max(margin, viewportWidth - margin - width),
  );
  const availableAbove = Math.max(0, anchor.top - gap - margin);
  const availableBelow = Math.max(0, viewportHeight - anchor.bottom - gap - margin);
  const preferredSide = preferredPlacement === "belowEditor" ? "below" : "above";
  const preferredSpace = preferredSide === "above" ? availableAbove : availableBelow;
  const alternateSpace = preferredSide === "above" ? availableBelow : availableAbove;
  const idealMaxHeight = viewportHeight * (compact ? 0.18 : 0.32);
  const minimumUsefulHeight = Math.min(idealMaxHeight, 96);
  const side =
    preferredSpace >= minimumUsefulHeight || preferredSpace >= alternateSpace
      ? preferredSide
      : preferredSide === "above"
        ? "below"
        : "above";
  const sideSpace = side === "above" ? availableAbove : availableBelow;
  const maxHeight = Math.max(1, Math.min(idealMaxHeight, sideSpace));

  return {
    side,
    left,
    width,
    maxHeight,
    ...(side === "above"
      ? { bottom: viewportHeight - anchor.top + gap }
      : { top: anchor.bottom + gap }),
  };
}

export function calculateWidgetPopoverLayout({
  anchor,
  viewportWidth,
  viewportHeight,
  hasAbove,
  hasBelow,
}: {
  anchor: WidgetAnchorRect;
  viewportWidth: number;
  viewportHeight: number;
  hasAbove: boolean;
  hasBelow: boolean;
}): WidgetPopoverLayout {
  const mixed = hasAbove && hasBelow;
  const above = hasAbove
    ? calculateWidgetPopoverPosition({
        anchor,
        viewportWidth,
        viewportHeight,
        preferredPlacement: "aboveEditor",
        compact: mixed,
      })
    : null;
  const below = hasBelow
    ? calculateWidgetPopoverPosition({
        anchor,
        viewportWidth,
        viewportHeight,
        preferredPlacement: "belowEditor",
        compact: mixed,
      })
    : null;

  if (!above || !below || above.side !== below.side) {
    return { above, below, combined: null };
  }

  return {
    above: null,
    below: null,
    combined: calculateWidgetPopoverPosition({
      anchor,
      viewportWidth,
      viewportHeight,
      preferredPlacement: above.side === "above" ? "aboveEditor" : "belowEditor",
      compact: false,
    }),
  };
}

function useWidgetPopoverLayout(
  anchorRef: RefObject<HTMLElement | null>,
  open: boolean,
  hasAbove: boolean,
  hasBelow: boolean,
): WidgetPopoverLayout | null {
  const [layout, setLayout] = useState<WidgetPopoverLayout | null>(null);

  useLayoutEffect(() => {
    if (!open) return;

    const update = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      setLayout(
        calculateWidgetPopoverLayout({
          anchor: {
            top: rect.top,
            bottom: rect.bottom,
            left: rect.left,
            width: rect.width,
          },
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          hasAbove,
          hasBelow,
        }),
      );
    };

    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    if (anchorRef.current) observer?.observe(anchorRef.current);

    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      observer?.disconnect();
    };
  }, [anchorRef, hasAbove, hasBelow, open]);

  return layout;
}

export function WidgetPanel({
  entries,
  placementLabel,
  position,
  onClose,
}: {
  entries: Array<{ key: string; widget: unknown }>;
  placementLabel: "above" | "below" | "around";
  position: WidgetPopoverPosition | null;
  onClose: () => void;
}) {
  if (entries.length === 0) return null;

  const style: CSSProperties = position
    ? {
        left: position.left,
        width: position.width,
        maxHeight: position.maxHeight,
        ...(position.top !== undefined ? { top: position.top } : {}),
        ...(position.bottom !== undefined ? { bottom: position.bottom } : {}),
      }
    : { left: 0, top: 0, width: 1, maxHeight: 1 };

  return (
    <div
      className={`fixed z-40 overflow-auto rounded-lg border border-border bg-surface-raised px-4 py-2 shadow-xl ${
        position ? "" : "invisible pointer-events-none"
      }`}
      style={style}
      data-widget-popover-side={position?.side}
      aria-label={`Extension widgets ${placementLabel} editor`}
    >
      <button
        type="button"
        aria-label={`Close extension widgets ${placementLabel} editor`}
        title={`Close extension widgets ${placementLabel} editor`}
        className="absolute right-2 top-2 flex size-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground"
        onClick={onClose}
      >
        <X size={15} />
      </button>
      {entries.map((entry) => (
        <section
          key={entry.key}
          className="py-1 pr-8"
          aria-label={`Extension widget ${entry.key}`}
        >
          <div className="mb-1 text-[10px] font-medium uppercase text-muted">
            {entry.key}
          </div>
          <pre className="whitespace-pre-wrap break-words font-mono text-xs text-foreground">
            {renderWidget(entry.widget)}
          </pre>
        </section>
      ))}
    </div>
  );
}

/** Floating extension drawer anchored to the composer without affecting layout. */
export function ExtensionWidgetsPopover({
  anchorRef,
  open,
  onClose,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
}) {
  const widgets = useAppStore((state) => state.extensionWidgets);
  const entries = Object.values(widgets);
  const { aboveEditor, belowEditor } = partitionExtensionWidgets(entries);
  const layout = useWidgetPopoverLayout(
    anchorRef,
    open && entries.length > 0,
    aboveEditor.length > 0,
    belowEditor.length > 0,
  );

  if (!open || entries.length === 0) return null;

  const panels = (
    <>
      {layout?.combined ? (
        <WidgetPanel
          entries={entries}
          placementLabel="around"
          position={layout.combined}
          onClose={onClose}
        />
      ) : (
        <>
          <WidgetPanel
            entries={aboveEditor}
            placementLabel="above"
            position={layout?.above ?? null}
            onClose={onClose}
          />
          <WidgetPanel
            entries={belowEditor}
            placementLabel="below"
            position={layout?.below ?? null}
            onClose={onClose}
          />
        </>
      )}
    </>
  );
  return typeof document === "undefined" ? panels : createPortal(panels, document.body);
}

export function ExtensionWidgetsButton({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  const widgets = useAppStore((state) => state.extensionWidgets);
  const entries = Object.values(widgets);

  if (entries.length === 0) return null;

  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label="Toggle extension widgets"
      title={`Extension widgets: ${entries.map((entry) => entry.key).join(", ")}`}
      className={`flex size-7 items-center justify-center rounded-md transition-colors ${
        open
          ? "bg-accent/15 text-accent"
          : "text-muted hover:bg-surface-overlay hover:text-foreground"
      }`}
      onClick={onToggle}
    >
      <PanelsTopLeft size={15} />
    </button>
  );
}
