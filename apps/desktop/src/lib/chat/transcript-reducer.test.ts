import { describe, expect, it } from "vitest";
import {
  applyAgentEvent,
  applyAgentEventBatch,
  type AgentEventEnvelope,
} from "./transcript-reducer.js";
import type { SessionSnapshot } from "@pideck/protocol";

function baseSession(): SessionSnapshot {
  return {
    sessionId: "s1",
    cwd: "/tmp",
    revision: 1,
    isStreaming: false,
    isIdle: true,
    isCompacting: false,
    isRetrying: false,
    thinkingLevel: "medium",
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    steeringMode: "all",
    followUpMode: "all",
    pending: { steering: [], followUp: [] },
    messages: [],
    tools: {
      revision: 1,
      workspaceId: "w1",
      sessionId: "s1",
      sessionRevision: 1,
      tools: [],
      active: [],
    },
  };
}

describe("applyAgentEvent", () => {
  it("settles the previous assistant before a new run starts", () => {
    const session = baseSession();
    session.messages = [
      { role: "assistant", content: [{ type: "text", text: "Previous answer" }] },
    ];

    const next = applyAgentEvent(
      session,
      { runId: "next-run", event: { type: "agent_start" } },
      250,
    )!;

    expect(next.messages[0]).toMatchObject({ endedAt: 250 });
    expect(next.isStreaming).toBe(true);
  });

  it("streams assistant text deltas onto the last assistant message", () => {
    let s = baseSession();
    s = applyAgentEvent(s, {
      runId: "r1",
      event: { type: "agent_start" },
    })!;
    expect(s.isStreaming).toBe(true);
    expect(s.isIdle).toBe(false);

    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "message_start",
        message: { role: "assistant", content: "" },
      },
    })!;
    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Hello" },
      },
    })!;
    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: " world" },
      },
    })!;
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]?.content).toBe("Hello world");

    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "message_end",
        message: { role: "assistant", content: "Hello world!" },
      },
    })!;
    expect(s.messages[0]?.content).toBe("Hello world!");

    s = applyAgentEvent(s, {
      runId: "r1",
      event: { type: "agent_end" },
    })!;
    expect(s.isIdle).toBe(false);
    expect(s.isStreaming).toBe(true);

    s = applyAgentEvent(s, {
      runId: "r1",
      event: { type: "agent_settled" },
    })!;
    expect(s.isIdle).toBe(true);
    expect(s.isStreaming).toBe(false);
  });

  it("applies a frame of deltas in order with their original receive times", () => {
    let s = applyAgentEvent(
      baseSession(),
      {
        runId: "r1",
        event: {
          type: "message_start",
          message: { role: "assistant", content: [] },
        },
      },
      90,
    )!;

    s = applyAgentEventBatch(s, [
      {
        receivedAt: 100,
        payload: {
          runId: "r1",
          event: {
            type: "message_update",
            assistantMessageEvent: {
              type: "thinking_delta",
              contentIndex: 0,
              delta: "Plan",
            },
          },
        },
      },
      {
        receivedAt: 140,
        payload: {
          runId: "r1",
          event: {
            type: "message_update",
            assistantMessageEvent: {
              type: "thinking_end",
              contentIndex: 0,
              content: "Plan",
            },
          },
        },
      },
      {
        receivedAt: 150,
        payload: {
          runId: "r1",
          event: {
            type: "message_update",
            assistantMessageEvent: {
              type: "text_delta",
              contentIndex: 1,
              delta: "Hello",
            },
          },
        },
      },
      {
        receivedAt: 160,
        payload: {
          runId: "r1",
          event: {
            type: "message_update",
            assistantMessageEvent: {
              type: "text_delta",
              contentIndex: 1,
              delta: " world",
            },
          },
        },
      },
    ])!;

    expect(s.messages[0]?.content).toMatchObject([
      { type: "thinking", thinking: "Plan", startedAt: 100, endedAt: 140 },
      { type: "text", text: "Hello world" },
    ]);
  });

  it("keeps thinking and text deltas in separate content blocks", () => {
    let s = baseSession();
    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "message_start",
        message: { role: "assistant", content: [] },
      },
    })!;
    for (const event of [
      { type: "thinking_delta", contentIndex: 0, delta: "Inspect " },
      { type: "thinking_delta", contentIndex: 0, delta: "files" },
      { type: "thinking_end", contentIndex: 0, content: "Inspect files" },
      { type: "text_delta", contentIndex: 1, delta: "Done." },
    ]) {
      s = applyAgentEvent(s, {
        runId: "r1",
        event: { type: "message_update", assistantMessageEvent: event },
      })!;
    }

    expect(s.messages[0]?.content).toMatchObject([
      { type: "thinking", thinking: "Inspect files" },
      { type: "text", text: "Done." },
    ]);
    const thinking = Array.isArray(s.messages[0]?.content)
      ? s.messages[0].content[0]
      : undefined;
    expect(typeof thinking?.startedAt).toBe("number");
    expect(typeof thinking?.endedAt).toBe("number");
  });

  it("uses Pi's structured partial message during streaming", () => {
    let s = baseSession();
    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "message_start",
        message: { role: "assistant", content: [] },
      },
    })!;
    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "message_update",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Plan" },
            { type: "text", text: "Working" },
          ],
        },
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 1,
          delta: " ignored because partial is authoritative",
        },
      },
    })!;

    expect(s.messages[0]?.content).toEqual([
      { type: "thinking", thinking: "Plan" },
      { type: "text", text: "Working" },
    ]);
  });

  it("tracks concurrent tool executions by toolCallId", () => {
    let s = baseSession();
    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "tool_execution_start",
        toolCallId: "call-read",
        toolName: "read",
        args: { path: "a.ts" },
      },
    })!;
    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "tool_execution_start",
        toolCallId: "call-write",
        toolName: "write",
        args: { path: "b.ts" },
      },
    })!;
    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "tool_execution_update",
        toolCallId: "call-read",
        toolName: "read",
        args: { path: "a.ts" },
        partialResult: { lines: 10 },
      },
    })!;
    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "tool_execution_end",
        toolCallId: "call-write",
        toolName: "write",
        result: { written: true },
        isError: false,
      },
    })!;

    const parts = s.messages
      .filter((message) => message.role === "tool" && Array.isArray(message.content))
      .map((message) => (message.content as Array<Record<string, unknown>>)[0]);
    expect(parts).toHaveLength(2);
    expect(parts.find((part) => part.id === "call-read")?.status).toBe("running");
    expect(parts.find((part) => part.id === "call-read")?.result).toContain("lines");
    expect(parts.find((part) => part.id === "call-write")?.status).toBe("done");
    expect(parts.find((part) => part.id === "call-write")?.result).toContain("written");
  });

  it("preserves sibling tool parts when one execution is updated", () => {
    const session = baseSession();
    session.messages = [
      {
        role: "tool",
        content: [
          {
            type: "toolCall",
            id: "call-read",
            name: "read",
            text: "running",
            status: "running",
            startedAt: 10,
          },
          {
            type: "toolCall",
            id: "call-write",
            name: "write",
            text: "running",
            status: "running",
            startedAt: 20,
          },
        ],
      },
    ];

    const next = applyAgentEvent(session, {
      runId: "r1",
      event: {
        type: "tool_execution_update",
        toolCallId: "call-read",
        toolName: "read",
        partialResult: { lines: 10 },
      },
    }, 30)!;

    const content = next.messages[0]?.content;
    expect(Array.isArray(content)).toBe(true);
    if (!Array.isArray(content)) return;
    expect(content).toHaveLength(2);
    expect(content.find((part) => part.id === "call-read")?.result).toContain("lines");
    expect(content.find((part) => part.id === "call-write")).toMatchObject({
      name: "write",
      status: "running",
      startedAt: 20,
    });
  });

  it("preserves tool error and aborted states", () => {
    let s = baseSession();
    for (const [id, result, isError] of [
      ["call-error", { message: "boom" }, true],
      ["call-abort", { aborted: true }, false],
    ] as const) {
      s = applyAgentEvent(s, {
        runId: "r1",
        event: {
          type: "tool_execution_start",
          toolCallId: id,
          toolName: "tool",
          args: {},
        },
      })!;
      s = applyAgentEvent(s, {
        runId: "r1",
        event: {
          type: "tool_execution_end",
          toolCallId: id,
          toolName: "tool",
          result,
          isError,
        },
      })!;
    }
    const parts = s.messages
      .filter((message) => message.role === "tool" && Array.isArray(message.content))
      .map((message) => (message.content as Array<Record<string, unknown>>)[0]);
    expect(parts.find((part) => part.id === "call-error")?.status).toBe("error");
    expect(parts.find((part) => part.id === "call-abort")?.status).toBe("aborted");
  });

  it("maps Pi's standard error-shaped tool cancellation to aborted", () => {
    let s = applyAgentEvent(baseSession(), {
      runId: "r1",
      event: {
        type: "tool_execution_start",
        toolCallId: "call-sdk-abort",
        toolName: "read",
        args: { path: "large.txt" },
      },
    })!;
    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "tool_execution_end",
        toolCallId: "call-sdk-abort",
        toolName: "read",
        result: {
          content: [{ type: "text", text: "Operation aborted" }],
          details: {},
        },
        isError: true,
      },
    })!;

    const toolMessage = s.messages.find((message) => message.role === "tool");
    const part = Array.isArray(toolMessage?.content) ? toolMessage.content[0] : undefined;
    expect(part).toMatchObject({
      id: "call-sdk-abort",
      status: "aborted",
      result: "Operation aborted",
      resultBlocks: [{ type: "text", text: "Operation aborted" }],
      details: {},
    });
  });

  it("keeps structured tool result content and details during realtime updates", () => {
    let s = applyAgentEvent(baseSession(), {
      runId: "r1",
      event: {
        type: "tool_execution_start",
        toolCallId: "call-image",
        toolName: "capture",
        args: { path: "screen.png" },
      },
    })!;
    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "tool_execution_end",
        toolCallId: "call-image",
        toolName: "capture",
        result: {
          content: [
            { type: "text", text: "captured" },
            { type: "image", data: "aW1n", mimeType: "image/png" },
          ],
          details: { width: 10 },
        },
      },
    })!;

    const toolMessage = s.messages.find((message) => message.role === "tool");
    const part = Array.isArray(toolMessage?.content) ? toolMessage.content[0] : undefined;
    expect(part).toMatchObject({
      id: "call-image",
      status: "done",
      result: "captured",
      resultBlocks: [
        { type: "text", text: "captured" },
        { type: "image", data: "aW1n", mimeType: "image/png" },
      ],
      details: { width: 10 },
    });
  });

  it("aborts unfinished tools when the agent settles", () => {
    let s = baseSession();
    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "tool_execution_start",
        toolCallId: "call-running",
        toolName: "bash",
        args: { command: "sleep 10" },
      },
    })!;
    s = applyAgentEvent(s, {
      runId: "r1",
      event: { type: "agent_settled" },
    })!;

    const toolMessage = s.messages.find((message) => message.role === "tool");
    const part = Array.isArray(toolMessage?.content) ? toolMessage.content[0] : undefined;
    expect(part?.status).toBe("aborted");
    expect(typeof part?.endedAt).toBe("number");
    expect(s.isIdle).toBe(true);
  });

  it("keeps tools active across agent runs until the whole turn settles", () => {
    let s = baseSession();
    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "tool_execution_start",
        toolCallId: "call-before-continuation",
        toolName: "read",
        args: { path: "first.ts" },
      },
    })!;
    s = applyAgentEvent(
      s,
      {
        runId: "r1",
        event: { type: "agent_end" },
      },
      200,
    )!;

    const afterAgentEnd = s.messages.find((message) => message.role === "tool");
    const firstPart = Array.isArray(afterAgentEnd?.content)
      ? afterAgentEnd.content[0]
      : undefined;
    expect(firstPart).toMatchObject({
      id: "call-before-continuation",
      status: "running",
    });
    expect(firstPart?.endedAt).toBeUndefined();
    expect(s.isIdle).toBe(false);
    expect(s.isStreaming).toBe(true);

    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "tool_execution_start",
        toolCallId: "call-in-continuation",
        toolName: "read",
        args: { path: "second.ts" },
      },
    })!;
    const continuationTools = s.messages.flatMap((message) =>
      message.role === "tool" && Array.isArray(message.content) ? message.content : [],
    );
    expect(continuationTools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "call-before-continuation", status: "running" }),
        expect.objectContaining({ id: "call-in-continuation", status: "running" }),
      ]),
    );

    s = applyAgentEvent(
      s,
      {
        runId: "r1",
        event: { type: "agent_settled" },
      },
      300,
    )!;
    const settledTools = s.messages.flatMap((message) =>
      message.role === "tool" && Array.isArray(message.content) ? message.content : [],
    );
    expect(settledTools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "call-before-continuation", status: "aborted", endedAt: 300 }),
        expect.objectContaining({ id: "call-in-continuation", status: "aborted", endedAt: 300 }),
      ]),
    );
    expect(s.isIdle).toBe(true);
    expect(s.isStreaming).toBe(false);
  });

  it("aborts a tool call that never reached execution start", () => {
    let s = baseSession();
    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "message_start",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "not-started", name: "read" }],
        },
      },
    })!;
    s = applyAgentEvent(s, {
      runId: "r1",
      event: { type: "agent_settled" },
    })!;

    const content = s.messages[0]?.content;
    const part = Array.isArray(content) ? content[0] : undefined;
    expect(part?.status).toBe("aborted");
    expect(typeof part?.endedAt).toBe("number");
  });

  it("updates queue from queue_update", () => {
    let s = baseSession();
    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "queue_update",
        steering: ["steer-1"],
        followUp: ["fu-1"],
      },
    } as AgentEventEnvelope)!;
    expect(s.pending.steering).toEqual(["steer-1"]);
    expect(s.pending.followUp).toEqual(["fu-1"]);
  });

  it("appends live extension entries only when they extend the active branch", () => {
    const session = baseSession();
    session.entries = [
      { id: "entry-1", type: "message", parentId: null, message: { role: "user", content: "hi" } },
    ];
    session.leafId = "entry-1";

    const next = applyAgentEvent(session, {
      runId: "r1",
      event: {
        type: "entry_appended",
        entry: {
          id: "entry-2",
          type: "custom",
          parentId: "entry-1",
          customType: "plan",
          data: { status: "active" },
        },
      },
    })!;

    expect(next.entries).toHaveLength(2);
    expect(next.leafId).toBe("entry-2");
  });

  it("waits for a full snapshot when an entry does not extend the active branch", () => {
    const session = baseSession();
    session.entries = [{ id: "entry-1", type: "custom", parentId: null }];
    session.leafId = "entry-1";

    const next = applyAgentEvent(session, {
      runId: "r1",
      event: {
        type: "entry_appended",
        entry: { id: "branch-entry", type: "custom", parentId: "other" },
      },
    })!;

    expect(next.entries).toEqual(session.entries);
    expect(next.leafId).toBe("entry-1");
  });
});
