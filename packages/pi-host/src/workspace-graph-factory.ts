import type { AgentSession, ExtensionCommandContextActions } from "@earendil-works/pi-coding-agent";
import {
  createHostError,
  type HostError,
  type HostIdentity,
  type SessionSnapshot,
  type SessionRuntimeState,
  type WorkspaceSnapshot,
} from "@pideck/protocol";
import type { PiHostServer } from "./server.js";
import { activateOnce } from "./extension-ui-lifecycle.js";
import { createExtensionCommandContextActions } from "./extension-command-actions.js";
import {
  SessionRuntimeCache,
  type ActiveSessionState,
  type ResolvedSessionTarget,
} from "./session-runtime-cache.js";
import type { AgentOperationLock } from "./locks.js";
import { WorkspaceLifecycle } from "./workspace-lifecycle.js";
export * from "./workspace-graph-types.js";
import {
  type BackgroundSessionRuntime,
  type GraphFactoryDeps,
  type WorkspaceGraph,
} from "./workspace-graph-types.js";
import {
  sessionPathsEqual,
  type WorkspaceSessionBootstrap,
} from "./workspace-session-bootstrap.js";
import {
  archiveSession,
  cleanupArchivedSessions,
  createSession,
  deleteSession,
  listSessions,
  openSession,
  refineActiveSessionName,
  reloadSession,
  renameSession,
  restoreSession,
  setActiveSessionName,
  setSessionRuntimeName,
} from "./session-lifecycle.js";
import { UserResourceCache } from "./user-resource-cache.js";

export class WorkspaceGraphFactory {
  /** @internal — session-lifecycle module */
  graph: WorkspaceGraph | null = null;
  /** @internal — session-lifecycle module */
  server: PiHostServer | null = null;
  readonly deps: GraphFactoryDeps;
  readonly userResourceCache: UserResourceCache;
  onModelHealthChanged?: () => void;
  private readonly sessionRuntimeCache: SessionRuntimeCache;
  private readonly workspaceLifecycle: WorkspaceLifecycle;

  constructor(deps: GraphFactoryDeps) {
    this.userResourceCache = deps.userResourceCache ?? new UserResourceCache(deps.agentDir);
    this.deps = { ...deps, userResourceCache: this.userResourceCache };
    this.sessionRuntimeCache = new SessionRuntimeCache({
      getGraph: () => this.graph,
      getServer: () => this.server,
      sessionPathsEqual: (left, right) => this.sessionPathsEqual(left, right),
      onRetainedGraphBecameIdle: (graph) =>
        this.workspaceLifecycle.suspendIdleRetainedProviders(graph),
    });
    this.workspaceLifecycle = new WorkspaceLifecycle(
      {
        deps: this.deps,
        getGraph: () => this.graph,
        setGraph: (graph) => {
          this.graph = graph;
        },
        getServer: () => this.server,
        onModelHealthChanged: () => this.onModelHealthChanged?.(),
        getCommandContextActions: (session) => this.extensionCommandContextActions(session),
      },
      this.sessionRuntimeCache,
    );
  }

  /** ctx.newSession()/fork()/navigateTree()/switchSession()/reload() for one bound session. */
  extensionCommandContextActions(session: AgentSession): ExtensionCommandContextActions {
    return createExtensionCommandContextActions({ factory: this, session });
  }

  bindServer(server: PiHostServer): void {
    this.server = server;
  }

  getGraph(): WorkspaceGraph | null {
    return this.graph;
  }

  getServer(): PiHostServer | null {
    return this.server;
  }

  getSessionOperationLock(session: AgentSession): AgentOperationLock {
    return this.sessionRuntimeCache.getSessionOperationLock(session);
  }

  isSessionBusy(session: AgentSession): boolean {
    return this.sessionRuntimeCache.isSessionBusy(session);
  }

  beginQueueTransaction(session: AgentSession) {
    return this.sessionRuntimeCache.beginQueueTransaction(session);
  }

  finishQueueTransaction(session: AgentSession) {
    return this.sessionRuntimeCache.finishQueueTransaction(session);
  }

  syncQueueState(session: AgentSession, force = false) {
    return this.sessionRuntimeCache.syncQueueState(session, force);
  }

  setSessionRunId(session: AgentSession, runId: string): void {
    this.sessionRuntimeCache.setSessionRunId(session, runId);
  }

  clearSessionRunId(session: AgentSession): void {
    this.sessionRuntimeCache.clearSessionRunId(session);
  }

  hasBusySessions(): boolean {
    return this.sessionRuntimeCache.hasBusySessions();
  }

  hasBusyRetainedSessions(): boolean {
    return this.workspaceLifecycle.hasBusyRetainedSessions();
  }

  hasRunningSessions(): boolean {
    return this.sessionRuntimeCache.hasRunningSessions();
  }

  liveSessionCount(): number {
    return this.sessionRuntimeCache.liveSessionCount();
  }

  wouldExceedLiveSessionLimit(): boolean {
    return this.sessionRuntimeCache.wouldExceedLiveSessionLimit();
  }

  markTitleRefine(session: AgentSession, pending: boolean): void {
    this.sessionRuntimeCache.markTitleRefine(session, pending);
  }

  resolveSessionTarget(sessionId: unknown, sessionRevision: unknown): ResolvedSessionTarget | null {
    return this.sessionRuntimeCache.resolveSessionTarget(sessionId, sessionRevision);
  }

  findRuntimeForSession(session: AgentSession): ResolvedSessionTarget | null {
    return this.sessionRuntimeCache.findRuntimeForSession(session);
  }

  getSessionRuntimeInfo(
    sessionId: string,
    sessionPath: string,
  ): { runtimeState: SessionRuntimeState; sessionRevision: number } | null {
    return this.sessionRuntimeCache.getSessionRuntimeInfo(sessionId, sessionPath);
  }

  resolveSessionIdentity(sessionId: unknown, sessionRevision: unknown): HostIdentity | null {
    return this.sessionRuntimeCache.resolveSessionIdentity(sessionId, sessionRevision);
  }

  canonicalizeCwd(cwd: string): string {
    return this.workspaceLifecycle.canonicalizeCwd(cwd);
  }

  buildWorkspaceSnapshot(g: WorkspaceGraph): WorkspaceSnapshot {
    return this.workspaceLifecycle.buildWorkspaceSnapshot(g);
  }

  /**
   * Dispose agent session and optionally entire graph services.
   */
  async disposeAgentSession(g: WorkspaceGraph): Promise<void> {
    return this.sessionRuntimeCache.disposeAgentSession(g);
  }

  /**
   * Dispose a session instance without mutating graph slots (candidate discard/commit).
   * @internal — session-lifecycle module
   */
  async disposeAgentSessionOnly(session: AgentSession): Promise<void> {
    return this.sessionRuntimeCache.disposeAgentSessionOnly(session);
  }

  /** @internal — session-lifecycle module */
  retainBusySession(
    graph: WorkspaceGraph,
    previous: ActiveSessionState,
  ): BackgroundSessionRuntime | null {
    return this.sessionRuntimeCache.retainBusySession(graph, previous);
  }

  /** @internal - session lifecycle file mutations */
  async disposeBackgroundSessionRuntimeIfIdle(
    graph: WorkspaceGraph,
    sessionId: string,
    sessionPath: string,
  ): Promise<"none" | "busy" | "disposed"> {
    return this.sessionRuntimeCache.disposeBackgroundSessionRuntimeIfIdle(
      graph,
      sessionId,
      sessionPath,
    );
  }

  async disposeSettledBackgroundRuntime(
    graph: WorkspaceGraph,
    runtime: BackgroundSessionRuntime,
  ): Promise<void> {
    return this.sessionRuntimeCache.disposeSettledBackgroundRuntime(graph, runtime);
  }

  /** @internal — session-lifecycle module */
  announceRetainedRuntime(runtime: BackgroundSessionRuntime): void {
    this.sessionRuntimeCache.announceRetainedRuntime(runtime);
  }

  /** @internal — session-lifecycle module */
  async promoteBackgroundRuntime(
    graph: WorkspaceGraph,
    runtime: BackgroundSessionRuntime,
  ): Promise<SessionSnapshot | { error: HostError }> {
    return this.sessionRuntimeCache.promoteBackgroundRuntime(graph, runtime);
  }

  async disposeGraph(g: WorkspaceGraph): Promise<void> {
    return this.workspaceLifecycle.disposeGraph(g);
  }

  /** Dispose every idle Workspace graph retained by the lifecycle owner. */
  async disposeRetainedGraphs(): Promise<void> {
    return this.workspaceLifecycle.disposeRetainedGraphs();
  }

  /** Dispose the idle Workspace graph that shares a Session storage namespace. */
  async invalidateRetainedWorkspaceGraph(canonicalCwd: string): Promise<void> {
    return this.workspaceLifecycle.invalidateRetainedWorkspaceGraph(canonicalCwd);
  }

  /** Drop every idle runtime that may have captured old settings or resources. */
  async invalidateRetainedRuntimeCaches(): Promise<void> {
    return this.workspaceLifecycle.invalidateRetainedRuntimeCaches();
  }

  /** @internal — session-lifecycle module */
  async activateExtensionUi(g: WorkspaceGraph): Promise<() => void> {
    return activateOnce(g);
  }

  /** Atomic Workspace switch facade. */
  async setCurrent(
    cwd: string,
    requestId: string,
    bootstrap?: WorkspaceSessionBootstrap,
  ): Promise<
    | {
        workspace: WorkspaceSnapshot;
        session?: SessionSnapshot;
      }
    | { error: HostError }
  > {
    return this.workspaceLifecycle.setCurrent(cwd, requestId, bootstrap);
  }

  /** @internal — session-lifecycle module */
  handleAgentEvent(graph: WorkspaceGraph, sourceSession: AgentSession, event: unknown): void {
    this.sessionRuntimeCache.handleAgentEvent(graph, sourceSession, event);
  }

  async listSessions() {
    return listSessions(this);
  }

  async archiveSession(requestId: string, sessionId: string, sessionPath: string) {
    return archiveSession(this, requestId, sessionId, sessionPath);
  }

  async restoreSession(requestId: string, sessionId: string, sessionPath: string) {
    return restoreSession(this, requestId, sessionId, sessionPath);
  }

  async deleteSession(requestId: string, sessionId: string, sessionPath: string) {
    return deleteSession(this, requestId, sessionId, sessionPath);
  }

  async cleanupArchivedSessions(requestId: string) {
    return cleanupArchivedSessions(this, requestId);
  }

  async renameSession(requestId: string, sessionId: string, sessionPath: string, name: string) {
    return renameSession(this, requestId, sessionId, sessionPath, name);
  }

  setActiveSessionName(name: string) {
    return setActiveSessionName(this, name);
  }

  setSessionRuntimeName(session: AgentSession, name: string) {
    return setSessionRuntimeName(this, session, name);
  }

  async refineActiveSessionName(args: {
    session: AgentSession;
    sessionId: string;
    provisionalTitle: string;
    userPrompt: string;
  }) {
    return refineActiveSessionName(this, args);
  }

  /** @internal — session-lifecycle module */
  sessionPathsEqual(left: string | undefined, right: string): boolean {
    return sessionPathsEqual(left, right);
  }

  async createSession(requestId: string, name?: string) {
    return createSession(this, requestId, name);
  }

  async openSession(
    requestId: string,
    sessionPath: string,
    options: { forceReload?: boolean } = {},
  ) {
    return openSession(this, requestId, sessionPath, options);
  }

  async reloadSession(requestId: string) {
    return reloadSession(this, requestId);
  }

  checkIdentity(
    context: Record<string, unknown>,
    opts: {
      requireWorkspace?: boolean;
      requireSession?: boolean;
      allowNullSession?: boolean;
      requirePackage?: boolean;
      requireTool?: boolean;
    } = {},
  ): HostError | null {
    const server = this.server;
    if (!server) return createHostError("HOST_NOT_READY", "Host not ready");

    if (
      typeof context.expectedHostInstanceId === "string" &&
      context.expectedHostInstanceId !== server.identity.hostInstanceId
    ) {
      return createHostError("STALE_REVISION", "Host instance mismatch");
    }

    if (opts.requireWorkspace) {
      if (context.expectedWorkspaceId !== server.identity.workspaceId) {
        return createHostError("STALE_REVISION", "Workspace id mismatch");
      }
      if (context.expectedWorkspaceRevision !== server.identity.workspaceRevision) {
        return createHostError("STALE_REVISION", "Workspace revision mismatch");
      }
    }

    if (opts.requireSession || opts.allowNullSession) {
      if (context.expectedSessionId !== server.identity.sessionId) {
        return createHostError("STALE_REVISION", "Session id mismatch");
      }
      if (context.expectedSessionRevision !== server.identity.sessionRevision) {
        return createHostError("STALE_REVISION", "Session revision mismatch");
      }
    }

    if (opts.requirePackage) {
      if (context.expectedPackageRevision !== server.identity.packageRevision) {
        return createHostError("STALE_REVISION", "Package revision mismatch");
      }
    }

    if (opts.requireTool) {
      const g = this.graph;
      if (!g || context.expectedToolRevision !== g.toolRevision) {
        return createHostError("STALE_REVISION", "Tool revision mismatch");
      }
    }

    return null;
  }
}
