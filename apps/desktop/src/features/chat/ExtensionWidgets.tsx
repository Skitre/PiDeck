import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
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
 * composer card. The chevron tab sits on the card's bottom edge; opening it
 * never moves the input: the panel is an overlay anchored above the card
 * (same width), growing upward with an internal scroll cap. Dismiss via the
 * tab, an outside click, or Escape. Must render inside the composer's
 * `relative` anchor wrapper.
 */
export function ExtensionWidgets() {
  const widgets = useAppStore((state) => state.extensionWidgets);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const entries = Object.values(widgets);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (
        rootRef.current &&
        event.target instanceof Node &&
        !rootRef.current.contains(event.target)
      ) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (entries.length === 0) return null;

  return (
    <div ref={rootRef}>
      <div className="flex justify-center">
        <button
          type="button"
          aria-expanded={open}
          aria-label="Toggle extension widgets"
          title={`Extension widgets: ${entries.map((entry) => entry.key).join(", ")}`}
          className="-mt-px flex h-4 w-10 items-center justify-center rounded-b-md border border-t-0 border-border bg-surface-raised text-muted hover:text-foreground"
          onClick={() => setOpen((current) => !current)}
        >
          <ChevronDown
            size={12}
            className={`transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>
      </div>
      {open && (
        <div className="absolute bottom-full left-0 right-0 z-30 mb-2 max-h-[65vh] overflow-auto rounded-lg border border-border bg-surface-raised px-4 py-2 shadow-xl">
          {entries.map((entry) => (
            <section
              key={entry.key}
              className="py-1"
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
