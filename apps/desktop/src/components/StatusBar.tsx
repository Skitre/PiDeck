import { useAppStore } from "../lib/stores/app-store";

export function StatusBar() {
  const host = useAppStore((s) => s.host);
  const workspace = useAppStore((s) => s.workspace);
  const extensionStatus = useAppStore((s) => s.extensionStatus);
  const notifications = useAppStore((s) => s.notifications);

  const lastNote = notifications[notifications.length - 1];

  return (
    <footer className="flex h-7 shrink-0 items-center gap-3 border-t border-border bg-surface-raised px-3 text-[11px] text-muted">
      <span className="truncate">
        {workspace?.canonicalCwd ?? "No workspace"}
      </span>
      {host?.modelConfigHealth?.state === "error" && (
        <span className="text-warning" title={host.modelConfigHealth.message}>
          Model config warning
        </span>
      )}
      {extensionStatus && (
        <span className="truncate text-foreground/80">{extensionStatus}</span>
      )}
      {lastNote && (
        <span className="ml-auto truncate" title={lastNote.message}>
          {lastNote.message}
        </span>
      )}
    </footer>
  );
}
