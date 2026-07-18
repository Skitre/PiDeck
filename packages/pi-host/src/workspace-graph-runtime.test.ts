import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { HostEventName, HostIdentity } from "@pideck/protocol";
import type { PiHostServer } from "./server.js";
import { TryMutex } from "./locks.js";
import {
  WorkspaceGraphFactory,
  type BackgroundSessionRuntime,
  type GraphFactoryDeps,
  type WorkspaceGraph,
} from "./workspace-graph-factory.js";

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const ACTIVE_SESSION_ID = "33333333-3333-4333-8333-333333333333";
const BACKGROUND_SESSION_ID = "44444444-4444-4444-8444-444444444444";

function fakeSession(isIdle: boolean, sessionId = "session"): AgentSession {
  return {
    isIdle,
    isCompacting: false,
    isRetrying: false,
    sessionId,
    sessionFile: `C:/sessions/${sessionId}.jsonl`,
    sessionName: sessionId,
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
    getAvailableThinkingLevels: () => ["off"],
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
  } as unknown as AgentSession;
}

describe("WorkspaceGraphFactory multi-Session routing", () => {
  it("uses independent operation locks for different AgentSession instances", () => {
    const factory = new WorkspaceGraphFactory({} as GraphFactoryDeps);
    const first = fakeSession(false);
    const second = fakeSession(false);

    expect(factory.getSessionOperationLock(first).tryAcquire("first")).toBe(true);
    expect(factory.getSessionOperationLock(second).tryAcquire("second")).toBe(true);
    expect(factory.getSessionOperationLock(first).tryAcquire("again")).toBe(false);
  });

  it("projects a background Agent event only as Session runtime state", () => {
    const events: Array<{ event: HostEventName; identity: HostIdentity; payload: unknown }> = [];
    const identity: HostIdentity = {
      hostInstanceId: HOST_ID,
      workspaceId: WORKSPACE_ID,
      workspaceRevision: 1,
      sessionId: ACTIVE_SESSION_ID,
      sessionRevision: 5,
      packageRevision: 1,
    };
    const server = {
      getIdentity: () => identity,
      emitForIdentity: vi.fn(
        (eventIdentity: HostIdentity, event: HostEventName, payload: unknown) => {
          events.push({ identity: eventIdentity, event, payload });
        },
      ),
      setPhase: vi.fn(),
    } as unknown as PiHostServer;
    const factory = new WorkspaceGraphFactory({} as GraphFactoryDeps);
    factory.bindServer(server);

    const activeSession = fakeSession(true);
    const backgroundSession = fakeSession(false);
    const background = {
      sessionId: BACKGROUND_SESSION_ID,
      sessionRevision: 3,
      agentSession: backgroundSession,
      sessionManager: {},
      sessionSnapshot: {
        sessionId: BACKGROUND_SESSION_ID,
        sessionPath: "C:/sessions/background.jsonl",
        cwd: "C:/workspace",
        revision: 3,
        isStreaming: true,
        isIdle: false,
        isCompacting: false,
        isRetrying: false,
        thinkingLevel: "off",
        autoCompactionEnabled: true,
        autoRetryEnabled: true,
        steeringMode: "all",
        followUpMode: "all",
        pending: { steering: [], followUp: [] },
        messages: [],
        tools: {
          revision: 1,
          workspaceId: WORKSPACE_ID,
          sessionId: BACKGROUND_SESSION_ID,
          sessionRevision: 3,
          tools: [],
          active: [],
        },
      },
      toolRevision: 1,
    } as unknown as BackgroundSessionRuntime;
    const graph = {
      workspaceId: WORKSPACE_ID,
      canonicalCwd: "C:/workspace",
      agentSession: activeSession,
      backgroundSessions: new Map([[BACKGROUND_SESSION_ID, background]]),
    } as unknown as WorkspaceGraph;
    Reflect.set(factory, "graph", graph);

    const internal = factory as unknown as {
      handleAgentEvent: (
        graph: WorkspaceGraph,
        session: AgentSession,
        event: unknown,
      ) => void;
    };
    internal.handleAgentEvent(graph, backgroundSession, { type: "turn_start" });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "session.runtimeChanged",
      identity: {
        sessionId: BACKGROUND_SESSION_ID,
        sessionRevision: 3,
      },
      payload: {
        sessionId: BACKGROUND_SESSION_ID,
        sessionRevision: 3,
        state: "running",
      },
    });
  });

  it("promotes a running background Runtime without reopening its Session file", async () => {
    const identity = {
      hostInstanceId: HOST_ID,
      workspaceId: WORKSPACE_ID,
      workspaceRevision: 1,
      sessionId: ACTIVE_SESSION_ID,
      sessionRevision: 5,
      packageRevision: 1,
    };
    const emitted: HostEventName[] = [];
    const server = {
      identity,
      getIdentity: () => ({ ...identity }),
      emit: vi.fn((event: HostEventName) => emitted.push(event)),
      emitForIdentity: vi.fn(),
    } as unknown as PiHostServer;
    const factory = new WorkspaceGraphFactory({} as GraphFactoryDeps);
    factory.bindServer(server);

    const foreground = fakeSession(true, ACTIVE_SESSION_ID);
    const backgroundSession = fakeSession(false, BACKGROUND_SESSION_ID);
    const updateIdentity = vi.fn();
    const runtime = {
      sessionId: BACKGROUND_SESSION_ID,
      sessionRevision: 3,
      sessionManager: {},
      agentSession: backgroundSession,
      resourceLoader: {},
      extensionsResult: null,
      toolRevision: 4,
      sessionSnapshot: {
        sessionId: BACKGROUND_SESSION_ID,
        sessionPath: `C:/sessions/${BACKGROUND_SESSION_ID}.jsonl`,
        revision: 3,
      },
      unsubscribeAgent: vi.fn(),
      extensionUiActivate: null,
      extensionUiCleanup: vi.fn(),
      extensionUiUpdateIdentity: updateIdentity,
    } as unknown as BackgroundSessionRuntime;
    const graph = {
      workspaceId: WORKSPACE_ID,
      canonicalCwd: "C:/workspace",
      agentSession: foreground,
      sessionManager: null,
      sessionSnapshot: null,
      resourceLoader: null,
      extensionsResult: null,
      toolRevision: 1,
      extensionUiActivate: null,
      extensionUiCleanup: null,
      extensionUiUpdateIdentity: null,
      unsubscribeAgent: null,
      backgroundSessions: new Map([[BACKGROUND_SESSION_ID, runtime]]),
    } as unknown as WorkspaceGraph;
    Reflect.set(factory, "graph", graph);
    const internal = factory as unknown as {
      promoteBackgroundRuntime: (
        graph: WorkspaceGraph,
        runtime: BackgroundSessionRuntime,
      ) => Promise<{ sessionId: string; revision: number }>;
    };

    const result = await internal.promoteBackgroundRuntime(graph, runtime);

    expect(result).toMatchObject({ sessionId: BACKGROUND_SESSION_ID, revision: 6 });
    expect(graph.agentSession).toBe(backgroundSession);
    expect(graph.backgroundSessions.has(BACKGROUND_SESSION_ID)).toBe(false);
    expect(identity).toMatchObject({
      sessionId: BACKGROUND_SESSION_ID,
      sessionRevision: 6,
    });
    expect(updateIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: BACKGROUND_SESSION_ID, sessionRevision: 6 }),
    );
    expect(foreground.dispose).toHaveBeenCalled();
    expect(emitted).toEqual([
      "session.snapshot",
      "agent.toolsChanged",
      "session.runtimeChanged",
    ]);
  });

  it("rejects disk reload while the active Session is running", async () => {
    const identity = {
      hostInstanceId: HOST_ID,
      workspaceId: WORKSPACE_ID,
      workspaceRevision: 1,
      sessionId: ACTIVE_SESSION_ID,
      sessionRevision: 5,
      packageRevision: 1,
    };
    const server = {
      identity,
      serviceGraphLock: new TryMutex(),
    } as unknown as PiHostServer;
    const factory = new WorkspaceGraphFactory({} as GraphFactoryDeps);
    factory.bindServer(server);
    const activeSession = fakeSession(false, ACTIVE_SESSION_ID);
    const sessionPath = `C:/sessions/${ACTIVE_SESSION_ID}.jsonl`;
    Reflect.set(factory, "graph", {
      canonicalCwd: "C:/workspace",
      servicesReady: true,
      settingsManager: {},
      resourceLoader: {},
      agentSession: activeSession,
      sessionSnapshot: {
        sessionId: ACTIVE_SESSION_ID,
        sessionPath,
        revision: 5,
      },
      backgroundSessions: new Map(),
    } as unknown as WorkspaceGraph);

    const result = await factory.reloadSession("reload-running");

    expect("error" in result && result.error.code).toBe("AGENT_BUSY");
    expect(server.serviceGraphLock.isHeld()).toBe(false);
  });
});
