import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    subscribe: vi.fn(() => vi.fn()),
    bindExtensions: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
  } as unknown as AgentSession;
}

function fakeSessionSnapshot(
  sessionId: string,
  revision: number,
  isIdle: boolean,
): BackgroundSessionRuntime["sessionSnapshot"] {
  return {
    sessionId,
    sessionPath: `C:/sessions/${sessionId}.jsonl`,
    cwd: "C:/workspace",
    revision,
    isStreaming: !isIdle,
    isIdle,
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
      sessionId,
      sessionRevision: revision,
      tools: [],
      active: [],
    },
  } as BackgroundSessionRuntime["sessionSnapshot"];
}

function fakeWorkspaceGraph(
  canonicalCwd: string,
  workspaceId: string,
  session: AgentSession,
): WorkspaceGraph {
  const sessionId = session.sessionId;
  return {
    workspaceId,
    cwd: canonicalCwd,
    canonicalCwd,
    revision: 1,
    servicesReady: true,
    settingsManager: {
      getGlobalSettings: () => ({}),
      getProjectSettings: () => ({}),
    },
    packageManager: {
      listConfiguredPackages: () => [],
      resolve: async () => ({ extensions: [], skills: [], prompts: [], themes: [] }),
    },
    resourceLoader: null,
    sessionManager: { getSessionId: () => sessionId },
    agentSession: session,
    extensionsResult: null,
    packageSnapshot: null,
    sessionSnapshot: fakeSessionSnapshot(sessionId, 1, true),
    toolRevision: 1,
    resourceIdMap: new Map(),
    unsubscribeAgent: vi.fn(),
    extensionUiActivate: null,
    extensionUiCleanup: vi.fn(),
    extensionUiUpdateIdentity: null,
    resourceReloadRequired: false,
    backgroundSessions: new Map(),
    retainedSessions: new Map(),
  } as unknown as WorkspaceGraph;
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

  it("keeps active snapshots running at agent_end and idle at agent_settled", () => {
    const events: Array<{ event: HostEventName; payload: unknown }> = [];
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
      emitForIdentity: vi.fn((_identity: HostIdentity, event: HostEventName, payload: unknown) => {
        events.push({ event, payload });
      }),
      setPhase: vi.fn(),
    } as unknown as PiHostServer;
    const factory = new WorkspaceGraphFactory({} as GraphFactoryDeps);
    factory.bindServer(server);
    const activeSession = fakeSession(false, ACTIVE_SESSION_ID);
    const graph = {
      workspaceId: WORKSPACE_ID,
      canonicalCwd: "C:/workspace",
      agentSession: activeSession,
      sessionManager: {},
      sessionSnapshot: fakeSessionSnapshot(ACTIVE_SESSION_ID, 5, false),
      toolRevision: 1,
      backgroundSessions: new Map(),
    } as unknown as WorkspaceGraph;
    Reflect.set(factory, "graph", graph);

    const internal = factory as unknown as {
      handleAgentEvent: (graph: WorkspaceGraph, session: AgentSession, event: unknown) => void;
    };
    internal.handleAgentEvent(graph, activeSession, { type: "agent_end" });

    const runningSnapshot = events.find((entry) => entry.event === "session.snapshot")
      ?.payload as { isIdle: boolean; isStreaming: boolean };
    expect(runningSnapshot).toMatchObject({ isIdle: false, isStreaming: true });

    Reflect.set(activeSession, "isIdle", true);
    internal.handleAgentEvent(graph, activeSession, { type: "agent_settled" });

    const snapshots = events
      .filter((entry) => entry.event === "session.snapshot")
      .map((entry) => entry.payload as { isIdle: boolean; isStreaming: boolean });
    expect(snapshots).toHaveLength(2);
    expect(snapshots.at(-1)).toMatchObject({ isIdle: true, isStreaming: false });
  });

  it("disposes a background session only after agent_settled", async () => {
    vi.useFakeTimers();
    try {
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
        getPhase: vi.fn(() => "agentBusy"),
        emitForIdentity: vi.fn(),
        setPhase: vi.fn(),
      } as unknown as PiHostServer;
      const factory = new WorkspaceGraphFactory({} as GraphFactoryDeps);
      factory.bindServer(server);
      const activeSession = fakeSession(true, ACTIVE_SESSION_ID);
      const backgroundSession = fakeSession(false, BACKGROUND_SESSION_ID);
      const background = {
        sessionId: BACKGROUND_SESSION_ID,
        sessionRevision: 3,
        agentSession: backgroundSession,
        sessionManager: {},
        resourceLoader: {},
        extensionsResult: null,
        toolRevision: 1,
        sessionSnapshot: fakeSessionSnapshot(BACKGROUND_SESSION_ID, 3, false),
        unsubscribeAgent: vi.fn(),
        extensionUiActivate: null,
        extensionUiCleanup: vi.fn(),
        extensionUiUpdateIdentity: null,
      } as unknown as BackgroundSessionRuntime;
      const graph = {
        workspaceId: WORKSPACE_ID,
        canonicalCwd: "C:/workspace",
        agentSession: activeSession,
        backgroundSessions: new Map([[BACKGROUND_SESSION_ID, background]]),
      } as unknown as WorkspaceGraph;
      Reflect.set(factory, "graph", graph);

      const internal = factory as unknown as {
        handleAgentEvent: (graph: WorkspaceGraph, session: AgentSession, event: unknown) => void;
      };
      internal.handleAgentEvent(graph, backgroundSession, { type: "agent_end" });
      await vi.runAllTimersAsync();

      expect(graph.backgroundSessions.get(BACKGROUND_SESSION_ID)).toBe(background);
      expect(backgroundSession.abort).not.toHaveBeenCalled();
      expect(backgroundSession.dispose).not.toHaveBeenCalled();
      expect(background.sessionSnapshot).toMatchObject({ isIdle: false, isStreaming: true });
      expect(server.setPhase).not.toHaveBeenCalled();

      Reflect.set(backgroundSession, "isIdle", true);
      internal.handleAgentEvent(graph, backgroundSession, { type: "agent_settled" });
      expect(graph.backgroundSessions.get(BACKGROUND_SESSION_ID)).toBe(background);

      await vi.runAllTimersAsync();

      expect(graph.backgroundSessions.has(BACKGROUND_SESSION_ID)).toBe(false);
      expect(backgroundSession.abort).not.toHaveBeenCalled();
      expect(backgroundSession.dispose).toHaveBeenCalledTimes(1);
      expect(server.setPhase).toHaveBeenCalledWith("ready");
    } finally {
      vi.useRealTimers();
    }
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
      sessionManager: {},
      sessionSnapshot: fakeSessionSnapshot(ACTIVE_SESSION_ID, 5, true),
      resourceLoader: {},
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
    expect(foreground.dispose).not.toHaveBeenCalled();
    expect(graph.retainedSessions?.has(ACTIVE_SESSION_ID)).toBe(true);
    expect(emitted).toEqual([
      "session.snapshot",
      "agent.toolsChanged",
      "session.runtimeChanged",
    ]);
  });

  it("reactivates a retained idle Session and parks the previous one", async () => {
    const identity: HostIdentity = {
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

    const active = fakeSession(true, ACTIVE_SESSION_ID);
    const retained = fakeSession(true, BACKGROUND_SESSION_ID);
    const activeCleanup = vi.fn();
    const activeUnsubscribe = vi.fn();
    const graph = {
      workspaceId: WORKSPACE_ID,
      canonicalCwd: "C:/workspace",
      agentSession: active,
      sessionManager: {},
      sessionSnapshot: fakeSessionSnapshot(ACTIVE_SESSION_ID, 5, true),
      resourceLoader: {},
      extensionsResult: null,
      toolRevision: 1,
      extensionUiActivate: null,
      extensionUiCleanup: activeCleanup,
      extensionUiUpdateIdentity: null,
      unsubscribeAgent: activeUnsubscribe,
      backgroundSessions: new Map(),
      retainedSessions: new Map(),
    } as unknown as WorkspaceGraph;
    Reflect.set(factory, "graph", graph);

    const runtime = await factory.retainIdleSession(graph, {
      sessionId: BACKGROUND_SESSION_ID,
      sessionRevision: 3,
      sessionManager: {} as never,
      agentSession: retained,
      resourceLoader: {} as never,
      extensionsResult: null,
      toolRevision: 2,
      sessionSnapshot: fakeSessionSnapshot(BACKGROUND_SESSION_ID, 3, true),
      unsubscribeAgent: vi.fn(),
      extensionUiActivate: null,
      extensionUiCleanup: vi.fn(),
      extensionUiUpdateIdentity: null,
    });
    expect(runtime).not.toBeNull();

    const result = await factory.promoteRetainedSessionRuntime(graph, runtime!);

    expect(result).toMatchObject({ sessionId: BACKGROUND_SESSION_ID, revision: 6 });
    expect(graph.agentSession).toBe(retained);
    expect(graph.retainedSessions.has(BACKGROUND_SESSION_ID)).toBe(false);
    expect(graph.retainedSessions.has(ACTIVE_SESSION_ID)).toBe(true);
    expect(active.dispose).not.toHaveBeenCalled();
    expect(activeCleanup).toHaveBeenCalledTimes(1);
    expect(activeUnsubscribe).toHaveBeenCalledTimes(1);
    expect(retained.bindExtensions).toHaveBeenCalledTimes(1);
    expect(emitted).toEqual([
      "session.snapshot",
      "agent.toolsChanged",
      "session.runtimeChanged",
    ]);
  });

  it("bounds retained idle Sessions and disposes the oldest runtime", async () => {
    const factory = new WorkspaceGraphFactory({} as GraphFactoryDeps);
    const graph = { retainedSessions: new Map() } as unknown as WorkspaceGraph;
    const sessions = Array.from({ length: 4 }, (_, index) =>
      fakeSession(true, `retained-${index}`),
    );

    for (const [index, session] of sessions.entries()) {
      await factory.retainIdleSession(graph, {
        sessionId: session.sessionId,
        sessionRevision: index + 1,
        sessionManager: {} as never,
        agentSession: session,
        resourceLoader: {} as never,
        extensionsResult: null,
        toolRevision: 1,
        sessionSnapshot: fakeSessionSnapshot(session.sessionId, index + 1, true),
        unsubscribeAgent: vi.fn(),
        extensionUiActivate: null,
        extensionUiCleanup: vi.fn(),
        extensionUiUpdateIdentity: null,
      });
    }

    expect(graph.retainedSessions.size).toBe(3);
    expect(graph.retainedSessions.has("retained-0")).toBe(false);
    expect(sessions[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(sessions.slice(1).every((session) => graph.retainedSessions.has(session.sessionId))).toBe(
      true,
    );
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

describe("WorkspaceGraphFactory retained Workspace recovery", () => {
  function setup() {
    const root = mkdtempSync(join(tmpdir(), "pideck-retained-workspace-"));
    const agentDir = join(root, "agent");
    const currentDir = join(root, "current");
    const retainedDir = join(root, "retained");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(currentDir, { recursive: true });
    mkdirSync(retainedDir, { recursive: true });

    const identity: HostIdentity = {
      hostInstanceId: HOST_ID,
      workspaceId: WORKSPACE_ID,
      workspaceRevision: 7,
      sessionId: ACTIVE_SESSION_ID,
      sessionRevision: 9,
      packageRevision: 4,
    };
    const server = {
      identity,
      serviceGraphLock: new TryMutex(),
      getIdentity: () => ({ ...identity }),
      emit: vi.fn(),
      emitForIdentity: vi.fn(),
      setPhase: vi.fn(),
      setLastError: vi.fn(),
    } as unknown as PiHostServer;
    const factory = new WorkspaceGraphFactory({
      agentDir,
      packageUpdateCheck: false,
    } as GraphFactoryDeps);
    factory.bindServer(server);

    const previous = fakeWorkspaceGraph(
      currentDir,
      WORKSPACE_ID,
      fakeSession(true, ACTIVE_SESSION_ID),
    );
    Reflect.set(factory, "graph", previous);
    const factoryInternals = factory as unknown as {
      workspaceLifecycle: {
        retainGraph: (graph: WorkspaceGraph) => Promise<void>;
        tryReactivateRetainedGraph: (args: {
          canonical: string;
          previousGraph: WorkspaceGraph | null;
          revision: number;
          sessionRevision: number;
          packageRevision: number;
        }) => Promise<unknown>;
        buildServices: () => Promise<{ graph: WorkspaceGraph }>;
        disposeRetainedGraphs: () => Promise<void>;
      };
      sessionRuntimeCache: {
        disposeRetainedSessionRuntimes: (graph: WorkspaceGraph) => Promise<void>;
      };
    };
    const internal = factoryInternals.workspaceLifecycle;

    return {
      root,
      retainedDir,
      identity,
      server,
      factory,
      previous,
      internal,
      sessionRuntimeCache: factoryInternals.sessionRuntimeCache,
    };
  }

  it("keeps the active graph and identity when retained graph preparation fails", async () => {
    const state = setup();
    try {
      const retainedSession = fakeSession(true, BACKGROUND_SESSION_ID);
      const retained = fakeWorkspaceGraph(
        state.retainedDir,
        "55555555-5555-4555-8555-555555555555",
        retainedSession,
      );
      retained.packageManager = null;
      await state.internal.retainGraph(retained);
      const originalIdentity = { ...state.identity };

      const result = await state.internal.tryReactivateRetainedGraph({
        canonical: state.retainedDir,
        previousGraph: state.previous,
        revision: 8,
        sessionRevision: 10,
        packageRevision: 5,
      });

      expect(result).toBeNull();
      expect(state.factory.getGraph()).toBe(state.previous);
      expect(state.identity).toEqual(originalIdentity);
      expect(state.previous.extensionUiCleanup).not.toHaveBeenCalled();
      expect(state.previous.unsubscribeAgent).not.toHaveBeenCalled();
      expect(retainedSession.dispose).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it("keeps the active graph when a newly built Workspace fails activation", async () => {
    const state = setup();
    try {
      const candidateSession = fakeSession(true, BACKGROUND_SESSION_ID);
      const candidate = fakeWorkspaceGraph(
        state.retainedDir,
        "88888888-8888-4888-8888-888888888888",
        candidateSession,
      );
      vi.spyOn(
        state.internal as unknown as {
          buildServices: () => Promise<{ graph: WorkspaceGraph }>;
        },
        "buildServices",
      ).mockResolvedValue({ graph: candidate });
      candidate.extensionUiActivate = async () => {
        throw new Error("extension activation failed");
      };
      const originalIdentity = { ...state.identity };

      const result = await state.factory.setCurrent(state.retainedDir, "switch-failed");

      expect("error" in result && result.error.code).toBe("WORKSPACE_SWITCH_FAILED");
      expect(state.factory.getGraph()).toBe(state.previous);
      expect(state.identity).toEqual(originalIdentity);
      expect(state.previous.extensionUiCleanup).not.toHaveBeenCalled();
      expect(state.previous.unsubscribeAgent).not.toHaveBeenCalled();
      expect(candidateSession.dispose).toHaveBeenCalledTimes(1);
      expect(state.server.setPhase).toHaveBeenCalledWith("ready");
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it("rolls back the active graph and identity when retained activation fails", async () => {
    const state = setup();
    try {
      const retainedSession = fakeSession(true, BACKGROUND_SESSION_ID);
      Reflect.set(
        retainedSession,
        "bindExtensions",
        vi.fn(async () => {
          throw new Error("extension activation failed");
        }),
      );
      const retained = fakeWorkspaceGraph(
        state.retainedDir,
        "66666666-6666-4666-8666-666666666666",
        retainedSession,
      );
      await state.internal.retainGraph(retained);
      const originalIdentity = { ...state.identity };

      const result = await state.internal.tryReactivateRetainedGraph({
        canonical: state.retainedDir,
        previousGraph: state.previous,
        revision: 8,
        sessionRevision: 10,
        packageRevision: 5,
      });

      expect(result).toBeNull();
      expect(state.factory.getGraph()).toBe(state.previous);
      expect(state.identity).toEqual(originalIdentity);
      expect(state.previous.extensionUiCleanup).not.toHaveBeenCalled();
      expect(state.previous.unsubscribeAgent).not.toHaveBeenCalled();
      expect(retainedSession.dispose).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it("discards a retained graph when project resources changed on disk", async () => {
    const state = setup();
    try {
      const retainedSession = fakeSession(true, BACKGROUND_SESSION_ID);
      const retained = fakeWorkspaceGraph(
        state.retainedDir,
        "77777777-7777-4777-8777-777777777777",
        retainedSession,
      );
      await state.internal.retainGraph(retained);
      const extensionsDir = join(state.retainedDir, ".pi", "extensions");
      mkdirSync(extensionsDir, { recursive: true });
      writeFileSync(join(extensionsDir, "changed.ts"), "export default () => {};\n");

      const result = await state.internal.tryReactivateRetainedGraph({
        canonical: state.retainedDir,
        previousGraph: state.previous,
        revision: 8,
        sessionRevision: 10,
        packageRevision: 5,
      });

      expect(result).toBeNull();
      expect(state.factory.getGraph()).toBe(state.previous);
      expect(retainedSession.bindExtensions).not.toHaveBeenCalled();
      expect(retainedSession.dispose).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it("invalidates retained Session and Workspace runtimes together", async () => {
    const state = setup();
    try {
      const disposeSessions = vi
        .spyOn(state.sessionRuntimeCache, "disposeRetainedSessionRuntimes")
        .mockResolvedValue();
      const disposeWorkspaces = vi
        .spyOn(state.internal, "disposeRetainedGraphs")
        .mockResolvedValue();

      await state.factory.invalidateRetainedRuntimeCaches();

      expect(disposeSessions).toHaveBeenCalledWith(state.previous);
      expect(disposeWorkspaces).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });
});
