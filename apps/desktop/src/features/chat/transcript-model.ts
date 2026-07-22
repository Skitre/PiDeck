import type {
  SerializableAgentContent,
  SerializableAgentMessage,
  SerializableSessionEntry,
  SerializableUsage,
} from "@pideck/protocol";
import { isAbortedToolResult } from "../../lib/chat/tool-result-status";

export type ToolTraceStatus = "waiting" | "running" | "done" | "error" | "aborted";

export type ToolTrace = {
  id: string;
  name: string;
  args?: unknown;
  result?: unknown;
  resultBlocks?: TranscriptContentBlock[];
  details?: unknown;
  status: ToolTraceStatus;
  startedAt?: number;
  endedAt?: number;
};

export function executionTraceIsActive(
  tools: readonly Pick<ToolTrace, "status">[],
  turnActive: boolean,
): boolean {
  return (
    turnActive ||
    tools.some((tool) => tool.status === "running" || tool.status === "waiting")
  );
}

export type TranscriptContentBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string; startedAt?: number; endedAt?: number }
  | { kind: "image"; data: string; mimeType: string }
  | { kind: "unknown"; type: string; value: unknown };

export type TranscriptBlock =
  | TranscriptContentBlock
  | { kind: "tool"; tool: ToolTrace };

export type AssistantOutcome = {
  status: "streaming" | "complete" | "error" | "aborted";
  stopReason?: string;
  errorMessage?: string;
};

export type BashExecution = {
  command: string;
  output: string;
  exitCode?: number;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  excludeFromContext: boolean;
};

export type TranscriptSummary = {
  kind: "compaction" | "branch";
  text: string;
  tokensBefore?: number;
  fromId?: string;
  details?: unknown;
  fromHook?: boolean;
};

export type TranscriptEvent = {
  kind: "model" | "thinkingLevel" | "unknown";
  label: string;
  details?: unknown;
};

export type AssistantTurnSections = {
  ordered: TranscriptBlock[];
  initialThinking: Extract<TranscriptBlock, { kind: "thinking" }>[];
  intro: TranscriptBlock[];
  activity: TranscriptBlock[];
  final: TranscriptBlock[];
  stepCount: number;
};

export type TranscriptRow = {
  key: string;
  role: "user" | "assistant" | "error" | "custom" | "bash" | "summary" | "event";
  blocks: TranscriptBlock[];
  copyText: string;
  sections?: AssistantTurnSections;
  outcome?: AssistantOutcome;
  customType?: string;
  display?: boolean;
  details?: unknown;
  bash?: BashExecution;
  summary?: TranscriptSummary;
  event?: TranscriptEvent;
  sourceId?: string;
  timestamp?: number;
  startedAt?: number;
  endedAt?: number;
  usage?: SerializableUsage;
};

export type BuildTranscriptOptions = {
  entries?: readonly SerializableSessionEntry[];
  leafId?: string | null;
};

export function findStreamingAssistantKey(
  rows: readonly TranscriptRow[],
  messages: readonly SerializableAgentMessage[],
  isStreaming: boolean,
): string | undefined {
  if (!isStreaming) return undefined;
  const tailRow = rows[rows.length - 1];
  if (tailRow?.role !== "assistant") return undefined;

  const lastMessage = messages[messages.length - 1];
  if (
    !lastMessage ||
    lastMessage.role !== "assistant" ||
    numberField(lastMessage, "endedAt") !== undefined
  ) {
    return undefined;
  }

  // Pi provider partials can carry stopReason="stop" from message_start.
  // Runtime timing, not stopReason, distinguishes an open partial here.
  return tailRow.key;
}

type WorkingTranscriptRow = TranscriptRow & {
  rounds?: TranscriptBlock[][];
};

type ToolResultRecord = {
  id: string;
  name: string;
  result?: unknown;
  resultBlocks: TranscriptContentBlock[];
  details?: unknown;
  isError: boolean;
  aborted: boolean;
};

type MessageSource = {
  kind: "message";
  message: SerializableAgentMessage;
  key: string;
  sourceId?: string;
  timestamp?: number;
};

type RowSource = {
  kind: "row";
  row: TranscriptRow;
};

type TranscriptSource = MessageSource | RowSource;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function numberField(value: unknown, key: string): number | undefined {
  const candidate = asRecord(value)[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  const candidate = asRecord(value)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function timestampField(value: unknown): number | undefined {
  const timestamp = asRecord(value).timestamp;
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) return timestamp;
  if (typeof timestamp !== "string") return undefined;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function mergeUsage(
  left: SerializableUsage | undefined,
  right: SerializableUsage | undefined,
): SerializableUsage | undefined {
  if (!left) return right;
  if (!right) return left;
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    ...(left.cacheWrite1h !== undefined || right.cacheWrite1h !== undefined
      ? { cacheWrite1h: (left.cacheWrite1h ?? 0) + (right.cacheWrite1h ?? 0) }
      : {}),
    ...(left.reasoning !== undefined || right.reasoning !== undefined
      ? { reasoning: (left.reasoning ?? 0) + (right.reasoning ?? 0) }
      : {}),
    totalTokens: left.totalTokens + right.totalTokens,
    cost: {
      input: left.cost.input + right.cost.input,
      output: left.cost.output + right.cost.output,
      cacheRead: left.cost.cacheRead + right.cost.cacheRead,
      cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
      total: left.cost.total + right.cost.total,
    },
  };
}

function contentParts(message: SerializableAgentMessage): SerializableAgentContent[] {
  return Array.isArray(message.content) ? message.content : [];
}

export function messageText(message: Pick<SerializableAgentMessage, "content">): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function thinkingText(part: SerializableAgentContent): string {
  const record = asRecord(part);
  return typeof record.thinking === "string"
    ? record.thinking
    : typeof record.reasoning === "string"
      ? record.reasoning
      : "";
}

function contentBlockFromPart(part: SerializableAgentContent): TranscriptContentBlock | null {
  if (part.type === "text" && typeof part.text === "string") {
    return part.text ? { kind: "text", text: part.text } : null;
  }
  if (part.type === "thinking" || part.type === "reasoning") {
    const text = thinkingText(part);
    return text
      ? {
          kind: "thinking",
          text,
          startedAt: numberField(part, "startedAt"),
          endedAt: numberField(part, "endedAt"),
        }
      : null;
  }
  if (part.type === "image") {
    const record = asRecord(part);
    if (typeof record.data === "string" && record.data) {
      return {
        kind: "image",
        data: record.data,
        mimeType:
          typeof record.mimeType === "string" && record.mimeType
            ? record.mimeType
            : typeof record.mediaType === "string" && record.mediaType
              ? record.mediaType
              : "image/png",
      };
    }
  }
  return {
    kind: "unknown",
    type: typeof part.type === "string" && part.type ? part.type : "unknown",
    value: part,
  };
}

function contentBlocksForValue(value: unknown): TranscriptContentBlock[] {
  if (typeof value === "string") {
    return value ? [{ kind: "text", text: value }] : [];
  }
  if (!Array.isArray(value)) {
    return value === undefined || value === null
      ? []
      : [{ kind: "unknown", type: "content", value }];
  }
  return value.flatMap((part) => {
    if (!part || typeof part !== "object") {
      return [{ kind: "unknown", type: "unknown", value: part } satisfies TranscriptContentBlock];
    }
    const block = contentBlockFromPart(part as SerializableAgentContent);
    return block ? [block] : [];
  });
}

function toolResultForMessage(message: SerializableAgentMessage): ToolResultRecord | null {
  if (message.role !== "toolResult") return null;
  const record = asRecord(message);
  const id = typeof record.toolCallId === "string" ? record.toolCallId : "";
  if (!id) return null;
  const resultBlocks = contentBlocksForValue(message.content);
  const result = messageText(message);
  const isError = record.isError === true;
  return {
    id,
    name: typeof record.toolName === "string" ? record.toolName : "tool",
    ...(result ? { result } : {}),
    resultBlocks,
    details: record.details,
    isError,
    aborted: isAbortedToolResult(message, isError),
  };
}

function toolTraceFromPart(
  part: SerializableAgentContent,
  index: number,
  results: Map<string, ToolResultRecord>,
): ToolTrace | null {
  if (!["toolCall", "tool_use", "functionCall"].includes(part.type)) return null;
  const record = asRecord(part);
  const id = typeof record.id === "string" ? record.id : `tool:${index}`;
  const linkedResult = results.get(id);
  const rawStatus = typeof record.status === "string" ? record.status : undefined;
  const status: ToolTraceStatus = linkedResult
    ? linkedResult.aborted
      ? "aborted"
      : linkedResult.isError
        ? "error"
        : "done"
    : rawStatus === "done" || rawStatus === "error" || rawStatus === "aborted"
      ? rawStatus
      : rawStatus === "running"
        ? "running"
        : "waiting";
  const inlineResult = record.result;
  const resultBlocks =
    linkedResult?.resultBlocks ??
    (Array.isArray(record.resultBlocks)
      ? contentBlocksForValue(record.resultBlocks)
      : contentBlocksForValue(inlineResult));
  const details = record.details ?? linkedResult?.details;
  return {
    id,
    name: typeof record.name === "string" ? record.name : linkedResult?.name ?? "tool",
    args: record.arguments ?? record.input,
    result: inlineResult ?? linkedResult?.result,
    ...(resultBlocks.length > 0 ? { resultBlocks } : {}),
    ...(details !== undefined && details !== null ? { details } : {}),
    status,
    startedAt: typeof record.startedAt === "number" ? record.startedAt : undefined,
    endedAt: typeof record.endedAt === "number" ? record.endedAt : undefined,
  };
}

function blocksForMessage(
  message: SerializableAgentMessage,
  sourceIndex: number,
  results: Map<string, ToolResultRecord>,
): TranscriptBlock[] {
  if (typeof message.content === "string") {
    return message.content ? [{ kind: "text", text: message.content }] : [];
  }
  const blocks: TranscriptBlock[] = [];
  for (const [partIndex, part] of contentParts(message).entries()) {
    const tool = toolTraceFromPart(part, sourceIndex * 1000 + partIndex, results);
    if (tool) {
      blocks.push({ kind: "tool", tool });
      continue;
    }
    const block = contentBlockFromPart(part);
    if (block) blocks.push(block);
  }
  return blocks;
}

function extendRowTiming(
  row: WorkingTranscriptRow,
  startedAt?: number,
  endedAt?: number,
) {
  if (startedAt !== undefined) {
    row.startedAt = row.startedAt === undefined ? startedAt : Math.min(row.startedAt, startedAt);
  }
  if (endedAt !== undefined) {
    row.endedAt = row.endedAt === undefined ? endedAt : Math.max(row.endedAt, endedAt);
  }
}

function blockTiming(block: TranscriptBlock): { startedAt?: number; endedAt?: number } {
  return block.kind === "tool"
    ? { startedAt: block.tool.startedAt, endedAt: block.tool.endedAt }
    : block.kind === "thinking"
      ? { startedAt: block.startedAt, endedAt: block.endedAt }
      : {};
}

function copyTextForBlocks(blocks: TranscriptBlock[]): string {
  return blocks
    .filter((block): block is Extract<TranscriptBlock, { kind: "text" }> => block.kind === "text")
    .map((block) => block.text)
    .join("\n\n");
}

function assistantSections(rounds: TranscriptBlock[][]): AssistantTurnSections {
  const firstToolRound = rounds.findIndex((round) =>
    round.some((block) => block.kind === "tool"),
  );

  if (firstToolRound < 0) {
    const blocks = rounds.flat();
    return {
      ordered: blocks,
      initialThinking: blocks.filter(
        (block): block is Extract<TranscriptBlock, { kind: "thinking" }> =>
          block.kind === "thinking",
      ),
      intro: [],
      activity: [],
      // Keep image/unknown blocks instead of silently dropping provider or
      // extension content from turns without tool calls.
      final: blocks.filter((block) => block.kind !== "thinking"),
      stepCount: 0,
    };
  }

  let lastToolRound = firstToolRound;
  rounds.forEach((round, index) => {
    if (round.some((block) => block.kind === "tool")) lastToolRound = index;
  });

  const initialThinking: AssistantTurnSections["initialThinking"] = [];
  const intro: AssistantTurnSections["intro"] = [];
  const activity: TranscriptBlock[] = [];
  const final: AssistantTurnSections["final"] = [];

  rounds.forEach((round, roundIndex) => {
    if (roundIndex < firstToolRound) {
      for (const block of round) {
        if (block.kind === "thinking") initialThinking.push(block);
        if (block.kind !== "tool") intro.push(block);
      }
      return;
    }

    if (roundIndex === firstToolRound) {
      const firstToolIndex = round.findIndex((block) => block.kind === "tool");
      round.forEach((block, blockIndex) => {
        if (blockIndex < firstToolIndex) {
          if (block.kind === "thinking") initialThinking.push(block);
          if (block.kind !== "tool") intro.push(block);
        } else {
          activity.push(block);
        }
      });
      return;
    }

    if (roundIndex <= lastToolRound) {
      activity.push(...round);
      return;
    }

    for (const block of round) {
      if (block.kind !== "tool" && block.kind !== "thinking") final.push(block);
      else activity.push(block);
    }
  });

  return {
    ordered: rounds.flat(),
    initialThinking,
    intro,
    activity,
    final,
    stepCount: activity.filter((block) => block.kind === "tool").length,
  };
}

function assistantOutcome(message: SerializableAgentMessage): AssistantOutcome | undefined {
  const stopReason = stringField(message, "stopReason");
  const errorMessage = stringField(message, "errorMessage");
  if (!stopReason && !errorMessage) return undefined;
  if (stopReason === "aborted") {
    return { status: "aborted", stopReason, ...(errorMessage ? { errorMessage } : {}) };
  }
  if (stopReason === "error" || errorMessage) {
    return { status: "error", ...(stopReason ? { stopReason } : {}), ...(errorMessage ? { errorMessage } : {}) };
  }
  return {
    status: stopReason === "toolUse" ? "streaming" : "complete",
    stopReason,
  };
}

function applyAssistantOutcomeToBlocks(
  blocks: TranscriptBlock[],
  outcome: AssistantOutcome | undefined,
): TranscriptBlock[] {
  if (!outcome || (outcome.status !== "error" && outcome.status !== "aborted")) return blocks;
  const fallback = outcome.errorMessage ?? (outcome.status === "aborted" ? "Operation aborted" : "Error");
  return blocks.map((block) => {
    if (block.kind !== "tool") return block;
    if (block.tool.status !== "waiting" && block.tool.status !== "running") return block;
    return {
      ...block,
      tool: {
        ...block.tool,
        status: outcome.status as "error" | "aborted",
        ...(block.tool.result === undefined ? { result: fallback } : {}),
      },
    };
  });
}

function customMessageVisible(message: SerializableAgentMessage): boolean {
  // SDK treats missing/false display as hidden. Do not leak extension state into
  // the transcript merely because it happens to contain text or JSON.
  return asRecord(message).display === true;
}

function bashFromMessage(message: SerializableAgentMessage): BashExecution {
  const record = asRecord(message);
  return {
    command: typeof record.command === "string" ? record.command : "",
    output: typeof record.output === "string" ? record.output : messageText(message),
    ...(numberField(message, "exitCode") !== undefined
      ? { exitCode: numberField(message, "exitCode") }
      : {}),
    cancelled: record.cancelled === true,
    truncated: record.truncated === true,
    ...(typeof record.fullOutputPath === "string" ? { fullOutputPath: record.fullOutputPath } : {}),
    excludeFromContext: record.excludeFromContext === true,
  };
}

function summaryFromMessage(message: SerializableAgentMessage): TranscriptSummary {
  const record = asRecord(message);
  const kind = message.role === "branchSummary" ? "branch" : "compaction";
  return {
    kind,
    text: typeof record.summary === "string" ? record.summary : "",
    ...(numberField(message, "tokensBefore") !== undefined
      ? { tokensBefore: numberField(message, "tokensBefore") }
      : {}),
    ...(typeof record.fromId === "string" ? { fromId: record.fromId } : {}),
    ...(record.details !== undefined ? { details: record.details } : {}),
    ...(record.fromHook === true ? { fromHook: true } : {}),
  };
}

function rowForNonAssistantMessage(
  message: SerializableAgentMessage,
  sourceKey: string,
  sourceId: string | undefined,
  timestamp: number | undefined,
  sourceIndex: number,
  results: Map<string, ToolResultRecord>,
): TranscriptRow | null {
  const role = message.role;
  if (role === "custom") {
    if (!customMessageVisible(message)) return null;
    const blocks = contentBlocksForValue(message.content);
    return {
      key: `custom:${sourceKey}`,
      role: "custom",
      blocks,
      copyText: copyTextForBlocks(blocks),
      customType: stringField(message, "customType") ?? "custom",
      display: true,
      ...(asRecord(message).details !== undefined ? { details: asRecord(message).details } : {}),
      ...(sourceId ? { sourceId } : {}),
      ...(timestamp !== undefined ? { timestamp } : {}),
    };
  }
  if (role === "bashExecution") {
    const bash = bashFromMessage(message);
    const blocks: TranscriptBlock[] = bash.output ? [{ kind: "text", text: bash.output }] : [];
    return {
      key: `bash:${sourceKey}`,
      role: "bash",
      blocks,
      copyText: bash.output,
      bash,
      ...(sourceId ? { sourceId } : {}),
      ...(timestamp !== undefined ? { timestamp } : {}),
    };
  }
  if (role === "branchSummary" || role === "compactionSummary") {
    const summary = summaryFromMessage(message);
    const blocks: TranscriptBlock[] = summary.text ? [{ kind: "text", text: summary.text }] : [];
    return {
      key: `summary:${sourceKey}`,
      role: "summary",
      blocks,
      copyText: summary.text,
      summary,
      ...(sourceId ? { sourceId } : {}),
      ...(timestamp !== undefined ? { timestamp } : {}),
    };
  }
  const blocks = blocksForMessage(message, sourceIndex, results);
  const copyText = copyTextForBlocks(blocks);
  if (role === "user" || role === "error") {
    if (blocks.length === 0 && role !== "error") return null;
    const errorText =
      role === "error" && blocks.length === 0
        ? stringField(message, "errorMessage") ?? "Agent error"
        : undefined;
    const finalBlocks = errorText ? [{ kind: "text", text: errorText } satisfies TranscriptBlock] : blocks;
    return {
      key: `${role}:${sourceKey}`,
      role,
      blocks: finalBlocks,
      copyText: copyTextForBlocks(finalBlocks),
      ...(sourceId ? { sourceId } : {}),
      ...(timestamp !== undefined ? { timestamp } : {}),
    };
  }
  if (role === "tool" || role === "toolResult" || role === "assistant") return null;
  // Preserve unknown roles as a visible diagnostic row instead of silently
  // presenting them as assistant prose.
  const details = asRecord(message);
  return {
    key: `event:${sourceKey}`,
    role: "event",
    blocks,
    copyText,
    event: {
      kind: "unknown",
      label: `Unknown message role: ${role || "(missing)"}`,
      details,
    },
    ...(sourceId ? { sourceId } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
  };
}

function sourceMessages(
  messages: readonly SerializableAgentMessage[],
  options: BuildTranscriptOptions | undefined,
): { sources: TranscriptSource[]; projectedMessageCount: number } {
  const entries = options?.entries;
  if (!entries) {
    return {
      sources: messages.map((message, index) => ({
        kind: "message" as const,
        message,
        key: String(index),
        timestamp: timestampField(message),
      })),
      projectedMessageCount: 0,
    };
  }

  const sources: TranscriptSource[] = [];
  let projectedMessageCount = 0;
  for (const entry of entries) {
    const record = asRecord(entry);
    const type = typeof record.type === "string" ? record.type : "unknown";
    const sourceId = typeof record.id === "string" ? record.id : undefined;
    const sourceKey = sourceId ?? `${type}:${sources.length}`;
    const timestamp = timestampField(record);
    if (type === "message") {
      projectedMessageCount += 1;
      const message = asAgentMessage(record.message);
      if (message) {
        sources.push({ kind: "message", message, key: sourceKey, sourceId, timestamp });
      }
      continue;
    }
    if (type === "custom_message") {
      projectedMessageCount += 1;
      const message = {
        role: "custom",
        customType: typeof record.customType === "string" ? record.customType : "custom",
        content: (record.content as SerializableAgentContent[] | string) ?? "",
        display: record.display === true,
        ...(record.details !== undefined ? { details: record.details } : {}),
      } as SerializableAgentMessage;
      sources.push({ kind: "message", message, key: sourceKey, sourceId, timestamp });
      continue;
    }
    if (type === "compaction") {
      projectedMessageCount += 1;
      sources.push({
        kind: "message",
        message: {
          role: "compactionSummary",
          content: "",
          summary: typeof record.summary === "string" ? record.summary : "",
          tokensBefore: record.tokensBefore as number | undefined,
          details: record.details,
          fromHook: record.fromHook,
        } as SerializableAgentMessage,
        key: sourceKey,
        sourceId,
        timestamp,
      });
      continue;
    }
    if (type === "branch_summary") {
      projectedMessageCount += 1;
      sources.push({
        kind: "message",
        message: {
          role: "branchSummary",
          content: "",
          summary: typeof record.summary === "string" ? record.summary : "",
          fromId: record.fromId as string | undefined,
          details: record.details,
          fromHook: record.fromHook,
        } as SerializableAgentMessage,
        key: sourceKey,
        sourceId,
        timestamp,
      });
      continue;
    }
    if (type === "model_change") {
      sources.push({
        kind: "row",
        row: {
          key: `event:${sourceKey}`,
          role: "event",
          blocks: [],
          copyText: "",
          event: {
            kind: "model",
            label: `Model: ${String(record.provider ?? "")}/${String(record.modelId ?? "")}`,
            details: record,
          },
          ...(sourceId ? { sourceId } : {}),
          ...(timestamp !== undefined ? { timestamp } : {}),
        },
      });
      continue;
    }
    if (type === "thinking_level_change") {
      sources.push({
        kind: "row",
        row: {
          key: `event:${sourceKey}`,
          role: "event",
          blocks: [],
          copyText: "",
          event: {
            kind: "thinkingLevel",
            label: `Thinking level: ${String(record.thinkingLevel ?? "off")}`,
            details: record,
          },
          ...(sourceId ? { sourceId } : {}),
          ...(timestamp !== undefined ? { timestamp } : {}),
        },
      });
      continue;
    }
    // Plain custom entries, labels and session metadata are intentionally not
    // rendered. Their data is for extension/session state, not conversation UI.
  }

  const tailStart = Math.min(projectedMessageCount, messages.length);
  for (let index = tailStart; index < messages.length; index += 1) {
    const message = messages[index];
    sources.push({
      kind: "message",
      message,
      key: `stream:${index}`,
      timestamp: timestampField(message),
    });
  }
  return { sources, projectedMessageCount };
}

function asAgentMessage(value: unknown): SerializableAgentMessage | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.role !== "string") return null;
  return {
    ...(record as SerializableAgentMessage),
    role: record.role,
    content: (record.content as SerializableAgentMessage["content"]) ?? "",
  };
}

export function buildTranscriptRows(
  messages: readonly SerializableAgentMessage[],
  options?: BuildTranscriptOptions,
): TranscriptRow[];
export function buildTranscriptRows(
  input: { messages: readonly SerializableAgentMessage[] } & BuildTranscriptOptions,
): TranscriptRow[];
export function buildTranscriptRows(
  inputOrMessages:
    | readonly SerializableAgentMessage[]
    | ({ messages: readonly SerializableAgentMessage[] } & BuildTranscriptOptions),
  options?: BuildTranscriptOptions,
): TranscriptRow[] {
  const input: { messages: readonly SerializableAgentMessage[] } & BuildTranscriptOptions =
    Array.isArray(inputOrMessages)
      ? { messages: inputOrMessages, ...(options ?? {}) }
      : (inputOrMessages as { messages: readonly SerializableAgentMessage[] } & BuildTranscriptOptions);
  const messages = input.messages;
  const { sources } = sourceMessages(messages, input);
  const allMessages = sources
    .filter((source): source is MessageSource => source.kind === "message")
    .map((source) => source.message);
  const results = new Map<string, ToolResultRecord>();
  const declaredToolIds = new Set<string>();
  for (const message of allMessages) {
    const result = toolResultForMessage(message);
    if (result) results.set(result.id, result);
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (!["toolCall", "tool_use", "functionCall"].includes(part.type)) continue;
        const id = stringField(part, "id");
        if (id) declaredToolIds.add(id);
      }
    }
  }

  const rows: WorkingTranscriptRow[] = [];
  let activeAssistant: WorkingTranscriptRow | null = null;
  const resetAssistant = () => {
    activeAssistant = null;
  };

  sources.forEach((source, sourceIndex) => {
    if (source.kind === "row") {
      rows.push(source.row);
      resetAssistant();
      return;
    }
    const { message, key: sourceKey, sourceId, timestamp } = source;
    const role = message.role;
    if (role === "toolResult") {
      const result = toolResultForMessage(message);
      if (!result || declaredToolIds.has(result.id)) return;
      const block: TranscriptBlock = {
        kind: "tool",
        tool: {
          id: result.id,
          name: result.name,
          result: result.result,
          ...(result.resultBlocks.length > 0 ? { resultBlocks: result.resultBlocks } : {}),
          details: result.details,
          status: result.aborted ? "aborted" : result.isError ? "error" : "done",
        },
      };
      const row: WorkingTranscriptRow = {
        key: `assistant:${sourceKey}`,
        role: "assistant",
        blocks: [block],
        copyText: "",
        rounds: [[block]],
        ...(sourceId ? { sourceId } : {}),
        ...(timestamp !== undefined ? { timestamp } : {}),
      };
      rows.push(row);
      activeAssistant = row;
      return;
    }
    if (role === "tool") {
      const toolBlocks = blocksForMessage(message, sourceIndex, results).filter(
        (block): block is Extract<TranscriptBlock, { kind: "tool" }> => block.kind === "tool",
      );
      if (toolBlocks.length === 0) return;
      if (activeAssistant?.role === "assistant") {
        for (const block of toolBlocks) {
          const existing = activeAssistant.blocks.find(
            (candidate) => candidate.kind === "tool" && candidate.tool.id === block.tool.id,
          );
          if (existing?.kind === "tool") {
            Object.assign(existing.tool, block.tool);
          } else {
            activeAssistant.blocks.push(block);
            const lastRound = activeAssistant.rounds?.[activeAssistant.rounds.length - 1];
            if (lastRound) lastRound.push(block);
            else activeAssistant.rounds = [[block]];
          }
          extendRowTiming(activeAssistant, block.tool.startedAt, block.tool.endedAt);
        }
        activeAssistant.copyText = copyTextForBlocks(activeAssistant.blocks);
      } else {
        const row: WorkingTranscriptRow = {
          key: `assistant:${sourceKey}`,
          role: "assistant",
          blocks: [...toolBlocks],
          copyText: "",
          rounds: [[...toolBlocks]],
          ...(sourceId ? { sourceId } : {}),
          ...(timestamp !== undefined ? { timestamp } : {}),
        };
        rows.push(row);
        activeAssistant = row;
      }
      return;
    }
    if (role === "assistant") {
      const outcome = assistantOutcome(message);
      const blocks = applyAssistantOutcomeToBlocks(
        blocksForMessage(message, sourceIndex, results),
        outcome,
      );
      const messageStartedAt = numberField(message, "startedAt");
      const messageEndedAt = numberField(message, "endedAt");
      if (activeAssistant?.role === "assistant") {
        activeAssistant.blocks.push(...blocks);
        activeAssistant.copyText = copyTextForBlocks(activeAssistant.blocks);
        activeAssistant.rounds = [...(activeAssistant.rounds ?? []), blocks];
        activeAssistant.usage = mergeUsage(activeAssistant.usage, message.usage);
        if (outcome) activeAssistant.outcome = outcome;
        extendRowTiming(activeAssistant, messageStartedAt, messageEndedAt);
        for (const block of blocks) {
          const timing = blockTiming(block);
          extendRowTiming(activeAssistant, timing.startedAt, timing.endedAt);
        }
        return;
      }
      if (blocks.length === 0 && !outcome) {
        resetAssistant();
        return;
      }
      const row: WorkingTranscriptRow = {
        key: `assistant:${sourceKey}`,
        role: "assistant",
        blocks: [...blocks],
        copyText: copyTextForBlocks(blocks),
        rounds: [[...blocks]],
        ...(outcome ? { outcome } : {}),
        ...(sourceId ? { sourceId } : {}),
        ...(timestamp !== undefined ? { timestamp } : {}),
        ...(messageStartedAt !== undefined ? { startedAt: messageStartedAt } : {}),
        ...(messageEndedAt !== undefined ? { endedAt: messageEndedAt } : {}),
        ...(message.usage ? { usage: message.usage } : {}),
      };
      rows.push(row);
      activeAssistant = row;
      for (const block of blocks) {
        const timing = blockTiming(block);
        extendRowTiming(row, timing.startedAt, timing.endedAt);
      }
      return;
    }

    const special = rowForNonAssistantMessage(
      message,
      sourceKey,
      sourceId,
      timestamp,
      sourceIndex,
      results,
    );
    if (special) rows.push(special);
    // Hidden custom messages are intentionally absent but still represent a
    // context boundary; this prevents unrelated assistant turns from merging.
    resetAssistant();
  });

  return rows.map(({ rounds, ...row }) => ({
    ...row,
    ...(row.role === "assistant"
      ? { sections: assistantSections(rounds ?? [row.blocks]) }
      : {}),
  }));
}

function blockEquivalent(a: TranscriptBlock, b: TranscriptBlock): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "text" && b.kind === "text") return a.text === b.text;
  if (a.kind === "image" && b.kind === "image") {
    return a.mimeType === b.mimeType && a.data === b.data;
  }
  if (a.kind === "unknown" && b.kind === "unknown") {
    return a.type === b.type && valuesEquivalent(a.value, b.value);
  }
  if (a.kind === "thinking" && b.kind === "thinking") {
    return a.text === b.text && a.startedAt === b.startedAt && a.endedAt === b.endedAt;
  }
  if (a.kind === "tool" && b.kind === "tool") {
    const x = a.tool;
    const y = b.tool;
    return (
      x.id === y.id &&
      x.name === y.name &&
      x.status === y.status &&
      x.startedAt === y.startedAt &&
      x.endedAt === y.endedAt &&
      x.args === y.args &&
      x.result === y.result &&
      blockListEquivalent(x.resultBlocks ?? [], y.resultBlocks ?? []) &&
      x.details === y.details
    );
  }
  return false;
}

function valuesEquivalent(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === undefined || b === undefined || a === null || b === null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function blockListEquivalent(a: TranscriptBlock[], b: TranscriptBlock[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!blockEquivalent(a[i], b[i])) return false;
  }
  return true;
}

function usageEquivalent(
  a: SerializableUsage | undefined,
  b: SerializableUsage | undefined,
): boolean {
  if (!a || !b) return a === b;
  return (
    a.input === b.input &&
    a.output === b.output &&
    a.cacheRead === b.cacheRead &&
    a.cacheWrite === b.cacheWrite &&
    a.cacheWrite1h === b.cacheWrite1h &&
    a.reasoning === b.reasoning &&
    a.totalTokens === b.totalTokens &&
    a.cost.input === b.cost.input &&
    a.cost.output === b.cost.output &&
    a.cost.cacheRead === b.cost.cacheRead &&
    a.cost.cacheWrite === b.cost.cacheWrite &&
    a.cost.total === b.cost.total
  );
}

function rowEquivalent(a: TranscriptRow, b: TranscriptRow): boolean {
  if (
    a.key !== b.key ||
    a.role !== b.role ||
    a.copyText !== b.copyText ||
    a.startedAt !== b.startedAt ||
    a.endedAt !== b.endedAt ||
    a.sourceId !== b.sourceId ||
    a.timestamp !== b.timestamp ||
    !valuesEquivalent(a.outcome, b.outcome) ||
    a.customType !== b.customType ||
    a.display !== b.display ||
    !valuesEquivalent(a.details, b.details) ||
    !valuesEquivalent(a.bash, b.bash) ||
    !valuesEquivalent(a.summary, b.summary) ||
    !valuesEquivalent(a.event, b.event) ||
    !usageEquivalent(a.usage, b.usage) ||
    !blockListEquivalent(a.blocks, b.blocks)
  ) {
    return false;
  }
  if (!a.sections !== !b.sections) return false;
  if (a.sections && b.sections) {
    return (
      a.sections.stepCount === b.sections.stepCount &&
      blockListEquivalent(a.sections.ordered, b.sections.ordered) &&
      blockListEquivalent(a.sections.initialThinking, b.sections.initialThinking) &&
      blockListEquivalent(a.sections.intro, b.sections.intro) &&
      blockListEquivalent(a.sections.activity, b.sections.activity) &&
      blockListEquivalent(a.sections.final, b.sections.final)
    );
  }
  return true;
}

function isLivePersistenceHandoff(
  previous: TranscriptRow,
  next: TranscriptRow,
): boolean {
  if (
    previous.sourceId !== undefined ||
    next.sourceId === undefined ||
    previous.role !== next.role ||
    !previous.key.includes("stream:")
  ) {
    return false;
  }

  if (previous.role !== "assistant") {
    return previous.copyText === next.copyText;
  }

  const previousToolIds = previous.blocks
    .filter((block): block is Extract<TranscriptBlock, { kind: "tool" }> => block.kind === "tool")
    .map((block) => block.tool.id);
  const nextToolIds = new Set(
    next.blocks
      .filter((block): block is Extract<TranscriptBlock, { kind: "tool" }> => block.kind === "tool")
      .map((block) => block.tool.id),
  );
  if (previousToolIds.some((id) => nextToolIds.has(id))) return true;

  if (previous.copyText && next.copyText) {
    return (
      previous.copyText === next.copyText ||
      previous.copyText.startsWith(next.copyText) ||
      next.copyText.startsWith(previous.copyText)
    );
  }
  if (previous.copyText || next.copyText) return false;

  const previousThinking = previous.blocks
    .filter((block): block is Extract<TranscriptBlock, { kind: "thinking" }> => block.kind === "thinking")
    .map((block) => block.text)
    .join("\n");
  const nextThinking = next.blocks
    .filter((block): block is Extract<TranscriptBlock, { kind: "thinking" }> => block.kind === "thinking")
    .map((block) => block.text)
    .join("\n");
  if (previousThinking && nextThinking) {
    return (
      previousThinking === nextThinking ||
      previousThinking.startsWith(nextThinking) ||
      nextThinking.startsWith(previousThinking)
    );
  }
  if (previousThinking || nextThinking) return false;

  return blockListEquivalent(previous.blocks, next.blocks);
}

/**
 * Text-file attachments travel inside the prompt text as tagged blocks so any
 * model (and the CLI) sees them; the transcript folds them back into chips.
 */
export function buildAttachedFileBlock(name: string, content: string): string {
  const safeName = name.replace(/"/g, "'");
  const body = content.endsWith("\n") ? content.slice(0, -1) : content;
  return `<attached-file name="${safeName}">\n${body}\n</attached-file>`;
}

export type ParsedUserText = {
  text: string;
  files: { name: string; content: string }[];
};

export function parseUserAttachments(raw: string): ParsedUserText {
  const files: ParsedUserText["files"] = [];
  const pattern = /<attached-file name="([^"]*)">\n?([\s\S]*?)\n?<\/attached-file>/g;
  const text = raw
    .replace(pattern, (_match, name: string, content: string) => {
      files.push({ name, content });
      return "";
    })
    .trim();
  return { text, files };
}

/**
 * Streaming hot path: the reducer rebuilds `messages` on every agent event,
 * so every derived row is a fresh object even when its content is unchanged.
 * Substituting the previous row object for content-equivalent rows lets a
 * memoized row component skip re-rendering the stable transcript prefix —
 * only the actively streaming row reconciles per frame.
 */
export function reuseStableRows(
  previous: TranscriptRow[] | null,
  next: TranscriptRow[],
): TranscriptRow[] {
  if (!previous || previous.length === 0) return next;
  const byKey = new Map(previous.map((row) => [row.key, row]));
  const bySourceId = new Map(
    previous
      .filter((row): row is TranscriptRow & { sourceId: string } => Boolean(row.sourceId))
      .map((row) => [row.sourceId, row]),
  );
  let reusedAll = previous.length === next.length;
  const merged = next.map((row, index) => {
    let stabilized = row;
    let prior = byKey.get(row.key);
    if (!prior && row.sourceId) {
      prior = bySourceId.get(row.sourceId);
      if (prior && prior.key !== row.key) stabilized = { ...row, key: prior.key };
    }
    if (!prior) {
      const indexedPrior = previous[index];
      if (indexedPrior && isLivePersistenceHandoff(indexedPrior, row)) {
        prior = indexedPrior;
        stabilized = { ...row, key: indexedPrior.key };
      }
    }
    if (prior && rowEquivalent(prior, stabilized)) {
      if (reusedAll && previous[index] !== prior) reusedAll = false;
      return prior;
    }
    reusedAll = false;
    return stabilized;
  });
  return reusedAll ? previous : merged;
}
