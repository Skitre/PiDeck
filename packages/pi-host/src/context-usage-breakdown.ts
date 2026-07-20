import type { SessionContextBreakdown } from "@pideck/protocol";

const CHARS_PER_TOKEN = 4;
const ESTIMATED_IMAGE_CHARS = 4_800;
const BREAKDOWN_KEYS = [
  "systemPrompt",
  "toolDefinitions",
  "userPrompts",
  "assistantMessages",
  "toolResults",
  "summaries",
  "other",
] as const satisfies readonly (keyof SessionContextBreakdown)[];

type UnknownRecord = Record<string, unknown>;

export type ContextBreakdownTool = {
  name: string;
  description?: string;
  parameters?: unknown;
};

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return "[unserializable]";
  }
}

function tokensForChars(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function contentChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;

  let chars = 0;
  for (const item of content) {
    const block = asRecord(item);
    if (!block) continue;
    if (block.type === "image") {
      chars += ESTIMATED_IMAGE_CHARS;
    } else if (block.type === "thinking" && typeof block.thinking === "string") {
      chars += block.thinking.length;
    } else if (typeof block.text === "string") {
      chars += block.text.length;
    }
  }
  return chars;
}

function assistantMessageTokens(message: UnknownRecord): number {
  if (!Array.isArray(message.content)) return tokensForChars(contentChars(message.content));

  let chars = 0;
  for (const item of message.content) {
    const block = asRecord(item);
    if (!block) continue;
    if (block.type === "text" && typeof block.text === "string") {
      chars += block.text.length;
    } else if (block.type === "thinking" && typeof block.thinking === "string") {
      chars += block.thinking.length;
    } else if (block.type === "image") {
      chars += ESTIMATED_IMAGE_CHARS;
    } else if (block.type === "toolCall") {
      chars += typeof block.name === "string" ? block.name.length : 0;
      chars += safeJsonStringify(block.arguments).length;
    }
  }
  return tokensForChars(chars);
}

function otherMessageTokens(message: UnknownRecord): number {
  if (message.role === "bashExecution") {
    const command = typeof message.command === "string" ? message.command : "";
    const output = typeof message.output === "string" ? message.output : "";
    return tokensForChars(command.length + output.length);
  }
  return tokensForChars(contentChars(message.content));
}

function sumBreakdown(breakdown: SessionContextBreakdown): number {
  return BREAKDOWN_KEYS.reduce((sum, key) => sum + breakdown[key], 0);
}

export function reconcileContextBreakdown(
  breakdown: SessionContextBreakdown,
  totalTokens: number | null,
): SessionContextBreakdown {
  if (totalTokens === null) return breakdown;
  const sourceTotal = sumBreakdown(breakdown);
  if (sourceTotal <= totalTokens) {
    return { ...breakdown, other: breakdown.other + totalTokens - sourceTotal };
  }
  if (sourceTotal === 0) {
    return { ...breakdown, other: totalTokens };
  }

  const weighted = BREAKDOWN_KEYS.map((key, index) => {
    const exact = (breakdown[key] * totalTokens) / sourceTotal;
    return { key, index, value: Math.floor(exact), fraction: exact - Math.floor(exact) };
  });
  let remaining = totalTokens - weighted.reduce((sum, item) => sum + item.value, 0);
  weighted
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index)
    .forEach((item) => {
      if (remaining <= 0) return;
      item.value += 1;
      remaining -= 1;
    });

  return Object.fromEntries(weighted.map(({ key, value }) => [key, value])) as SessionContextBreakdown;
}

export function buildContextUsageBreakdown(args: {
  systemPrompt: string;
  tools: ContextBreakdownTool[];
  activeToolNames: string[];
  messages: unknown[];
  totalTokens: number | null;
}): SessionContextBreakdown {
  const activeNames = new Set(args.activeToolNames);
  const activeTools = args.tools
    .filter((tool) => activeNames.has(tool.name))
    .map(({ name, description, parameters }) => ({ name, description, parameters }));
  const breakdown: SessionContextBreakdown = {
    systemPrompt: tokensForChars(args.systemPrompt.length),
    toolDefinitions: activeTools.length > 0 ? tokensForChars(safeJsonStringify(activeTools).length) : 0,
    userPrompts: 0,
    assistantMessages: 0,
    toolResults: 0,
    summaries: 0,
    other: 0,
  };

  for (const value of args.messages) {
    const message = asRecord(value);
    if (!message || typeof message.role !== "string") continue;
    switch (message.role) {
      case "user":
        breakdown.userPrompts += tokensForChars(contentChars(message.content));
        break;
      case "assistant":
        breakdown.assistantMessages += assistantMessageTokens(message);
        break;
      case "tool":
      case "toolResult":
      case "bashExecution":
        breakdown.toolResults += otherMessageTokens(message);
        break;
      case "branchSummary":
      case "compactionSummary":
        breakdown.summaries += tokensForChars(
          typeof message.summary === "string" ? message.summary.length : 0,
        );
        break;
      default:
        breakdown.other += otherMessageTokens(message);
        break;
    }
  }

  return reconcileContextBreakdown(breakdown, args.totalTokens);
}
