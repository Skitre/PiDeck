/**
 * Apply Host agent.event payloads onto the local SessionSnapshot projection.
 * Pi remains the fact source — this only streams UI until the next full snapshot.
 */
import type { SessionSnapshot, SerializableAgentMessage } from "@pideck/protocol";

type ToolExecutionPart = {
  type: "toolCall";
  id: string;
  name: string;
  text: string;
  status: "running" | "done" | "error" | "aborted";
  arguments?: string;
  result?: string;
  startedAt: number;
  endedAt?: number;
};

export type AgentEventEnvelope = {
  runId?: string;
  event: {
    type?: string;
    message?: SerializableAgentMessage | { role?: string; content?: unknown };
    delta?: unknown;
    assistantMessageEvent?: {
      type?: string;
      delta?: string;
      contentIndex?: number;
      content?: string;
    };
    toolCall?: { name?: string; arguments?: unknown; id?: string };
    toolCallId?: string;
    toolName?: string;
    args?: unknown;
    partialResult?: unknown;
    toolResult?: unknown;
    result?: unknown;
    isError?: boolean;
    error?: unknown;
    [key: string]: unknown;
  };
};

export type TimedAgentEventEnvelope = {
  payload: AgentEventEnvelope;
  receivedAt: number;
};

export function applyAgentEventBatch(
  session: SessionSnapshot | null,
  events: TimedAgentEventEnvelope[],
): SessionSnapshot | null {
  let next = session;
  for (const event of events) {
    next = applyAgentEvent(next, event.payload, event.receivedAt);
  }
  return next;
}

export function applyAgentEvent(
  session: SessionSnapshot | null,
  payload: AgentEventEnvelope,
  eventTime = Date.now(),
): SessionSnapshot | null {
  if (!session) return session;
  const ev = payload.event ?? (payload as unknown as AgentEventEnvelope["event"]);
  if (!ev || typeof ev !== "object") return session;

  const type = String(ev.type ?? "");
  let next: SessionSnapshot = { ...session, messages: [...session.messages] };

  switch (type) {
    case "agent_start":
    case "turn_start":
      next = { ...next, isStreaming: true, isIdle: false };
      break;

    case "message_start": {
      const msg = normalizeMessage(ev.message);
      if (msg) {
        next.messages = [
          ...next.messages,
          msg.role === "assistant"
            ? { ...msg, startedAt: numericField(msg, "startedAt") ?? eventTime }
            : msg,
        ];
      }
      next = { ...next, isStreaming: true, isIdle: false };
      break;
    }

    case "message_update": {
      if (ev.message) {
        const msg = normalizeMessage(ev.message);
        if (msg) {
          next.messages = mergeLastAssistant(next.messages, msg, eventTime, false);
        }
      }
      if (ev.assistantMessageEvent) {
        next.messages = appendAssistantContentEvent(
          next.messages,
          ev.assistantMessageEvent,
          eventTime,
          !ev.message,
        );
      } else if (!ev.message) {
        const deltaText = extractGenericDelta(ev);
        if (deltaText) next.messages = appendTextDelta(next.messages, deltaText, eventTime);
      }
      next = { ...next, isStreaming: true, isIdle: false };
      break;
    }

    case "message_end": {
      const msg = normalizeMessage(ev.message);
      if (msg) {
        if (msg.role === "assistant") {
          next.messages = mergeLastAssistant(next.messages, msg, eventTime, true);
        } else {
          const last = next.messages[next.messages.length - 1];
          next.messages = last?.role === msg.role
            ? [...next.messages.slice(0, -1), msg]
            : [...next.messages, msg];
        }
      }
      break;
    }

    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end": {
      const toolName = String(
        ev.toolName ?? (ev.toolCall as { name?: string } | undefined)?.name ?? "tool",
      );
      const toolCallId = String(
        ev.toolCallId ?? (ev.toolCall as { id?: string } | undefined)?.id ?? `${payload.runId ?? "run"}:${toolName}`,
      );
      const existing = findToolExecution(next.messages, toolCallId);
      const ended = type === "tool_execution_end";
      const aborted =
        ended &&
        Boolean(
          ev.result &&
            typeof ev.result === "object" &&
            "aborted" in ev.result &&
            (ev.result as { aborted?: unknown }).aborted,
        );
      const status = ended
        ? aborted
          ? "aborted"
          : ev.isError
            ? "error"
            : "done"
        : "running";
      const part: ToolExecutionPart = {
        type: "toolCall",
        id: toolCallId,
        name: toolName,
        text: status,
        status,
        arguments: toJsonish(
          ev.args ??
            (ev.toolCall as { arguments?: unknown } | undefined)?.arguments ??
            existing?.arguments ??
            null,
        ),
        result: toJsonish(
          ended ? ev.result ?? ev.error ?? null : ev.partialResult ?? existing?.result ?? null,
        ),
        startedAt: existing?.startedAt ?? eventTime,
        ...(ended ? { endedAt: eventTime } : {}),
      };
      next.messages = upsertToolExecution(next.messages, toolCallId, part);
      next = { ...next, isStreaming: true, isIdle: false };
      break;
    }

    case "queue_update": {
      const steering = Array.isArray((ev as { steering?: unknown }).steering)
        ? ((ev as { steering: string[] }).steering as string[])
        : next.pending.steering;
      const followUp = Array.isArray((ev as { followUp?: unknown }).followUp)
        ? ((ev as { followUp: string[] }).followUp as string[])
        : next.pending.followUp;
      next = {
        ...next,
        pending: { steering, followUp },
      };
      break;
    }

    case "compaction_start":
      next = { ...next, isCompacting: true, isIdle: false };
      break;
    case "compaction_end":
      next = { ...next, isCompacting: false };
      break;
    case "auto_retry_start":
      next = { ...next, isRetrying: true, isIdle: false };
      break;
    case "auto_retry_end":
      next = { ...next, isRetrying: false };
      break;

    case "agent_end":
    case "agent_settled":
      next.messages = settleOpenRuntime(next.messages, eventTime);
      next = {
        ...next,
        isStreaming: false,
        isIdle: true,
        isCompacting: false,
        isRetrying: false,
      };
      break;

    case "error": {
      const errText =
        typeof ev.error === "string"
          ? ev.error
          : typeof (ev as { message?: unknown }).message === "string"
            ? String((ev as { message: string }).message)
            : "Agent error";
      next.messages = [
        ...settleOpenRuntime(next.messages, eventTime),
        { role: "error", content: errText },
      ];
      next = { ...next, isStreaming: false, isIdle: true };
      break;
    }

    default:
      break;
  }

  return next;
}

function findToolExecution(
  messages: SerializableAgentMessage[],
  toolCallId: string,
): ToolExecutionPart | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "tool" || !Array.isArray(message.content)) continue;
    const part = message.content.find(
      (item) => item.type === "toolCall" && item.id === toolCallId,
    );
    if (part) return part as ToolExecutionPart;
  }
  return null;
}

function upsertToolExecution(
  messages: SerializableAgentMessage[],
  toolCallId: string,
  part: ToolExecutionPart,
): SerializableAgentMessage[] {
  const next = [...messages];
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const message = next[index];
    if (message?.role !== "tool" || !Array.isArray(message.content)) continue;
    if (message.content.some((item) => item.type === "toolCall" && item.id === toolCallId)) {
      next[index] = {
        ...message,
        content: message.content.map((item) =>
          item.type === "toolCall" && item.id === toolCallId ? part : item,
        ),
      };
      return next;
    }
  }
  next.push({ role: "tool", content: [part] });
  return next;
}

function normalizeMessage(
  message: unknown,
): SerializableAgentMessage | null {
  if (!message || typeof message !== "object") return null;
  const m = message as SerializableAgentMessage;
  if (typeof m.role !== "string") return null;
  return {
    ...m,
    role: m.role,
    content: (m.content as SerializableAgentMessage["content"]) ?? "",
  };
}

function extractGenericDelta(ev: AgentEventEnvelope["event"]): string {
  if (typeof ev.delta === "string") return ev.delta;
  if (ev.delta && typeof ev.delta === "object" && "text" in (ev.delta as object)) {
    return String((ev.delta as { text?: string }).text ?? "");
  }
  return "";
}

function numericField(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

function mergeContentTiming(
  previous: SerializableAgentMessage["content"],
  current: SerializableAgentMessage["content"],
): SerializableAgentMessage["content"] {
  if (!Array.isArray(current) || !Array.isArray(previous)) return current;
  return current.map((part, index) => {
    const prior = previous[index];
    if (!prior || prior.type !== part.type) return part;
    const startedAt = numericField(part, "startedAt") ?? numericField(prior, "startedAt");
    const endedAt = numericField(part, "endedAt") ?? numericField(prior, "endedAt");
    return {
      ...part,
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(endedAt !== undefined ? { endedAt } : {}),
    };
  });
}

function mergeLastAssistant(
  messages: SerializableAgentMessage[],
  message: SerializableAgentMessage,
  eventTime: number,
  complete: boolean,
): SerializableAgentMessage[] {
  const last = messages[messages.length - 1];
  if (last?.role !== "assistant") {
    return [
      ...messages,
      {
        ...message,
        startedAt: numericField(message, "startedAt") ?? eventTime,
        ...(complete ? { endedAt: eventTime } : {}),
      },
    ];
  }
  return [
    ...messages.slice(0, -1),
    {
      ...message,
      content: mergeContentTiming(last.content, message.content),
      startedAt:
        numericField(message, "startedAt") ?? numericField(last, "startedAt") ?? eventTime,
      ...(complete ? { endedAt: eventTime } : {}),
    },
  ];
}

function appendAssistantContentEvent(
  messages: SerializableAgentMessage[],
  event: NonNullable<AgentEventEnvelope["event"]["assistantMessageEvent"]>,
  eventTime: number,
  appendContent: boolean,
): SerializableAgentMessage[] {
  const eventType = String(event.type ?? "");
  const contentKind = eventType.startsWith("thinking_")
    ? "thinking"
    : eventType.startsWith("text_")
      ? "text"
      : null;
  if (!contentKind) return messages;

  const delta =
    typeof event.delta === "string"
      ? event.delta
      : typeof event.content === "string" && eventType.endsWith("_end")
        ? event.content
        : "";
  const contentIndex =
    typeof event.contentIndex === "number" && event.contentIndex >= 0
      ? event.contentIndex
      : 0;

  const next = [...messages];
  const last = next[next.length - 1];
  if (!last || last.role !== "assistant") {
    next.push({ role: "assistant", content: [], startedAt: eventTime });
  }

  const assistant = next[next.length - 1]!;
  if (
    contentKind === "text" &&
    typeof assistant.content === "string" &&
    contentIndex === 0
  ) {
    if (appendContent && delta && eventType.endsWith("_delta")) {
      next[next.length - 1] = { ...assistant, content: assistant.content + delta };
    }
    return next;
  }

  const parts = Array.isArray(assistant.content)
    ? [...assistant.content]
    : assistant.content
      ? [{ type: "text", text: assistant.content }]
      : [];
  const current = parts[contentIndex];
  const currentValue =
    contentKind === "thinking"
      ? typeof current?.thinking === "string"
        ? current.thinking
        : ""
      : typeof current?.text === "string"
        ? current.text
        : "";

  if (!current || current.type !== contentKind) {
    parts[contentIndex] =
      contentKind === "thinking"
        ? { type: "thinking", thinking: appendContent ? delta : "", startedAt: eventTime }
        : { type: "text", text: delta };
  } else if (appendContent && delta && eventType.endsWith("_delta")) {
    parts[contentIndex] =
      contentKind === "thinking"
        ? { ...current, thinking: currentValue + delta }
        : { ...current, text: currentValue + delta };
  } else if (appendContent && delta && eventType.endsWith("_end")) {
    parts[contentIndex] =
      contentKind === "thinking"
        ? { ...current, thinking: delta }
        : { ...current, text: delta };
  }

  const updated = parts[contentIndex];
  if (contentKind === "thinking" && updated) {
    parts[contentIndex] = {
      ...updated,
      startedAt: numericField(updated, "startedAt") ?? eventTime,
      ...(eventType === "thinking_end" ? { endedAt: eventTime } : {}),
    };
  }

  next[next.length - 1] = { ...assistant, content: parts };
  return next;
}

function appendTextDelta(
  messages: SerializableAgentMessage[],
  delta: string,
  eventTime: number,
): SerializableAgentMessage[] {
  if (!delta) return messages;
  const out = [...messages];
  const last = out[out.length - 1];
  if (!last || last.role !== "assistant") {
    out.push({ role: "assistant", content: delta, startedAt: eventTime });
    return out;
  }
  const content = last.content;
  if (typeof content === "string") {
    out[out.length - 1] = { ...last, content: content + delta };
  } else if (Array.isArray(content)) {
    const parts = [...content];
    const lastPart = parts[parts.length - 1];
    if (lastPart && lastPart.type === "text" && typeof lastPart.text === "string") {
      parts[parts.length - 1] = { ...lastPart, text: lastPart.text + delta };
    } else {
      parts.push({ type: "text", text: delta });
    }
    out[out.length - 1] = { ...last, content: parts };
  } else {
    out[out.length - 1] = { ...last, content: delta };
  }
  return out;
}

function settleOpenRuntime(
  messages: SerializableAgentMessage[],
  eventTime: number,
): SerializableAgentMessage[] {
  let lastAssistant = -1;
  messages.forEach((message, index) => {
    if (message.role === "assistant") lastAssistant = index;
  });

  return messages.map((message, messageIndex) => {
    let nextMessage = message;
    if (messageIndex === lastAssistant && numericField(message, "endedAt") === undefined) {
      nextMessage = { ...nextMessage, endedAt: eventTime };
    }
    if (!Array.isArray(message.content)) return nextMessage;
    if (message.role === "assistant") {
      const content = message.content.map((part) => {
        if (!["toolCall", "tool_use", "functionCall"].includes(part.type)) return part;
        const status = typeof part.status === "string" ? part.status : "waiting";
        if (status !== "running" && status !== "waiting") return part;
        return { ...part, status: "aborted", endedAt: eventTime };
      });
      return { ...nextMessage, content };
    }
    if (message.role !== "tool") return nextMessage;
    const content = message.content.map((part) => {
      const status = typeof part.status === "string" ? part.status : "";
      if (status !== "running" && status !== "waiting") return part;
      return { ...part, status: "aborted", text: "aborted", endedAt: eventTime };
    });
    return { ...nextMessage, content };
  });
}

function toJsonish(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
