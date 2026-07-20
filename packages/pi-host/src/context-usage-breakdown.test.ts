import { describe, expect, it } from "vitest";
import {
  buildContextUsageBreakdown,
  reconcileContextBreakdown,
} from "./context-usage-breakdown.js";

describe("context usage breakdown", () => {
  it("categorizes current prompt, tools, messages, results, and summaries", () => {
    const breakdown = buildContextUsageBreakdown({
      systemPrompt: "system instructions",
      tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
      activeToolNames: ["read"],
      messages: [
        { role: "user", content: "inspect this" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "plan" },
            { type: "toolCall", name: "read", arguments: { path: "a.ts" } },
          ],
        },
        { role: "toolResult", content: [{ type: "text", text: "file contents" }] },
        { role: "compactionSummary", summary: "earlier work" },
      ],
      totalTokens: 100,
    });

    expect(breakdown.systemPrompt).toBeGreaterThan(0);
    expect(breakdown.toolDefinitions).toBeGreaterThan(0);
    expect(breakdown.userPrompts).toBeGreaterThan(0);
    expect(breakdown.assistantMessages).toBeGreaterThan(0);
    expect(breakdown.toolResults).toBeGreaterThan(0);
    expect(breakdown.summaries).toBeGreaterThan(0);
    expect(Object.values(breakdown).reduce((sum, value) => sum + value, 0)).toBe(100);
  });

  it("scales overestimates while preserving the provider total", () => {
    const breakdown = reconcileContextBreakdown(
      {
        systemPrompt: 100,
        toolDefinitions: 100,
        userPrompts: 100,
        assistantMessages: 100,
        toolResults: 100,
        summaries: 100,
        other: 100,
      },
      13,
    );

    expect(Object.values(breakdown).reduce((sum, value) => sum + value, 0)).toBe(13);
    expect(Object.values(breakdown).every((value) => Number.isSafeInteger(value) && value >= 0)).toBe(
      true,
    );
  });
});
