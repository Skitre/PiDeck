import { describe, expect, it } from "vitest";
import type { SerializableAgentMessage } from "@pideck/protocol";
import { buildTranscriptRows, messageText, reuseStableRows } from "./transcript-model";

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
});

describe("buildTranscriptRows", () => {
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
    expect(rows[0]?.sections?.intro.map((block) => block.text)).toEqual(["I will check."]);
    expect(rows[0]?.sections?.final.map((block) => block.text)).toEqual(["Done."]);
    expect(rows[0]?.sections?.stepCount).toBe(1);
    const tool = rows[0]?.sections?.activity[0];
    expect(tool?.kind).toBe("tool");
    if (tool?.kind === "tool") {
      expect(tool.tool.result).toBe("file contents");
      expect(tool.tool.details).toEqual({ diff: "-old\n+new" });
      expect(tool.tool.status).toBe("done");
    }
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
    expect(rows[0]?.sections?.intro.map((block) => block.text)).toEqual(["Checking"]);
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
    expect(rows[1]?.sections?.stepCount).toBe(4);
    expect(rows[1]?.sections?.final.map((block) => block.text)).toEqual(["# Final answer"]);
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
