import { describe, expect, it } from "vitest";
import type { SerializableAgentMessage } from "@pideck/protocol";
import {
  buildAttachedFileBlock,
  buildTranscriptRows,
  executionTraceIsActive,
  findStreamingAssistantKey,
  messageText,
  parseUserAttachments,
  reuseStableRows,
} from "./transcript-model";

describe("attached file blocks", () => {
  it("round-trips build and parse", () => {
    const raw = [
      "please review",
      buildAttachedFileBlock("main.rs", "fn main() {}\n"),
      buildAttachedFileBlock('we"ird.txt', "content"),
    ].join("\n\n");
    const parsed = parseUserAttachments(raw);
    expect(parsed.text).toBe("please review");
    expect(parsed.files).toEqual([
      { name: "main.rs", content: "fn main() {}" },
      { name: "we'ird.txt", content: "content" },
    ]);
  });

  it("passes through plain text untouched", () => {
    const parsed = parseUserAttachments("just a message");
    expect(parsed).toEqual({ text: "just a message", files: [] });
  });
});

describe("reuseStableRows", () => {
  const history: SerializableAgentMessage[] = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "text", text: "hello" }] },
    { role: "user", content: [{ type: "text", text: "go" }] },
  ];

  it("keeps previous row object identities for content-equivalent rows", () => {
    const first = buildTranscriptRows(history);
    const second = reuseStableRows(first, buildTranscriptRows([...history]));
    // Same content → the exact same array/objects, so memoized rows skip render
    expect(second).toBe(first);
  });

  it("replaces only the row whose content changed during streaming", () => {
    const first = reuseStableRows(null, buildTranscriptRows(history));
    const streamed: SerializableAgentMessage[] = [
      ...history,
      { role: "assistant", content: [{ type: "text", text: "working on i" }] },
    ];
    const second = reuseStableRows(first, buildTranscriptRows(streamed));
    expect(second).not.toBe(first);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(second[2]).toBe(first[2]);
    expect(second[3]).not.toBe(first[3]);

    const grown: SerializableAgentMessage[] = [
      ...history,
      { role: "assistant", content: [{ type: "text", text: "working on it" }] },
    ];
    const third = reuseStableRows(second, buildTranscriptRows(grown));
    expect(third[0]).toBe(first[0]);
    expect(third[3]).not.toBe(second[3]);
    expect(third[3]?.copyText).toContain("working on it");
  });

  it("does not reuse a row when a tool status changes", () => {
    const withTool: SerializableAgentMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Running" },
          { type: "toolCall", id: "t1", name: "bash", status: "running" },
        ],
      },
    ];
    const first = reuseStableRows(null, buildTranscriptRows(withTool));
    const finished: SerializableAgentMessage[] = [
      ...withTool,
      {
        role: "toolResult",
        toolCallId: "t1",
        toolName: "bash",
        isError: false,
        content: [{ type: "text", text: "ok" }],
      },
    ];
    const second = reuseStableRows(first, buildTranscriptRows(finished));
    expect(second[0]).not.toBe(first[0]);
    const tool = second[0]?.blocks.find((block) => block.kind === "tool");
    expect(tool?.kind === "tool" && tool.tool.status).toBe("done");
  });

  it("keeps the live row key when the same message is persisted as an entry", () => {
    const messages: SerializableAgentMessage[] = [
      { role: "assistant", content: [{ type: "text", text: "Done" }] },
    ];
    const live = reuseStableRows(
      null,
      buildTranscriptRows(messages, { entries: [] }),
    );
    const persisted = reuseStableRows(
      live,
      buildTranscriptRows(messages, {
        entries: [
          {
            id: "entry-1",
            parentId: null,
            type: "message",
            timestamp: "2026-07-22T00:00:00.000Z",
            message: messages[0] as never,
          },
        ],
      }),
    );

    expect(live[0]?.key).toBe("assistant:stream:0");
    expect(persisted[0]?.key).toBe(live[0]?.key);
    expect(persisted[0]?.sourceId).toBe("entry-1");

    const refreshed = reuseStableRows(
      persisted,
      buildTranscriptRows(messages, {
        entries: [
          {
            id: "entry-1",
            parentId: null,
            type: "message",
            timestamp: "2026-07-22T00:00:00.000Z",
            message: messages[0] as never,
          },
        ],
      }),
    );
    expect(refreshed[0]?.key).toBe(live[0]?.key);
  });
});

describe("findStreamingAssistantKey", () => {
  it("accepts real Pi partials that already contain stopReason", () => {
    const messages: SerializableAgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "text", text: "Streaming" }],
        stopReason: "stop",
      },
    ];
    const rows = buildTranscriptRows(messages);

    expect(findStreamingAssistantKey(rows, messages, true)).toBe(rows[0]?.key);
  });

  it("does not reuse a settled prior assistant before the next provider block", () => {
    const messages: SerializableAgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "text", text: "Previous" }],
        endedAt: 200,
      },
    ];
    const rows = buildTranscriptRows(messages);

    expect(findStreamingAssistantKey(rows, messages, true)).toBeUndefined();
  });

  it("requires the current transcript tail to be an assistant row", () => {
    const messages: SerializableAgentMessage[] = [
      { role: "assistant", content: [{ type: "text", text: "Previous" }] },
      { role: "user", content: [{ type: "text", text: "Next" }] },
    ];
    const rows = buildTranscriptRows(messages);

    expect(findStreamingAssistantKey(rows, messages, true)).toBeUndefined();
  });

  it("does not mark a tool-execution tail as model text streaming", () => {
    const messages: SerializableAgentMessage[] = [
      { role: "assistant", content: [{ type: "text", text: "Calling a tool" }] },
      {
        role: "tool",
        content: [
          { type: "toolCall", id: "tool-1", name: "read", status: "running" },
        ],
      },
    ];
    const rows = buildTranscriptRows(messages);

    expect(rows.at(-1)?.role).toBe("assistant");
    expect(findStreamingAssistantKey(rows, messages, true)).toBeUndefined();
  });
});

describe("executionTraceIsActive", () => {
  it("keeps the trailing trace active between tool calls in one agent turn", () => {
    expect(executionTraceIsActive([{ status: "done" }], true)).toBe(true);
  });

  it("settles only after the agent turn ends", () => {
    expect(executionTraceIsActive([{ status: "done" }], false)).toBe(false);
    expect(executionTraceIsActive([{ status: "running" }], false)).toBe(true);
  });
});

describe("buildTranscriptRows", () => {
  it("aggregates usage across assistant messages in one turn", () => {
    const baseUsage = {
      input: 10,
      output: 2,
      cacheRead: 3,
      cacheWrite: 1,
      reasoning: 1,
      totalTokens: 16,
      cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.004, total: 0.037 },
    };
    const rows = buildTranscriptRows([
      {
        role: "assistant",
        content: [{ type: "text", text: "First" }],
        usage: baseUsage,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Second" }],
        usage: { ...baseUsage, reasoning: 2 },
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.usage).toEqual({
      input: 20,
      output: 4,
      cacheRead: 6,
      cacheWrite: 2,
      reasoning: 3,
      totalTokens: 32,
      cost: { input: 0.02, output: 0.04, cacheRead: 0.006, cacheWrite: 0.008, total: 0.074 },
    });
  });

  it("merges historical tool results into their assistant tool calls", () => {
    const messages: SerializableAgentMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Inspect files" },
          { type: "text", text: "I will check." },
          { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        isError: false,
        details: { diff: "-old\n+new" },
        content: [{ type: "text", text: "file contents" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
      },
    ];

    const rows = buildTranscriptRows(messages);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sections?.initialThinking.map((block) => block.text)).toEqual([
      "Inspect files",
    ]);
    expect(rows[0]?.sections?.intro.filter((block) => block.kind === "text").map((block) => block.text)).toEqual(["I will check."]);
    expect(rows[0]?.sections?.final.filter((block) => block.kind === "text").map((block) => block.text)).toEqual(["Done."]);
    expect(rows[0]?.sections?.stepCount).toBe(1);
    const tool = rows[0]?.sections?.activity[0];
    expect(tool?.kind).toBe("tool");
    if (tool?.kind === "tool") {
      expect(tool.tool.result).toBe("file contents");
      expect(tool.tool.details).toEqual({ diff: "-old\n+new" });
      expect(tool.tool.status).toBe("done");
    }
  });

  it("preserves the original assistant block order", () => {
    const rows = buildTranscriptRows([
      {
        role: "assistant",
        content: [
          { type: "text", text: "Before" },
          { type: "thinking", thinking: "Consider the next step" },
          { type: "toolCall", id: "ordered-1", name: "read", arguments: { path: "a.ts" } },
          { type: "text", text: "After" },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "ordered-1",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "file contents" }],
      },
    ]);

    expect(rows[0]?.sections?.ordered.map((block) => block.kind)).toEqual([
      "text",
      "thinking",
      "tool",
      "text",
    ]);
    expect(
      rows[0]?.sections?.ordered.map((block) =>
        block.kind === "tool"
          ? block.tool.id
          : block.kind === "text" || block.kind === "thinking"
            ? block.text
            : block.kind,
      ),
    ).toEqual(["Before", "Consider the next step", "ordered-1", "After"]);
  });

  it("attaches live tool projection messages to the previous assistant row", () => {
    const rows = buildTranscriptRows([
      { role: "assistant", content: [{ type: "text", text: "Checking" }] },
      {
        role: "tool",
        content: [
          {
            type: "toolCall",
            id: "live-1",
            name: "bash",
            status: "running",
            arguments: "{\"command\":\"pwd\"}",
          },
        ],
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.sections?.intro.filter((block) => block.kind === "text").map((block) => block.text)).toEqual(["Checking"]);
    expect(rows[0]?.sections?.activity.map((block) => block.kind)).toEqual(["tool"]);
  });

  it("replaces the persisted tool call with its live execution state", () => {
    const rows = buildTranscriptRows([
      {
        role: "assistant",
        startedAt: 100,
        content: [
          { type: "toolCall", id: "live-1", name: "bash", arguments: { command: "pwd" } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "toolCall",
            id: "live-1",
            name: "bash",
            status: "done",
            arguments: "{\"command\":\"pwd\"}",
            result: "ok",
            startedAt: 120,
            endedAt: 180,
          },
        ],
      },
    ]);

    const tools = rows[0]?.blocks.filter((block) => block.kind === "tool") ?? [];
    expect(tools).toHaveLength(1);
    expect(tools[0]?.kind === "tool" ? tools[0].tool.status : undefined).toBe("done");
    expect(rows[0]?.startedAt).toBe(100);
    expect(rows[0]?.endedAt).toBe(180);
  });

  it("projects realtime tool result blocks and details", () => {
    const rows = buildTranscriptRows([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "live-image", name: "capture", arguments: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "toolCall",
            id: "live-image",
            name: "capture",
            status: "done",
            result: "captured",
            resultBlocks: [
              { type: "text", text: "captured" },
              { type: "image", data: "aW1n", mimeType: "image/png" },
            ],
            details: { width: 10 },
          },
        ],
      },
    ]);

    const block = rows[0]?.blocks.find((candidate) => candidate.kind === "tool");
    expect(block?.kind).toBe("tool");
    if (block?.kind === "tool") {
      expect(block.tool.result).toBe("captured");
      expect(block.tool.details).toEqual({ width: 10 });
      expect(block.tool.resultBlocks).toEqual([
        { kind: "text", text: "captured" },
        { kind: "image", data: "aW1n", mimeType: "image/png" },
      ]);
    }
  });

  it("keeps unmatched tool errors visible", () => {
    const rows = buildTranscriptRows([
      {
        role: "toolResult",
        toolCallId: "missing-call",
        toolName: "bash",
        isError: true,
        content: [{ type: "text", text: "command failed" }],
      },
    ]);

    expect(rows).toHaveLength(1);
    const block = rows[0]?.sections?.activity[0];
    expect(block?.kind).toBe("tool");
    if (block?.kind === "tool") expect(block.tool.status).toBe("error");
  });

  it("groups multiple tool rounds into one turn with a final answer", () => {
    const rows = buildTranscriptRows([
      { role: "user", content: "Research this" },
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          { type: "thinking", thinking: "Plan searches" },
          { type: "text", text: "I will research several directions." },
          { type: "toolCall", id: "search-1", name: "search", arguments: { query: "one" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "search-1",
        toolName: "search",
        isError: false,
        content: [{ type: "text", text: "result one" }],
      },
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          { type: "thinking", thinking: "Refine query" },
          { type: "toolCall", id: "search-2", name: "search", arguments: { query: "two" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "search-2",
        toolName: "search",
        isError: false,
        content: [{ type: "text", text: "result two" }],
      },
      {
        role: "assistant",
        stopReason: "stop",
        content: [
          { type: "thinking", thinking: "Synthesize findings" },
          { type: "text", text: "# Final answer" },
        ],
      },
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[1]?.role).toBe("assistant");
    expect(rows[1]?.sections?.initialThinking.map((block) => block.text)).toEqual([
      "Plan searches",
    ]);
    expect(rows[1]?.sections?.activity.map((block) => block.kind)).toEqual([
      "tool",
      "thinking",
      "tool",
      "thinking",
    ]);
    expect(rows[1]?.sections?.stepCount).toBe(2);
    expect(rows[1]?.sections?.final.filter((block) => block.kind === "text").map((block) => block.text)).toEqual(["# Final answer"]);
  });
});

describe("buildTranscriptRows image parts", () => {
  it("renders user image parts as image blocks and reuses them stably", () => {
    const messages: SerializableAgentMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        ],
      },
    ];
    const first = buildTranscriptRows(messages);
    expect(first[0]?.blocks.map((block) => block.kind)).toEqual(["text", "image"]);
    const image = first[0]?.blocks[1];
    if (image?.kind === "image") {
      expect(image.data).toBe("aGVsbG8=");
      expect(image.mimeType).toBe("image/png");
    }
    const second = reuseStableRows(first, buildTranscriptRows([...messages]));
    expect(second).toBe(first);
  });
});

describe("messageText", () => {
  it("joins text parts without exposing tool or thinking payloads", () => {
    expect(
      messageText({
        content: [
          { type: "thinking", thinking: "hidden" },
          { type: "text", text: "one" },
          { type: "toolCall", id: "call" },
          { type: "text", text: "two" },
        ],
      }),
    ).toBe("one\ntwo");
  });
});

describe("Pi extension and session entry messages", () => {
  it("hides custom state messages and renders displayable custom messages separately", () => {
    const rows = buildTranscriptRows([
      {
        role: "custom",
        customType: "context-pruning",
        display: false,
        details: { keep: 4 },
        content: [{ type: "text", text: "internal state" }],
      },
      {
        role: "custom",
        customType: "plan",
        display: true,
        details: { status: "active" },
        content: [
          { type: "text", text: "## Plan" },
          { type: "image", data: "cGxhbg==", mimeType: "image/png" },
        ],
      },
    ] as SerializableAgentMessage[]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.role).toBe("custom");
    expect(rows[0]?.customType).toBe("plan");
    expect(rows[0]?.display).toBe(true);
    expect(rows[0]?.details).toEqual({ status: "active" });
    expect(rows[0]?.blocks.map((block) => block.kind)).toEqual(["text", "image"]);
  });

  it("keeps unknown content parts as typed fallback blocks", () => {
    const rows = buildTranscriptRows([
      {
        role: "assistant",
        content: [
          { type: "text", text: "before" },
          { type: "artifact", artifactId: "a1", payload: { ok: true } },
          { type: "text", text: "after" },
        ],
      },
    ]);
    expect(rows[0]?.blocks.map((block) => block.kind)).toEqual(["text", "unknown", "text"]);
    const unknown = rows[0]?.blocks[1];
    expect(unknown?.kind).toBe("unknown");
    if (unknown?.kind === "unknown") expect(unknown.type).toBe("artifact");
  });

  it("renders bash and summaries while deferring trailing setting changes", () => {
    const entries = [
      {
        id: "m1",
        type: "message",
        parentId: null,
        timestamp: "2026-07-22T00:00:00.000Z",
        message: {
          role: "bashExecution",
          command: "pwd",
          output: "C:/work",
          exitCode: 0,
          cancelled: false,
          truncated: false,
          timestamp: 1782086400000,
        },
      },
      {
        id: "c1",
        type: "compaction",
        parentId: "m1",
        timestamp: "2026-07-22T00:00:01.000Z",
        summary: "Earlier context",
        tokensBefore: 12000,
      },
      {
        id: "b1",
        type: "branch_summary",
        parentId: "c1",
        timestamp: "2026-07-22T00:00:02.000Z",
        fromId: "old-leaf",
        summary: "Returned from branch",
      },
      {
        id: "model1",
        type: "model_change",
        parentId: "b1",
        timestamp: "2026-07-22T00:00:03.000Z",
        provider: "openai",
        modelId: "gpt-test",
      },
      {
        id: "think1",
        type: "thinking_level_change",
        parentId: "model1",
        timestamp: "2026-07-22T00:00:04.000Z",
        thinkingLevel: "high",
      },
    ];
    const messages = [
      {
        role: "bashExecution",
        command: "pwd",
        output: "C:/work",
        exitCode: 0,
        cancelled: false,
        truncated: false,
        content: "",
      },
      { role: "compactionSummary", summary: "Earlier context", tokensBefore: 12000, content: "" },
      { role: "branchSummary", fromId: "old-leaf", summary: "Returned from branch", content: "" },
    ] as SerializableAgentMessage[];
    const rows = buildTranscriptRows(messages, { entries });
    expect(rows.map((row) => row.role)).toEqual(["bash", "summary", "summary"]);
    expect(rows[1]?.summary).toMatchObject({ kind: "compaction", text: "Earlier context", tokensBefore: 12000 });
    expect(rows[2]?.summary).toMatchObject({ kind: "branch", fromId: "old-leaf" });
  });

  it("shows only the final model and thinking level before the next user message", () => {
    const entries = [
      {
        id: "model-old",
        type: "model_change",
        parentId: null,
        timestamp: "2026-07-22T00:00:00.000Z",
        provider: "openai",
        modelId: "gpt-old",
      },
      {
        id: "thinking-old",
        type: "thinking_level_change",
        parentId: "model-old",
        timestamp: "2026-07-22T00:00:01.000Z",
        thinkingLevel: "low",
      },
      {
        id: "thinking-final",
        type: "thinking_level_change",
        parentId: "thinking-old",
        timestamp: "2026-07-22T00:00:02.000Z",
        thinkingLevel: "high",
      },
      {
        id: "model-final",
        type: "model_change",
        parentId: "thinking-final",
        timestamp: "2026-07-22T00:00:03.000Z",
        provider: "anthropic",
        modelId: "claude-final",
      },
      {
        id: "user-1",
        type: "message",
        parentId: "model-final",
        timestamp: "2026-07-22T00:00:04.000Z",
        message: { role: "user", content: "Use these settings" },
      },
    ];
    const messages = [
      { role: "user", content: "Use these settings" },
    ] as SerializableAgentMessage[];

    const rows = buildTranscriptRows(messages, { entries });

    expect(rows.map((row) => row.role)).toEqual(["event", "event", "user"]);
    expect(rows[0]?.sourceId).toBe("model-final");
    expect(rows[0]?.event).toMatchObject({
      kind: "model",
      label: "Model: anthropic/claude-final",
    });
    expect(rows[1]?.sourceId).toBe("thinking-final");
    expect(rows[1]?.event).toMatchObject({
      kind: "thinkingLevel",
      label: "Thinking level: high",
    });
    expect(rows[2]?.copyText).toBe("Use these settings");
  });

  it("keeps deferred setting events stable across the live-to-persisted handoff", () => {
    const settingEntries = [
      {
        id: "model-1",
        type: "model_change",
        parentId: null,
        timestamp: "2026-07-22T00:00:00.000Z",
        provider: "openai",
        modelId: "gpt-test",
      },
      {
        id: "thinking-1",
        type: "thinking_level_change",
        parentId: "model-1",
        timestamp: "2026-07-22T00:00:01.000Z",
        thinkingLevel: "medium",
      },
    ];
    const messages = [{ role: "user", content: "Streamed prompt" }] as SerializableAgentMessage[];
    const liveRows = buildTranscriptRows(messages, { entries: settingEntries });
    const persistedRows = buildTranscriptRows(messages, {
      entries: [
        ...settingEntries,
        {
          id: "user-1",
          type: "message",
          parentId: "thinking-1",
          timestamp: "2026-07-22T00:00:02.000Z",
          message: messages[0] as never,
        },
      ],
    });

    for (const rows of [liveRows, persistedRows]) {
      expect(rows.map((row) => row.role)).toEqual(["event", "event", "user"]);
      expect(rows.filter((row) => row.event?.kind === "model")).toHaveLength(1);
      expect(rows.filter((row) => row.event?.kind === "thinkingLevel")).toHaveLength(1);
    }
    expect(persistedRows[0]?.sourceId).toBe(liveRows[0]?.sourceId);
    expect(persistedRows[1]?.sourceId).toBe(liveRows[1]?.sourceId);
  });

  it("flushes single setting changes independently for each user message", () => {
    const entries = [
      {
        id: "model-1",
        type: "model_change",
        parentId: null,
        timestamp: "2026-07-22T00:00:00.000Z",
        provider: "openai",
        modelId: "gpt-test",
      },
      {
        id: "user-1",
        type: "message",
        parentId: "model-1",
        timestamp: "2026-07-22T00:00:01.000Z",
        message: { role: "user", content: "First prompt" },
      },
      {
        id: "thinking-1",
        type: "thinking_level_change",
        parentId: "user-1",
        timestamp: "2026-07-22T00:00:02.000Z",
        thinkingLevel: "high",
      },
      {
        id: "user-2",
        type: "message",
        parentId: "thinking-1",
        timestamp: "2026-07-22T00:00:03.000Z",
        message: { role: "user", content: "Second prompt" },
      },
    ];
    const messages = [
      { role: "user", content: "First prompt" },
      { role: "user", content: "Second prompt" },
    ] as SerializableAgentMessage[];

    const rows = buildTranscriptRows(messages, { entries });

    expect(rows.map((row) => row.role)).toEqual(["event", "user", "event", "user"]);
    expect(rows[0]?.event?.kind).toBe("model");
    expect(rows[2]?.event?.kind).toBe("thinkingLevel");
  });

  it("preserves a tool result image and details when linked to a call", () => {
    const rows = buildTranscriptRows([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "img-1", name: "capture", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "img-1",
        toolName: "capture",
        isError: false,
        details: { width: 10 },
        content: [{ type: "image", data: "aW1n", mimeType: "image/png" }],
      },
    ]);
    const block = rows[0]?.blocks.find((candidate) => candidate.kind === "tool");
    expect(block?.kind).toBe("tool");
    if (block?.kind === "tool") {
      expect(block.tool.details).toEqual({ width: 10 });
      expect(block.tool.result).toBeUndefined();
      expect(block.tool.resultBlocks).toEqual([
        { kind: "image", data: "aW1n", mimeType: "image/png" },
      ]);
    }
  });

  it("keeps Pi's standard error-shaped tool cancellation aborted after a snapshot", () => {
    const rows = buildTranscriptRows([
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "cancelled-read", name: "read", arguments: { path: "large.txt" } },
        ],
        stopReason: "aborted",
      },
      {
        role: "toolResult",
        toolCallId: "cancelled-read",
        toolName: "read",
        isError: true,
        details: {},
        content: [{ type: "text", text: "Operation aborted" }],
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toMatchObject({ status: "aborted", stopReason: "aborted" });
    const block = rows[0]?.blocks.find((candidate) => candidate.kind === "tool");
    expect(block?.kind).toBe("tool");
    if (block?.kind === "tool") {
      expect(block.tool).toMatchObject({
        id: "cancelled-read",
        status: "aborted",
        result: "Operation aborted",
        resultBlocks: [{ kind: "text", text: "Operation aborted" }],
        details: {},
      });
    }
  });

  it("keeps an assistant error with no content visible", () => {
    const rows = buildTranscriptRows([
      { role: "assistant", content: [], stopReason: "error", errorMessage: "Provider failed" },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.role).toBe("assistant");
    expect(rows[0]?.outcome).toMatchObject({
      status: "error",
      stopReason: "error",
      errorMessage: "Provider failed",
    });
    expect(rows[0]?.blocks).toEqual([]);

    const aborted = buildTranscriptRows([
      { role: "assistant", content: [], stopReason: "aborted" },
    ]);
    expect(aborted[0]?.outcome).toMatchObject({ status: "aborted", stopReason: "aborted" });
  });

  it("uses entry messages as the persisted prefix and keeps only the streaming tail", () => {
    const entries = [
      {
        id: "u1",
        type: "message",
        parentId: null,
        timestamp: "2026-07-22T00:00:00.000Z",
        message: { role: "user", content: "old prompt" },
      },
      {
        id: "hidden",
        type: "custom_message",
        parentId: "u1",
        timestamp: "2026-07-22T00:00:01.000Z",
        customType: "pruning",
        display: false,
        content: "internal",
      },
    ];
    const messages = [
      { role: "user", content: "old prompt" },
      { role: "custom", customType: "pruning", display: false, content: "internal" },
      { role: "assistant", content: [{ type: "text", text: "streaming tail" }] },
    ] as SerializableAgentMessage[];
    const rows = buildTranscriptRows(messages, { entries, leafId: "hidden" });
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant"]);
    expect(rows[0]?.sourceId).toBe("u1");
    expect(rows[1]?.copyText).toBe("streaming tail");
  });
});
