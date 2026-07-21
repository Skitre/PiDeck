import { useAppStore } from "../../lib/stores/app-store";

export function ChatHeader() {
  const session = useAppStore((s) => s.session);
  const sessionName = session?.name?.trim() || "New conversation";
  const runtimeLabel = session?.isStreaming
    ? "Streaming"
    : session?.isCompacting
      ? "Compacting"
      : session?.isRetrying
        ? "Retrying"
        : session?.isIdle
          ? "Ready"
          : "Working";

  return (
    <div
      className="flex h-11 shrink-0 items-center gap-4 border-b border-border pl-5 pr-[180px]"
      data-tauri-drag-region
    >
      <div className="pointer-events-none min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h1 className="truncate text-sm font-semibold" title={sessionName}>
            {sessionName}
          </h1>
          <span
            className={`size-1.5 shrink-0 rounded-full ${
              session?.isStreaming || (session && !session.isIdle)
                ? "bg-success"
                : "bg-muted"
            }`}
            title={session ? runtimeLabel : "No active session"}
          />
          <span className="text-[11px] text-muted">
            {session ? runtimeLabel : "No active session"}
          </span>
        </div>
      </div>
    </div>
  );
}
