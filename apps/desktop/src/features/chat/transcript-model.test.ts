import { describe, expect, it } from "vitest";
import { buildAttachmentReferenceBlock, type SerializableAgentMessage } from "@pideck/protocol";
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
    expect(parsed).toEqual({ text: "just a message", files: [], documents: [] });
  });

  it("hides managed attachment markers and returns document cards", () => {
    const marker = buildAttachmentReferenceBlock([
      {
        id: "11111111-1111-4111-8111-111111111111",
        name: "manual.pdf",
        mediaType: "application/pdf",
        sizeBytes: 1024,
        status: "ready",
        unit: "page",
        unitCount: 12,
      },
    ]);
    const parsed = parseUserAttachments(`review this\n\n${marker}`);
    expect(parsed.text).toBe("review this");
    expect(parsed.documents).toEqual([
      expect.objectContaining({
        id: "11111111-1111-4111-8111-111111111111",
        name: "manual.pdf",
        unit: "page",
        unitCount: 12,
      }),
    ]);
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

  it("does not reuse an assistant row when its Extension presentation changes", () => {
    const message = {
      role: "custom",
      customType: "worker-progress",
      display: true,
      content: "Working",
      presentation: {
        version: 1,
        extensionId: "worker-extension",
        audience: "user",
        kind: "progress",
        correlationId: "run-1",
        status: "running",
      },
    } as const;
    const first = buildTranscriptRows([message as SerializableAgentMessage]);
    const changed = buildTranscriptRows([
      {
        ...message,
        presentation: { ...message.presentation, status: "resolved" },
      } as SerializableAgentMessage,
    ]);
    const second = reuseStableRows(first, changed);

    expect(second[0]).not.toBe(first[0]);
    const extension = second[0]?.blocks.find((block) => block.kind === "extension");
    expect(extension?.kind === "extension" && extension.row.extensionPresentation?.status).toBe(
      "resolved",
    );
  });

  it("switches to the durable entry key when a live message is persisted", () => {
    const messages: SerializableAgentMessage[] = [
      { role: "assistant", content: [{ type: "text", text: "Done" }] },
    ];
    const live = reuseStableRows(null, buildTranscriptRows(messages, { entries: [] }));
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
    expect(persisted[0]?.key).toBe("assistant:entry-1");
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
    expect(refreshed[0]).toBe(persisted[0]);
  });

  it("keeps row keys unique when compaction reuses a live message index", () => {
    const retainedMessage: SerializableAgentMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Retained answer" }],
    };
    const initialEntries = [
      {
        id: "before-user",
        parentId: null,
        type: "message",
        message: { role: "user", content: "Before" },
      },
      {
        id: "before-assistant",
        parentId: "before-user",
        type: "message",
        message: { role: "assistant", content: "Earlier answer" },
      },
      {
        id: "last-prompt",
        parentId: "before-assistant",
        type: "message",
        message: { role: "user", content: "Keep this" },
      },
    ];
    const initialMessages: SerializableAgentMessage[] = [
      { role: "user", content: "Before" },
      { role: "assistant", content: "Earlier answer" },
      { role: "user", content: "Keep this" },
      retainedMessage,
    ];
    const live = reuseStableRows(
      null,
      buildTranscriptRows(initialMessages, { entries: initialEntries as never }),
    );
    expect(live.at(-1)?.key).toBe("assistant:stream:3");

    const persistedEntries = [
      ...initialEntries,
      {
        id: "retained-answer",
        parentId: "last-prompt",
        type: "message",
        message: retainedMessage,
      },
    ];
    const persisted = reuseStableRows(
      live,
      buildTranscriptRows(initialMessages, { entries: persistedEntries as never }),
    );

    const compactedEntries = [
      {
        id: "compaction-1",
        parentId: null,
        type: "compaction",
        summary: "Earlier context",
        tokensBefore: 12_000,
      },
      {
        id: "retained-answer",
        parentId: "compaction-1",
        type: "message",
        message: retainedMessage,
      },
      {
        id: "next-prompt",
        parentId: "retained-answer",
        type: "message",
        message: { role: "user", content: "Continue" },
      },
    ];
    const compactedMessages: SerializableAgentMessage[] = [
      {
        role: "compactionSummary",
        content: "",
        summary: "Earlier context",
        tokensBefore: 12_000,
      },
      retainedMessage,
      { role: "user", content: "Continue" },
      { role: "assistant", content: "New live answer" },
    ];
    const afterCompaction = reuseStableRows(
      persisted,
      buildTranscriptRows(compactedMessages, { entries: compactedEntries as never }),
    );
    const keys = afterCompaction.map((row) => row.key);

    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("assistant:retained-answer");
    expect(keys).toContain("assistant:stream:3");
  });
});

describe("assistant turn entry ids", () => {
  it("keeps sourceId at the first segment and sourceEndId at the last", () => {
    const rows = buildTranscriptRows([], {
      entries: [
        {
          id: "e-user",
          parentId: null,
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "do it" }] },
        },
        {
          id: "e-a1",
          parentId: "e-user",
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "part one" }] },
        },
        {
          id: "e-a2",
          parentId: "e-a1",
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "part two" }] },
        },
      ] as never,
    });

    const assistant = rows.filter((row) => row.role === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0]?.sourceId).toBe("e-a1");
    expect(assistant[0]?.sourceEndId).toBe("e-a2");
    expect(assistant[0]?.copyText).toContain("part one");
    expect(assistant[0]?.copyText).toContain("part two");
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
        content: [{ type: "toolCall", id: "tool-1", name: "read", status: "running" }],
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
    expect(
      rows[0]?.sections?.intro.filter((block) => block.kind === "text").map((block) => block.text),
    ).toEqual(["I will check."]);
    expect(
      rows[0]?.sections?.final.filter((block) => block.kind === "text").map((block) => block.text),
    ).toEqual(["Done."]);
    expect(rows[0]?.sections?.stepCount).toBe(1);
    const tool = rows[0]?.sections?.activity[0];
    expect(tool?.kind).toBe("tool");
    if (tool?.kind === "tool") {
      expect(tool.tool.result).toBe("file contents");
      expect(tool.tool.details).toEqual({ diff: "-old\n+new" });
      expect(tool.tool.status).toBe("done");
    }
  });

  it("associates reused tool-call ids with their own chronological rounds", () => {
    const rows = buildTranscriptRows([
      { role: "user", content: "Read the first file" },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_0", name: "read", arguments: { path: "a.ts" } }],
      },
      {
        role: "toolResult",
        toolCallId: "call_0",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "first file contents" }],
      },
      { role: "assistant", content: "First done" },
      { role: "user", content: "Read the second file" },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_0", name: "read", arguments: { path: "b.ts" } }],
      },
      {
        role: "toolResult",
        toolCallId: "call_0",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "second file contents" }],
      },
      { role: "assistant", content: "Second done" },
    ]);
    const assistantRows = rows.filter((row) => row.role === "assistant");
    const tools = assistantRows.map((row) => row.blocks.find((block) => block.kind === "tool"));

    expect(assistantRows).toHaveLength(2);
    expect(tools[0]?.kind === "tool" ? tools[0].tool.result : undefined).toBe(
      "first file contents",
    );
    expect(tools[1]?.kind === "tool" ? tools[1].tool.result : undefined).toBe(
      "second file contents",
    );
  });

  it("does not let a future call claim an earlier unmatched result", () => {
    const rows = buildTranscriptRows([
      {
        role: "toolResult",
        toolCallId: "call_0",
        toolName: "read",
        isError: true,
        content: [{ type: "text", text: "orphaned failure" }],
      },
      { role: "user", content: "Start a new turn" },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_0", name: "read", arguments: { path: "later.ts" } },
        ],
      },
    ]);
    const assistantRows = rows.filter((row) => row.role === "assistant");
    const orphan = assistantRows[0]?.blocks.find((block) => block.kind === "tool");
    const later = assistantRows[1]?.blocks.find((block) => block.kind === "tool");

    expect(assistantRows).toHaveLength(2);
    expect(orphan?.kind === "tool" ? orphan.tool : undefined).toMatchObject({
      status: "error",
      result: "orphaned failure",
    });
    expect(later?.kind === "tool" ? later.tool : undefined).toMatchObject({
      status: "waiting",
    });
    expect(later?.kind === "tool" ? later.tool.result : undefined).toBeUndefined();
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
            arguments: '{"command":"pwd"}',
          },
        ],
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(
      rows[0]?.sections?.intro.filter((block) => block.kind === "text").map((block) => block.text),
    ).toEqual(["Checking"]);
    expect(rows[0]?.sections?.activity.map((block) => block.kind)).toEqual(["tool"]);
  });

  it("replaces the persisted tool call with its live execution state", () => {
    const rows = buildTranscriptRows([
      {
        role: "assistant",
        startedAt: 100,
        content: [{ type: "toolCall", id: "live-1", name: "bash", arguments: { command: "pwd" } }],
      },
      {
        role: "tool",
        content: [
          {
            type: "toolCall",
            id: "live-1",
            name: "bash",
            status: "done",
            arguments: '{"command":"pwd"}',
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

  it("merges a terminal live projection with its persisted tool result", () => {
    const rows = buildTranscriptRows([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "live-persisted", name: "read", arguments: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "toolCall",
            id: "live-persisted",
            name: "read",
            status: "done",
            result: "live result",
            details: { source: "live" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "live-persisted",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "persisted result" }],
        details: { source: "persisted" },
      },
    ]);
    const tools = rows[0]?.blocks.filter((block) => block.kind === "tool") ?? [];

    expect(tools).toHaveLength(1);
    expect(tools[0]?.kind === "tool" ? tools[0].tool : undefined).toMatchObject({
      id: "live-persisted",
      status: "done",
      result: "live result",
      details: { source: "live" },
    });
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
    expect(
      rows[1]?.sections?.final.filter((block) => block.kind === "text").map((block) => block.text),
    ).toEqual(["# Final answer"]);
  });

  it("keeps one assistant row when entries and messages stay aligned", () => {
    const user = { role: "user" as const, content: "query" };
    const assistant = {
      role: "assistant" as const,
      content: [
        { type: "text", text: "searching" },
        { type: "toolCall", id: "t1", name: "search", status: "done" },
      ],
    };
    const result = {
      role: "toolResult" as const,
      toolCallId: "t1",
      toolName: "search",
      isError: false,
      content: [{ type: "text", text: "ok" }],
    };
    const followUp = {
      role: "assistant" as const,
      content: [{ type: "text", text: "found it" }],
    };
    const messages = [user, assistant, result, followUp];
    const rows = buildTranscriptRows(messages, {
      entries: [
        { id: "e-user", parentId: null, type: "message", message: user },
        { id: "e-a1", parentId: "e-user", type: "message", message: assistant },
        { id: "e-t1", parentId: "e-a1", type: "message", message: result },
        { id: "e-a2", parentId: "e-t1", type: "message", message: followUp },
      ] as never,
    });

    expect(rows.filter((row) => row.role === "assistant")).toHaveLength(1);
  });

  it("splits a turn when a promote snapshot's entries outrun the event draft", () => {
    const user = { role: "user" as const, content: "query" };
    const assistant = {
      role: "assistant" as const,
      content: [
        { type: "text", text: "searching" },
        { type: "toolCall", id: "t1", name: "search", status: "done" },
      ],
    };
    const result = {
      role: "toolResult" as const,
      toolCallId: "t1",
      toolName: "search",
      isError: false,
      content: [{ type: "text", text: "ok" }],
    };
    const followUp = {
      role: "assistant" as const,
      content: [{ type: "text", text: "found it" }],
    };
    const rows = buildTranscriptRows([user, assistant, result, followUp], {
      entries: [
        { id: "e-user", parentId: null, type: "message", message: user },
        { id: "e-a1", parentId: "e-user", type: "message", message: assistant },
        { id: "e-t1", parentId: "e-a1", type: "message", message: result },
        { id: "e-a2", parentId: "e-t1", type: "message", message: followUp },
        {
          id: "e-t1-again",
          parentId: "e-a2",
          type: "message",
          message: result,
        },
      ] as never,
    });

    expect(rows.filter((row) => row.role === "assistant").length).toBeGreaterThan(1);
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
  it("hides custom state messages and embeds displayable custom messages in an assistant turn", () => {
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
    expect(rows[0]?.role).toBe("assistant");
    const extension = rows[0]?.blocks[0];
    expect(extension?.kind).toBe("extension");
    if (extension?.kind === "extension") {
      expect(extension.row.customType).toBe("plan");
      expect(extension.row.display).toBe(true);
      expect(extension.row.details).toEqual({ status: "active" });
      expect(extension.row.blocks.map((block) => block.kind)).toEqual(["text", "image"]);
    }
  });

  it("parses declarative Extension presentation from top-level and details metadata", () => {
    const basePresentation = {
      version: 1,
      extensionId: "review-extension",
      audience: "user",
      kind: "decision",
      correlationId: "review-1",
      title: "Review requested",
    } as const;
    const rows = buildTranscriptRows([
      {
        role: "custom",
        customType: "review",
        display: true,
        content: "top-level",
        presentation: basePresentation,
      },
      {
        role: "custom",
        customType: "review",
        display: true,
        content: "nested",
        details: {
          presentation: { ...basePresentation, correlationId: "review-2", kind: "activity" },
        },
      },
    ] as SerializableAgentMessage[]);

    expect(rows).toHaveLength(1);
    const extensions = rows[0]?.blocks.filter((block) => block.kind === "extension") ?? [];
    expect(extensions[0]?.kind === "extension" && extensions[0].row.extensionPresentation).toEqual(
      basePresentation,
    );
    expect(
      extensions[1]?.kind === "extension" && extensions[1].row.extensionPresentation,
    ).toMatchObject({
      correlationId: "review-2",
      kind: "activity",
    });
  });

  it("adapts legacy supervisor requests to quiet agent activity without parsing content", () => {
    const content = "Reply with: intercom({ action: 'respond' })";
    const rows = buildTranscriptRows([
      {
        role: "custom",
        customType: "subagent_supervisor_request",
        display: true,
        content,
        details: { id: "request-1", expectsReply: true, agent: "researcher" },
      },
    ] as SerializableAgentMessage[]);

    const extension = rows[0]?.blocks[0];
    expect(extension?.kind).toBe("extension");
    expect(extension?.kind === "extension" && extension.row.copyText).toBe(content);
    expect(extension?.kind === "extension" && extension.row.extensionPresentation).toEqual({
      version: 1,
      extensionId: "pi-subagents",
      sourceLabel: "Subagents",
      audience: "agent",
      kind: "activity",
      correlationId: "request-1",
      severity: "neutral",
    });
  });

  it("keeps malformed presentation metadata in the neutral custom fallback", () => {
    const rows = buildTranscriptRows([
      {
        role: "custom",
        customType: "unsafe-extension",
        display: true,
        content: "Visible diagnostic",
        presentation: {
          version: 1,
          extensionId: "unsafe-extension",
          audience: "user",
          kind: "html",
          correlationId: "unsafe-1",
        },
      },
    ] as SerializableAgentMessage[]);

    const extension = rows[0]?.blocks[0];
    expect(extension?.kind === "extension" && extension.row.extensionPresentation).toBeUndefined();
    expect(extension?.kind === "extension" && extension.row.copyText).toBe("Visible diagnostic");
  });

  it("preserves top-level presentation on persisted custom message entries", () => {
    const presentation = {
      version: 1,
      extensionId: "worker-extension",
      audience: "user",
      kind: "result",
      correlationId: "worker-1",
      status: "resolved",
    } as const;
    const rows = buildTranscriptRows([], {
      entries: [
        {
          id: "custom-1",
          parentId: null,
          type: "custom_message",
          timestamp: "2026-07-22T00:00:00.000Z",
          customType: "worker-result",
          display: true,
          content: "Finished",
          presentation,
        } as never,
      ],
    });

    const extension = rows[0]?.blocks[0];
    expect(extension?.kind === "extension" && extension.row.extensionPresentation).toEqual(
      presentation,
    );
  });

  it("keeps assistant output around Agent coordination in one visual turn", () => {
    const rows = buildTranscriptRows([
      { role: "assistant", content: "First assistant phase" },
      {
        role: "custom",
        customType: "subagent_supervisor_request",
        display: true,
        content: "Reply with the internal result",
        details: { id: "request-between-phases" },
      },
      { role: "assistant", content: "Second assistant phase" },
    ] as SerializableAgentMessage[]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.role).toBe("assistant");
    expect(rows[0]?.blocks.map((block) => block.kind)).toEqual(["text", "extension", "text"]);
    expect(rows[0]?.copyText).toBe("First assistant phase\n\nSecond assistant phase");
    expect(rows[0]?.sections?.stepCount).toBe(1);
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

  it("ignores sparse and malformed runtime content instead of failing the transcript", () => {
    const content = new Array(5) as unknown[];
    content[1] = undefined;
    content[2] = null;
    content[3] = { payload: "missing type" };
    content[4] = { type: "text", text: "Recovered content" };

    const rows = buildTranscriptRows([
      {
        role: "assistant",
        content,
      } as unknown as SerializableAgentMessage,
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.blocks).toEqual([{ kind: "text", text: "Recovered content" }]);
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
    expect(rows[1]?.summary).toMatchObject({
      kind: "compaction",
      text: "Earlier context",
      tokensBefore: 12000,
    });
    expect(rows[2]?.summary).toMatchObject({ kind: "branch", fromId: "old-leaf" });
  });

  it("keeps the live tail visible after an empty branch summary", () => {
    const rows = buildTranscriptRows([{ role: "user", content: "Live prompt after branching" }], {
      entries: [
        {
          id: "empty-branch",
          type: "branch_summary",
          parentId: null,
          fromId: "root",
          summary: "",
        },
      ],
    });

    expect(rows.map((row) => row.role)).toEqual(["summary", "user"]);
    expect(rows[0]?.summary).toMatchObject({ kind: "branch", text: "" });
    expect(rows[1]?.copyText).toBe("Live prompt after branching");
  });

  it("counts a whitespace branch summary like the SDK projection", () => {
    const rows = buildTranscriptRows(
      [
        { role: "branchSummary", content: "", summary: " ", fromId: "root" },
        { role: "user", content: "Live prompt" },
      ],
      {
        entries: [
          {
            id: "whitespace-branch",
            type: "branch_summary",
            parentId: null,
            fromId: "root",
            summary: " ",
          },
        ],
      },
    );

    expect(rows.map((row) => row.role)).toEqual(["summary", "user"]);
    expect(rows[0]?.summary).toMatchObject({ kind: "branch", text: " " });
  });

  it("counts an empty compaction summary like the SDK projection", () => {
    const rows = buildTranscriptRows(
      [
        { role: "compactionSummary", content: "", summary: "", tokensBefore: 0 },
        { role: "user", content: "Live prompt" },
      ],
      {
        entries: [
          {
            id: "empty-compaction",
            type: "compaction",
            parentId: null,
            summary: "",
            tokensBefore: 0,
          },
        ],
      },
    );

    expect(rows.map((row) => row.role)).toEqual(["summary", "user"]);
    expect(rows[0]?.summary).toMatchObject({ kind: "compaction", text: "" });
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
          {
            type: "toolCall",
            id: "cancelled-read",
            name: "read",
            arguments: { path: "large.txt" },
          },
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

  it("attaches Host-rendered Extension output to its persisted custom message", () => {
    const rows = buildTranscriptRows([], {
      entries: [
        {
          id: "custom-rendered",
          type: "custom_message",
          customType: "dynamic-result",
          display: true,
          content: "Running...",
        },
      ],
      extensionMessageRenders: {
        "custom-rendered": {
          version: 1,
          collapsed: ["Doctor complete"],
          expanded: ["Doctor complete", "All checks passed"],
        },
      },
    });

    const block = rows[0]?.blocks[0];
    expect(block?.kind).toBe("extension");
    expect(block?.kind === "extension" && block.row.extensionMessageRender).toEqual({
      version: 1,
      collapsed: ["Doctor complete"],
      expanded: ["Doctor complete", "All checks passed"],
    });
  });

  it("attaches renderer output to a live custom-message tail by message index", () => {
    const messages = [
      { role: "user", content: "Run doctor" },
      {
        role: "custom",
        customType: "subagent-slash-result",
        display: true,
        content: "Running subagent...",
        details: { requestId: "doctor-1" },
      },
      {
        role: "custom",
        customType: "subagent-slash-result",
        display: false,
        content: "final state",
        details: { requestId: "doctor-1" },
      },
    ] as SerializableAgentMessage[];
    const rows = buildTranscriptRows(messages, {
      entries: [
        {
          id: "user-1",
          type: "message",
          parentId: null,
          message: { role: "user", content: "Run doctor" },
        },
      ],
      leafId: "user-1",
      extensionMessageRenders: {
        "custom-live-entry": {
          version: 1,
          collapsed: ["Subagents doctor report"],
          expanded: ["Subagents doctor report", "Runtime: ok"],
          messageIndex: 1,
        },
      },
    });

    expect(rows).toHaveLength(2);
    const extension = rows[1]?.blocks.find((block) => block.kind === "extension");
    expect(extension?.kind === "extension" && extension.row).toMatchObject({
      role: "custom",
      customType: "subagent-slash-result",
      extensionMessageRender: {
        collapsed: ["Subagents doctor report"],
        expanded: ["Subagents doctor report", "Runtime: ok"],
        messageIndex: 1,
      },
    });
  });
});
