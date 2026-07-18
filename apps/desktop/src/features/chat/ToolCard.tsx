import { useEffect, useState } from "react";
import {
  ChevronRight,
  FileCode2,
  Search,
  Terminal,
  Wrench,
} from "lucide-react";
import type { ToolTraceStatus } from "./transcript-model";

export function toolValueText(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return String(value);
  }
}

export function toolSummary(value: unknown): string {
  let record: Record<string, unknown> | null = null;
  if (value && typeof value === "object") {
    record = value as Record<string, unknown>;
  } else if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object") record = parsed as Record<string, unknown>;
    } catch {
      return value.split("\n")[0]?.slice(0, 80) ?? "";
    }
  }
  if (!record) return "";
  for (const key of ["path", "filePath", "pattern", "query", "command", "url"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) {
      const firstLine = candidate.trim().split("\n")[0] ?? "";
      return firstLine.length > 80 ? `${firstLine.slice(0, 80)}...` : firstLine;
    }
  }
  return Object.entries(record)
    .slice(0, 2)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(" | ")
    .slice(0, 80);
}

function toolIcon(name: string) {
  const normalized = name.toLocaleLowerCase();
  if (["bash", "shell", "exec", "command"].some((part) => normalized.includes(part))) {
    return Terminal;
  }
  if (["read", "write", "edit", "file"].some((part) => normalized.includes(part))) {
    return FileCode2;
  }
  if (["find", "search", "grep", "glob"].some((part) => normalized.includes(part))) {
    return Search;
  }
  return Wrench;
}

export function statusLabel(status: ToolTraceStatus): string {
  switch (status) {
    case "done":
      return "Done";
    case "error":
      return "Failed";
    case "aborted":
      return "Stopped";
    case "running":
      return "Running";
    default:
      return "Waiting";
  }
}

export type ToolCardProps = {
  name: string;
  args?: unknown;
  result?: unknown;
  details?: unknown;
  status: ToolTraceStatus;
  startedAt?: number;
  endedAt?: number;
};

export function ToolCard(props: ToolCardProps) {
  const [open, setOpen] = useState(props.status === "error");
  const Icon = toolIcon(props.name);
  const canExpand = props.args !== undefined || props.result !== undefined;
  const summary = toolSummary(props.args);
  const statusClass =
    props.status === "running"
      ? "text-warning"
      : props.status === "error"
        ? "text-danger"
        : props.status === "done"
          ? "text-success"
          : "text-muted";

  useEffect(() => {
    if (props.status === "error") setOpen(true);
  }, [props.status]);

  return (
    <div className="group/tool min-w-0 max-w-full">
      <button
        type="button"
        className={`flex h-8 w-full items-center gap-2 rounded-md px-1.5 text-left transition-colors ${
          canExpand ? "hover:bg-surface-overlay/60" : "cursor-default"
        }`}
        onClick={() => {
          if (canExpand) setOpen((current) => !current);
        }}
        aria-expanded={canExpand ? open : undefined}
      >
        <Icon size={14} className="shrink-0 text-muted" />
        <span className="shrink-0 text-xs font-medium text-foreground/80">{props.name}</span>
        {summary && (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted" title={summary}>
            {summary}
          </span>
        )}
        {!summary && <span className="flex-1" />}
        <span className="text-[10px] text-muted">
          {formatDuration(props.startedAt, props.endedAt)}
        </span>
        <span className={`text-[10px] ${statusClass}`}>{statusLabel(props.status)}</span>
        {canExpand && (
          <ChevronRight
            size={13}
            className={`text-muted transition-transform ${open ? "rotate-90" : ""}`}
          />
        )}
      </button>
      {open && canExpand && (
        <div className="mb-2 ml-[22px] mt-1 flex flex-col gap-2">
          {props.args !== undefined && (
            <ToolSection label="Arguments" value={props.args} />
          )}
          {props.result !== undefined && (
            <ToolSection
              label={props.status === "error" ? "Error" : "Result"}
              value={props.result}
              error={props.status === "error"}
              terminal={props.name.toLocaleLowerCase().includes("bash")}
            />
          )}
        </div>
      )}
    </div>
  );
}

function ToolSection({
  label,
  value,
  error = false,
  terminal = false,
}: {
  label: string;
  value: unknown;
  error?: boolean;
  terminal?: boolean;
}) {
  return (
    <section>
      <div className="mb-1 text-[10px] font-medium text-muted">{label}</div>
      <pre
        className={`max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md px-3 py-2 font-mono text-[11px] leading-5 ${
          error
            ? "bg-danger/10 text-danger"
            : terminal
              ? "bg-[#171918] text-[#cbd5cc]"
              : "bg-surface-overlay/55 text-foreground/80"
        }`}
      >
        {toolValueText(value)}
      </pre>
    </section>
  );
}

export function formatDuration(startedAt?: number, endedAt?: number): string {
  if (!startedAt) return "";
  const end = endedAt ?? Date.now();
  const elapsed = Math.max(0, end - startedAt);
  return elapsed < 1_000 ? `${elapsed}ms` : `${(elapsed / 1_000).toFixed(1)}s`;
}
