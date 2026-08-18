import { useId, useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, PanelsTopLeft, X } from "lucide-react";
import { useAppStore } from "../../lib/stores/app-store";
import { useT } from "../../lib/i18n/use-t";

type WidgetPlacement = "aboveEditor" | "belowEditor";

type PlaceableWidget<T> = T & { placement?: WidgetPlacement };

export function partitionExtensionWidgets<T>(entries: readonly PlaceableWidget<T>[]): {
  aboveEditor: PlaceableWidget<T>[];
  belowEditor: PlaceableWidget<T>[];
} {
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

export function isUsableWidgetAnchor(anchor: WidgetAnchorRect): boolean {
  return Number.isFinite(anchor.width) && anchor.width >= 80;
}

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
    if (!open) {
      setLayout(null);
      return;
    }

    const update = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const nextAnchor = {
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        width: rect.width,
      };
      if (!isUsableWidgetAnchor(nextAnchor)) return;
      setLayout(
        calculateWidgetPopoverLayout({
          anchor: nextAnchor,
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
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    if (anchorRef.current) {
      observer?.observe(anchorRef.current);
      // The dock/sidebar transitions resize the composer's container while the
      // max-width anchor itself can keep exactly the same dimensions. Observe
      // that container too so the portaled drawer follows the anchor's new
      // viewport position throughout those layout transitions.
      if (anchorRef.current.parentElement) {
        observer?.observe(anchorRef.current.parentElement);
      }
    }

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
  collapsedWidgetKeys,
  placementLabel,
  position,
  onClose,
  onToggleCollapsed,
}: {
  entries: Array<{ key: string; widget: unknown }>;
  collapsedWidgetKeys: Readonly<Record<string, true>>;
  placementLabel: "above" | "below" | "around";
  position: WidgetPopoverPosition | null;
  onClose: () => void;
  onToggleCollapsed: (key: string) => void;
}) {
  const t = useT();
  if (entries.length === 0) return null;

  const panelLabel =
    placementLabel === "above"
      ? t("extWidgetsAboveEditor")
      : placementLabel === "below"
        ? t("extWidgetsBelowEditor")
        : t("extWidgetsAroundEditor");
  const closeLabel =
    placementLabel === "above"
      ? t("extWidgetsCloseAboveEditor")
      : placementLabel === "below"
        ? t("extWidgetsCloseBelowEditor")
        : t("extWidgetsCloseAroundEditor");

  if (!position || position.width < 80) return null;

  const style: CSSProperties = {
    left: position.left,
    width: position.width,
    maxHeight: position.maxHeight,
    ...(position.top !== undefined ? { top: position.top } : {}),
    ...(position.bottom !== undefined ? { bottom: position.bottom } : {}),
  };

  return (
    <div
      className="theme-floating-surface fixed z-40 overflow-auto rounded-lg border border-border bg-surface-raised px-4 py-2 shadow-xl"
      style={style}
      data-widget-popover
      data-widget-popover-side={position.side}
      aria-label={panelLabel}
    >
      <button
        type="button"
        aria-label={closeLabel}
        title={closeLabel}
        className="absolute right-2 top-2 flex size-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground"
        onClick={onClose}
      >
        <X size={15} />
      </button>
      {entries.map((entry) => {
        const collapsed = collapsedWidgetKeys[entry.key] === true;
        return (
          <WidgetSection
            key={entry.key}
            entry={entry}
            collapsed={collapsed}
            onToggle={() => onToggleCollapsed(entry.key)}
          />
        );
      })}
    </div>
  );
}

function WidgetSection({
  entry,
  collapsed,
  onToggle,
}: {
  entry: { key: string; widget: unknown };
  collapsed: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  const contentId = useId();
  const toggleLabel = t(collapsed ? "extWidgetExpand" : "extWidgetCollapse", {
    key: entry.key,
  });

  return (
    <section className="py-1 pr-8" aria-label={t("extWidgetLabel", { key: entry.key })}>
      <button
        type="button"
        className="group flex min-h-7 w-full items-center gap-1.5 rounded px-1 text-left transition-colors hover:bg-surface-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/50"
        aria-expanded={!collapsed}
        aria-controls={contentId}
        aria-label={toggleLabel}
        title={toggleLabel}
        onClick={onToggle}
      >
        <ChevronRight
          aria-hidden="true"
          size={13}
          className={`shrink-0 text-muted transition-transform duration-150 motion-reduce:transition-none ${
            collapsed ? "" : "rotate-90"
          }`}
        />
        <span className="min-w-0 break-words text-[10px] font-medium uppercase text-muted group-hover:text-foreground">
          {entry.key}
        </span>
      </button>
      {!collapsed && (
        <pre
          id={contentId}
          className="mt-1 whitespace-pre-wrap break-words pl-5 font-mono text-xs text-foreground"
        >
          {renderWidget(entry.widget)}
        </pre>
      )}
    </section>
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
  const collapsedWidgetKeys = useAppStore((state) => state.collapsedExtensionWidgetKeys);
  const onToggleCollapsed = useAppStore((state) => state.toggleExtensionWidgetCollapsed);
  const entries = Object.values(widgets);
  const { aboveEditor, belowEditor } = partitionExtensionWidgets(entries);
  const layout = useWidgetPopoverLayout(
    anchorRef,
    open && entries.length > 0,
    aboveEditor.length > 0,
    belowEditor.length > 0,
  );

  if (!open || entries.length === 0 || !layout) return null;

  const panels = (
    <>
      {layout?.combined ? (
        <WidgetPanel
          entries={entries}
          collapsedWidgetKeys={collapsedWidgetKeys}
          placementLabel="around"
          position={layout.combined}
          onClose={onClose}
          onToggleCollapsed={onToggleCollapsed}
        />
      ) : (
        <>
          <WidgetPanel
            entries={aboveEditor}
            collapsedWidgetKeys={collapsedWidgetKeys}
            placementLabel="above"
            position={layout?.above ?? null}
            onClose={onClose}
            onToggleCollapsed={onToggleCollapsed}
          />
          <WidgetPanel
            entries={belowEditor}
            collapsedWidgetKeys={collapsedWidgetKeys}
            placementLabel="below"
            position={layout?.below ?? null}
            onClose={onClose}
            onToggleCollapsed={onToggleCollapsed}
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
  const t = useT();
  const widgets = useAppStore((state) => state.extensionWidgets);
  const entries = Object.values(widgets);

  if (entries.length === 0) return null;

  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={t("extWidgetsToggle")}
      title={t("extWidgetsTitle", {
        names: entries.map((entry) => entry.key).join(", "),
      })}
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
