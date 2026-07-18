import { describe, expect, it, vi } from "vitest";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import {
  createProvisionalSessionTitle,
  extractLatestAssistantText,
  generateRefinedSessionTitle,
  sanitizeSessionTitle,
} from "./session-title.js";

describe("session titles", () => {
  it("creates a concise provisional title from the first sentence", () => {
    expect(createProvisionalSessionTitle("修复 session 恢复问题。然后补测试")).toBe(
      "修复 session 恢复问题",
    );
    expect(createProvisionalSessionTitle("   ")).toBe("新会话");
  });

  it("cleans model labels, quotes, punctuation, and excessive length", () => {
    expect(sanitizeSessionTitle('标题："修复桌面会话恢复。"')).toBe("修复桌面会话恢复");
    expect(sanitizeSessionTitle("a".repeat(40))).toBe(`${"a".repeat(27)}…`);
  });

  it("extracts the latest assistant text blocks", () => {
    expect(
      extractLatestAssistantText([
        { role: "assistant", content: "old" },
        { role: "user", content: "question" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hidden" },
            { type: "text", text: "first" },
            { type: "text", text: "second" },
          ],
        },
      ]),
    ).toBe("first\nsecond");
  });

  it("uses a separate minimal completion and sanitizes its result", async () => {
    const complete = vi.fn(
      async (
        _model: Model<Api>,
        _context: Context,
        _options?: SimpleStreamOptions,
      ) =>
        ({
        role: "assistant",
        content: [{ type: "text", text: "Title: Restore desktop sessions." }],
        stopReason: "stop",
        }) as AssistantMessage,
    );
    const model = { provider: "test", id: "title", api: "test" } as Model<Api>;
    const title = await generateRefinedSessionTitle({
      model,
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
      },
      userPrompt: "Restore desktop sessions",
      assistantText: "Implemented session restoration.",
      complete,
    });

    expect(title).toBe("Restore desktop sessions");
    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0]?.[2]).toMatchObject({
      apiKey: "test-key",
      maxTokens: 64,
      maxRetries: 0,
      reasoning: "minimal",
      timeoutMs: 15_000,
    });
  });
});
