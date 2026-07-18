import { useAppStore } from "../lib/stores/app-store";

export function TitleBar() {
  const host = useAppStore((s) => s.host);

  return (
    <header
      className="flex h-9 shrink-0 items-center justify-between border-b border-border bg-surface-raised px-3 select-none"
      data-tauri-drag-region
    >
      <div className="flex items-center gap-2 text-sm font-medium" data-tauri-drag-region>
        <span className="text-accent">π</span>
        <span>Pi Desktop Manager</span>
      </div>
      <div className="flex items-center gap-3 text-xs text-muted">
        {host ? (
          <>
            <span title="SDK version">SDK {host.sdkVersion}</span>
            <span
              className={
                host.phase === "ready" || host.phase === "waitingForWorkspace"
                  ? "text-success"
                  : host.phase === "fatal"
                    ? "text-danger"
                    : "text-warning"
              }
            >
              {host.phase}
            </span>
          </>
        ) : (
          <span>booting</span>
        )}
      </div>
    </header>
  );
}
