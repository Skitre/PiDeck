import { describe, expect, it } from "vitest";
import { toolResultNeedsToolsRefresh } from "./tools-refresh.js";

describe("toolResultNeedsToolsRefresh", () => {
  it("returns true when tool_execution_end has non-empty addedToolNames", () => {
    expect(
      toolResultNeedsToolsRefresh({
        type: "tool_execution_end",
        result: { addedToolNames: ["new_tool"], content: [], details: null },
      }),
    ).toBe(true);
  });

  it("returns false when addedToolNames empty or missing", () => {
    expect(
      toolResultNeedsToolsRefresh({
        type: "tool_execution_end",
        result: { content: [], details: null },
      }),
    ).toBe(false);
    expect(
      toolResultNeedsToolsRefresh({
        type: "tool_execution_end",
        result: { addedToolNames: [], content: [], details: null },
      }),
    ).toBe(false);
  });

  it("returns false for unrelated events", () => {
    expect(toolResultNeedsToolsRefresh({ type: "message_update" })).toBe(false);
  });
});
