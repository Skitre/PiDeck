import { describe, expect, it } from "vitest";
import type { SessionSnapshot } from "@pideck/protocol";
import {
  adoptLiveTranscriptDraft,
  applyAgentEventToTranscript,
  groupTimedAgentEventsBySession,
  isLiveTranscriptSession,
  overlayLiveTranscriptMessages,
  parkTranscriptDraft,
  pruneTranscriptDrafts,
  MAX_TRANSCRIPT_DRAFTS,
} from "./transcript-drafts";
import type { TimedAgentEventEnvelope } from "./transcript-reducer";

function session(id: string, overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: id,
    cwd: "/tmp",
    revision: 1,
    isStreaming: false,
    isIdle: true,
    isCompacting: false,
    isRetrying: false,
    thinkingLevel: "off",
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    steeringMode: "all",
    followUpMode: "all",
    pending: { revision: 0, steering: [], followUp: [] },
    messages: [],
    tools: {
      revision: 1,
      workspaceId: "w1",
      sessionId: id,
      sessionRevision: 1,
      tools: [],
      active: [],
    },
    ...overrides,
  };
}

describe("transcript drafts", () => {
  it("parks only a live Session", () => {
    expect(parkTranscriptDraft({}, session("s1"))).toEqual({});
    const live = session("s1", {
      isIdle: false,
      isStreaming: true,
      messages: [{ role: "assistant", content: "hi", startedAt: 100 }],
    });
    expect(parkTranscriptDraft({}, live).s1?.messages).toEqual(live.messages);
  });

  it("keeps draft messages and startedAt when adopting a promote snapshot", () => {
    const draft = session("s1", {
      revision: 3,
      isIdle: false,
      isStreaming: true,
      messages: [{ role: "assistant", content: "streaming", startedAt: 100 }],
      entries: [
        {
          id: "e-live",
          parentId: null,
          type: "message",
          message: { role: "assistant", content: "streaming", startedAt: 100 },
        },
      ],
      leafId: "e-live",
    });
    const snapshot = session("s1", {
      revision: 4,
      isIdle: false,
      isStreaming: true,
      messages: [{ role: "assistant", content: "streaming" }],
      entries: [
        {
          id: "e-file",
          parentId: null,
          type: "message",
          message: { role: "assistant", content: "streaming" },
        },
        {
          id: "e-tool",
          parentId: "e-file",
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "t1",
            toolName: "search",
            content: [{ type: "text", text: "ok" }],
          },
        },
      ],
      leafId: "e-tool",
      tools: { ...draft.tools, sessionRevision: 4, revision: 2 },
    });
    const adopted = adoptLiveTranscriptDraft({ s1: draft }, snapshot);
    expect(adopted.session.revision).toBe(4);
    expect(adopted.session.tools.revision).toBe(2);
    expect(adopted.session.messages).toEqual(draft.messages);
    expect(adopted.session.messages[0]).toMatchObject({ startedAt: 100 });
    expect(adopted.session.entries).toEqual(draft.entries);
    expect(adopted.session.leafId).toBe("e-live");
    expect(adopted.drafts.s1).toBeUndefined();
  });

  it("does not let a live partial transcript replace a richer Host snapshot", () => {
    const live = session("s1", {
      revision: 6,
      isIdle: false,
      isStreaming: true,
      messages: [{ role: "assistant", content: "partial transcript" }],
    });
    const snapshot = session("s1", {
      revision: 6,
      isIdle: false,
      isStreaming: true,
      messages: [{ role: "assistant", content: "complete transcript" }],
    });
    expect(overlayLiveTranscriptMessages(snapshot, live).messages).toEqual(snapshot.messages);
  });

  it("does not let equal messages hide a richer Host entry tree", () => {
    const live = session("s1", {
      revision: 6,
      isIdle: false,
      isStreaming: true,
      messages: [{ role: "assistant", content: "streaming", startedAt: 100 }],
      entries: [
        {
          id: "e-live",
          parentId: null,
          type: "message",
          message: { role: "assistant", content: "streaming", startedAt: 100 },
        },
      ],
      leafId: "e-live",
    });
    const snapshot = session("s1", {
      revision: 6,
      isIdle: false,
      isStreaming: true,
      messages: [{ role: "assistant", content: "streaming" }],
      entries: [
        {
          id: "e-live",
          parentId: null,
          type: "message",
          message: { role: "assistant", content: "streaming" },
        },
        {
          id: "e-tool",
          parentId: "e-live",
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "t1",
            toolName: "search",
            content: [{ type: "text", text: "ok" }],
          },
        },
      ],
      leafId: "e-tool",
    });
    const overlaid = overlayLiveTranscriptMessages(snapshot, live);
    expect(overlaid.messages).toEqual(live.messages);
    expect(overlaid.entries).toEqual(snapshot.entries);
    expect(overlaid.leafId).toBe("e-tool");
  });

  it("does not let equal messages hide a newer Host leaf", () => {
    const live = session("s1", {
      revision: 6,
      isIdle: false,
      isStreaming: true,
      messages: [{ role: "assistant", content: "streaming" }],
      entries: [
        {
          id: "e1",
          parentId: null,
          type: "message",
          message: { role: "assistant", content: "streaming" },
        },
        {
          id: "e2",
          parentId: "e1",
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "t1",
            toolName: "search",
            content: [{ type: "text", text: "ok" }],
          },
        },
      ],
      leafId: "e1",
    });
    const snapshot = session("s1", {
      revision: 6,
      isIdle: false,
      isStreaming: true,
      messages: [{ role: "assistant", content: "streaming" }],
      entries: live.entries,
      leafId: "e2",
    });
    const overlaid = overlayLiveTranscriptMessages(snapshot, live);
    expect(overlaid.messages).toEqual(live.messages);
    expect(overlaid.entries).toEqual(snapshot.entries);
    expect(overlaid.leafId).toBe("e2");
  });

  it("keeps the live entry tree when a promote snapshot rematerializes different IDs", () => {
    const live = session("s1", {
      revision: 3,
      isIdle: false,
      isStreaming: true,
      messages: [{ role: "assistant", content: "Hello world", startedAt: 100 }],
      entries: [
        {
          id: "e-live",
          parentId: null,
          type: "message",
          message: { role: "assistant", content: "Hello world", startedAt: 100 },
        },
      ],
      leafId: "e-live",
    });
    const snapshot = session("s1", {
      revision: 4,
      isIdle: false,
      isStreaming: true,
      messages: [{ role: "assistant", content: "Hello world" }],
      entries: [
        {
          id: "e-file",
          parentId: null,
          type: "message",
          message: { role: "assistant", content: "Hello world" },
        },
      ],
      leafId: "e-file",
    });
    const adopted = adoptLiveTranscriptDraft({ s1: live }, snapshot);
    expect(adopted.session.entries?.[0]).toMatchObject({ id: "e-live" });
    expect(adopted.session.leafId).toBe("e-live");
    expect(overlayLiveTranscriptMessages(snapshot, live).entries?.[0]).toMatchObject({
      id: "e-live",
    });
  });

  it("keeps Host Extension renders that the live draft does not have yet", () => {
    const live = session("s1", {
      revision: 6,
      isIdle: false,
      isStreaming: true,
      messages: [{ role: "assistant", content: "streaming" }],
      extensionMessageRenders: {
        "e-live": { version: 1, collapsed: ["old"], expanded: ["old"] },
      },
    });
    const snapshot = session("s1", {
      revision: 6,
      isIdle: false,
      isStreaming: true,
      messages: [{ role: "assistant", content: "streaming" }],
      extensionMessageRenders: {
        "e-host": { version: 1, collapsed: ["new"], expanded: ["new"] },
      },
    });
    const overlaid = overlayLiveTranscriptMessages(snapshot, live);
    expect(overlaid.extensionMessageRenders).toEqual({
      "e-live": { version: 1, collapsed: ["old"], expanded: ["old"] },
      "e-host": { version: 1, collapsed: ["new"], expanded: ["new"] },
    });
  });

  it("keeps live drafts from two Workspaces under the per-workspace cap", () => {
    let drafts: Record<string, SessionSnapshot> = {};
    for (let index = 0; index < MAX_TRANSCRIPT_DRAFTS; index += 1) {
      drafts = parkTranscriptDraft(
        drafts,
        session(`a${index}`, {
          isIdle: false,
          isStreaming: true,
          tools: {
            revision: 1,
            workspaceId: "workspace-a",
            sessionId: `a${index}`,
            sessionRevision: 1,
            tools: [],
            active: [],
          },
        }),
      );
      drafts = parkTranscriptDraft(
        drafts,
        session(`b${index}`, {
          isIdle: false,
          isStreaming: true,
          tools: {
            revision: 1,
            workspaceId: "workspace-b",
            sessionId: `b${index}`,
            sessionRevision: 1,
            tools: [],
            active: [],
          },
        }),
      );
    }
    expect(Object.keys(drafts)).toHaveLength(MAX_TRANSCRIPT_DRAFTS * 2);
  });

  it("drops a settled draft when opening from a file snapshot", () => {
    const draft = session("s1", {
      isIdle: false,
      isStreaming: true,
      messages: [{ role: "assistant", content: "old", startedAt: 100 }],
    });
    const snapshot = session("s1", {
      revision: 8,
      messages: [{ role: "assistant", content: "from file" }],
    });
    const adopted = adoptLiveTranscriptDraft({ s1: draft }, snapshot);
    expect(adopted.session.messages).toEqual(snapshot.messages);
    expect(adopted.drafts.s1).toBeUndefined();
  });

  it("keeps startedAt when a later event lands on a parked draft", () => {
    const parked = session("s1", {
      isIdle: false,
      isStreaming: true,
      messages: [{ role: "assistant", content: "Hello", startedAt: 100 }],
    });
    const next = applyAgentEventToTranscript(
      parked,
      {
        runId: "r1",
        event: {
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " world" },
        },
      },
      5_000,
    );
    expect(next?.messages[0]).toMatchObject({
      content: expect.anything(),
      startedAt: 100,
    });
    expect(isLiveTranscriptSession(next!)).toBe(true);
  });

  it("raises the draft revision when a promoted event arrives", () => {
    const parked = session("s1", { revision: 3, isIdle: false, isStreaming: true });
    const next = applyAgentEventToTranscript(
      parked,
      { runId: "r1", event: { type: "turn_start" } },
      200,
      4,
    );
    expect(next?.revision).toBe(4);
  });

  it("groups buffered events by Session id", () => {
    const events = [
      { sessionId: "a", sequence: 1 },
      { sessionId: "b", sequence: 2 },
      { sessionId: "a", sequence: 3 },
    ] as TimedAgentEventEnvelope[];
    const groups = groupTimedAgentEventsBySession(events);
    expect([...groups.keys()]).toEqual(["a", "b"]);
    expect(groups.get("a")?.map((event) => event.sequence)).toEqual([1, 3]);
  });

  it("caps parked drafts at the live runtime limit", () => {
    let drafts: Record<string, SessionSnapshot> = {};
    for (let index = 0; index < MAX_TRANSCRIPT_DRAFTS + 2; index += 1) {
      drafts = parkTranscriptDraft(
        drafts,
        session(`s${index}`, { isIdle: false, isStreaming: true }),
      );
    }
    expect(Object.keys(drafts)).toHaveLength(MAX_TRANSCRIPT_DRAFTS);
  });

  it("prune drops idle extras first", () => {
    const drafts: Record<string, SessionSnapshot> = {
      idle: session("idle"),
    };
    for (let index = 0; index < MAX_TRANSCRIPT_DRAFTS; index += 1) {
      drafts[`live${index}`] = session(`live${index}`, { isIdle: false, isStreaming: true });
    }
    const pruned = pruneTranscriptDrafts(drafts);
    expect(pruned.idle).toBeUndefined();
    expect(Object.keys(pruned)).toHaveLength(MAX_TRANSCRIPT_DRAFTS);
  });
});
