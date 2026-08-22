import { useId } from "react";
import { ChevronRight } from "lucide-react";
import { useAppStore } from "../../lib/stores/app-store";
import { useT } from "../../lib/i18n/use-t";
import { statusChipText } from "../../lib/extension-ui-status-text";
import type { LiveWidgetContent } from "../../lib/extension-ui-slots";

function renderWidget(widget: unknown): string {
  if (typeof widget === "string") return widget;
  if (typeof widget === "number" || typeof widget === "boolean") return String(widget);
  if (Array.isArray(widget) && widget.every((line) => typeof line === "string")) {
    return widget.join("\n");
  }
  return JSON.stringify(widget, null, 2);
}

export function ExtensionWidgetRows({ widgets }: { widgets: readonly LiveWidgetContent[] }) {
  const t = useT();
  const collapsedWidgetKeys = useAppStore((state) => state.collapsedExtensionWidgetKeys);
  const onToggleCollapsed = useAppStore((state) => state.toggleExtensionWidgetCollapsed);
  return (
    <div className="flex flex-col gap-1">
      {widgets.map((entry) => (
        <WidgetRow
          key={entry.key}
          entry={entry}
          collapsed={collapsedWidgetKeys[entry.key] === true}
          onToggle={() => onToggleCollapsed(entry.key)}
          label={t("extWidgetLabel", { key: entry.key })}
          toggleLabel={t(collapsedWidgetKeys[entry.key] ? "extWidgetExpand" : "extWidgetCollapse", {
            key: entry.key,
          })}
        />
      ))}
    </div>
  );
}

function WidgetRow({
  entry,
  collapsed,
  onToggle,
  label,
  toggleLabel,
}: {
  entry: LiveWidgetContent;
  collapsed: boolean;
  onToggle: () => void;
  label: string;
  toggleLabel: string;
}) {
  const contentId = useId();
  return (
    <section className={collapsed ? undefined : "py-0.5"} aria-label={label}>
      <button
        type="button"
        className={`group flex w-full items-center gap-1 rounded px-0.5 text-left transition-colors hover:bg-surface-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/50 ${
          collapsed ? "h-5" : "min-h-6"
        }`}
        aria-expanded={!collapsed}
        aria-controls={contentId}
        aria-label={toggleLabel}
        title={toggleLabel}
        onClick={onToggle}
      >
        <ChevronRight
          aria-hidden="true"
          size={11}
          className={`shrink-0 text-muted transition-transform duration-150 motion-reduce:transition-none ${
            collapsed ? "" : "rotate-90"
          }`}
        />
        <span className="min-w-0 truncate text-[10px] font-medium uppercase leading-none text-muted group-hover:text-foreground">
          {entry.key}
        </span>
      </button>
      {!collapsed && (
        <pre
          id={contentId}
          tabIndex={-1}
          aria-readonly="true"
          className="mt-1 whitespace-pre-wrap break-words pl-5 font-mono text-xs text-foreground"
        >
          {renderWidget(entry.widget)}
        </pre>
      )}
    </section>
  );
}

export function ExtensionStatusRows({
  statuses,
}: {
  statuses: readonly { key: string; text: string }[];
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted">
      {statuses.map((entry) => {
        const label = statusChipText(entry.key, entry.text);
        return (
          <span key={entry.key} className="min-w-0 max-w-[18rem] truncate" title={label}>
            {label}
          </span>
        );
      })}
    </div>
  );
}
