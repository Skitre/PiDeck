import { describe, expect, it } from "vitest";
import type { SerializableAgentMessage } from "@pideck/protocol";
import { buildTranscriptRows, messageText } from "./transcript-model";

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
