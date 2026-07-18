import { useAppStore } from "../../lib/stores/app-store";

function renderWidget(widget: unknown): string {
  if (typeof widget === "string") return widget;
  if (typeof widget === "number" || typeof widget === "boolean") return String(widget);
  return JSON.stringify(widget, null, 2);
}

export function ExtensionWidgets() {
  const widgets = useAppStore((state) => state.extensionWidgets);
  const entries = Object.values(widgets);
  if (entries.length === 0) return null;

  return (
    <div className="max-h-48 shrink-0 overflow-auto border-b border-border bg-surface-overlay/40 px-4 py-2">
      {entries.map((entry) => (
        <section key={entry.key} className="py-1" aria-label={`Extension widget ${entry.key}`}>
          <div className="mb-1 text-[10px] font-medium uppercase text-muted">{entry.key}</div>
          <pre className="whitespace-pre-wrap break-words font-sans text-xs text-foreground">
            {renderWidget(entry.widget)}
          </pre>
        </section>
      ))}
    </div>
  );
}
