import { describe, expect, it, vi } from "vitest";
import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { buildSessionSnapshot } from "./session-snapshot.js";

const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

function sessionFixture(): AgentSession {
  return {
    sessionId: SESSION_ID,
    sessionFile: undefined,
    sessionName: undefined,
    cwd: "C:/workspace",
    isIdle: true,
    isCompacting: false,
    isRetrying: false,
    model: undefined,
    messages: [],
    thinkingLevel: "off",
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    steeringMode: "all",
    followUpMode: "all",
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    getAllTools: () => [],
    getActiveToolNames: () => [],
  } as unknown as AgentSession;
}

describe("buildSessionSnapshot entry projection", () => {
  it("uses the SDK's active compaction-aware path and serializes its leaf", () => {
    const entries = [
      {
        id: "compaction-1",
        type: "compaction",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        summary: "Earlier context",
        firstKeptEntryId: "message-1",
        tokensBefore: 123,
        details: { extensionState: 1n },
      },
      {
        id: "message-1",
        type: "message",
        parentId: "compaction-1",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "user", content: "Continue" },
      },
    ];
    const sessionManager = {
      buildContextEntries: vi.fn(() => entries),
      getLeafId: vi.fn(() => "message-1"),
      getEntries: vi.fn(() => [{ id: "not-on-active-path", type: "message" }]),
    } as unknown as SessionManager;

    const snapshot = buildSessionSnapshot({
      session: sessionFixture(),
      sessionManager,
      cwd: "C:/workspace",
      sessionId: SESSION_ID,
      revision: 4,
      workspaceId: WORKSPACE_ID,
      toolRevision: 2,
    });

    expect(sessionManager.buildContextEntries).toHaveBeenCalledOnce();
    expect(sessionManager.getLeafId).toHaveBeenCalledOnce();
    expect(sessionManager.getEntries).not.toHaveBeenCalled();
    expect(snapshot.leafId).toBe("message-1");
    expect(snapshot.entries).toEqual([
      expect.objectContaining({
        id: "compaction-1",
        type: "compaction",
        details: { extensionState: "1" },
      }),
      expect.objectContaining({ id: "message-1", type: "message" }),
    ]);
  });

  it("omits the optional path for an older session-manager-shaped test double", () => {
    const snapshot = buildSessionSnapshot({
      session: sessionFixture(),
      sessionManager: {} as SessionManager,
      cwd: "C:/workspace",
      sessionId: SESSION_ID,
      revision: 1,
      workspaceId: WORKSPACE_ID,
      toolRevision: 1,
    });

    expect(snapshot).not.toHaveProperty("entries");
    expect(snapshot).not.toHaveProperty("leafId");
  });
});
