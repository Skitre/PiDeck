import { useState } from "react";
import { PanelsTopLeft, X } from "lucide-react";
import { useAppStore } from "../../lib/stores/app-store";

function renderWidget(widget: unknown): string {
  if (typeof widget === "string") return widget;
  if (typeof widget === "number" || typeof widget === "boolean") return String(widget);
  if (Array.isArray(widget) && widget.every((line) => typeof line === "string")) {
    return widget.join("\n");
  }
  return JSON.stringify(widget, null, 2);
}

/**
 * Extension widgets (ctx.ui.setWidget) — a floating drawer attached to the
 * composer card. Its toolbar trigger opens an overlay above the card (same
 * width), growing upward with an internal scroll cap. It stays open while the
 * user works and closes only from the toolbar trigger or its close button.
 * Must render inside the composer's `relative` anchor wrapper.
 */
export function ExtensionWidgets() {
  const widgets = useAppStore((state) => state.extensionWidgets);
  const [open, setOpen] = useState(false);
  const entries = Object.values(widgets);

  if (entries.length === 0) return null;

  return (
    <div className="contents">
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
        onClick={() => setOpen((current) => !current)}
      >
        <PanelsTopLeft size={15} />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 right-0 z-30 mb-2 max-h-[65vh] overflow-auto rounded-lg border border-border bg-surface-raised px-4 py-2 shadow-xl">
          <button
            type="button"
            aria-label="Close extension widgets"
            title="Close extension widgets"
            className="absolute right-2 top-2 flex size-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground"
            onClick={() => setOpen(false)}
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
      )}
    </div>
  );
}
