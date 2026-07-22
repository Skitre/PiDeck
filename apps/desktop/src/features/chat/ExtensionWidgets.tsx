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

function WidgetPanel({
  entries,
  placement,
  compact,
  onClose,
}: {
  entries: Array<{ key: string; widget: unknown }>;
  placement: WidgetPlacement;
  compact: boolean;
  onClose: () => void;
}) {
  if (entries.length === 0) return null;

  const isAboveEditor = placement === "aboveEditor";
  const placementLabel = isAboveEditor ? "above" : "below";

  return (
    <div
      className={`relative overflow-auto rounded-lg border border-border bg-surface-raised px-4 py-2 shadow-md ${
        compact ? "max-h-[18vh]" : "max-h-[32vh]"
      } ${
        isAboveEditor ? "mb-2" : "mt-2"
      }`}
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

/**
 * Extension widgets use normal-flow panels so below-editor content remains
 * inside the app viewport. Missing placement defaults above to match Pi.
 */
export function ExtensionWidgetPanel({
  placement,
  open,
  onClose,
}: {
  placement: WidgetPlacement;
  open: boolean;
  onClose: () => void;
}) {
  const widgets = useAppStore((state) => state.extensionWidgets);
  const entries = Object.values(widgets);
  const { aboveEditor, belowEditor } = partitionExtensionWidgets(entries);
  const selected = placement === "aboveEditor" ? aboveEditor : belowEditor;
  const compact = aboveEditor.length > 0 && belowEditor.length > 0;

  if (!open || selected.length === 0) return null;

  return (
    <WidgetPanel
      entries={selected}
      placement={placement}
      compact={compact}
      onClose={onClose}
    />
  );
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
