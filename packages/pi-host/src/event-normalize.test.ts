import { describe, expect, it } from "vitest";
import { normalizeAgentEvent } from "./event-normalize.js";

describe("normalizeAgentEvent", () => {
  it("preserves addedToolNames and terminate on tool results", () => {
    const out = normalizeAgentEvent({
      type: "tool_execution_end",
      result: {
        content: [{ type: "text", text: "ok" }],
        details: { nested: true },
        addedToolNames: ["dynamic_tool_a"],
        terminate: false,
      },
    });
    expect(out.type).toBe("tool_execution_end");
    const result = out.result as {
      addedToolNames?: string[];
      terminate?: boolean;
      details: unknown;
    };
    expect(result.addedToolNames).toEqual(["dynamic_tool_a"]);
    expect(result.terminate).toBe(false);
    expect(result.details).toEqual({ nested: true });
  });

  it("safe-serializes Error and drops functions in details", () => {
    const out = normalizeAgentEvent({
      type: "tool_execution_end",
      result: {
        content: [],
        details: { err: new Error("x"), fn: () => 1 },
      },
    });
    const result = out.result as { details: { err: { message: string }; fn: string } };
    expect(result.details.err.message).toBe("x");
    expect(result.details.fn).toBe("[function]");
  });
});
