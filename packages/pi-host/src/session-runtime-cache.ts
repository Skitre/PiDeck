import { randomUUID } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  createHostError,
  type HostError,
  type HostIdentity,
  type QueueSnapshot,
  type SessionRuntimeState,
  type SessionSnapshot,
} from "@pideck/protocol";
import { clearSlots } from "./extension-ui-lifecycle.js";
import { normalizeAgentEvent } from "./event-normalize.js";
import { AgentOperationLock } from "./locks.js";
import { logger } from "./logger.js";
import { pruneQueuedImages } from "./queue-attachments.js";
import {
  beginQueueTransaction,
  finishQueueTransaction,
  observeQueueUpdate,
} from "./queue-state.js";
import { buildSessionSnapshot, buildToolSnapshot } from "./session-snapshot.js";
import type { PiHostServer } from "./server.js";
import { toolResultNeedsToolsRefresh } from "./tools-refresh.js";
import type { BackgroundSessionRuntime, WorkspaceGraph } from "./workspace-graph-types.js";

export const SESSION_DISPOSAL_STEP_TIMEOUT_MS = 15_000;
export const MAX_LIVE_SESSIONS = 5;

type DisposalStepResult =
  { status: "completed" } | { status: "failed"; error: unknown } | { status: "timed_out" };

async function settleDisposalStep(operation: () => Promise<unknown>): Promise<DisposalStepResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const completed: Promise<DisposalStepResult> = Promise.resolve()
    .then(operation)
    .then(
      () => ({ status: "completed" }),
      (error: unknown) => ({ status: "failed", error }),
    );
  const timedOut = new Promise<DisposalStepResult>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timed_out" }), SESSION_DISPOSAL_STEP_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([completed, timedOut]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function runDisposalStep(
  description: string,
  operation: () => Promise<unknown>,
): Promise<void> {
  const result = await settleDisposalStep(operation);
  if (result.status === "completed") return;
  if (result.status === "timed_out") {
    logger.warn(`${description} timed out`, {
      timeoutMs: SESSION_DISPOSAL_STEP_TIMEOUT_MS,
    });
    return;
  }
  logger.warn(`${description} failed`, {
    error: result.error instanceof Error ? result.error.message : String(result.error),
  });
}

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
  | "extensionUiReplayState"
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
    extensionUiReplayState: graph.extensionUiReplayState,
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
  graph.extensionUiReplayState = state.extensionUiReplayState;
  graph.unsubscribeAgent = state.unsubscribeAgent;
  identity.sessionId = state.sessionId;
  identity.sessionRevision = state.sessionRevision;
}

export type SessionRuntimeCacheContext = {
  getGraph: () => WorkspaceGraph | null;
  getServer: () => PiHostServer | null;
  sessionPathsEqual: (left: string | undefined, right: string) => boolean;
  onRetainedGraphBecameIdle?: (graph: WorkspaceGraph) => void;
};

export type ResolvedSessionTarget = {
  identity: HostIdentity;
  agentSession: AgentSession;
  sessionManager: BackgroundSessionRuntime["sessionManager"];
  sessionSnapshot: SessionSnapshot;
  toolRevision: number;
  isActive: boolean;
  background?: BackgroundSessionRuntime;
};

function liveSessionCount(graph: WorkspaceGraph): number {
  return (graph.agentSession ? 1 : 0) + graph.backgroundSessions.size;
}

function wouldExceedLiveSessionLimit(graph: WorkspaceGraph, currentIsBusy: boolean): boolean {
  const disposingCurrent = Boolean(graph.agentSession) && !currentIsBusy;
  return liveSessionCount(graph) - (disposingCurrent ? 1 : 0) + 1 > MAX_LIVE_SESSIONS;
}

export class SessionRuntimeCache {
  private readonly runtimeStates = new WeakMap<AgentSession, SessionRuntimeState>();
  private readonly sessionOperationLocks = new WeakMap<AgentSession, AgentOperationLock>();
  private readonly runIds = new WeakMap<AgentSession, string>();
  private readonly disposedSessions = new WeakSet<AgentSession>();
  private readonly titleRefineSessions = new WeakSet<AgentSession>();

  constructor(private readonly context: SessionRuntimeCacheContext) {}

  getSessionOperationLock(session: AgentSession): AgentOperationLock {
    let lock = this.sessionOperationLocks.get(session);
    if (!lock) {
      lock = new AgentOperationLock();
      this.sessionOperationLocks.set(session, lock);
    }
    return lock;
  }

  isSessionBusy(session: AgentSession): boolean {
    return !session.isIdle || this.getSessionOperationLock(session).isHeld();
  }

  setSessionRunId(session: AgentSession, runId: string): void {
    this.runIds.set(session, runId);
  }

  clearSessionRunId(session: AgentSession): void {
    this.runIds.delete(session);
  }

  beginQueueTransaction(session: AgentSession): QueueSnapshot {
    return beginQueueTransaction(session);
  }

  finishQueueTransaction(session: AgentSession): QueueSnapshot {
    const result = finishQueueTransaction(session);
    if (result.changed) this.publishQueueSnapshot(session, result.queue);
    pruneQueuedImages(session, [...result.queue.steering, ...result.queue.followUp]);
    return result.queue;
  }

  syncQueueState(session: AgentSession, force = false): QueueSnapshot {
    const observed = observeQueueUpdate(session);
    if (!observed.suppressed && (observed.changed || force)) {
      this.publishQueueSnapshot(session, observed.queue);
      pruneQueuedImages(session, [...observed.queue.steering, ...observed.queue.followUp]);
    }
    return observed.queue;
  }

  graphHasBusySessions(graph: WorkspaceGraph): boolean {
    if (graph.agentSession && this.isSessionBusy(graph.agentSession)) return true;
    for (const runtime of graph.backgroundSessions.values()) {
      if (this.isSessionBusy(runtime.agentSession)) return true;
    }
    return false;
  }

  hasBusySessions(): boolean {
    const graph = this.context.getGraph();
    return graph ? this.graphHasBusySessions(graph) : false;
  }

  hasRunningSessions(): boolean {
    return this.hasBusySessions();
  }

  liveSessionCount(): number {
    const graph = this.context.getGraph();
    return graph ? liveSessionCount(graph) : 0;
  }

  wouldExceedLiveSessionLimit(): boolean {
    const graph = this.context.getGraph();
    if (!graph) return false;
    const currentIsBusy = graph.agentSession ? this.isSessionBusy(graph.agentSession) : false;
    return wouldExceedLiveSessionLimit(graph, currentIsBusy);
  }

  markTitleRefine(session: AgentSession, pending: boolean): void {
    if (pending) this.titleRefineSessions.add(session);
    else this.titleRefineSessions.delete(session);
  }

  resolveSessionTarget(sessionId: unknown, sessionRevision: unknown): ResolvedSessionTarget | null {
    const identity = this.resolveSessionIdentity(sessionId, sessionRevision);
    const graph = this.context.getGraph();
    const server = this.context.getServer();
    if (!identity || !graph || !server || typeof sessionId !== "string") return null;
    if (
      graph.agentSession &&
      graph.sessionManager &&
      graph.sessionSnapshot &&
      server.identity.sessionId === sessionId &&
      server.identity.sessionRevision === sessionRevision
    ) {
      return {
        identity,
        agentSession: graph.agentSession,
        sessionManager: graph.sessionManager,
        sessionSnapshot: graph.sessionSnapshot,
        toolRevision: graph.toolRevision,
        isActive: true,
      };
    }
    const background = graph.backgroundSessions.get(sessionId);
    if (!background || background.sessionRevision !== sessionRevision) return null;
    return {
      identity,
      agentSession: background.agentSession,
      sessionManager: background.sessionManager,
      sessionSnapshot: background.sessionSnapshot,
      toolRevision: background.toolRevision,
      isActive: false,
      background,
    };
  }

  findRuntimeForSession(session: AgentSession): ResolvedSessionTarget | null {
    const graph = this.context.getGraph();
    const server = this.context.getServer();
    if (!graph || !server) return null;
    if (graph.agentSession === session && graph.sessionManager && graph.sessionSnapshot) {
      return {
        identity: server.getIdentity(),
        agentSession: session,
        sessionManager: graph.sessionManager,
        sessionSnapshot: graph.sessionSnapshot,
        toolRevision: graph.toolRevision,
        isActive: true,
      };
    }
    const background = [...graph.backgroundSessions.values()].find(
      (runtime) => runtime.agentSession === session,
    );
    if (!background) return null;
    return {
      identity: {
        ...server.getIdentity(),
        sessionId: background.sessionId,
        sessionRevision: background.sessionRevision,
      },
      agentSession: session,
      sessionManager: background.sessionManager,
      sessionSnapshot: background.sessionSnapshot,
      toolRevision: background.toolRevision,
      isActive: false,
      background,
    };
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

  resolveSessionIdentity(sessionId: unknown, sessionRevision: unknown): HostIdentity | null {
    const server = this.context.getServer();
    const graph = this.context.getGraph();
    if (!server || !graph || typeof sessionId !== "string" || typeof sessionRevision !== "number") {
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
  }

  async disposeAgentSessionOnly(session: AgentSession): Promise<void> {
    if (this.disposedSessions.has(session)) return;
    this.disposedSessions.add(session);
    try {
      const extensionRunner = session.extensionRunner;
      if (extensionRunner?.hasHandlers("session_shutdown")) {
        await runDisposalStep("Extension session_shutdown during dispose", () =>
          extensionRunner.emit({ type: "session_shutdown", reason: "quit" }),
        );
      }
    } catch (err) {
      logger.warn("Extension session_shutdown during dispose failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      if (!session.isIdle) {
        await runDisposalStep("abort during dispose", () => session.abort());
      }
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
      !this.isSessionBusy(previous.agentSession)
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
      extensionUiReplayState: previous.extensionUiReplayState,
    };
    graph.backgroundSessions.set(runtime.sessionId, runtime);
    return runtime;
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
    if (this.isSessionBusy(runtime.agentSession)) {
      return "busy";
    }
    await this.disposeBackgroundRuntime(graph, runtime);
    return "disposed";
  }

  announceRetainedRuntime(runtime: BackgroundSessionRuntime): void {
    const graph = this.context.getGraph();
    const server = this.context.getServer();
    if (!graph || !server || graph.backgroundSessions.get(runtime.sessionId) !== runtime) {
      return;
    }
    this.publishRuntimeState(runtime.agentSession, {
      ...server.getIdentity(),
      sessionId: runtime.sessionId,
      sessionRevision: runtime.sessionRevision,
    });
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
      extensionUiReplayState: runtime.extensionUiReplayState,
      unsubscribeAgent: runtime.unsubscribeAgent,
      sessionId: runtime.sessionId,
      sessionRevision,
    });

    if (!retainedPrevious) {
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

    server.emit("session.snapshot", snapshot);
    server.emit("agent.toolsChanged", snapshot.tools);
    if (retainedPrevious) this.announceRetainedRuntime(retainedPrevious);
    server.emit("session.runtimeChanged", {
      sessionId: runtime.sessionId,
      sessionRevision,
      state: this.isSessionBusy(runtime.agentSession) ? "running" : "idle",
      updatedAt: Date.now(),
    });
    runtime.extensionUiReplayState?.();
    return snapshot;
  }

  handleAgentEvent(graph: WorkspaceGraph, sourceSession: AgentSession, event: unknown): void {
    try {
      this.publishAgentEvent(graph, sourceSession, event);
    } catch (error) {
      logger.warn("Failed to publish agent event", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private publishAgentEvent(
    graph: WorkspaceGraph,
    sourceSession: AgentSession,
    event: unknown,
  ): void {
    const server = this.context.getServer();
    if (!server) return;
    const graphIsCurrent = this.context.getGraph() === graph;

    const active = graph.agentSession === sourceSession;
    const background = active
      ? undefined
      : [...graph.backgroundSessions.values()].find(
          (runtime) => runtime.agentSession === sourceSession,
        );
    const sessionManager = active ? graph.sessionManager : background?.sessionManager;
    const currentSnapshot = active ? graph.sessionSnapshot : background?.sessionSnapshot;
    if (!sessionManager || !currentSnapshot) return;
    const eventIdentity = this.identityForGraphSession(
      graph,
      currentSnapshot.sessionId,
      currentSnapshot.revision,
    );

    const eventType =
      typeof event === "object" && event !== null && "type" in event
        ? String((event as { type?: unknown }).type ?? "")
        : "";
    if (eventType === "queue_update") {
      const queueEvent = event as {
        steering?: readonly string[];
        followUp?: readonly string[];
      };
      const observed = observeQueueUpdate(sourceSession, {
        steering: Array.isArray(queueEvent.steering)
          ? [...queueEvent.steering]
          : [...sourceSession.getSteeringMessages()],
        followUp: Array.isArray(queueEvent.followUp)
          ? [...queueEvent.followUp]
          : [...sourceSession.getFollowUpMessages()],
      });
      if (!observed.suppressed && observed.changed) {
        this.publishQueueSnapshot(sourceSession, observed.queue);
        pruneQueuedImages(sourceSession, [...observed.queue.steering, ...observed.queue.followUp]);
      }
      return;
    }
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
      if (active && graphIsCurrent) {
        server.emitForIdentity(eventIdentity, "session.snapshot", nextSnapshot);
      }
      return;
    }

    const runId = this.runIds.get(sourceSession) ?? randomUUID();
    const serialized = normalizeAgentEvent(event);
    server.emitForIdentity(eventIdentity, "agent.event", { runId, event: serialized });
    this.publishRuntimeState(sourceSession, eventIdentity, eventType, serialized);

    if (toolResultNeedsToolsRefresh(event)) {
      const toolRevision = active ? (graph.toolRevision += 1) : (background!.toolRevision += 1);
      const tools = buildToolSnapshot({
        session: sourceSession,
        workspaceId: graph.workspaceId,
        sessionId: eventIdentity.sessionId ?? "",
        sessionRevision: eventIdentity.sessionRevision,
        toolRevision,
      });
      if (active && graph.sessionSnapshot) graph.sessionSnapshot.tools = tools;
      if (!active && background) background.sessionSnapshot.tools = tools;
      if (active && graphIsCurrent) {
        server.emitForIdentity(eventIdentity, "agent.toolsChanged", tools);
      }
    }

    const snapshot = active ? graph.sessionSnapshot : background?.sessionSnapshot;
    if (!snapshot) return;
    snapshot.isIdle = sourceSession.isIdle;
    snapshot.isStreaming = !sourceSession.isIdle;
    if (eventType !== "agent_end" && eventType !== "agent_settled") return;

    if (!this.hasBusySessions()) server.setPhase("ready");
    if (!graphIsCurrent && !this.graphHasBusySessions(graph)) {
      this.context.onRetainedGraphBecameIdle?.(graph);
    }
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
      if (graphIsCurrent) {
        server.emitForIdentity(eventIdentity, "session.snapshot", lifecycleSnapshot);
      }
    } else if (background) {
      background.sessionSnapshot = lifecycleSnapshot;
      if (eventType === "agent_settled") {
        setTimeout(() => {
          void this.disposeSettledBackgroundRuntime(graph, background).then(() => {
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
    if (this.isSessionBusy(session)) return "running";
    if (session.getSteeringMessages().length > 0 || session.getFollowUpMessages().length > 0) {
      return "queued";
    }
    return "idle";
  }

  private publishQueueSnapshot(session: AgentSession, queue: QueueSnapshot): void {
    const graph = this.context.getGraph();
    const server = this.context.getServer();
    if (!graph || !server) return;
    const active = graph.agentSession === session;
    const background = active
      ? undefined
      : [...graph.backgroundSessions.values()].find((runtime) => runtime.agentSession === session);
    const sessionSnapshot = active ? graph.sessionSnapshot : background?.sessionSnapshot;
    if (!sessionSnapshot) return;
    sessionSnapshot.pending = queue;
    if (!active) return;
    server.emitForIdentity(
      {
        ...server.getIdentity(),
        sessionId: sessionSnapshot.sessionId,
        sessionRevision: sessionSnapshot.revision,
      },
      "agent.queueChanged",
      queue,
    );
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

  async disposeSettledBackgroundRuntime(
    graph: WorkspaceGraph,
    runtime: BackgroundSessionRuntime,
  ): Promise<void> {
    const server = this.context.getServer();
    if (!server) return;
    if (this.titleRefineSessions.has(runtime.agentSession)) return;
    if (this.isSessionBusy(runtime.agentSession)) return;
    this.publishRuntimeState(
      runtime.agentSession,
      this.identityForGraphSession(graph, runtime.sessionId, runtime.sessionRevision),
      "agent_settled",
    );
    const requestId = `background-settle:${runtime.sessionId}`;
    await server.serviceGraphLock.acquireUnbounded({
      operationKind: "session.cleanup",
      requestId,
    });
    try {
      if (this.titleRefineSessions.has(runtime.agentSession)) return;
      if (this.isSessionBusy(runtime.agentSession)) return;
      await this.disposeBackgroundRuntime(graph, runtime);
    } finally {
      server.serviceGraphLock.release(requestId);
    }
  }

  private identityForGraphSession(
    graph: WorkspaceGraph,
    sessionId: string,
    sessionRevision: number,
  ): HostIdentity {
    const server = this.context.getServer()!;
    const identity = server.getIdentity();
    const current = this.context.getGraph() === graph;
    return {
      ...identity,
      workspaceId: graph.workspaceId,
      workspaceRevision: current ? identity.workspaceRevision : graph.revision,
      sessionId,
      sessionRevision,
    };
  }

  private publishRuntimeState(
    session: AgentSession,
    identity: HostIdentity,
    eventType = "",
    serializedEvent: Record<string, unknown> = {},
  ): void {
    const server = this.context.getServer();
    if (!server || !identity.sessionId) return;
    const state: SessionRuntimeState =
      eventType === "error" ? "error" : this.runtimeStateForSession(session);
    if (this.runtimeStates.get(session) === state && state !== "error") return;
    this.runtimeStates.set(session, state);
    const rawError = serializedEvent.error ?? serializedEvent.message;
    const error =
      state === "error" ? (typeof rawError === "string" ? rawError : "Agent error") : undefined;
    server.emitForIdentity(identity, "session.runtimeChanged", {
      sessionId: identity.sessionId,
      sessionRevision: identity.sessionRevision,
      state,
      updatedAt: Date.now(),
      ...(error ? { error } : {}),
    });
  }
}
