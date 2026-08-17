import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Activity,
  ArrowDown,
  Ban,
  Bot,
  Brain,
  Braces,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Copy,
  ExternalLink,
  FileText,
  FoldVertical,
  GitBranch,
  GitFork,
  Link2,
  ListTree,
  LoaderCircle,
  MessageCircleQuestion,
  PanelRightOpen,
  Pencil,
  Puzzle,
  RotateCw,
  Terminal,
} from "lucide-react";
import { useAppStore } from "../../lib/stores/app-store";
import { requestFork } from "../../lib/fork-actions";
import { requestPromptFromEntry, requestRegenerateInSession } from "../../lib/tree-actions";
import { requestDockBrowser } from "../../lib/dock-browser";
import { openSystemUrl } from "../../lib/open-system-url";
import { isSafeExternalUrl, sanitizeAgentText } from "./markdown-utils";
import { ToolView } from "./ToolView";
import { formatDuration } from "./ToolCard";
import { formatTokenCount } from "../../lib/format-token-count";
import { useT, type Translate } from "../../lib/i18n/use-t";
import { PiMark } from "../../components/PiMark";
import { CollapsibleRegion } from "../../components/CollapsibleRegion";
import { stripAttachmentReferenceBlocks } from "@pideck/protocol";
import {
  buildTranscriptRows,
  executionTraceIsActive,
  findStreamingAssistantKey,
  branchPromptInput,
  branchSourceForRow,
  hasBranchPayload,
  parseUserAttachments,
  reuseStableRows,
  userPromptEntryIds,
  type BranchSource,
  type TranscriptContentBlock,
  type TranscriptBlock,
  type TranscriptRow,
} from "./transcript-model";
import { contextMenuTrigger, openContextMenu } from "../../lib/context-menu";
import { shouldKeepNativeContextMenu } from "../../lib/context-menu-policy";
import {
  autoMountFloor,
  createBatchSizer,
  NEAR_TOP_BOOST_VIEWPORTS,
  scheduleIdleMount,
  SCROLL_QUIET_MS,
} from "./progressive-mount";
import {
  forgetTranscriptScrollPosition,
  readTranscriptScrollPosition,
  saveTranscriptScrollPosition,
} from "./transcript-scroll-memory";

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
      <MarkdownMessage content={content} mode={mode} showCaret={showCaret} className={className} />
    </Suspense>
  );
}

/**
 * Rows mounted synchronously when a session opens; the idle loop in
 * progressive-mount.ts converges the rest afterwards.
 */
const INITIAL_VISIBLE_ROWS = 60;
const SHOW_EARLIER_CHUNK = 120;

/** Reopen a session at its remembered reading position, else at the tail. */
function initialHiddenFor(sessionId: string | null, rowCount: number): number {
  const tailHidden = Math.max(0, rowCount - INITIAL_VISIBLE_ROWS);
  if (sessionId === null) return tailHidden;
  const remembered = readTranscriptScrollPosition(sessionId);
  if (remembered === undefined) return tailHidden;
  return Math.min(remembered.hidden, Math.max(0, rowCount - 1));
}

export function Transcript() {
  const t = useT();
  const session = useAppStore((state) => state.session);
  const messages = useMemo(() => session?.messages ?? [], [session?.messages]);
  const prevRowsRef = useRef<TranscriptRow[] | null>(null);
  const rows = useMemo(
    () =>
      reuseStableRows(
        prevRowsRef.current,
        buildTranscriptRows(messages, {
          entries: session?.entries,
          leafId: session?.leafId,
          extensionMessageRenders: session?.extensionMessageRenders,
        }),
      ),
    [messages, session?.entries, session?.leafId, session?.extensionMessageRenders],
  );
  prevRowsRef.current = rows;
  const promptEntryIds = useMemo(() => userPromptEntryIds(rows), [rows]);
  const userRowsByEntryId = useMemo(() => {
    const map = new Map<string, TranscriptRow>();
    for (const row of rows) {
      if (row.role === "user" && row.sourceId) map.set(row.sourceId, row);
    }
    return map;
  }, [rows]);
  const [editing, setEditing] = useState<{ entryId: string; text: string } | null>(null);
  useEffect(() => {
    setEditing(null);
  }, [session?.sessionId]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const scrollMetricsRef = useRef({ top: 0, height: 0 });
  const followingRef = useRef(true);
  const [following, setFollowing] = useState(true);

  // Persistent reading anchor: the tail spacer's viewport position, captured
  // on genuine user scrolls only. Batch compensation always corrects back to
  // this one baseline, so sub-pixel quantization loss cannot accumulate into
  // a slow directional drift across hundreds of batches.
  const tailAnchorRef = useRef<HTMLDivElement>(null);
  const readingAnchorTopRef = useRef<number | null>(null);
  const programmaticScrollTopRef = useRef<number | null>(null);

  const refreshReadingAnchor = useCallback(() => {
    const tail = tailAnchorRef.current;
    readingAnchorTopRef.current = tail ? tail.getBoundingClientRect().top : null;
  }, []);

  const cancelScheduledScroll = useCallback(() => {
    if (scrollFrameRef.current === null) return;
    cancelAnimationFrame(scrollFrameRef.current);
    scrollFrameRef.current = null;
  }, []);

  const alignToBottom = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    programmaticScrollTopRef.current = element.scrollTop;
    scrollMetricsRef.current = {
      top: element.scrollTop,
      height: element.scrollHeight,
    };
  }, []);

  const scheduleBottomAlignment = useCallback(() => {
    cancelScheduledScroll();
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      if (followingRef.current) alignToBottom();
    });
  }, [alignToBottom, cancelScheduledScroll]);

  const updateFollowing = useCallback((next: boolean) => {
    followingRef.current = next;
    setFollowing((current) => (current === next ? current : next));
  }, []);

  const stopFollowing = useCallback(() => {
    cancelScheduledScroll();
    updateFollowing(false);
    refreshReadingAnchor();
  }, [cancelScheduledScroll, refreshReadingAnchor, updateFollowing]);

  // Top-anchored window: `hidden` rows stay unmounted above the fold. New
  // rows stream in at the tail without disturbing what is on screen.
  // Derived-during-render so a freshly opened long session only mounts its
  // tail on first paint; idle-time batches then converge toward a fully
  // mounted transcript (see progressive-mount.ts).
  const sessionKey = session?.sessionId ?? null;
  const [hiddenState, setHiddenState] = useState<{ sessionId: string | null; hidden: number }>({
    sessionId: sessionKey,
    hidden: initialHiddenFor(sessionKey, rows.length),
  });
  if (hiddenState.sessionId !== sessionKey) {
    // Remember (or forget) the departing session's reading position before
    // the window resets. Idempotent, so the render-phase setState pattern
    // stays safe under double-invoked renders.
    if (hiddenState.sessionId !== null) {
      if (followingRef.current) {
        forgetTranscriptScrollPosition(hiddenState.sessionId);
      } else {
        saveTranscriptScrollPosition(hiddenState.sessionId, {
          hidden: hiddenState.hidden,
          scrollTop: scrollMetricsRef.current.top,
        });
      }
    }
    setHiddenState({
      sessionId: sessionKey,
      hidden: initialHiddenFor(sessionKey, rows.length),
    });
  }
  const hidden = Math.min(
    hiddenState.sessionId === sessionKey ? hiddenState.hidden : 0,
    Math.max(0, rows.length - 1),
  );
  const visibleRows = hidden > 0 ? rows.slice(hidden) : rows;
  const expandAnchorRef = useRef<{ prevHeight: number; prevTop: number } | null>(null);
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;

  const mountEarlier = useCallback((count: number, floor = 0) => {
    if (hiddenRef.current <= floor) return;
    const element = scrollRef.current;
    if (element) {
      expandAnchorRef.current = {
        prevHeight: element.scrollHeight,
        prevTop: element.scrollTop,
      };
    }
    setHiddenState((current) => ({
      ...current,
      hidden: Math.max(floor, current.hidden - count),
    }));
  }, []);

  // Save the reading position when the transcript unmounts (e.g. workspace
  // switches); session switches are handled by the render-phase reset above.
  const sessionKeyRef = useRef(sessionKey);
  sessionKeyRef.current = sessionKey;
  useEffect(
    () => () => {
      const departing = sessionKeyRef.current;
      if (departing === null) return;
      if (followingRef.current) {
        forgetTranscriptScrollPosition(departing);
      } else {
        saveTranscriptScrollPosition(departing, {
          hidden: hiddenRef.current,
          scrollTop: scrollMetricsRef.current.top,
        });
      }
    },
    [],
  );

  // Idle-time convergence toward a fully mounted transcript (bounded by the
  // full-mount cap). Each batch triggers this effect again through `hidden`,
  // which paces the loop one batch per idle slice. Batch size adapts to the
  // measured cost of this session's rows. Convergence only runs when its
  // scroll adjustments cannot be seen: bottom realignment carries sub-pixel
  // rounding wobble, so a focused reader pinned to the tail pauses the loop
  // until they scroll into history (or the window blurs).
  const mountFloor = autoMountFloor(rows.length);
  const isStreaming = session?.isStreaming === true;
  const batchSizerRef = useRef(createBatchSizer());
  const batchStartRef = useRef<number | null>(null);
  const lastUserScrollAtRef = useRef(0);
  const [windowFocused, setWindowFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const onFocus = () => setWindowFocused(true);
    const onBlur = () => setWindowFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
  useEffect(() => {
    if (hidden <= mountFloor) return;
    if (isStreaming && following) return;
    if (following && windowFocused) return;
    let cancelled = false;
    let cancel: (() => void) | null = null;
    const tick = () => {
      if (cancelled) return;
      if (performance.now() - lastUserScrollAtRef.current < SCROLL_QUIET_MS) {
        cancel = scheduleIdleMount(tick);
        return;
      }
      batchStartRef.current = performance.now();
      mountEarlier(batchSizerRef.current.size(), mountFloor);
    };
    cancel = scheduleIdleMount(tick);
    return () => {
      cancelled = true;
      cancel?.();
    };
  }, [hidden, mountFloor, isStreaming, following, windowFocused, mountEarlier]);

  useLayoutEffect(() => {
    // Keep the viewport anchored on the previously-visible content after
    // older rows mount above it. While pinned to the tail, snap straight to
    // the bottom instead of delta math so convergence batches can never
    // accumulate sub-pixel drift.
    const anchor = expandAnchorRef.current;
    if (!anchor) return;
    expandAnchorRef.current = null;
    const element = scrollRef.current;
    if (!element) return;
    if (followingRef.current) {
      alignToBottom();
    } else {
      const readingTop = readingAnchorTopRef.current;
      const tail = tailAnchorRef.current;
      element.scrollTop =
        readingTop !== null && tail
          ? element.scrollTop + (tail.getBoundingClientRect().top - readingTop)
          : anchor.prevTop + (element.scrollHeight - anchor.prevHeight);
      programmaticScrollTopRef.current = element.scrollTop;
      scrollMetricsRef.current = {
        top: element.scrollTop,
        height: element.scrollHeight,
      };
    }
    // Reading scrollHeight above forced layout, so this measures the full
    // render + layout cost of the batch that just mounted.
    if (batchStartRef.current !== null) {
      batchSizerRef.current.record(performance.now() - batchStartRef.current);
      batchStartRef.current = null;
    }
  }, [hidden, alignToBottom]);

  const lastAssistantRow = [...rows].reverse().find((row) => row.role === "assistant");
  const streamingAssistantKey = findStreamingAssistantKey(
    rows,
    messages,
    session?.isStreaming === true,
  );
  const hasRunningTool = lastAssistantRow?.blocks.some(
    (block) =>
      block.kind === "tool" && (block.tool.status === "running" || block.tool.status === "waiting"),
  );
  const tailRow = rows[rows.length - 1];
  const workingHeaderKey =
    session && !session.isIdle && tailRow?.role === "assistant" ? tailRow.key : undefined;

  useLayoutEffect(() => {
    const remembered = sessionKey !== null ? readTranscriptScrollPosition(sessionKey) : undefined;
    const element = scrollRef.current;
    if (remembered !== undefined && element) {
      // Reopen at the remembered reading position; row layout is unchanged
      // for identical content, so the saved pixel offset stays meaningful.
      updateFollowing(false);
      element.scrollTop = remembered.scrollTop;
      programmaticScrollTopRef.current = element.scrollTop;
      scrollMetricsRef.current = {
        top: element.scrollTop,
        height: element.scrollHeight,
      };
      refreshReadingAnchor();
      return;
    }
    updateFollowing(true);
    alignToBottom();
    scheduleBottomAlignment();
  }, [alignToBottom, refreshReadingAnchor, scheduleBottomAlignment, sessionKey, updateFollowing]);

  useLayoutEffect(() => {
    if (followingRef.current) scheduleBottomAlignment();
  }, [messages, scheduleBottomAlignment]);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (followingRef.current) scheduleBottomAlignment();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [scheduleBottomAlignment]);

  useEffect(() => cancelScheduledScroll, [cancelScheduledScroll]);

  function scrollToBottom() {
    const element = scrollRef.current;
    if (!element) return;
    updateFollowing(true);
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        data-transcript-scroll
        className="scrollbar-auto-hide h-full overflow-y-auto px-3 py-4 sm:px-6 sm:py-5"
        onWheel={(event) => {
          lastUserScrollAtRef.current = performance.now();
          if (event.deltaY < 0) stopFollowing();
        }}
        onScroll={(event) => {
          const element = event.currentTarget;
          // Genuine user scrolls move the reading anchor; echoes of our own
          // compensation (within a pixel of the last programmatic value)
          // must not, or batch corrections would re-baseline onto their own
          // quantization error and drift.
          const programmaticTop = programmaticScrollTopRef.current;
          programmaticScrollTopRef.current = null;
          if (programmaticTop === null || Math.abs(element.scrollTop - programmaticTop) >= 1) {
            lastUserScrollAtRef.current = performance.now();
            refreshReadingAnchor();
          }
          // Near-edge boost: mount the next batch synchronously when the
          // reader approaches the top of the mounted region, so fast upward
          // scrolling never has to wait for the idle loop.
          if (
            hidden > mountFloor &&
            element.scrollTop < element.clientHeight * NEAR_TOP_BOOST_VIEWPORTS
          ) {
            batchStartRef.current = performance.now();
            mountEarlier(batchSizerRef.current.size(), mountFloor);
          }
          const previous = scrollMetricsRef.current;
          const movingUp =
            element.scrollTop < previous.top && element.scrollHeight >= previous.height;
          scrollMetricsRef.current = {
            top: element.scrollTop,
            height: element.scrollHeight,
          };
          if (movingUp) {
            stopFollowing();
            return;
          }
          const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
          const shouldFollow = distance < 80;
          if (!shouldFollow && scrollFrameRef.current !== null) {
            cancelScheduledScroll();
          }
          updateFollowing(shouldFollow);
        }}
      >
        <div
          ref={contentRef}
          data-transcript-content
          className="conversation-content-width mx-auto flex flex-col gap-5 sm:gap-6"
        >
          {hidden > 0 && (
            <button
              type="button"
              onClick={() => mountEarlier(SHOW_EARLIER_CHUNK)}
              className="mx-auto flex h-8 items-center rounded-full border border-border bg-surface-raised px-4 text-xs text-muted transition-colors hover:bg-surface-overlay hover:text-foreground"
            >
              {t("transcriptShowEarlier", { count: hidden })}
            </button>
          )}
          {visibleRows.map((row) => {
            const streaming = row.key === streamingAssistantKey;
            const working = row.key === workingHeaderKey;
            const branch = branchSourceForRow(row, promptEntryIds, userRowsByEntryId);
            return (
              <div
                className="transcript-row"
                data-row-key={row.key}
                key={`${session?.sessionId ?? "session"}:${row.key}`}
                onContextMenu={(event) => {
                  if (shouldKeepNativeContextMenu(event.nativeEvent)) return;
                  event.preventDefault();
                  event.stopPropagation();
                  const selection = window.getSelection();
                  const selectedText = selection?.toString() ?? "";
                  const selectionInside = Boolean(
                    selectedText &&
                    selection?.rangeCount &&
                    selection.getRangeAt(0).intersectsNode(event.currentTarget),
                  );
                  const anchor =
                    event.target instanceof Element
                      ? event.target.closest<HTMLAnchorElement>("a[href]")
                      : null;
                  const linkUrl = anchor && isSafeExternalUrl(anchor.href) ? anchor.href : null;
                  const idle = useAppStore.getState().session?.isIdle ?? false;
                  openContextMenu({
                    x: event.clientX,
                    y: event.clientY,
                    trigger: contextMenuTrigger(event.target),
                    items: [
                      ...(linkUrl
                        ? [
                            {
                              id: "transcript.openLinkInDock",
                              label: t("menuOpenLinkInDock"),
                              icon: PanelRightOpen,
                              onSelect: () => {
                                requestDockBrowser({ url: linkUrl });
                              },
                            },
                            {
                              id: "transcript.openLinkExternal",
                              label: t("menuOpenLinkExternal"),
                              icon: ExternalLink,
                              onSelect: () => openSystemUrl(linkUrl),
                            },
                            {
                              id: "transcript.copyLink",
                              label: t("menuCopyLink"),
                              icon: Link2,
                              onSelect: () => navigator.clipboard.writeText(linkUrl),
                            },
                          ]
                        : []),
                      ...(selectionInside
                        ? [
                            {
                              id: "transcript.copySelection",
                              label: t("menuCopySelection"),
                              icon: Copy,
                              separatorBefore: Boolean(linkUrl),
                              onSelect: () => navigator.clipboard.writeText(selectedText),
                            },
                          ]
                        : []),
                      ...(row.role === "user" && branch
                        ? [
                            {
                              id: "transcript.edit",
                              label: t("transcriptEdit"),
                              icon: Pencil,
                              separatorBefore: Boolean(linkUrl || selectionInside),
                              disabled: !idle,
                              onSelect: () => {
                                setEditing({
                                  entryId: branch.entryId,
                                  text: branch.fallbackText,
                                });
                              },
                            },
                          ]
                        : []),
                      ...(row.role === "assistant" && branch && !working
                        ? [
                            {
                              id: "transcript.regenerate",
                              label: t("transcriptRegenerate"),
                              icon: RotateCw,
                              separatorBefore: Boolean(linkUrl || selectionInside),
                              disabled: !idle,
                              onSelect: () => {
                                const prompt = branchPromptInput(branch);
                                void requestRegenerateInSession(branch.entryId, {
                                  fallbackText: prompt.text,
                                  images: prompt.images,
                                  attachmentIds: prompt.attachmentIds,
                                });
                              },
                            },
                          ]
                        : []),
                      {
                        id: "transcript.copyMessage",
                        label: t("menuCopyMessage"),
                        icon: Copy,
                        separatorBefore:
                          Boolean(branch) || (linkUrl ? !selectionInside : selectionInside),
                        disabled: !row.copyText,
                        onSelect: () => navigator.clipboard.writeText(row.copyText),
                      },
                    ],
                  });
                }}
              >
                <TranscriptRowView
                  row={row}
                  mode={streaming ? "streaming" : "static"}
                  showCaret={Boolean(streaming)}
                  working={working}
                  branch={branch}
                  editing={editing?.entryId === branch?.entryId ? editing : null}
                  onStartEdit={
                    branch
                      ? () =>
                          setEditing({
                            entryId: branch.entryId,
                            text: branch.fallbackText,
                          })
                      : undefined
                  }
                  onChangeEdit={(text) =>
                    setEditing((current) => (current ? { ...current, text } : current))
                  }
                  onCancelEdit={() => setEditing(null)}
                  onSubmitEdit={
                    branch && editing?.entryId === branch.entryId
                      ? async () => {
                          const sent = await requestPromptFromEntry(
                            branch.entryId,
                            branchPromptInput(branch, editing.text),
                          );
                          if (sent) setEditing(null);
                        }
                      : undefined
                  }
                />
              </div>
            );
          })}
          {session &&
            !session.isIdle &&
            !workingHeaderKey &&
            !streamingAssistantKey &&
            !hasRunningTool && (
              <div className="flex items-center gap-3 text-xs text-muted">
                <AssistantAvatar />
                <span>{t("transcriptPiWorking")}</span>
              </div>
            )}
          <div ref={tailAnchorRef} className="h-1" aria-hidden="true" />
        </div>
      </div>
      {!following && (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute bottom-3 left-1/2 flex size-8 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-surface-raised text-muted shadow-md transition-colors hover:bg-surface-overlay hover:text-foreground"
          title={t("transcriptJumpLatest")}
          aria-label={t("transcriptJumpLatest")}
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

export function DurationLabel({
  startedAt,
  endedAt,
  active = false,
  className = "",
}: {
  startedAt?: number;
  endedAt?: number;
  active?: boolean;
  className?: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  const live = active || endedAt === undefined;

  useEffect(() => {
    if (!startedAt || !live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [startedAt, live]);

  if (!startedAt) return null;
  return (
    <span className={`tabular-nums text-[10px] text-muted ${className}`}>
      {formatDuration(startedAt, active ? now : (endedAt ?? now))}
    </span>
  );
}

// Memoized: with reuseStableRows keeping row references stable, only the
// actively streaming row re-renders per animation frame.
const TranscriptRowView = memo(function TranscriptRowView({
  row,
  mode,
  showCaret,
  working,
  branch,
  editing,
  onStartEdit,
  onChangeEdit,
  onCancelEdit,
  onSubmitEdit,
}: {
  row: TranscriptRow;
  mode: "streaming" | "static";
  showCaret: boolean;
  working: boolean;
  branch?: BranchSource;
  editing?: { entryId: string; text: string } | null;
  onStartEdit?: () => void;
  onChangeEdit?: (text: string) => void;
  onCancelEdit?: () => void;
  onSubmitEdit?: () => void | Promise<void>;
}) {
  const t = useT();
  if (row.role === "user") {
    const images = row.blocks.filter(
      (block): block is Extract<TranscriptBlock, { kind: "image" }> => block.kind === "image",
    );
    const parsed = parseUserAttachments(row.copyText);
    return (
      <div className="group relative ml-auto w-fit max-w-[92%] sm:max-w-[78%]">
        {images.length > 0 && (
          <div className="mb-1 flex flex-wrap justify-end gap-1.5">
            {images.map((image, index) => (
              <img
                key={`img:${index}`}
                src={`data:${image.mimeType};base64,${image.data}`}
                alt={t("transcriptAttachmentAlt")}
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
        {parsed.documents.length > 0 && (
          <div className="mb-1 flex flex-wrap justify-end gap-1.5">
            {parsed.documents.map((document) => (
              <div
                key={document.id}
                className="flex h-8 max-w-full items-center gap-1.5 rounded-md border border-border bg-surface px-2 text-xs"
                title={document.name}
              >
                <FileText size={12} className="shrink-0 text-accent" />
                <span className="max-w-48 truncate">{document.name}</span>
                <span className="shrink-0 text-[10px] text-muted">
                  {document.unit === "page"
                    ? t("composerDocumentPages", { count: document.unitCount })
                    : t("composerDocumentChunks", { count: document.unitCount })}
                </span>
              </div>
            ))}
          </div>
        )}
        {editing ? (
          <UserMessageEditor
            text={editing.text}
            canSend={Boolean(
              editing.text.trim() ||
              (branch &&
                hasBranchPayload({
                  fallbackText: editing.text,
                  images: branch.images,
                  files: branch.files,
                  attachmentIds: branch.attachmentIds,
                })),
            )}
            onChange={onChangeEdit}
            onCancel={onCancelEdit}
            onSubmit={onSubmitEdit}
          />
        ) : (
          parsed.text && (
            <div className="theme-user-message whitespace-pre-wrap break-words rounded-xl rounded-br-md bg-surface-overlay px-3.5 py-2.5 text-sm leading-6">
              {parsed.text}
            </div>
          )
        )}
        {!editing && (
          <div className="mt-1 flex h-7 items-center justify-end gap-1">
            {branch && onStartEdit && (
              <EditMessageButton
                onStartEdit={onStartEdit}
                className="opacity-0 group-hover:opacity-100"
              />
            )}
            <CopyMessageButton
              text={stripAttachmentReferenceBlocks(row.copyText)}
              className="opacity-0 group-hover:opacity-100"
            />
          </div>
        )}
      </div>
    );
  }

  if (row.role === "error") {
    return (
      <div className="flex items-start gap-3">
        <CircleAlert className="mt-1 size-5 shrink-0 text-danger" />
        <div className="min-w-0 flex-1 whitespace-pre-wrap break-words rounded-md border border-danger/25 bg-danger/10 px-3 py-2 text-sm text-danger">
          {row.copyText}
        </div>
      </div>
    );
  }

  if (row.role === "custom") return <ExtensionMessageRow row={row} />;
  if (row.role === "bash") return <BashExecutionRow row={row} />;
  if (row.role === "summary") return <SummaryRow row={row} />;
  if (row.role === "event") return <SessionEventRow row={row} />;

  const sections = row.sections ?? {
    ordered: row.blocks,
    initialThinking: [],
    intro: [],
    activity: row.blocks,
    final: [],
    stepCount: row.blocks.filter((block) => block.kind === "tool").length,
  };
  const lastTextBlock = [...row.blocks]
    .reverse()
    .find((block): block is Extract<TranscriptBlock, { kind: "text" }> => block.kind === "text");

  return (
    <div className="group/assistant relative w-full">
      <div className="flex h-7 items-center gap-2">
        <AssistantAvatar />
        {working && <span className="text-[11px] text-muted">{t("transcriptPiWorking")}</span>}
      </div>
      <div className="mt-2 min-w-0 space-y-3">
        <AssistantOrderedContent
          blocks={sections.ordered}
          mode={mode}
          showCaret={showCaret}
          lastTextBlock={lastTextBlock}
          turnActive={working}
        />
        {row.outcome && (row.outcome.status === "error" || row.outcome.status === "aborted") && (
          <AssistantOutcome outcome={row.outcome} />
        )}
      </div>
      <div className="mt-2 flex h-7 items-center gap-2">
        <DurationLabel startedAt={row.startedAt} endedAt={row.endedAt} active={working} />
        <div className="ml-auto flex items-center gap-1">
          {!working && branch && (
            <RegenerateMessageButton
              entryId={branch.entryId}
              fallbackText={branch.fallbackText}
              images={branch.images}
              files={branch.files}
              attachmentIds={branch.attachmentIds}
              className="opacity-0 group-hover/assistant:opacity-100"
            />
          )}
          {!working && row.sourceEndId && (
            <ForkFromTurnButton
              entryId={row.sourceEndId}
              className="opacity-0 group-hover/assistant:opacity-100"
            />
          )}
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

function EditMessageButton({
  onStartEdit,
  className = "",
}: {
  onStartEdit: () => void;
  className?: string;
}) {
  const t = useT();
  const idle = useAppStore((s) => s.session?.isIdle ?? false);
  return (
    <button
      type="button"
      title={t("transcriptEdit")}
      aria-label={t("transcriptEdit")}
      disabled={!idle}
      className={`flex size-6 items-center justify-center rounded text-muted transition-opacity hover:bg-surface-overlay hover:text-foreground disabled:opacity-40 ${className}`}
      onClick={onStartEdit}
    >
      <Pencil size={13} />
    </button>
  );
}

function UserMessageEditor({
  text,
  canSend,
  onChange,
  onCancel,
  onSubmit,
}: {
  text: string;
  canSend: boolean;
  onChange?: (text: string) => void;
  onCancel?: () => void;
  onSubmit?: () => void | Promise<void>;
}) {
  const t = useT();
  const idle = useAppStore((s) => s.session?.isIdle ?? false);
  const [pending, setPending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.focus();
    node.selectionStart = node.value.length;
    node.selectionEnd = node.value.length;
  }, []);

  const submit = () => {
    if (!idle || pending || !canSend || !onSubmit) return;
    setPending(true);
    void Promise.resolve(onSubmit()).finally(() => setPending(false));
  };

  return (
    <div className="min-w-[16rem] sm:min-w-[22rem]">
      <textarea
        ref={textareaRef}
        value={text}
        disabled={pending}
        aria-label={t("transcriptEdit")}
        className="theme-user-message max-h-64 min-h-[4.5rem] w-full resize-y rounded-xl rounded-br-md border border-accent/40 bg-surface-overlay px-3.5 py-2.5 text-sm leading-6 outline-none"
        onChange={(event) => onChange?.(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel?.();
            return;
          }
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="mt-1 flex h-7 items-center justify-end gap-1">
        <button
          type="button"
          className="h-7 rounded-md px-2 text-xs text-muted hover:bg-surface-overlay hover:text-foreground"
          onClick={onCancel}
        >
          {t("commonCancel")}
        </button>
        <button
          type="button"
          disabled={!idle || pending || !canSend}
          className="flex h-7 items-center gap-1 rounded-md bg-accent px-2 text-xs text-accent-foreground hover:opacity-90 disabled:opacity-40"
          onClick={submit}
        >
          {pending ? <LoaderCircle size={12} className="animate-spin" /> : null}
          {t("transcriptEditSend")}
        </button>
      </div>
    </div>
  );
}

function RegenerateMessageButton({
  entryId,
  fallbackText,
  images,
  files,
  attachmentIds,
  className = "",
}: {
  entryId: string;
  fallbackText: string;
  images: BranchSource["images"];
  files: BranchSource["files"];
  attachmentIds: string[];
  className?: string;
}) {
  const t = useT();
  const idle = useAppStore((s) => s.session?.isIdle ?? false);
  const [pending, setPending] = useState(false);
  return (
    <button
      type="button"
      title={t("transcriptRegenerate")}
      aria-label={t("transcriptRegenerate")}
      disabled={!idle || pending}
      className={`flex size-6 items-center justify-center rounded text-muted transition-opacity hover:bg-surface-overlay hover:text-foreground disabled:opacity-40 ${className}`}
      onClick={() => {
        setPending(true);
        const prompt = branchPromptInput({
          entryId,
          fallbackText,
          images,
          files,
          attachmentIds,
        });
        void requestRegenerateInSession(entryId, {
          fallbackText: prompt.text,
          images: prompt.images,
          attachmentIds: prompt.attachmentIds,
        }).finally(() => setPending(false));
      }}
    >
      {pending ? <LoaderCircle size={13} className="animate-spin" /> : <RotateCw size={13} />}
    </button>
  );
}

/** Fork the conversation keeping history through this assistant turn. */
function ForkFromTurnButton({ entryId, className = "" }: { entryId: string; className?: string }) {
  const t = useT();
  const idle = useAppStore((s) => s.session?.isIdle ?? false);
  const [pending, setPending] = useState(false);
  return (
    <button
      type="button"
      title={t("transcriptForkHere")}
      aria-label={t("transcriptForkHere")}
      disabled={!idle || pending}
      className={`flex size-6 items-center justify-center rounded text-muted transition-opacity hover:bg-surface-overlay hover:text-foreground disabled:opacity-40 ${className}`}
      onClick={() => {
        setPending(true);
        void requestFork(entryId, { position: "at" }).finally(() => setPending(false));
      }}
    >
      {pending ? <LoaderCircle size={13} className="animate-spin" /> : <GitFork size={13} />}
    </button>
  );
}

/**
 * Keep assistant content in the order emitted by Pi. Reasoning and tool calls
 * are grouped only while they are adjacent, so a provider's text/thinking/tool
 * interleaving remains visible instead of being reclassified by position.
 */
export function AssistantOrderedContent({
  blocks,
  mode,
  showCaret,
  lastTextBlock,
  turnActive,
}: {
  blocks: TranscriptBlock[];
  mode: "streaming" | "static";
  showCaret: boolean;
  lastTextBlock?: Extract<TranscriptBlock, { kind: "text" }>;
  turnActive: boolean;
}) {
  const t = useT();
  const content: ReactNode[] = [];
  let workBlocks: TranscriptBlock[] = [];
  let workIndex = 0;

  const flushWork = (traceActive = false) => {
    if (workBlocks.length === 0) return;
    const hasActivity = workBlocks.some(
      (block) => block.kind === "tool" || block.kind === "extension",
    );
    if (hasActivity) {
      content.push(
        <ExecutionTrace
          key={`ordered-trace:${workIndex}`}
          blocks={workBlocks}
          stepCount={
            workBlocks.filter((block) => block.kind === "tool" || block.kind === "extension").length
          }
          mode={mode}
          showCaret={showCaret}
          lastTextBlock={lastTextBlock}
          turnActive={traceActive}
        />,
      );
    } else {
      workBlocks.forEach((block, index) => {
        if (block.kind === "thinking") {
          content.push(
            <ThinkingBlock
              key={`ordered-thinking:${workIndex}:${index}`}
              content={block.text}
              label={t("transcriptThoughtProcess")}
              defaultOpen={mode === "streaming"}
              streaming={mode === "streaming"}
            />,
          );
        } else {
          content.push(
            <AssistantBlock
              key={`ordered-work:${workIndex}:${index}`}
              block={block}
              mode={mode}
              showCaret={false}
            />,
          );
        }
      });
    }
    workBlocks = [];
    workIndex += 1;
  };

  blocks.forEach((block, index) => {
    if (block.kind === "thinking" || block.kind === "tool" || block.kind === "extension") {
      workBlocks.push(block);
      return;
    }
    flushWork();
    content.push(
      <AssistantBlock
        key={`ordered-block:${index}`}
        block={block}
        mode={mode}
        showCaret={showCaret && block === lastTextBlock}
      />,
    );
  });
  // Only the trailing trace can receive more adjacent tool calls. Earlier
  // trace groups are final even while the broader assistant turn is active.
  flushWork(turnActive);

  return <>{content}</>;
}

export function ExecutionTrace({
  blocks,
  stepCount,
  mode,
  showCaret,
  lastTextBlock,
  turnActive,
}: {
  blocks: TranscriptBlock[];
  stepCount: number;
  mode: "streaming" | "static";
  showCaret: boolean;
  lastTextBlock?: Extract<TranscriptBlock, { kind: "text" }>;
  turnActive: boolean;
}) {
  const t = useT();
  const contentId = useId();
  const tools = blocks.filter(
    (block): block is Extract<TranscriptBlock, { kind: "tool" }> => block.kind === "tool",
  );
  const extensions = blocks.filter(
    (block): block is Extract<TranscriptBlock, { kind: "extension" }> => block.kind === "extension",
  );
  const imageCount = tools.reduce(
    (count, block) =>
      count + (block.tool.resultBlocks?.filter((result) => result.kind === "image").length ?? 0),
    0,
  );
  const active =
    executionTraceIsActive(
      tools.map((block) => block.tool),
      turnActive,
    ) ||
    extensions.some((block) => {
      const status = block.row.extensionPresentation?.status;
      return status === "pending" || status === "running";
    });
  const [open, setOpen] = useState(false);
  const failed =
    tools.filter((block) => block.tool.status === "error").length +
    extensions.filter((block) => block.row.extensionPresentation?.status === "failed").length;
  const aborted = tools.filter((block) => block.tool.status === "aborted").length;
  const traceLabel = active
    ? t(stepCount === 1 ? "transcriptTraceRunningOne" : "transcriptTraceRunningMany", {
        count: stepCount,
      })
    : failed > 0
      ? t(
          stepCount === 1
            ? "transcriptTraceCompletedFailedOne"
            : "transcriptTraceCompletedFailedMany",
          { count: stepCount, failed },
        )
      : aborted > 0
        ? t(stepCount === 1 ? "transcriptTraceStoppedOne" : "transcriptTraceStoppedMany", {
            count: stepCount,
          })
        : t(stepCount === 1 ? "transcriptTraceCompletedOne" : "transcriptTraceCompletedMany", {
            count: stepCount,
          });
  const traceLabelWithMedia =
    imageCount > 0
      ? `${traceLabel} / ${t(
          imageCount === 1 ? "transcriptTraceImageOne" : "transcriptTraceImageMany",
          { count: imageCount },
        )}`
      : traceLabel;
  return (
    <div className="execution-trace">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex h-8 w-full items-center gap-2 rounded-md text-left text-xs font-medium text-foreground/80 transition-colors hover:text-foreground"
        aria-expanded={open}
        aria-controls={contentId}
      >
        {active ? (
          <span className="execution-trace-spinner text-muted" aria-hidden="true">
            <LoaderCircle size={14} />
          </span>
        ) : (
          <ListTree size={14} className="shrink-0 text-muted" aria-hidden="true" />
        )}
        <span className="min-w-0 truncate" title={traceLabelWithMedia}>
          {traceLabelWithMedia}
        </span>
        <ChevronRight
          size={13}
          className={`ml-auto transition-transform duration-[160ms] motion-reduce:transition-none ${
            open ? "rotate-90" : ""
          }`}
        />
      </button>
      <CollapsibleRegion open={open} id={contentId}>
        <div className="ml-2 mt-1 space-y-1 border-l border-border py-1 pl-4">
          {blocks.map((block, index) =>
            block.kind === "thinking" ? (
              <ThinkingBlock
                key={`activity:${block.kind}:${index}`}
                content={block.text}
                defaultOpen={active}
                streaming={active}
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
      </CollapsibleRegion>
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
  const t = useT();
  if (block.kind === "text") {
    return <LazyMarkdownMessage content={block.text} mode={mode} showCaret={showCaret} />;
  }
  if (block.kind === "thinking") {
    return <ThinkingBlock content={block.text} streaming={mode === "streaming"} />;
  }
  if (block.kind === "image") {
    return (
      <img
        src={`data:${block.mimeType};base64,${block.data}`}
        alt={t("transcriptAttachmentAlt")}
        className="max-h-48 max-w-full rounded-lg border border-border object-contain"
      />
    );
  }
  if (block.kind === "unknown") {
    return <UnknownBlock block={block} />;
  }
  if (block.kind === "extension") {
    return <ExtensionMessageRow row={block.row} />;
  }
  return <ToolTraceBlock tool={block.tool} />;
}

function ToolTraceBlock({ tool }: { tool: Extract<TranscriptBlock, { kind: "tool" }>["tool"] }) {
  const orderedResults = tool.resultBlocks?.some((block) => block.kind !== "text")
    ? tool.resultBlocks
    : undefined;
  return (
    <div className="min-w-0">
      <ToolView
        name={tool.name}
        args={tool.args}
        result={orderedResults ? undefined : tool.result}
        resultContent={
          orderedResults ? (
            <div className="space-y-2">
              {orderedResults.map((block, index) => (
                <ContentBlockView key={`tool-result:${index}`} block={block} />
              ))}
            </div>
          ) : undefined
        }
        details={tool.details}
        status={tool.status}
        startedAt={tool.startedAt}
        endedAt={tool.endedAt}
      />
    </div>
  );
}

const TOOL_RESULT_TEXT_LIMIT = 100_000;

function boundedToolResultText(text: string, truncatedLabel: string): string {
  return text.length <= TOOL_RESULT_TEXT_LIMIT
    ? text
    : `${text.slice(0, TOOL_RESULT_TEXT_LIMIT)}\n... ${truncatedLabel}`;
}

function ContentBlockView({ block }: { block: TranscriptContentBlock }) {
  const t = useT();
  if (block.kind === "text") {
    return (
      <LazyMarkdownMessage
        content={boundedToolResultText(block.text, t("transcriptToolDataTruncated"))}
        className="text-foreground/80"
      />
    );
  }
  if (block.kind === "thinking") {
    return (
      <ThinkingBlock
        content={boundedToolResultText(block.text, t("transcriptToolDataTruncated"))}
      />
    );
  }
  if (block.kind === "image") {
    return (
      <img
        src={`data:${block.mimeType};base64,${block.data}`}
        alt={t("transcriptToolResultAlt")}
        className="max-h-64 max-w-full rounded-md border border-border object-contain"
      />
    );
  }
  return <UnknownBlock block={block} />;
}

function UnknownBlock({ block }: { block: Extract<TranscriptContentBlock, { kind: "unknown" }> }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <details
      className="rounded-md border border-border/70 bg-surface-raised/60 text-xs"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-2 text-muted hover:text-foreground [&::-webkit-details-marker]:hidden">
        <Braces size={13} />
        <span>{t("transcriptUnsupportedContent")}</span>
        <span
          className="min-w-0 max-w-[55%] truncate font-mono text-[10px] text-muted/75"
          title={block.type}
        >
          {block.type}
        </span>
      </summary>
      {open && (
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words border-t border-border px-2.5 py-2 font-mono text-[11px] leading-5 text-foreground/75">
          {formatJson(block.value, t("transcriptDetailsTruncated"))}
        </pre>
      )}
    </details>
  );
}

function extensionStatusLabel(
  status: NonNullable<TranscriptRow["extensionPresentation"]>["status"],
  t: Translate,
): string | null {
  if (!status) return null;
  const labels = {
    pending: "extPresentationPending",
    running: "extPresentationRunning",
    resolved: "extPresentationResolved",
    cancelled: "extPresentationCancelled",
    expired: "extPresentationExpired",
    failed: "extPresentationFailed",
  } as const;
  return t(labels[status]);
}

function extensionKindLabel(
  presentation: NonNullable<TranscriptRow["extensionPresentation"]>,
  t: Translate,
): string {
  if (presentation.audience === "agent") return t("extPresentationAgentActivity");
  const labels = {
    activity: "extPresentationActivity",
    progress: "extPresentationProgress",
    decision: "extPresentationDecision",
    result: "extPresentationResult",
    warning: "extPresentationWarning",
  } as const;
  return t(labels[presentation.kind]);
}

function ExtensionTechnicalContent({
  row,
  presentation,
  renderBlocks = false,
}: {
  row: TranscriptRow;
  presentation?: NonNullable<TranscriptRow["extensionPresentation"]>;
  renderBlocks?: boolean;
}) {
  const t = useT();
  const visibleBlocks = row.blocks.filter(
    (block): block is Exclude<TranscriptBlock, { kind: "tool" }> => block.kind !== "tool",
  );
  const metadata = {
    ...(row.customType ? { customType: row.customType } : {}),
    ...(presentation ? { presentation } : {}),
    ...(row.details !== undefined ? { details: row.details } : {}),
  };
  const hasMetadata = Object.keys(metadata).length > 0;
  return (
    <div className="space-y-2">
      {renderBlocks ? (
        visibleBlocks.length > 0 && (
          <div className="space-y-2">
            {visibleBlocks.map((block, index) => (
              <AssistantBlock
                key={`extension-content:${index}`}
                block={block}
                mode="static"
                showCaret={false}
              />
            ))}
          </div>
        )
      ) : row.copyText ? (
        <div>
          <div className="mb-1 text-[10px] font-medium text-muted">
            {t("extPresentationRawMessage")}
          </div>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-overlay/50 px-2 py-1.5 font-mono text-[11px] leading-5 text-foreground/70">
            {formatJson(row.copyText, t("transcriptDetailsTruncated"))}
          </pre>
        </div>
      ) : null}
      {hasMetadata && (
        <div>
          <div className="mb-1 text-[10px] font-medium text-muted">
            {t("extPresentationMetadata")}
          </div>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-overlay/50 px-2 py-1.5 font-mono text-[11px] leading-5 text-foreground/70">
            {formatJson(metadata, t("transcriptDetailsTruncated"))}
          </pre>
        </div>
      )}
    </div>
  );
}

function ExtensionFallbackRow({ row }: { row: TranscriptRow }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="min-w-0 text-xs text-muted">
      <button
        type="button"
        className="flex h-8 w-full items-center gap-2 rounded-md text-left text-xs font-medium text-foreground/80 transition-colors hover:text-foreground"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Puzzle size={14} className="shrink-0" />
        <span className="min-w-0 truncate">{t("extPresentationFallback")}</span>
        <ChevronRight
          size={13}
          className={`ml-auto shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open && (
        <div className="ml-2 mt-1 border-l border-border py-1 pl-4">
          <ExtensionTechnicalContent row={row} renderBlocks />
        </div>
      )}
    </div>
  );
}

function ExtensionRenderedMessageRow({ row }: { row: TranscriptRow }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const render = row.extensionMessageRender!;
  const collapsedText = render.collapsed.join("\n");
  const expandedText = render.expanded.join("\n");
  const expandable = collapsedText !== expandedText;
  const toggleLabel = t(expanded ? "extRendererCollapse" : "extRendererExpand");

  if (!expandable) {
    return (
      <div className="flex min-w-0 items-start gap-2 py-1 text-xs text-foreground/80">
        <Puzzle size={14} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
        <pre className="max-h-48 min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5">
          {collapsedText}
        </pre>
      </div>
    );
  }

  return (
    <div className="min-w-0 text-xs text-foreground/80">
      <button
        type="button"
        className="flex min-h-8 w-full cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-surface-overlay/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/50"
        aria-expanded={expanded}
        title={toggleLabel}
        onClick={() => setExpanded((current) => !current)}
      >
        <Puzzle size={14} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-[11px] leading-5">
          {collapsedText}
        </span>
        <ChevronRight
          size={13}
          aria-hidden="true"
          className={`mt-0.5 shrink-0 text-muted transition-transform duration-150 motion-reduce:transition-none ${
            expanded ? "rotate-90" : ""
          }`}
        />
      </button>
      {expanded && (
        <pre className="ml-[22px] mt-1 max-h-[32rem] overflow-auto whitespace-pre-wrap break-words border-l border-border py-1 pl-3 font-mono text-[11px] leading-5">
          {expandedText}
        </pre>
      )}
    </div>
  );
}

export function ExtensionMessageRow({ row }: { row: TranscriptRow }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const presentation = row.extensionPresentation;
  if (!presentation && row.extensionMessageRender) {
    return <ExtensionRenderedMessageRow row={row} />;
  }
  if (!presentation) return <ExtensionFallbackRow row={row} />;

  const agentOnly = presentation.audience === "agent";
  const title = agentOnly
    ? t("extPresentationAgentActivity")
    : presentation.title?.trim() || extensionKindLabel(presentation, t);
  const summary = agentOnly ? undefined : presentation.summary?.trim();
  const statusLabel = extensionStatusLabel(presentation.status, t);
  const isDecision = presentation.audience === "user" && presentation.kind === "decision";
  const isDanger = presentation.status === "failed" || presentation.severity === "danger";
  const isWarning =
    !isDanger && (presentation.kind === "warning" || presentation.severity === "warning");
  const isSuccess = presentation.kind === "result" || presentation.status === "resolved";
  const Icon =
    isDanger || isWarning
      ? CircleAlert
      : isSuccess
        ? CircleCheck
        : isDecision
          ? MessageCircleQuestion
          : presentation.kind === "progress" && presentation.status === "running"
            ? LoaderCircle
            : Activity;
  const iconTone = isDanger
    ? "text-danger"
    : isWarning
      ? "text-warning"
      : isSuccess
        ? "text-success"
        : isDecision
          ? "text-foreground/80"
          : "text-muted";

  const header = (
    <>
      <Icon
        size={14}
        className={`shrink-0 ${iconTone} ${
          presentation.kind === "progress" && presentation.status === "running"
            ? "animate-spin"
            : ""
        }`}
      />
      <span className="min-w-0 truncate" title={title}>
        {title}
      </span>
      {!agentOnly && presentation.sourceLabel && (
        <span
          className="max-w-48 shrink-0 truncate text-[10px] font-normal text-muted"
          title={presentation.sourceLabel}
        >
          {presentation.sourceLabel}
        </span>
      )}
      {statusLabel && (
        <span className="shrink-0 text-[10px] font-normal text-muted">{statusLabel}</span>
      )}
    </>
  );

  return (
    <div className="min-w-0">
      <button
        type="button"
        className="flex h-8 w-full min-w-0 items-center gap-2 rounded-md text-left text-xs font-medium text-foreground/80 transition-colors hover:text-foreground"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {header}
        <ChevronRight
          size={13}
          className={`ml-auto shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open && (
        <div className="ml-2 mt-1 space-y-2 border-l border-border py-1 pl-4">
          {summary && <p className="break-words text-xs leading-5 text-muted">{summary}</p>}
          <ExtensionTechnicalContent row={row} presentation={presentation} />
        </div>
      )}
    </div>
  );
}

function BashExecutionRow({ row }: { row: TranscriptRow }) {
  const t = useT();
  const bash = row.bash;
  if (!bash) return null;
  const hasError = bash.cancelled || (bash.exitCode !== undefined && bash.exitCode !== 0);
  const outputLines = bash.output ? bash.output.split("\n") : [];
  const collapsible = outputLines.length > 5;
  const output = bash.output ? (
    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words border-t border-border px-3 py-2 font-mono text-[11px] leading-5 text-foreground/80">
      {bash.output}
      {bash.truncated ? `\n${t("transcriptOutputTruncated")}` : ""}
    </pre>
  ) : null;
  return (
    <div className="flex min-w-0 items-start gap-3">
      <div
        className={`mt-1 flex size-7 shrink-0 items-center justify-center rounded-md border ${hasError ? "border-danger/30 bg-danger/10 text-danger" : "border-border bg-surface-raised text-muted"}`}
      >
        <Terminal size={14} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-h-7 items-center gap-2 text-xs">
          <span className="min-w-0 break-all font-mono text-foreground/90">
            $ {bash.command || t("transcriptEmptyCommand")}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-1 text-[10px]">
            {hasError ? (
              <CircleAlert size={12} className="text-danger" />
            ) : (
              <CircleCheck size={12} className="text-success" />
            )}
            <span className={hasError ? "text-danger" : "text-muted"}>
              {bash.cancelled
                ? t("transcriptCancelled")
                : bash.exitCode === undefined
                  ? t("transcriptRunning")
                  : t("transcriptExitCode", { code: bash.exitCode })}
            </span>
          </span>
        </div>
        {output &&
          (collapsible ? (
            <details
              className="mt-1 rounded-md border border-border bg-surface-raised"
              open={hasError}
            >
              <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 text-[10px] text-muted hover:text-foreground [&::-webkit-details-marker]:hidden">
                <ChevronRight size={12} />
                <span>{t("transcriptOutputLines", { count: outputLines.length })}</span>
              </summary>
              {output}
            </details>
          ) : (
            <div className="mt-1 rounded-md border border-border bg-surface-raised">{output}</div>
          ))}
        {bash.fullOutputPath && (
          <div className="mt-1 min-w-0 break-words text-[10px] text-muted">
            {t("transcriptFullOutput")}{" "}
            <span className="font-mono break-all">{bash.fullOutputPath}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryRow({ row }: { row: TranscriptRow }) {
  const t = useT();
  const summary = row.summary;
  if (!summary) return null;
  const isBranch = summary.kind === "branch";
  return (
    <details className="group/summary border-y border-border/70 py-2">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-xs text-muted hover:text-foreground [&::-webkit-details-marker]:hidden">
        {isBranch ? <GitBranch size={14} /> : <FoldVertical size={14} />}
        <span className="font-medium">
          {isBranch ? t("transcriptBranchSummary") : t("transcriptConversationCompacted")}
        </span>
        {summary.tokensBefore !== undefined && (
          <span className="text-[10px]">
            {t("transcriptTokensBefore", { count: formatTokenCount(summary.tokensBefore) })}
          </span>
        )}
        <ChevronRight
          size={13}
          className="ml-auto transition-transform group-open/summary:rotate-90"
        />
      </summary>
      <div className="mt-2 border-l border-border pl-4">
        <LazyMarkdownMessage content={summary.text} className="text-muted" />
        {summary.details !== undefined && (
          <JsonDetails label={t("transcriptSummaryDetails")} value={summary.details} />
        )}
      </div>
    </details>
  );
}

function SessionEventRow({ row }: { row: TranscriptRow }) {
  const t = useT();
  const event = row.event;
  if (!event) return null;
  const Icon = event.kind === "model" ? Bot : event.kind === "thinkingLevel" ? Brain : CircleAlert;
  const eventDetails =
    event.details && typeof event.details === "object"
      ? (event.details as Record<string, unknown>)
      : undefined;
  const thinkingLevel = String(eventDetails?.thinkingLevel ?? "off");
  const thinkingLevelLabels = {
    off: "modelThinkingOff",
    minimal: "modelThinkingMinimal",
    low: "modelThinkingLow",
    medium: "modelThinkingMedium",
    high: "modelThinkingHigh",
    xhigh: "modelThinkingExtraHigh",
  } as const;
  const localizedThinkingLevel =
    thinkingLevel in thinkingLevelLabels
      ? t(thinkingLevelLabels[thinkingLevel as keyof typeof thinkingLevelLabels])
      : thinkingLevel;
  const label =
    event.kind === "model" && eventDetails
      ? t("transcriptModelChanged", {
          model: `${String(eventDetails.provider ?? "")}/${String(eventDetails.modelId ?? "")}`,
        })
      : event.kind === "thinkingLevel" && eventDetails
        ? t("transcriptThinkingLevelChanged", {
            level: localizedThinkingLevel,
          })
        : event.kind === "unknown" && eventDetails
          ? t("transcriptUnknownMessageRole", {
              role:
                typeof eventDetails.role === "string" && eventDetails.role
                  ? eventDetails.role
                  : t("transcriptMissingRole"),
            })
          : event.label;
  return (
    <div>
      <div className="flex items-center gap-3 py-1 text-[11px] text-muted">
        <div className="h-px flex-1 bg-border/70" />
        <span className="flex min-w-0 max-w-[80%] items-center gap-1.5 text-center">
          <Icon size={13} />
          <span className="min-w-0 break-words">{label}</span>
        </span>
        <div className="h-px flex-1 bg-border/70" />
      </div>
      {event.kind === "unknown" && (row.blocks.length > 0 || event.details !== undefined) && (
        <div className="mx-auto mt-1 max-w-[90%] space-y-2">
          {row.blocks.map((block, index) => (
            <AssistantBlock key={`event:${index}`} block={block} mode="static" showCaret={false} />
          ))}
          {event.details !== undefined && (
            <JsonDetails label={t("transcriptRawMessage")} value={event.details} />
          )}
        </div>
      )}
    </div>
  );
}

function AssistantOutcome({ outcome }: { outcome: NonNullable<TranscriptRow["outcome"]> }) {
  const t = useT();
  const aborted = outcome.status === "aborted";
  const message =
    outcome.errorMessage ||
    (aborted ? t("transcriptOperationAborted") : t("transcriptAssistantIncomplete"));
  return (
    <div
      className={`flex items-start gap-2 border-l-2 px-3 py-2 text-xs ${aborted ? "border-warning/60 bg-warning/8 text-warning" : "border-danger/70 bg-danger/8 text-danger"}`}
    >
      {aborted ? (
        <Ban size={14} className="mt-0.5 shrink-0" />
      ) : (
        <CircleAlert size={14} className="mt-0.5 shrink-0" />
      )}
      <div className="min-w-0">
        <div className="font-medium">
          {aborted ? t("transcriptResponseStopped") : t("transcriptResponseFailed")}
        </div>
        <div className="mt-0.5 whitespace-pre-wrap break-words opacity-90">{message}</div>
      </div>
    </div>
  );
}

function JsonDetails({ label, value }: { label: string; value: unknown }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <details
      className="mt-2 text-[10px] text-muted"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-1 hover:text-foreground [&::-webkit-details-marker]:hidden">
        <Braces size={12} />
        <span>{label}</span>
      </summary>
      {open && (
        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-overlay/50 px-2 py-1.5 font-mono text-[11px] leading-5 text-foreground/70">
          {formatJson(value, t("transcriptDetailsTruncated"))}
        </pre>
      )}
    </details>
  );
}

function formatJson(value: unknown, truncatedLabel = "[details truncated]"): string {
  const limit = 100_000;
  let formatted: string;
  if (typeof value === "string") {
    formatted = value;
  } else {
    try {
      formatted = JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      formatted = String(value);
    }
  }
  if (formatted.length <= limit) return formatted;
  return `${formatted.slice(0, limit)}\n... ${truncatedLabel}`;
}

const THINKING_FOLLOW_THRESHOLD_PX = 24;

export function ThinkingBlock({
  content,
  label,
  defaultOpen = false,
  streaming = false,
}: {
  content: string;
  label?: string;
  defaultOpen?: boolean;
  streaming?: boolean;
}) {
  const t = useT();
  const contentId = useId();
  const [open, setOpen] = useState(defaultOpen);
  const [following, setFollowing] = useState(true);
  const [overflowing, setOverflowing] = useState(false);
  const userToggled = useRef(false);
  const followingRef = useRef(true);
  const returningToLatestRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const text = sanitizeAgentText(content);

  const updateFollowing = useCallback((next: boolean) => {
    followingRef.current = next;
    setFollowing((current) => (current === next ? current : next));
  }, []);

  const syncScrollLayout = useCallback(
    (followTail: boolean) => {
      const element = scrollRef.current;
      if (!element) return;
      const nextOverflowing = element.scrollHeight - element.clientHeight > 1;
      setOverflowing((current) => (current === nextOverflowing ? current : nextOverflowing));
      if (!nextOverflowing) {
        returningToLatestRef.current = false;
        updateFollowing(true);
        return;
      }
      if (followTail) element.scrollTop = element.scrollHeight;
    },
    [updateFollowing],
  );

  useEffect(() => {
    if (userToggled.current) return;
    setOpen(defaultOpen);
    if (defaultOpen) updateFollowing(true);
  }, [defaultOpen, updateFollowing]);

  useLayoutEffect(() => {
    if (!open) return;
    syncScrollLayout(streaming && followingRef.current);
  }, [open, streaming, syncScrollLayout, text]);

  useLayoutEffect(() => {
    if (!open || typeof ResizeObserver === "undefined") return;
    const observed = contentRef.current;
    if (!observed) return;
    const observer = new ResizeObserver(() => {
      syncScrollLayout(streaming && followingRef.current);
    });
    observer.observe(observed);
    return () => observer.disconnect();
  }, [open, streaming, syncScrollLayout]);

  if (!text.trim()) return null;

  function scrollToLatest() {
    const element = scrollRef.current;
    if (!element) return;
    returningToLatestRef.current = true;
    updateFollowing(true);
    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (typeof element.scrollTo === "function") {
      element.scrollTo({
        top: element.scrollHeight,
        behavior: reduceMotion ? "auto" : "smooth",
      });
    } else {
      element.scrollTop = element.scrollHeight;
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          userToggled.current = true;
          setOpen((current) => !current);
        }}
        className="flex h-8 w-full items-center gap-2 rounded-md text-left text-xs text-muted transition-colors hover:text-foreground"
        aria-expanded={open}
        aria-controls={contentId}
      >
        <Brain size={14} />
        <span>{label ?? t("transcriptThinking")}</span>
        <ChevronRight
          size={13}
          className={`ml-auto transition-transform duration-[160ms] motion-reduce:transition-none ${
            open ? "rotate-90" : ""
          }`}
        />
      </button>
      <CollapsibleRegion open={open} id={contentId}>
        <div className="relative ml-[22px] border-l border-border">
          <div
            ref={scrollRef}
            data-thinking-scroll
            data-following={following ? "true" : "false"}
            role={overflowing ? "region" : undefined}
            aria-label={overflowing ? (label ?? t("transcriptThinking")) : undefined}
            tabIndex={overflowing ? 0 : undefined}
            className="thinking-scroll-region overflow-y-auto pl-3 pr-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-focus"
            onWheel={(event) => {
              const element = event.currentTarget;
              if (
                event.deltaY >= 0 ||
                element.scrollHeight <= element.clientHeight ||
                element.scrollTop <= 0
              ) {
                return;
              }
              returningToLatestRef.current = false;
              userToggled.current = true;
              updateFollowing(false);
            }}
            onScroll={(event) => {
              const element = event.currentTarget;
              const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
              const nextFollowing = distance < THINKING_FOLLOW_THRESHOLD_PX;
              if (returningToLatestRef.current) {
                if (nextFollowing) returningToLatestRef.current = false;
                return;
              }
              if (!nextFollowing) userToggled.current = true;
              updateFollowing(nextFollowing);
            }}
          >
            <div ref={contentRef} data-thinking-content>
              <LazyMarkdownMessage content={text} className="thinking-markdown" />
            </div>
          </div>
          {overflowing && !following && (
            <button
              type="button"
              onClick={scrollToLatest}
              className="absolute bottom-2 right-2 flex size-7 items-center justify-center rounded-full border border-border bg-surface-raised text-muted shadow-md transition-colors hover:bg-surface-overlay hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/50"
              title={t("transcriptThinkingJumpLatest")}
              aria-label={t("transcriptThinkingJumpLatest")}
            >
              <ArrowDown size={14} />
            </button>
          )}
        </div>
      </CollapsibleRegion>
    </div>
  );
}

function UsageLabel({ usage }: { usage?: TranscriptRow["usage"] }) {
  const t = useT();
  if (!usage) return null;
  const tooltip = [
    t("transcriptUsageInput", { count: formatTokenCount(usage.input) }),
    t("transcriptUsageOutput", { count: formatTokenCount(usage.output) }),
    t("transcriptUsageCacheRead", { count: formatTokenCount(usage.cacheRead) }),
    t("transcriptUsageCacheWrite", { count: formatTokenCount(usage.cacheWrite) }),
    t("transcriptUsageReasoning", {
      count:
        usage.reasoning === undefined
          ? t("transcriptUsageNotReported")
          : formatTokenCount(usage.reasoning),
    }),
  ].join("\n");
  const cost =
    usage.cost.total > 0
      ? usage.cost.total < 0.0001
        ? "<$0.0001"
        : `$${usage.cost.total.toFixed(4)}`
      : null;

  return (
    <span className="whitespace-nowrap text-[10px] tabular-nums text-muted" title={tooltip}>
      {formatTokenCount(usage.totalTokens)} {t("transcriptTokenShort")}
      {cost ? ` / ${cost}` : ""}
    </span>
  );
}

function CopyMessageButton({ text, className = "" }: { text: string; className?: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  if (!text) return null;
  return (
    <button
      type="button"
      title={copied ? t("transcriptCopied") : t("transcriptCopyMessage")}
      aria-label={copied ? t("transcriptCopied") : t("transcriptCopyMessage")}
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
