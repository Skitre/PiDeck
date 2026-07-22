import { lazy, memo, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Brain, ChevronRight, Copy, FileText, LoaderCircle } from "lucide-react";
import { useAppStore } from "../../lib/stores/app-store";
import { sanitizeAgentText } from "./markdown-utils";
import { ToolView } from "./ToolView";
import { formatDuration } from "./ToolCard";
import { formatTokenCount } from "../../lib/format-token-count";
import { PiMark } from "../../components/PiMark";
import {
  buildTranscriptRows,
  parseUserAttachments,
  reuseStableRows,
  type TranscriptBlock,
  type TranscriptRow,
} from "./transcript-model";

const MarkdownMessage = lazy(() =>
  import("./MarkdownMessage").then((module) => ({ default: module.MarkdownMessage })),
);

function MarkdownFallback({ content, className = "" }: { content: string; className?: string }) {
  return (
    <div className={`whitespace-pre-wrap break-words text-sm leading-6 ${className}`}>
      {sanitizeAgentText(content)}
    </div>
  );
}

function LazyMarkdownMessage({
  content,
  mode = "static",
  showCaret = false,
  className,
}: {
  content: string;
  mode?: "streaming" | "static";
  showCaret?: boolean;
  className?: string;
}) {
  return (
    <Suspense fallback={<MarkdownFallback content={content} className={className} />}>
      <MarkdownMessage
        content={content}
        mode={mode}
        showCaret={showCaret}
        className={className}
      />
    </Suspense>
  );
}

/** Rows mounted when a session opens; older rows load in chunks on demand. */
const INITIAL_VISIBLE_ROWS = 60;
const SHOW_EARLIER_CHUNK = 120;

export function Transcript() {
  const session = useAppStore((state) => state.session);
  const messages = session?.messages ?? [];
  const prevRowsRef = useRef<TranscriptRow[] | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rows = useMemo(
    () => reuseStableRows(prevRowsRef.current, buildTranscriptRows(messages)),
    [messages],
  );
  prevRowsRef.current = rows;
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const rowModes = useRef(new Set<string>());
  const modeSessionId = useRef<string | null>(null);
  const [following, setFollowing] = useState(true);

  // Top-anchored window: `hidden` rows stay unmounted above the fold. New
  // rows stream in at the tail without disturbing what is on screen.
  // Derived-during-render so a freshly opened long session never mounts in
  // full even once.
  const sessionKey = session?.sessionId ?? null;
  const [hiddenState, setHiddenState] = useState<{ sessionId: string | null; hidden: number }>(
    { sessionId: sessionKey, hidden: Math.max(0, rows.length - INITIAL_VISIBLE_ROWS) },
  );
  if (hiddenState.sessionId !== sessionKey) {
    setHiddenState({
      sessionId: sessionKey,
      hidden: Math.max(0, rows.length - INITIAL_VISIBLE_ROWS),
    });
  }
  const hidden = Math.min(
    hiddenState.sessionId === sessionKey ? hiddenState.hidden : 0,
    Math.max(0, rows.length - 1),
  );
  const visibleRows = hidden > 0 ? rows.slice(hidden) : rows;
  const expandAnchorRef = useRef<{ prevHeight: number; prevTop: number } | null>(null);

  function showEarlier() {
    const element = scrollRef.current;
    if (element) {
      expandAnchorRef.current = {
        prevHeight: element.scrollHeight,
        prevTop: element.scrollTop,
      };
    }
    setHiddenState((current) => ({
      ...current,
      hidden: Math.max(0, current.hidden - SHOW_EARLIER_CHUNK),
    }));
  }

  useLayoutEffect(() => {
    // Keep the viewport anchored on the previously-visible content after
    // older rows mount above it.
    const anchor = expandAnchorRef.current;
    if (!anchor) return;
    expandAnchorRef.current = null;
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = anchor.prevTop + (element.scrollHeight - anchor.prevHeight);
  }, [hidden]);

  if (modeSessionId.current !== (session?.sessionId ?? null)) {
    modeSessionId.current = session?.sessionId ?? null;
    rowModes.current.clear();
  }

  const lastAssistantKey = [...rows]
    .reverse()
    .find((row) => row.role === "assistant")?.key;
  if (session?.isStreaming && lastAssistantKey) rowModes.current.add(lastAssistantKey);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    setFollowing(true);
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      element.scrollTop = element.scrollHeight;
    });
    return () => {
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, [session?.sessionId]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !following) return;
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      element.scrollTop = element.scrollHeight;
    });
    return () => {
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, [following, messages]);

  function scrollToBottom() {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
    setFollowing(true);
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        className="h-full overflow-y-auto px-6 py-5"
        onScroll={(event) => {
          const element = event.currentTarget;
          const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
          const shouldFollow = distance < 80;
          if (!shouldFollow && scrollFrameRef.current !== null) {
            cancelAnimationFrame(scrollFrameRef.current);
            scrollFrameRef.current = null;
          }
          setFollowing(shouldFollow);
        }}
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-6">
          {hidden > 0 && (
            <button
              type="button"
              onClick={showEarlier}
              className="mx-auto flex h-8 items-center rounded-full border border-border bg-surface-raised px-4 text-xs text-muted transition-colors hover:bg-surface-overlay hover:text-foreground"
            >
              Show earlier messages ({hidden} hidden)
            </button>
          )}
          {visibleRows.map((row) => {
            const streaming = session?.isStreaming && row.key === lastAssistantKey;
            return (
              <div className="transcript-row" key={`${session?.sessionId ?? "session"}:${row.key}`}>
                <TranscriptRowView
                  row={row}
                  mode={rowModes.current.has(row.key) ? "streaming" : "static"}
                  showCaret={Boolean(streaming)}
                />
              </div>
            );
          })}
          {session && !session.isIdle && !lastAssistantKey && (
            <div className="flex items-center gap-3 text-xs text-muted">
              <AssistantAvatar />
              <span>Pi is working...</span>
            </div>
          )}
          <div className="h-1" aria-hidden="true" />
        </div>
      </div>
      {!following && (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute bottom-3 left-1/2 flex size-8 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-surface-raised text-muted shadow-md transition-colors hover:bg-surface-overlay hover:text-foreground"
          title="Jump to latest message"
          aria-label="Jump to latest message"
        >
          <ArrowDown size={15} />
        </button>
      )}
    </div>
  );
}

function AssistantAvatar() {
  return <PiMark className="mt-0.5 size-7" />;
}

function DurationLabel({
  startedAt,
  endedAt,
  className = "",
}: {
  startedAt?: number;
  endedAt?: number;
  className?: string;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!startedAt || endedAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [startedAt, endedAt]);

  if (!startedAt) return null;
  return (
    <span className={`tabular-nums text-[10px] text-muted ${className}`}>
      {formatDuration(startedAt, endedAt ?? now)}
    </span>
  );
}

// Memoized: with reuseStableRows keeping row references stable, only the
// actively streaming row re-renders per animation frame.
const TranscriptRowView = memo(function TranscriptRowView({
  row,
  mode,
  showCaret,
}: {
  row: TranscriptRow;
  mode: "streaming" | "static";
  showCaret: boolean;
}) {
  if (row.role === "user") {
    const images = row.blocks.filter(
      (block): block is Extract<TranscriptBlock, { kind: "image" }> =>
        block.kind === "image",
    );
    const parsed = parseUserAttachments(row.copyText);
    return (
      <div className="group relative ml-auto w-fit max-w-[78%]">
        {images.length > 0 && (
          <div className="mb-1 flex flex-wrap justify-end gap-1.5">
            {images.map((image, index) => (
              <img
                key={`img:${index}`}
                src={`data:${image.mimeType};base64,${image.data}`}
                alt="attachment"
                className="max-h-48 max-w-full rounded-lg border border-border object-contain"
              />
            ))}
          </div>
        )}
        {parsed.files.length > 0 && (
          <div className="mb-1 flex flex-wrap justify-end gap-1.5">
            {parsed.files.map((file, index) => (
              <details
                key={`file:${index}`}
                className="max-w-full rounded-md border border-border bg-surface text-xs"
              >
                <summary className="flex h-7 cursor-pointer list-none items-center gap-1.5 px-2 text-muted hover:text-foreground [&::-webkit-details-marker]:hidden">
                  <FileText size={12} className="shrink-0" />
                  <span className="max-w-48 truncate">{file.name}</span>
                </summary>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words border-t border-border px-2 py-1.5 text-[11px] leading-5">
                  {file.content}
                </pre>
              </details>
            ))}
          </div>
        )}
        {parsed.text && (
          <div className="whitespace-pre-wrap break-words rounded-xl rounded-br-md bg-surface-overlay px-3.5 py-2.5 text-sm leading-6">
            {parsed.text}
          </div>
        )}
        <div className="mt-1 flex h-7 items-center justify-end">
          <CopyMessageButton
            text={row.copyText}
            className="opacity-0 group-hover:opacity-100"
          />
        </div>
      </div>
    );
  }

  if (row.role === "error") {
    return (
      <div className="flex items-start gap-3">
        <AssistantAvatar />
        <div className="min-w-0 flex-1 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
          {row.copyText}
        </div>
      </div>
    );
  }

  const sections = row.sections;
  if (!sections) return null;
  const lastTextBlock = [...row.blocks]
    .reverse()
    .find((block): block is Extract<TranscriptBlock, { kind: "text" }> =>
      block.kind === "text",
    );

  return (
    <div className="group/assistant relative w-full">
      <div className="flex h-7 items-center gap-2">
        <AssistantAvatar />
      </div>
      <div className="mt-2 min-w-0 space-y-3">
        {sections.initialThinking.length > 0 && (
          <ThinkingBlock
            content={sections.initialThinking.map((block) => block.text).join("\n\n")}
            label="Thought process"
            defaultOpen
          />
        )}
        {sections.intro.map((block, index) => (
          <AssistantBlock
            key={`intro:${index}`}
            block={block}
            mode={mode}
            showCaret={showCaret && block === lastTextBlock}
          />
        ))}
        {sections.stepCount > 0 && (
          <ExecutionTrace
            blocks={sections.activity}
            stepCount={sections.stepCount}
            mode={mode}
            showCaret={showCaret}
            lastTextBlock={lastTextBlock}
          />
        )}
        {sections.final.length > 0 && (
          <div className={sections.stepCount > 0 ? "pt-1" : ""}>
            {sections.final.map((block, index) => (
              <AssistantBlock
                key={`final:${index}`}
                block={block}
                mode={mode}
                showCaret={showCaret && block === lastTextBlock}
              />
            ))}
          </div>
        )}
      </div>
      <div className="mt-2 flex h-7 items-center gap-2">
        <DurationLabel
          startedAt={row.startedAt}
          endedAt={row.endedAt}
        />
        <div className="ml-auto flex items-center gap-1">
          <CopyMessageButton
            text={row.copyText}
            className="opacity-0 group-hover/assistant:opacity-100"
          />
          <UsageLabel usage={row.usage} />
        </div>
      </div>
    </div>
  );
});

function ExecutionTrace({
  blocks,
  stepCount,
  mode,
  showCaret,
  lastTextBlock,
}: {
  blocks: TranscriptBlock[];
  stepCount: number;
  mode: "streaming" | "static";
  showCaret: boolean;
  lastTextBlock?: Extract<TranscriptBlock, { kind: "text" }>;
}) {
  const [open, setOpen] = useState(true);
  const tools = blocks.filter(
    (block): block is Extract<TranscriptBlock, { kind: "tool" }> => block.kind === "tool",
  );
  const running = tools.some(
    (block) => block.tool.status === "running" || block.tool.status === "waiting",
  );
  const failed = tools.filter((block) => block.tool.status === "error").length;
  const aborted = tools.filter((block) => block.tool.status === "aborted").length;
  const traceLabel = running
    ? `Running ${stepCount} ${stepCount === 1 ? "step" : "steps"}`
    : failed > 0
      ? `Executed ${stepCount} steps · ${failed} failed`
      : aborted > 0
        ? `Stopped after ${stepCount} ${stepCount === 1 ? "step" : "steps"}`
        : `Executed ${stepCount} ${stepCount === 1 ? "step" : "steps"}`;
  const TraceIcon = running ? LoaderCircle : Brain;

  return (
    <div className="execution-trace">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex h-8 w-full items-center gap-2 rounded-md text-left text-xs font-medium text-foreground/80 transition-colors hover:text-foreground"
        aria-expanded={open}
      >
        <TraceIcon size={14} className={`text-muted ${running ? "animate-spin" : ""}`} />
        <span>{traceLabel}</span>
        <ChevronRight
          size={13}
          className={`ml-auto transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open && (
        <div className="ml-2 mt-1 space-y-1 border-l border-border py-1 pl-4">
          {blocks.map((block, index) =>
            block.kind === "thinking" ? (
              <ThinkingBlock
                key={`activity:${block.kind}:${index}`}
                content={block.text}
              />
            ) : block.kind === "text" ? (
              <div key={`activity:${block.kind}:${index}`} className="py-1 text-foreground/85">
                <AssistantBlock
                  block={block}
                  mode={mode}
                  showCaret={showCaret && block === lastTextBlock}
                />
              </div>
            ) : (
              <AssistantBlock
                key={`activity:${block.kind}:${index}`}
                block={block}
                mode={mode}
                showCaret={false}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}

function AssistantBlock({
  block,
  mode,
  showCaret,
}: {
  block: TranscriptBlock;
  mode: "streaming" | "static";
  showCaret: boolean;
}) {
  if (block.kind === "text") {
    return <LazyMarkdownMessage content={block.text} mode={mode} showCaret={showCaret} />;
  }
  if (block.kind === "thinking") {
    return <ThinkingBlock content={block.text} />;
  }
  if (block.kind === "image") {
    return (
      <img
        src={`data:${block.mimeType};base64,${block.data}`}
        alt="attachment"
        className="max-h-48 max-w-full rounded-lg border border-border object-contain"
      />
    );
  }
  return (
    <ToolView
      name={block.tool.name}
      args={block.tool.args}
      result={block.tool.result}
      details={block.tool.details}
      status={block.tool.status}
    />
  );
}

function ThinkingBlock({
  content,
  label = "Thinking",
  defaultOpen = false,
}: {
  content: string;
  label?: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const text = sanitizeAgentText(content);
  if (!text.trim()) return null;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex h-8 w-full items-center gap-2 rounded-md text-left text-xs text-muted transition-colors hover:text-foreground"
        aria-expanded={open}
      >
        <Brain size={14} />
        <span>{label}</span>
        <ChevronRight
          size={13}
          className={`ml-auto transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open && (
        <div className="ml-[22px] border-l border-border pl-3">
          <LazyMarkdownMessage content={text} className="thinking-markdown" />
        </div>
      )}
    </div>
  );
}

function UsageLabel({ usage }: { usage?: TranscriptRow["usage"] }) {
  if (!usage) return null;
  const tooltip = [
    `Input: ${formatTokenCount(usage.input)} tokens`,
    `Output: ${formatTokenCount(usage.output)} tokens`,
    `Cache read: ${formatTokenCount(usage.cacheRead)} tokens`,
    `Cache write: ${formatTokenCount(usage.cacheWrite)} tokens`,
    `Reasoning: ${usage.reasoning === undefined ? "not reported" : formatTokenCount(usage.reasoning)}`,
  ].join("\n");
  const cost =
    usage.cost.total > 0
      ? usage.cost.total < 0.0001
        ? "<$0.0001"
        : `$${usage.cost.total.toFixed(4)}`
      : null;

  return (
    <span
      className="whitespace-nowrap text-[10px] tabular-nums text-muted"
      title={tooltip}
    >
      {formatTokenCount(usage.totalTokens)} tok
      {cost ? ` / ${cost}` : ""}
    </span>
  );
}

function CopyMessageButton({
  text,
  className = "",
}: {
  text: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  if (!text) return null;
  return (
    <button
      type="button"
      title={copied ? "Copied" : "Copy message"}
      aria-label={copied ? "Copied" : "Copy message"}
      className={`flex size-7 shrink-0 items-center justify-center rounded-md text-muted transition-opacity hover:bg-surface-overlay hover:text-foreground ${className}`}
      onClick={() => {
        void navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1400);
          })
          .catch(() => undefined);
      }}
    >
      <Copy size={13} />
    </button>
  );
}
