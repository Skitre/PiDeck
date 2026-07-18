import { toJsonValue, type SerializableAgentSessionEvent } from "@pideck/protocol";

/**
 * Normalize AgentSession events for JSONL transport.
 * Preserves addedToolNames / terminate on tool results.
 */
export function normalizeAgentEvent(event: unknown): SerializableAgentSessionEvent {
  if (event === null || event === undefined) {
    return { type: "unknown" };
  }

  if (typeof event !== "object") {
    return { type: "unknown", value: toJsonValue(event) };
  }

  const e = event as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(e)) {
    if (key === "result" && value && typeof value === "object") {
      out.result = normalizeToolResult(value);
    } else {
      out[key] = toJsonValue(value);
    }
  }

  if (typeof out.type !== "string") {
    out.type = "unknown";
  }

  return out as SerializableAgentSessionEvent;
}

function normalizeToolResult(result: unknown): unknown {
  if (!result || typeof result !== "object") return toJsonValue(result);
  const r = result as Record<string, unknown>;
  const out: Record<string, unknown> = {
    content: toJsonValue(r.content ?? []),
    details: toJsonValue(r.details ?? null),
  };
  if (Array.isArray(r.addedToolNames)) {
    out.addedToolNames = r.addedToolNames.filter((n) => typeof n === "string");
  }
  if (typeof r.terminate === "boolean") {
    out.terminate = r.terminate;
  }
  return out;
}
