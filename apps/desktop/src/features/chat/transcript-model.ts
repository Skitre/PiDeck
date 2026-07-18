import type {
  SerializableAgentContent,
  SerializableAgentMessage,
} from "@pideck/protocol";

export type ToolTraceStatus = "waiting" | "running" | "done" | "error" | "aborted";

export type ToolTrace = {
  id: string;
  name: string;
  args?: unknown;
  result?: unknown;
  details?: unknown;
  status: ToolTraceStatus;
  startedAt?: number;
  endedAt?: number;
};

export type TranscriptBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string; startedAt?: number; endedAt?: number }
  | { kind: "tool"; tool: ToolTrace };

export type AssistantTurnSections = {
  initialThinking: Extract<TranscriptBlock, { kind: "thinking" }>[];
  intro: Extract<TranscriptBlock, { kind: "text" }>[];
  activity: TranscriptBlock[];
  final: Extract<TranscriptBlock, { kind: "text" }>[];
  stepCount: number;
};

export type TranscriptRow = {
  key: string;
  role: "user" | "assistant" | "error";
  blocks: TranscriptBlock[];
  copyText: string;
  sections?: AssistantTurnSections;
  startedAt?: number;
  endedAt?: number;
};

type WorkingTranscriptRow = TranscriptRow & {
  rounds?: TranscriptBlock[][];
};

type ToolResultRecord = {
  id: string;
  name: string;
  result?: unknown;
  details?: unknown;
  isError: boolean;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function numberField(value: unknown, key: string): number | undefined {
  const candidate = asRecord(value)[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
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

function toolResultForMessage(message: SerializableAgentMessage): ToolResultRecord | null {
  if (message.role !== "toolResult") return null;
  const record = asRecord(message);
  const id = typeof record.toolCallId === "string" ? record.toolCallId : "";
  if (!id) return null;
  return {
    id,
    name: typeof record.toolName === "string" ? record.toolName : "tool",
    result: messageText(message),
    details: record.details,
    isError: record.isError === true,
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
    ? linkedResult.isError
      ? "error"
      : "done"
    : rawStatus === "done" || rawStatus === "error" || rawStatus === "aborted"
      ? rawStatus
      : rawStatus === "running"
        ? "running"
        : "waiting";
  return {
    id,
    name: typeof record.name === "string" ? record.name : linkedResult?.name ?? "tool",
    args: record.arguments ?? record.input,
    result: record.result ?? linkedResult?.result,
    details: record.details ?? linkedResult?.details,
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
    if (part.type === "text" && typeof part.text === "string" && part.text) {
      blocks.push({ kind: "text", text: part.text });
      continue;
    }
    if (part.type === "thinking" || part.type === "reasoning") {
      const text = thinkingText(part);
      if (text) {
        blocks.push({
          kind: "thinking",
          text,
          startedAt: numberField(part, "startedAt"),
          endedAt: numberField(part, "endedAt"),
        });
      }
      continue;
    }
    const tool = toolTraceFromPart(part, sourceIndex * 1000 + partIndex, results);
    if (tool) blocks.push({ kind: "tool", tool });
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
      initialThinking: blocks.filter(
        (block): block is Extract<TranscriptBlock, { kind: "thinking" }> =>
          block.kind === "thinking",
      ),
      intro: [],
      activity: [],
      final: blocks.filter(
        (block): block is Extract<TranscriptBlock, { kind: "text" }> =>
          block.kind === "text",
      ),
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
        if (block.kind === "text") intro.push(block);
      }
      return;
    }

    if (roundIndex === firstToolRound) {
      const firstToolIndex = round.findIndex((block) => block.kind === "tool");
      round.forEach((block, blockIndex) => {
        if (blockIndex < firstToolIndex) {
          if (block.kind === "thinking") initialThinking.push(block);
          if (block.kind === "text") intro.push(block);
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
      if (block.kind === "text") final.push(block);
      else activity.push(block);
    }
  });

  return {
    initialThinking,
    intro,
    activity,
    final,
    stepCount: activity.filter(
      (block) => block.kind === "thinking" || block.kind === "tool",
    ).length,
  };
}

export function buildTranscriptRows(messages: SerializableAgentMessage[]): TranscriptRow[] {
  const results = new Map<string, ToolResultRecord>();
  for (const message of messages) {
    const result = toolResultForMessage(message);
    if (result) results.set(result.id, result);
  }

  const rows: WorkingTranscriptRow[] = [];
  const consumedResults = new Set<string>();

  messages.forEach((message, sourceIndex) => {
    if (message.role === "toolResult") return;

    if (message.role === "tool") {
      const toolBlocks = blocksForMessage(message, sourceIndex, results).filter(
        (block): block is Extract<TranscriptBlock, { kind: "tool" }> => block.kind === "tool",
      );
      toolBlocks.forEach((block) => consumedResults.add(block.tool.id));
      const previous = rows[rows.length - 1];
      if (previous?.role === "assistant") {
        for (const block of toolBlocks) {
          const existing = previous.blocks.find(
            (candidate) => candidate.kind === "tool" && candidate.tool.id === block.tool.id,
          );
          if (existing?.kind === "tool") {
            Object.assign(existing.tool, block.tool);
          } else {
            previous.blocks.push(block);
            const lastRound = previous.rounds?.[previous.rounds.length - 1];
            if (lastRound) lastRound.push(block);
            else previous.rounds = [[block]];
          }
          extendRowTiming(previous, block.tool.startedAt, block.tool.endedAt);
        }
      } else if (toolBlocks.length > 0) {
        const toolStarts = toolBlocks
          .map((block) => block.tool.startedAt)
          .filter((value): value is number => value !== undefined);
        const toolEnds = toolBlocks
          .map((block) => block.tool.endedAt)
          .filter((value): value is number => value !== undefined);
        rows.push({
          key: `assistant:${sourceIndex}`,
          role: "assistant",
          blocks: [...toolBlocks],
          copyText: "",
          rounds: [[...toolBlocks]],
          ...(toolStarts.length > 0 ? { startedAt: Math.min(...toolStarts) } : {}),
          ...(toolEnds.length > 0 ? { endedAt: Math.max(...toolEnds) } : {}),
        });
      }
      return;
    }

    const role =
      message.role === "user"
        ? "user"
        : message.role === "error"
          ? "error"
          : "assistant";
    const blocks = blocksForMessage(message, sourceIndex, results);
    const messageStartedAt = numberField(message, "startedAt");
    const messageEndedAt = numberField(message, "endedAt");
    for (const block of blocks) {
      if (block.kind === "tool") consumedResults.add(block.tool.id);
    }
    if (blocks.length === 0) return;

    const previous = rows[rows.length - 1];
    if (role === "assistant" && previous?.role === "assistant") {
      previous.blocks.push(...blocks);
      previous.copyText = copyTextForBlocks(previous.blocks);
      previous.rounds = [...(previous.rounds ?? []), blocks];
      extendRowTiming(previous, messageStartedAt, messageEndedAt);
      for (const block of blocks) {
        const timing = blockTiming(block);
        extendRowTiming(previous, timing.startedAt, timing.endedAt);
      }
      return;
    }

    rows.push({
      key: `${role}:${sourceIndex}`,
      role,
      blocks: [...blocks],
      copyText: copyTextForBlocks(blocks),
      ...(role === "assistant" ? { rounds: [[...blocks]] } : {}),
      ...(role === "assistant" && messageStartedAt !== undefined
        ? { startedAt: messageStartedAt }
        : {}),
      ...(role === "assistant" && messageEndedAt !== undefined ? { endedAt: messageEndedAt } : {}),
    });
    const current = rows[rows.length - 1];
    if (current?.role === "assistant") {
      for (const block of blocks) {
        const timing = blockTiming(block);
        extendRowTiming(current, timing.startedAt, timing.endedAt);
      }
    }
  });

  for (const [id, result] of results) {
    if (consumedResults.has(id) || !result.isError) continue;
    rows.push({
      key: `unmatched-error:${id}`,
      role: "assistant",
      blocks: [
        {
          kind: "tool",
          tool: {
            id,
            name: result.name,
            result: result.result,
            status: "error",
          },
        },
      ],
      copyText: "",
      rounds: [
        [
          {
            kind: "tool",
            tool: {
              id,
              name: result.name,
              result: result.result,
              status: "error",
            },
          },
        ],
      ],
    });
  }

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
      x.details === y.details
    );
  }
  return false;
}

function blockListEquivalent(a: TranscriptBlock[], b: TranscriptBlock[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!blockEquivalent(a[i], b[i])) return false;
  }
  return true;
}

function rowEquivalent(a: TranscriptRow, b: TranscriptRow): boolean {
  if (
    a.key !== b.key ||
    a.role !== b.role ||
    a.copyText !== b.copyText ||
    a.startedAt !== b.startedAt ||
    a.endedAt !== b.endedAt ||
    !blockListEquivalent(a.blocks, b.blocks)
  ) {
    return false;
  }
  if (!a.sections !== !b.sections) return false;
  if (a.sections && b.sections) {
    return (
      a.sections.stepCount === b.sections.stepCount &&
      blockListEquivalent(a.sections.initialThinking, b.sections.initialThinking) &&
      blockListEquivalent(a.sections.intro, b.sections.intro) &&
      blockListEquivalent(a.sections.activity, b.sections.activity) &&
      blockListEquivalent(a.sections.final, b.sections.final)
    );
  }
  return true;
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
  let reusedAll = previous.length === next.length;
  const merged = next.map((row, index) => {
    const prior = byKey.get(row.key);
    if (prior && rowEquivalent(prior, row)) {
      if (reusedAll && previous[index] !== prior) reusedAll = false;
      return prior;
    }
    reusedAll = false;
    return row;
  });
  return reusedAll ? previous : merged;
}
