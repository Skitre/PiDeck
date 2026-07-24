import { randomUUID } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  createHostError,
  type HostError,
  type HostIdentity,
  type SessionRuntimeState,
  type SessionSnapshot,
} from "@pideck/protocol";
import { bindForCandidate, activateOnce, clearSlots } from "./extension-ui-lifecycle.js";
import { normalizeAgentEvent } from "./event-normalize.js";
import { AgentOperationLock } from "./locks.js";
import { logger } from "./logger.js";
import { buildSessionSnapshot, buildToolSnapshot } from "./session-snapshot.js";
import type { PiHostServer } from "./server.js";
import { toolResultNeedsToolsRefresh } from "./tools-refresh.js";
import type {
  BackgroundSessionRuntime,
  WorkspaceGraph,
} from "./workspace-graph-types.js";

type ActiveSessionSlots = Pick<
  WorkspaceGraph,
  | "sessionManager"
  | "agentSession"
  | "extensionsResult"
  | "resourceLoader"
  | "toolRevision"
  | "sessionSnapshot"
  | "extensionUiActivate"
  | "extensionUiCleanup"
  | "extensionUiUpdateIdentity"
  | "unsubscribeAgent"
>;

export type ActiveSessionState = ActiveSessionSlots & {
  sessionId: string | null;
  sessionRevision: number;
};

type SessionIdentitySlots = {
  sessionId: string | null;
  sessionRevision: number;
};

export function captureActiveSessionState(
  graph: WorkspaceGraph,
  identity: SessionIdentitySlots,
): ActiveSessionState {
  return {
    sessionManager: graph.sessionManager,
    agentSession: graph.agentSession,
    extensionsResult: graph.extensionsResult,
    resourceLoader: graph.resourceLoader,
    toolRevision: graph.toolRevision,
    sessionSnapshot: graph.sessionSnapshot,
    extensionUiActivate: graph.extensionUiActivate,
    extensionUiCleanup: graph.extensionUiCleanup,
    extensionUiUpdateIdentity: graph.extensionUiUpdateIdentity,
    unsubscribeAgent: graph.unsubscribeAgent,
    sessionId: identity.sessionId,
    sessionRevision: identity.sessionRevision,
  };
}

/** Assign active Session graph slots and identity only; callers own all side effects. */
export function commitActiveSessionState(
  graph: WorkspaceGraph,
  identity: SessionIdentitySlots,
  state: ActiveSessionState,
): void {
  graph.sessionManager = state.sessionManager;
  graph.agentSession = state.agentSession;
  graph.extensionsResult = state.extensionsResult;
  graph.resourceLoader = state.resourceLoader;
  graph.toolRevision = state.toolRevision;
  graph.sessionSnapshot = state.sessionSnapshot;
  graph.extensionUiActivate = state.extensionUiActivate;
  graph.extensionUiCleanup = state.extensionUiCleanup;
  graph.extensionUiUpdateIdentity = state.extensionUiUpdateIdentity;
  graph.unsubscribeAgent = state.unsubscribeAgent;
  identity.sessionId = state.sessionId;
  identity.sessionRevision = state.sessionRevision;
}

export type SessionRuntimeCacheContext = {
  getGraph: () => WorkspaceGraph | null;
  getServer: () => PiHostServer | null;
  getCurrentRunId: () => string | null;
  sessionPathsEqual: (left: string | undefined, right: string) => boolean;
};

export class SessionRuntimeCache {
  private static readonly MAX_RETAINED_SESSIONS = 3;
  private readonly runtimeStates = new WeakMap<AgentSession, SessionRuntimeState>();
  private readonly sessionOperationLocks = new WeakMap<AgentSession, AgentOperationLock>();
  private readonly runIds = new WeakMap<AgentSession, string>();

  constructor(private readonly context: SessionRuntimeCacheContext) {}

  getSessionOperationLock(session: AgentSession): AgentOperationLock {
    let lock = this.sessionOperationLocks.get(session);
    if (!lock) {
      lock = new AgentOperationLock();
      this.sessionOperationLocks.set(session, lock);
    }
    return lock;
  }

  setSessionRunId(session: AgentSession, runId: string): void {
    this.runIds.set(session, runId);
  }

  clearSessionRunId(session: AgentSession): void {
    this.runIds.delete(session);
  }

  hasBusySessions(): boolean {
    const graph = this.context.getGraph();
    if (!graph) return false;
    if (graph.agentSession && !graph.agentSession.isIdle) return true;
    return graph.backgroundSessions.size > 0;
  }

  getSessionRuntimeInfo(
    sessionId: string,
    sessionPath: string,
  ): { runtimeState: SessionRuntimeState; sessionRevision: number } | null {
    const graph = this.context.getGraph();
    const server = this.context.getServer();
    if (!graph || !server) return null;
    if (
      graph.agentSession &&
      graph.sessionSnapshot &&
      (server.identity.sessionId === sessionId ||
        this.context.sessionPathsEqual(graph.sessionSnapshot.sessionPath, sessionPath))
    ) {
      return {
        runtimeState: this.runtimeStateForSession(graph.agentSession),
        sessionRevision: server.identity.sessionRevision,
      };
    }
    const background =
      graph.backgroundSessions.get(sessionId) ??
      [...graph.backgroundSessions.values()].find((runtime) =>
        this.context.sessionPathsEqual(runtime.sessionSnapshot.sessionPath, sessionPath),
      );
    return background
      ? {
          runtimeState: this.runtimeStateForSession(background.agentSession),
          sessionRevision: background.sessionRevision,
        }
      : null;
  }

  resolveSessionIdentity(
    sessionId: unknown,
    sessionRevision: unknown,
  ): HostIdentity | null {
    const server = this.context.getServer();
    const graph = this.context.getGraph();
    if (
      !server ||
      !graph ||
      typeof sessionId !== "string" ||
      typeof sessionRevision !== "number"
    ) {
      return null;
    }
    if (
      server.identity.sessionId === sessionId &&
      server.identity.sessionRevision === sessionRevision
    ) {
      return server.getIdentity();
    }
    const background = graph.backgroundSessions.get(sessionId);
    if (!background || background.sessionRevision !== sessionRevision) return null;
    return { ...server.getIdentity(), sessionId, sessionRevision };
  }

  async disposeAgentSession(graph: WorkspaceGraph): Promise<void> {
    try {
      clearSlots(graph);
    } catch {
      /* ignore Extension UI cleanup failure during disposal */
    }
    try {
      graph.unsubscribeAgent?.();
    } catch {
      /* ignore subscription cleanup failure during disposal */
    }
    graph.unsubscribeAgent = null;
    if (graph.agentSession) {
      await this.disposeAgentSessionOnly(graph.agentSession);
      graph.agentSession = null;
      graph.sessionManager = null;
      graph.sessionSnapshot = null;
    }
  }

  async disposeGraphSessionRuntimes(graph: WorkspaceGraph): Promise<void> {
    await this.disposeAgentSession(graph);
    for (const runtime of [...graph.backgroundSessions.values()]) {
      await this.disposeBackgroundRuntime(graph, runtime);
    }
    await this.disposeRetainedSessionRuntimes(graph);
  }

  async disposeAgentSessionOnly(session: {
    isIdle: boolean;
    abort: () => Promise<void> | void;
    dispose: () => void;
  }): Promise<void> {
    try {
      if (!session.isIdle) await session.abort();
    } catch (err) {
      logger.warn("abort during dispose failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      session.dispose();
    } catch {
      /* ignore */
    }
  }

  retainBusySession(
    graph: WorkspaceGraph,
    previous: ActiveSessionState,
  ): BackgroundSessionRuntime | null {
    if (
      !previous.sessionId ||
      !previous.sessionManager ||
      !previous.agentSession ||
      !previous.resourceLoader ||
      !previous.sessionSnapshot ||
      previous.agentSession.isIdle
    ) {
      return null;
    }
    const runtime: BackgroundSessionRuntime = {
      sessionId: previous.sessionId,
      sessionRevision: previous.sessionRevision,
      sessionManager: previous.sessionManager,
      agentSession: previous.agentSession,
      resourceLoader: previous.resourceLoader,
      extensionsResult: previous.extensionsResult,
      toolRevision: previous.toolRevision,
      sessionSnapshot: previous.sessionSnapshot,
      unsubscribeAgent: previous.unsubscribeAgent,
      extensionUiActivate: previous.extensionUiActivate,
      extensionUiCleanup: previous.extensionUiCleanup,
      extensionUiUpdateIdentity: previous.extensionUiUpdateIdentity,
    };
    graph.backgroundSessions.set(runtime.sessionId, runtime);
    return runtime;
  }

  async retainIdleSession(
    graph: WorkspaceGraph,
    previous: ActiveSessionState,
  ): Promise<BackgroundSessionRuntime | null> {
    if (
      !previous.sessionId ||
      !previous.sessionManager ||
      !previous.agentSession ||
      !previous.resourceLoader ||
      !previous.sessionSnapshot?.sessionPath ||
      !previous.agentSession.isIdle
    ) {
      return null;
    }
    try {
      previous.unsubscribeAgent?.();
    } catch {
      /* ignore */
    }
    try {
      previous.extensionUiCleanup?.();
    } catch {
      /* ignore */
    }

    const runtime: BackgroundSessionRuntime = {
      sessionId: previous.sessionId,
      sessionRevision: previous.sessionRevision,
      sessionManager: previous.sessionManager,
      agentSession: previous.agentSession,
      resourceLoader: previous.resourceLoader,
      extensionsResult: previous.extensionsResult,
      toolRevision: previous.toolRevision,
      sessionSnapshot: previous.sessionSnapshot,
      unsubscribeAgent: null,
      extensionUiActivate: null,
      extensionUiCleanup: null,
      extensionUiUpdateIdentity: null,
    };

    const retainedSessions = this.retainedSessionRuntimes(graph);
    const existing = retainedSessions.get(runtime.sessionId);
    retainedSessions.delete(runtime.sessionId);
    if (existing && existing !== runtime) {
      await this.disposeRetainedSessionRuntime(graph, existing, false);
    }
    retainedSessions.set(runtime.sessionId, runtime);

    while (retainedSessions.size > SessionRuntimeCache.MAX_RETAINED_SESSIONS) {
      const oldestId = retainedSessions.keys().next().value;
      if (oldestId === undefined) break;
      const evicted = retainedSessions.get(oldestId);
      retainedSessions.delete(oldestId);
      if (evicted) await this.disposeRetainedSessionRuntime(graph, evicted, false);
    }
    return runtime;
  }

  async disposeRetainedSessionRuntimes(graph: WorkspaceGraph): Promise<void> {
    const retainedSessions = this.retainedSessionRuntimes(graph);
    const runtimes = [...retainedSessions.values()];
    retainedSessions.clear();
    for (const runtime of runtimes) {
      await this.disposeRetainedSessionRuntime(graph, runtime, false);
    }
  }

  async disposeRetainedSessionRuntimeIfPresent(
    graph: WorkspaceGraph,
    sessionId: string,
    sessionPath: string,
  ): Promise<boolean> {
    const runtime = [...this.retainedSessionRuntimes(graph).values()].find(
      (candidate) =>
        candidate.sessionId === sessionId &&
        this.context.sessionPathsEqual(candidate.sessionSnapshot.sessionPath, sessionPath),
    );
    if (!runtime) return false;
    await this.disposeRetainedSessionRuntime(graph, runtime);
    return true;
  }

  async disposeBackgroundSessionRuntimeIfIdle(
    graph: WorkspaceGraph,
    sessionId: string,
    sessionPath: string,
  ): Promise<"none" | "busy" | "disposed"> {
    const runtime = [...graph.backgroundSessions.values()].find(
      (candidate) =>
        candidate.sessionId === sessionId &&
        this.context.sessionPathsEqual(candidate.sessionSnapshot.sessionPath, sessionPath),
    );
    if (!runtime) return "none";
    if (!runtime.agentSession.isIdle || this.getSessionOperationLock(runtime.agentSession).isHeld()) {
      return "busy";
    }
    await this.disposeBackgroundRuntime(graph, runtime);
    return "disposed";
  }

  announceRetainedRuntime(runtime: BackgroundSessionRuntime): void {
    const server = this.context.getServer();
    if (!server) return;
    server.emitForIdentity(
      {
        ...server.getIdentity(),
        sessionId: runtime.sessionId,
        sessionRevision: runtime.sessionRevision,
      },
      "session.runtimeChanged",
      {
        sessionId: runtime.sessionId,
        sessionRevision: runtime.sessionRevision,
        state: "running",
        updatedAt: Date.now(),
      },
    );
  }

  async promoteBackgroundRuntime(
    graph: WorkspaceGraph,
    runtime: BackgroundSessionRuntime,
  ): Promise<SessionSnapshot | { error: HostError }> {
    const server = this.context.getServer();
    if (!server || graph.backgroundSessions.get(runtime.sessionId) !== runtime) {
      return {
        error: createHostError("SESSION_NOT_FOUND", "Background Session is no longer available"),
      };
    }

    const previous = captureActiveSessionState(graph, server.identity);
    const retainedPrevious = this.retainBusySession(graph, previous);
    graph.backgroundSessions.delete(runtime.sessionId);
    const sessionRevision = server.identity.sessionRevision + 1;
    const promotedIdentity: HostIdentity = {
      ...server.getIdentity(),
      sessionId: runtime.sessionId,
      sessionRevision,
    };
    runtime.sessionRevision = sessionRevision;
    runtime.extensionUiUpdateIdentity?.(promotedIdentity);
    const snapshot = buildSessionSnapshot({
      session: runtime.agentSession,
      sessionManager: runtime.sessionManager,
      cwd: graph.canonicalCwd,
      sessionId: runtime.sessionId,
      revision: sessionRevision,
      workspaceId: graph.workspaceId,
      toolRevision: runtime.toolRevision,
    });
    runtime.sessionSnapshot = snapshot;

    commitActiveSessionState(graph, server.identity, {
      sessionManager: runtime.sessionManager,
      agentSession: runtime.agentSession,
      extensionsResult: runtime.extensionsResult,
      resourceLoader: runtime.resourceLoader,
      toolRevision: runtime.toolRevision,
      sessionSnapshot: snapshot,
      extensionUiActivate: runtime.extensionUiActivate,
      extensionUiCleanup: runtime.extensionUiCleanup,
      extensionUiUpdateIdentity: runtime.extensionUiUpdateIdentity,
      unsubscribeAgent: runtime.unsubscribeAgent,
      sessionId: runtime.sessionId,
      sessionRevision,
    });

    if (!retainedPrevious) {
      const retainedIdle = previous.agentSession?.isIdle
        ? await this.retainIdleSession(graph, previous)
        : null;
      if (!retainedIdle) {
        try {
          previous.unsubscribeAgent?.();
        } catch {
          /* ignore */
        }
        try {
          previous.extensionUiCleanup?.();
        } catch {
          /* ignore */
        }
        if (previous.agentSession) {
          await this.disposeAgentSessionOnly(previous.agentSession);
        }
      }
    }

    server.emit("session.snapshot", snapshot);
    server.emit("agent.toolsChanged", snapshot.tools);
    if (retainedPrevious) this.announceRetainedRuntime(retainedPrevious);
    server.emit("session.runtimeChanged", {
      sessionId: runtime.sessionId,
      sessionRevision,
      state: runtime.agentSession.isIdle ? "idle" : "running",
      updatedAt: Date.now(),
    });
    return snapshot;
  }

  async promoteRetainedSessionRuntime(
    graph: WorkspaceGraph,
    runtime: BackgroundSessionRuntime,
  ): Promise<SessionSnapshot | { error: HostError } | null> {
    const server = this.context.getServer();
    const retainedSessions = this.retainedSessionRuntimes(graph);
    if (!server || retainedSessions.get(runtime.sessionId) !== runtime) return null;

    const previous = captureActiveSessionState(graph, server.identity);
    const sessionRevision = server.identity.sessionRevision + 1;
    const candidateIdentity: HostIdentity = {
      ...server.getIdentity(),
      sessionId: runtime.sessionId,
      sessionRevision,
    };

    let binding: Awaited<ReturnType<typeof bindForCandidate>>;
    try {
      binding = await bindForCandidate(
        runtime.agentSession,
        runtime.extensionsResult,
        server,
        candidateIdentity,
      );
    } catch (err) {
      logger.warn("retained Session Extension rebind failed; reopening from disk", {
        sessionId: runtime.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      await this.disposeRetainedSessionRuntime(graph, runtime);
      return null;
    }

    const unsubscribe = runtime.agentSession.subscribe((event) => {
      this.handleAgentEvent(graph, runtime.agentSession, event);
    });
    const retainedPrevious = this.retainBusySession(graph, previous);
    retainedSessions.delete(runtime.sessionId);
    runtime.sessionRevision = sessionRevision;
    runtime.unsubscribeAgent = unsubscribe;
    runtime.extensionUiActivate = binding.activate;
    runtime.extensionUiCleanup = binding.cleanup;
    runtime.extensionUiUpdateIdentity = binding.updateIdentity;
    binding.updateIdentity(candidateIdentity);
    const snapshot = buildSessionSnapshot({
      session: runtime.agentSession,
      sessionManager: runtime.sessionManager,
      cwd: graph.canonicalCwd,
      sessionId: runtime.sessionId,
      revision: sessionRevision,
      workspaceId: graph.workspaceId,
      toolRevision: runtime.toolRevision,
    });
    runtime.sessionSnapshot = snapshot;

    commitActiveSessionState(graph, server.identity, {
      sessionManager: runtime.sessionManager,
      agentSession: runtime.agentSession,
      extensionsResult: runtime.extensionsResult,
      resourceLoader: runtime.resourceLoader,
      toolRevision: runtime.toolRevision,
      sessionSnapshot: snapshot,
      extensionUiActivate: runtime.extensionUiActivate,
      extensionUiCleanup: runtime.extensionUiCleanup,
      extensionUiUpdateIdentity: runtime.extensionUiUpdateIdentity,
      unsubscribeAgent: runtime.unsubscribeAgent,
      sessionId: runtime.sessionId,
      sessionRevision,
    });

    let publishExtensionUi = () => {};
    try {
      publishExtensionUi = await activateOnce(graph);
    } catch (err) {
      if (retainedPrevious) graph.backgroundSessions.delete(retainedPrevious.sessionId);
      try {
        unsubscribe();
      } catch {
        /* ignore */
      }
      try {
        binding.cleanup();
      } catch {
        /* ignore */
      }
      runtime.unsubscribeAgent = null;
      runtime.extensionUiActivate = null;
      runtime.extensionUiCleanup = null;
      runtime.extensionUiUpdateIdentity = null;
      retainedSessions.set(runtime.sessionId, runtime);
      commitActiveSessionState(graph, server.identity, previous);
      return {
        error: createHostError(
          "SESSION_SWITCH_FAILED",
          err instanceof Error ? err.message : "Extension bind failed",
        ),
      };
    }

    if (!retainedPrevious) {
      const retainedIdle = await this.retainIdleSession(graph, previous);
      if (!retainedIdle) {
        try {
          previous.unsubscribeAgent?.();
        } catch {
          /* ignore */
        }
        try {
          previous.extensionUiCleanup?.();
        } catch {
          /* ignore */
        }
        if (previous.agentSession) {
          await this.disposeAgentSessionOnly(previous.agentSession);
        }
      }
    }
    server.emit("session.snapshot", snapshot);
    server.emit("agent.toolsChanged", snapshot.tools);
    if (retainedPrevious) this.announceRetainedRuntime(retainedPrevious);
    server.emit("session.runtimeChanged", {
      sessionId: runtime.sessionId,
      sessionRevision,
      state: "idle",
      updatedAt: Date.now(),
    });
    publishExtensionUi();
    return snapshot;
  }

  handleAgentEvent(
    graph: WorkspaceGraph,
    sourceSession: AgentSession,
    event: unknown,
  ): void {
    const server = this.context.getServer();
    if (!server || this.context.getGraph() !== graph) return;

    const active = graph.agentSession === sourceSession;
    const background = active
      ? undefined
      : [...graph.backgroundSessions.values()].find(
          (runtime) => runtime.agentSession === sourceSession,
        );
    const sessionManager = active ? graph.sessionManager : background?.sessionManager;
    const currentSnapshot = active ? graph.sessionSnapshot : background?.sessionSnapshot;
    if (!sessionManager || !currentSnapshot) return;
    const eventIdentity: HostIdentity = {
      ...server.getIdentity(),
      sessionId: currentSnapshot.sessionId,
      sessionRevision: currentSnapshot.revision,
    };

    const eventType =
      typeof event === "object" && event !== null && "type" in event
        ? String((event as { type?: unknown }).type ?? "")
        : "";
    if (eventType === "session_info_changed") {
      const nextSnapshot = buildSessionSnapshot({
        session: sourceSession,
        sessionManager,
        cwd: graph.canonicalCwd,
        sessionId: eventIdentity.sessionId ?? "",
        revision: eventIdentity.sessionRevision,
        workspaceId: graph.workspaceId,
        toolRevision: active ? graph.toolRevision : background!.toolRevision,
      });
      if (active) graph.sessionSnapshot = nextSnapshot;
      else background!.sessionSnapshot = nextSnapshot;
      server.emitForIdentity(eventIdentity, "session.infoChanged", {
        sessionId: nextSnapshot.sessionId,
        ...(nextSnapshot.name ? { name: nextSnapshot.name } : {}),
      });
      if (active) server.emitForIdentity(eventIdentity, "session.snapshot", nextSnapshot);
      return;
    }

    const runId =
      this.runIds.get(sourceSession) ?? this.context.getCurrentRunId() ?? randomUUID();
    const serialized = normalizeAgentEvent(event);
    if (active) {
      server.emitForIdentity(eventIdentity, "agent.event", { runId, event: serialized });
    }
    this.publishRuntimeState(sourceSession, eventIdentity, eventType, serialized);

    if (toolResultNeedsToolsRefresh(event)) {
      const toolRevision = active
        ? (graph.toolRevision += 1)
        : (background!.toolRevision += 1);
      const tools = buildToolSnapshot({
        session: sourceSession,
        workspaceId: graph.workspaceId,
        sessionId: eventIdentity.sessionId ?? "",
        sessionRevision: eventIdentity.sessionRevision,
        toolRevision,
      });
      if (active && graph.sessionSnapshot) graph.sessionSnapshot.tools = tools;
      if (!active && background) background.sessionSnapshot.tools = tools;
      if (active) server.emitForIdentity(eventIdentity, "agent.toolsChanged", tools);
    }

    const snapshot = active ? graph.sessionSnapshot : background?.sessionSnapshot;
    if (!snapshot) return;
    snapshot.isIdle = sourceSession.isIdle;
    snapshot.isStreaming = !sourceSession.isIdle;
    if (eventType !== "agent_end" && eventType !== "agent_settled") return;

    if (!this.hasBusySessions()) server.setPhase("ready");
    const lifecycleSnapshot = buildSessionSnapshot({
      session: sourceSession,
      sessionManager,
      cwd: graph.canonicalCwd,
      sessionId: eventIdentity.sessionId ?? "",
      revision: eventIdentity.sessionRevision,
      workspaceId: graph.workspaceId,
      toolRevision: active ? graph.toolRevision : background!.toolRevision,
    });
    if (active) {
      graph.sessionSnapshot = lifecycleSnapshot;
      server.emitForIdentity(eventIdentity, "session.snapshot", lifecycleSnapshot);
    } else if (background) {
      background.sessionSnapshot = lifecycleSnapshot;
      if (eventType === "agent_settled") {
        setTimeout(() => {
          void this.disposeBackgroundRuntime(graph, background).then(() => {
            if (
              this.context.getGraph() === graph &&
              server.getPhase() === "agentBusy" &&
              !this.hasBusySessions()
            ) {
              server.setPhase("ready");
            }
          });
        }, 0);
      }
    }
  }

  private runtimeStateForSession(session: AgentSession): SessionRuntimeState {
    if (!session.isIdle) return "running";
    if (session.getSteeringMessages().length > 0 || session.getFollowUpMessages().length > 0) {
      return "queued";
    }
    return "idle";
  }

  private retainedSessionRuntimes(
    graph: WorkspaceGraph,
  ): Map<string, BackgroundSessionRuntime> {
    return graph.retainedSessions ?? (graph.retainedSessions = new Map());
  }

  private async disposeRetainedSessionRuntime(
    graph: WorkspaceGraph,
    runtime: BackgroundSessionRuntime,
    remove = true,
  ): Promise<void> {
    const retainedSessions = this.retainedSessionRuntimes(graph);
    if (remove) {
      if (retainedSessions.get(runtime.sessionId) !== runtime) return;
      retainedSessions.delete(runtime.sessionId);
    }
    try {
      runtime.unsubscribeAgent?.();
    } catch {
      /* ignore */
    }
    try {
      runtime.extensionUiCleanup?.();
    } catch {
      /* ignore */
    }
    await this.disposeAgentSessionOnly(runtime.agentSession);
  }

  private async disposeBackgroundRuntime(
    graph: WorkspaceGraph,
    runtime: BackgroundSessionRuntime,
  ): Promise<void> {
    if (graph.backgroundSessions.get(runtime.sessionId) !== runtime) return;
    graph.backgroundSessions.delete(runtime.sessionId);
    try {
      runtime.unsubscribeAgent?.();
    } catch {
      /* ignore */
    }
    try {
      runtime.extensionUiCleanup?.();
    } catch {
      /* ignore */
    }
    await this.disposeAgentSessionOnly(runtime.agentSession);
  }

  private publishRuntimeState(
    session: AgentSession,
    identity: HostIdentity,
    eventType: string,
    serializedEvent: Record<string, unknown>,
  ): void {
    const server = this.context.getServer();
    if (!server || !identity.sessionId) return;
    const state: SessionRuntimeState =
      eventType === "error" ? "error" : this.runtimeStateForSession(session);
    if (this.runtimeStates.get(session) === state && state !== "error") return;
    this.runtimeStates.set(session, state);
    const rawError = serializedEvent.error ?? serializedEvent.message;
    const error =
      state === "error"
        ? typeof rawError === "string"
          ? rawError
          : "Agent error"
        : undefined;
    server.emitForIdentity(identity, "session.runtimeChanged", {
      sessionId: identity.sessionId,
      sessionRevision: identity.sessionRevision,
      state,
      updatedAt: Date.now(),
      ...(error ? { error } : {}),
    });
  }
}
