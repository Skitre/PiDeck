import { useMemo, type ReactNode } from "react";
import {
  ChevronRight,
  FileCode2,
  FilePenLine,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import { sanitizeAgentText } from "./markdown-utils";
import {
  formatDuration,
  statusLabel,
  ToolCard,
  ToolDetailsDisclosure,
  useToolDisclosure,
  type ToolCardProps,
} from "./ToolCard";

function parseJsonish(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function toolRecord(value: unknown): Record<string, unknown> | null {
  const parsed = parseJsonish(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

export function toolResultText(value: unknown): string {
  const parsed = parseJsonish(value);
  if (typeof parsed === "string") return sanitizeAgentText(parsed);
  if (Array.isArray(parsed)) {
    return parsed.map(toolResultText).filter(Boolean).join("\n");
  }
  if (!parsed || typeof parsed !== "object") return parsed == null ? "" : String(parsed);

  const record = parsed as Record<string, unknown>;
  if (Array.isArray(record.content)) {
    const content = record.content
      .map((part) => {
        const item = toolRecord(part);
        return typeof item?.text === "string" ? item.text : "";
      })
      .filter(Boolean)
      .join("\n");
    if (content) return sanitizeAgentText(content);
  }
  for (const key of ["output", "stdout", "text", "message", "error", "result"]) {
    if (record[key] !== undefined) {
      const text = toolResultText(record[key]);
      if (text) return text;
    }
  }
  try {
    return JSON.stringify(parsed, null, 2);
  } catch {
    return String(parsed);
  }
}

function stringField(record: Record<string, unknown> | null, keys: string[]): string {
  if (!record) return "";
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function statusClass(status: ToolCardProps["status"]): string {
  if (status === "running") return "text-warning";
  if (status === "error") return "text-danger";
  if (status === "done") return "text-success";
  return "text-muted";
}

function ToolRow({
  icon: Icon,
  label,
  summary,
  props,
  children,
}: {
  icon: LucideIcon;
  label: string;
  summary: string;
  props: ToolCardProps;
  children?: ReactNode;
}) {
  const [open, setOpen] = useToolDisclosure(props);
  const canExpand = children !== undefined;

  return (
    <div className="min-w-0 max-w-full">
      <button
        type="button"
        className={`flex min-h-8 w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors ${
          canExpand ? "hover:bg-surface-overlay/60" : "cursor-default"
        }`}
        onClick={() => {
          if (canExpand) setOpen(!open);
        }}
        aria-expanded={canExpand ? open : undefined}
      >
        <Icon size={14} className="shrink-0 text-muted" />
        <span className="shrink-0 text-xs font-medium text-foreground/80">{label}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted" title={summary}>
          {summary}
        </span>
        <span className="shrink-0 text-[10px] text-muted">
          {formatDuration(props.startedAt, props.endedAt)}
        </span>
        <span className={`shrink-0 text-[10px] ${statusClass(props.status)}`}>
          {statusLabel(props.status)}
        </span>
        {canExpand && (
          <ChevronRight
            size={13}
            className={`shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`}
          />
        )}
      </button>
      {open && canExpand && (
        <div className="mb-2 ml-[22px] mt-1">
          {children}
          <ToolDetailsDisclosure details={props.details} />
        </div>
      )}
    </div>
  );
}

const READ_NAMES = new Set(["read", "read_file", "file_read"]);
const SHELL_NAMES = new Set(["bash", "shell", "exec", "exec_command", "command"]);
const MUTATION_NAMES = new Set(["edit", "write", "write_file", "apply_patch"]);

function normalizedName(name: string): string {
  return name.trim().toLocaleLowerCase().replace(/[\s.-]+/g, "_");
}

export function isFileReadTool(name: string): boolean {
  return READ_NAMES.has(normalizedName(name));
}

export function isShellTool(name: string): boolean {
  return SHELL_NAMES.has(normalizedName(name));
}

export function isFileMutationTool(name: string): boolean {
  return MUTATION_NAMES.has(normalizedName(name));
}

export function FileReadToolCard(props: ToolCardProps) {
  const args = toolRecord(props.args);
  const path = stringField(args, ["path", "filePath", "file_path"]);
  const content = toolResultText(props.result);
  const offset = typeof args?.offset === "number" ? Math.max(1, args.offset) : 1;
  const lines = useMemo(() => content.split("\n").slice(0, 400), [content]);

  if (props.status === "error") return <ToolCard {...props} />;

  return (
    <ToolRow icon={FileCode2} label="Read" summary={path || props.name} props={props}>
      <div className="max-h-72 overflow-auto rounded-md border border-border bg-surface-overlay/35">
        <pre className="min-w-max py-2 font-mono text-[11px] leading-5 text-foreground/80">
          {lines.map((line, index) => (
            <span key={index} className="flex min-h-5">
              <span className="w-12 shrink-0 select-none pr-3 text-right text-muted/65">
                {offset + index}
              </span>
              <span className="whitespace-pre pr-4">{line || " "}</span>
            </span>
          ))}
        </pre>
      </div>
      {content.split("\n").length > lines.length && (
        <div className="mt-1 text-[10px] text-muted">Preview limited to {lines.length} lines</div>
      )}
    </ToolRow>
  );
}

export function ShellToolCard(props: ToolCardProps) {
  const args = toolRecord(props.args);
  const command = stringField(args, ["command", "cmd", "script"]);
  const output = toolResultText(props.result);
  if (!command || props.status === "error") return <ToolCard {...props} />;

  return (
    <ToolRow
      icon={Terminal}
      label="Run"
      summary={command.split("\n")[0] ?? command}
      props={props}
    >
      <div className="overflow-hidden rounded-md bg-[#171918] text-[#cbd5cc]">
        <div className="border-b border-white/10 px-3 py-2 font-mono text-[11px] leading-5 text-[#e3e8e4]">
          <span className="select-none text-[#7f9385]">$ </span>
          <span className="whitespace-pre-wrap break-words">{command}</span>
        </div>
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-5">
          {output || (props.status === "running" ? "Running..." : "(no output)")}
        </pre>
      </div>
    </ToolRow>
  );
}

function detailsRecord(props: ToolCardProps): Record<string, unknown> | null {
  const explicit = toolRecord(props.details);
  if (explicit) return explicit;
  return toolRecord(toolRecord(props.result)?.details);
}

export function mutationDiff(props: Pick<ToolCardProps, "name" | "args" | "result" | "details">): string {
  const details = detailsRecord(props as ToolCardProps);
  const persistedDiff = stringField(details, ["patch", "diff"]);
  if (persistedDiff) return sanitizeAgentText(persistedDiff);

  const args = toolRecord(props.args);
  const edits = args?.edits;
  if (Array.isArray(edits)) {
    return edits
      .map((edit) => {
        const record = toolRecord(edit);
        const oldText = stringField(record, ["oldText", "old_text"]);
        const newText = stringField(record, ["newText", "new_text"]);
        return [
          ...oldText.split("\n").map((line) => `-${line}`),
          ...newText.split("\n").map((line) => `+${line}`),
        ].join("\n");
      })
      .join("\n");
  }

  const content = stringField(args, ["content"]);
  return content ? content.split("\n").map((line) => `+${line}`).join("\n") : "";
}

function diffCounts(diff: string): { additions: number; deletions: number } {
  const lines = diff.split("\n");
  return {
    additions: lines.filter((line) => line.startsWith("+") && !line.startsWith("+++" )).length,
    deletions: lines.filter((line) => line.startsWith("-") && !line.startsWith("---" )).length,
  };
}

export function FileMutationToolCard(props: ToolCardProps) {
  const args = toolRecord(props.args);
  const path = stringField(args, ["path", "filePath", "file_path"]);
  const diff = useMemo(() => mutationDiff(props), [props]);
  const counts = useMemo(() => diffCounts(diff), [diff]);
  const write = normalizedName(props.name).includes("write");
  if (!path || !diff || props.status === "error") return <ToolCard {...props} />;

  return (
    <ToolRow
      icon={FilePenLine}
      label={write ? "Write" : "Edit"}
      summary={path}
      props={props}
    >
      <div className="overflow-hidden rounded-md border border-border bg-surface-overlay/30">
        <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-[10px] text-muted">
          <span className="min-w-0 flex-1 truncate font-mono" title={path}>{path}</span>
          <span className="text-success">+{counts.additions}</span>
          <span className="text-danger">-{counts.deletions}</span>
        </div>
        <pre className="max-h-80 overflow-auto py-2 font-mono text-[11px] leading-5">
          {diff.split("\n").slice(0, 500).map((line, index) => {
            const addition = line.startsWith("+") && !line.startsWith("+++");
            const deletion = line.startsWith("-") && !line.startsWith("---");
            return (
              <span
                key={index}
                className={`block min-w-max whitespace-pre px-3 ${
                  addition
                    ? "bg-success/10 text-success"
                    : deletion
                      ? "bg-danger/10 text-danger"
                      : "text-foreground/70"
                }`}
              >
                {line || " "}
              </span>
            );
          })}
        </pre>
      </div>
    </ToolRow>
  );
}
