import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureActiveSessionState,
  commitActiveSessionState,
  SESSION_DISPOSAL_STEP_TIMEOUT_MS,
  SessionRuntimeCache,
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
    extensionUiReplayState: vi.fn(),
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
    extensionUiReplayState: state.extensionUiReplayState,
    unsubscribeAgent: state.unsubscribeAgent,
  } as WorkspaceGraph;
}

function disposalCache(): SessionRuntimeCache {
  return new SessionRuntimeCache({
    getGraph: () => null,
    getServer: () => null,
    sessionPathsEqual: () => false,
  });
}

function disposalSession(
  options: {
    emit?: () => Promise<void>;
    abort?: () => Promise<void>;
  } = {},
) {
  const emit = vi.fn(options.emit ?? (async () => undefined));
  const abort = vi.fn(options.abort ?? (async () => undefined));
  const dispose = vi.fn();
  const session = {
    isIdle: false,
    extensionRunner: {
      hasHandlers: vi.fn(() => true),
      emit,
    },
    abort,
    dispose,
  } as unknown as AgentSession;
  return { session, emit, abort, dispose };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("session disposal bounds", () => {
  it("continues through abort and dispose when session_shutdown never settles", async () => {
    vi.useFakeTimers();
    const cache = disposalCache();
    const { session, emit, abort, dispose } = disposalSession({
      emit: () => new Promise<void>(() => undefined),
    });
    let settled = false;

    void cache.disposeAgentSessionOnly(session).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(emit).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(SESSION_DISPOSAL_STEP_TIMEOUT_MS);

    expect(settled).toBe(true);
    expect(abort).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("continues through dispose and handles a late abort rejection", async () => {
    vi.useFakeTimers();
    let rejectAbort: ((reason?: unknown) => void) | undefined;
    const abortPromise = new Promise<void>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const cache = disposalCache();
    const { session, abort, dispose } = disposalSession({
      abort: () => abortPromise,
    });
    let settled = false;

    void cache.disposeAgentSessionOnly(session).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(SESSION_DISPOSAL_STEP_TIMEOUT_MS);

    expect(settled).toBe(true);
    expect(abort).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();

    rejectAbort?.(new Error("late abort failure"));
    await Promise.resolve();
  });
});

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
