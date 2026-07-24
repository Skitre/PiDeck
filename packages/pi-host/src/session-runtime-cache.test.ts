import { describe, expect, it, vi } from "vitest";
import {
  captureActiveSessionState,
  commitActiveSessionState,
  type ActiveSessionState,
} from "./session-runtime-cache.js";
import type { WorkspaceGraph } from "./workspace-graph-types.js";

function activeSlots(seed: string): ActiveSessionState {
  return {
    sessionManager: { seed } as unknown as ActiveSessionState["sessionManager"],
    agentSession: { seed } as unknown as ActiveSessionState["agentSession"],
    extensionsResult: { seed },
    resourceLoader: { seed } as unknown as ActiveSessionState["resourceLoader"],
    toolRevision: seed === "next" ? 9 : 3,
    sessionSnapshot: { sessionId: seed } as ActiveSessionState["sessionSnapshot"],
    extensionUiActivate: vi.fn(),
    extensionUiCleanup: vi.fn(),
    extensionUiUpdateIdentity: vi.fn(),
    unsubscribeAgent: vi.fn(),
    sessionId: seed,
    sessionRevision: seed === "next" ? 7 : 2,
  };
}

function graphFrom(state: ActiveSessionState): WorkspaceGraph {
  return {
    sessionManager: state.sessionManager,
    agentSession: state.agentSession,
    extensionsResult: state.extensionsResult,
    resourceLoader: state.resourceLoader,
    toolRevision: state.toolRevision,
    sessionSnapshot: state.sessionSnapshot,
    extensionUiActivate: state.extensionUiActivate,
    extensionUiCleanup: state.extensionUiCleanup,
    extensionUiUpdateIdentity: state.extensionUiUpdateIdentity,
    unsubscribeAgent: state.unsubscribeAgent,
  } as WorkspaceGraph;
}

describe("active Session state", () => {
  it("captures all Session graph slots and both identity fields", () => {
    const state = activeSlots("current");
    const captured = captureActiveSessionState(graphFrom(state), {
      sessionId: state.sessionId,
      sessionRevision: state.sessionRevision,
    });

    expect(captured).toEqual(state);
  });

  it("commits only Session graph slots and identity", () => {
    const current = activeSlots("current");
    const next = activeSlots("next");
    const graph = {
      ...graphFrom(current),
      workspaceId: "workspace-stable",
      revision: 11,
      packageSnapshot: { revision: 13 },
      backgroundSessions: new Map([["background", {}]]),
    } as unknown as WorkspaceGraph;
    const identity = {
      sessionId: current.sessionId,
      sessionRevision: current.sessionRevision,
      workspaceRevision: 11,
      packageRevision: 13,
    };

    commitActiveSessionState(graph, identity, next);

    expect(captureActiveSessionState(graph, identity)).toEqual(next);
    expect(graph).toMatchObject({
      workspaceId: "workspace-stable",
      revision: 11,
      packageSnapshot: { revision: 13 },
    });
    expect(graph.backgroundSessions.has("background")).toBe(true);
    expect(identity).toMatchObject({ workspaceRevision: 11, packageRevision: 13 });
  });
});
