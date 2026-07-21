import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import {
  AgentSession,
  createAgentSession,
  DefaultPackageManager,
  DefaultResourceLoader,
  hasTrustRequiringProjectResources,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  createHostError,
  type HostError,
  type HostIdentity,
  type SessionSnapshot,
  type SessionRuntimeState,
  type ToolSnapshot,
  type TrustOption,
  type WorkspaceSnapshot,
  toJsonValue,
} from "@pideck/protocol";
import type { PiHostServer } from "./server.js";
import { logger } from "./logger.js";
import { buildSessionSnapshot, buildToolSnapshot } from "./session-snapshot.js";
import { buildPackageSnapshot } from "./package-snapshot.js";
import { bindExtensionUi } from "./extension-ui-bridge.js";
import { normalizeAgentEvent } from "./event-normalize.js";
import { toolResultNeedsToolsRefresh } from "./tools-refresh.js";
import { AgentOperationLock } from "./locks.js";
export * from "./workspace-graph-types.js";
import {
  TRUST_OPTIONS,
  type BackgroundSessionRuntime,
  type GraphFactoryDeps,
  type TrustDecisionUi,
  type WorkspaceGraph,
} from "./workspace-graph-types.js";
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
} from "./session-lifecycle.js";

export class WorkspaceGraphFactory {
  /** @internal — session-lifecycle module */
  graph: WorkspaceGraph | null = null;
  /** @internal — session-lifecycle module */
  server: PiHostServer | null = null;
  readonly deps: GraphFactoryDeps;
  onModelHealthChanged?: () => void;
  /** Active run id for agent events */
  currentRunId: string | null = null;
  private readonly runtimeStates = new WeakMap<AgentSession, SessionRuntimeState>();
  private readonly sessionOperationLocks = new WeakMap<AgentSession, AgentOperationLock>();
  private readonly runIds = new WeakMap<AgentSession, string>();

  constructor(deps: GraphFactoryDeps) {
    this.deps = deps;
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

  getTrustOptions(): TrustOption[] {
    return TRUST_OPTIONS;
  }

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
    const graph = this.graph;
    if (!graph) return false;
    if (graph.agentSession && !graph.agentSession.isIdle) return true;
    return graph.backgroundSessions.size > 0;
  }

  getSessionRuntimeInfo(
    sessionId: string,
    sessionPath: string,
  ): { runtimeState: SessionRuntimeState; sessionRevision: number } | null {
    const graph = this.graph;
    const server = this.server;
    if (!graph || !server) return null;
    if (
      graph.agentSession &&
      graph.sessionSnapshot &&
      (server.identity.sessionId === sessionId ||
        this.sessionPathsEqual(graph.sessionSnapshot.sessionPath, sessionPath))
    ) {
      return {
        runtimeState: this.runtimeStateForSession(graph.agentSession),
        sessionRevision: server.identity.sessionRevision,
      };
    }
    const background =
      graph.backgroundSessions.get(sessionId) ??
      [...graph.backgroundSessions.values()].find((runtime) =>
        this.sessionPathsEqual(runtime.sessionSnapshot.sessionPath, sessionPath),
      );
    return background
      ? {
          runtimeState: this.runtimeStateForSession(background.agentSession),
          sessionRevision: background.sessionRevision,
        }
      : null;
  }

  private runtimeStateForSession(session: AgentSession): SessionRuntimeState {
    if (!session.isIdle) return "running";
    if (
      session.getSteeringMessages().length > 0 ||
      session.getFollowUpMessages().length > 0
    ) {
      return "queued";
    }
    return "idle";
  }

  resolveSessionIdentity(
    sessionId: unknown,
    sessionRevision: unknown,
  ): HostIdentity | null {
    const server = this.server;
    const graph = this.graph;
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
    return {
      ...server.getIdentity(),
      sessionId,
      sessionRevision,
    };
  }

  canonicalizeCwd(cwd: string): string {
    const resolved = pathResolve(cwd);
    if (!existsSync(resolved)) {
      throw createHostError("WORKSPACE_SWITCH_FAILED", `Directory does not exist: ${resolved}`, {
        retryable: false,
        details: { cwd: resolved },
      });
    }
    try {
      return realpathSync(resolved);
    } catch {
      return resolved;
    }
  }

  buildWorkspaceSnapshot(g: WorkspaceGraph): WorkspaceSnapshot {
    return {
      id: g.workspaceId,
      cwd: g.cwd,
      canonicalCwd: g.canonicalCwd,
      revision: g.revision,
      trust: {
        required: g.trustDecision !== "notRequired",
        decision: g.trustDecision,
      },
      servicesReady: g.servicesReady,
    };
  }

  /**
   * Dispose agent session and optionally entire graph services.
   */
  async disposeAgentSession(g: WorkspaceGraph): Promise<void> {
    g.extensionUiActivate = null;
    g.extensionUiCleanup?.();
    g.extensionUiCleanup = null;
    g.extensionUiUpdateIdentity = null;
    g.unsubscribeAgent?.();
    g.unsubscribeAgent = null;
    if (g.agentSession) {
      await this.disposeAgentSessionOnly(g.agentSession);
      g.agentSession = null;
      g.sessionManager = null;
      g.sessionSnapshot = null;
    }
  }

  /**
   * Dispose a session instance without mutating graph slots (candidate discard/commit).
   * @internal — session-lifecycle module
   */
  async disposeAgentSessionOnly(session: {
    isIdle: boolean;
    abort: () => Promise<void> | void;
    dispose: () => void;
  }): Promise<void> {
    try {
      if (!session.isIdle) {
        await session.abort();
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

  /** @internal — session-lifecycle module */
  retainBusySession(
    graph: WorkspaceGraph,
    previous: {
      sessionId: string | null;
      sessionRevision: number;
      sessionManager: SessionManager | null;
      agentSession: AgentSession | null;
      resourceLoader: DefaultResourceLoader | null;
      extensionsResult: unknown;
      toolRevision: number;
      sessionSnapshot: SessionSnapshot | null;
      unsubscribeAgent: (() => void) | null;
      extensionUiActivate: (() => Promise<() => void>) | null;
      extensionUiCleanup: (() => void) | null;
      extensionUiUpdateIdentity: ((identity: HostIdentity) => void) | null;
    },
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

  /** @internal - session lifecycle file mutations */
  async disposeBackgroundSessionRuntimeIfIdle(
    graph: WorkspaceGraph,
    sessionId: string,
    sessionPath: string,
  ): Promise<"none" | "busy" | "disposed"> {
    const runtime = [...graph.backgroundSessions.values()].find(
      (candidate) =>
        candidate.sessionId === sessionId &&
        this.sessionPathsEqual(candidate.sessionSnapshot.sessionPath, sessionPath),
    );
    if (!runtime) return "none";
    if (
      !runtime.agentSession.isIdle ||
      this.getSessionOperationLock(runtime.agentSession).isHeld()
    ) {
      return "busy";
    }
    await this.disposeBackgroundRuntime(graph, runtime);
    return "disposed";
  }

  /** @internal — session-lifecycle module */
  announceRetainedRuntime(runtime: BackgroundSessionRuntime): void {
    const server = this.server;
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

  /** @internal — session-lifecycle module */
  async promoteBackgroundRuntime(
    graph: WorkspaceGraph,
    runtime: BackgroundSessionRuntime,
  ): Promise<SessionSnapshot | { error: HostError }> {
    const server = this.server;
    if (!server || graph.backgroundSessions.get(runtime.sessionId) !== runtime) {
      return {
        error: createHostError("SESSION_NOT_FOUND", "Background Session is no longer available"),
      };
    }

    const previous = {
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
      sessionId: server.identity.sessionId,
      sessionRevision: server.identity.sessionRevision,
    };
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

    graph.sessionManager = runtime.sessionManager;
    graph.agentSession = runtime.agentSession;
    graph.extensionsResult = runtime.extensionsResult;
    graph.resourceLoader = runtime.resourceLoader;
    graph.toolRevision = runtime.toolRevision;
    graph.sessionSnapshot = snapshot;
    graph.extensionUiActivate = runtime.extensionUiActivate;
    graph.extensionUiCleanup = runtime.extensionUiCleanup;
    graph.extensionUiUpdateIdentity = runtime.extensionUiUpdateIdentity;
    graph.unsubscribeAgent = runtime.unsubscribeAgent;
    server.identity.sessionId = runtime.sessionId;
    server.identity.sessionRevision = sessionRevision;

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
      state: runtime.agentSession.isIdle ? "idle" : "running",
      updatedAt: Date.now(),
    });
    return snapshot;
  }

  async disposeGraph(g: WorkspaceGraph): Promise<void> {
    await this.disposeAgentSession(g);
    for (const runtime of [...g.backgroundSessions.values()]) {
      await this.disposeBackgroundRuntime(g, runtime);
    }
    g.settingsManager = null;
    g.packageManager = null;
    g.resourceLoader = null;
    g.extensionsResult = null;
    g.packageSnapshot = null;
    g.resourceIdMap.clear();
    g.servicesReady = false;
  }

  /**
   * Workspace graphs are expensive to build (settings, packages, resource
   * reload, agent session, extension bind), so switching away parks the idle
   * graph here instead of disposing it; switching back reactivates it in
   * milliseconds. Keyed by case-folded canonical cwd, LRU-bounded.
   */
  private retainedGraphs = new Map<string, WorkspaceGraph>();
  private static readonly MAX_RETAINED_GRAPHS = 3;

  private retainedGraphKey(canonicalCwd: string): string {
    return canonicalCwd.toLocaleLowerCase();
  }

  /**
   * Quiesce an idle graph and park it for instant reactivation. Retained
   * graphs must not emit anything: emitForIdentity throws for a non-current
   * workspace identity, so agent subscription and Extension UI are unbound
   * here and re-bound on reactivation. Graphs that cannot be safely retained
   * (not ready, busy, or with background runtimes) are disposed instead.
   */
  private async retainGraph(g: WorkspaceGraph): Promise<void> {
    if (
      !g.servicesReady ||
      !g.agentSession ||
      !g.agentSession.isIdle ||
      g.backgroundSessions.size > 0
    ) {
      await this.disposeGraph(g);
      return;
    }
    g.unsubscribeAgent?.();
    g.unsubscribeAgent = null;
    g.extensionUiActivate = null;
    try {
      g.extensionUiCleanup?.();
    } catch {
      /* ignore */
    }
    g.extensionUiCleanup = null;
    g.extensionUiUpdateIdentity = null;

    const key = this.retainedGraphKey(g.canonicalCwd);
    const existing = this.retainedGraphs.get(key);
    this.retainedGraphs.delete(key);
    if (existing && existing !== g) {
      await this.disposeGraph(existing);
    }
    this.retainedGraphs.set(key, g);
    while (this.retainedGraphs.size > WorkspaceGraphFactory.MAX_RETAINED_GRAPHS) {
      const oldestKey = this.retainedGraphs.keys().next().value;
      if (oldestKey === undefined) break;
      const evicted = this.retainedGraphs.get(oldestKey);
      this.retainedGraphs.delete(oldestKey);
      if (evicted) await this.disposeGraph(evicted);
    }
  }

  private takeRetainedGraph(canonicalCwd: string): WorkspaceGraph | null {
    const key = this.retainedGraphKey(canonicalCwd);
    const g = this.retainedGraphs.get(key) ?? null;
    this.retainedGraphs.delete(key);
    return g;
  }

  async disposeRetainedGraphs(): Promise<void> {
    const graphs = [...this.retainedGraphs.values()];
    this.retainedGraphs.clear();
    for (const g of graphs) {
      await this.disposeGraph(g);
    }
  }

  /**
   * Fast workspace switch: reactivate a retained graph under the caller's
   * already-held serviceGraphLock. Returns null when no retained graph is
   * usable (caller falls through to the full rebuild). Mirrors the commit
   * tail of setCurrentWorkspace: rebind Extension UI against the candidate
   * identity, commit identity, rebuild snapshots with the new revisions,
   * then emit the authoritative snapshots.
   */
  private async tryReactivateRetainedGraph(args: {
    canonical: string;
    requiresTrust: boolean;
    stored: boolean | null | undefined;
    previousGraph: WorkspaceGraph | null;
    revision: number;
    sessionRevision: number;
    packageRevision: number;
  }): Promise<
    | { workspace: WorkspaceSnapshot; session?: SessionSnapshot }
    | null
  > {
    const server = this.server;
    if (!server) return null;
    const g = this.takeRetainedGraph(args.canonical);
    if (!g) return null;

    // Re-evaluate trust against the store; a retained trust-once ("session")
    // grant remains valid for this host instance. Anything else mismatched
    // (revoked, denied, not ready) discards the retained graph.
    let trustDecision: TrustDecisionUi | null = null;
    if (g.servicesReady && g.agentSession && args.stored !== false) {
      if (!args.requiresTrust) trustDecision = "notRequired";
      else if (args.stored === true) trustDecision = "trusted";
      else if (g.trustDecision === "session" && g.projectTrusted) trustDecision = "session";
    }
    if (!trustDecision) {
      await this.disposeGraph(g);
      return null;
    }

    const session = g.agentSession;
    const sessionManager = g.sessionManager;
    if (!session || !sessionManager) {
      await this.disposeGraph(g);
      return null;
    }
    const sessionId =
      g.sessionSnapshot?.sessionId || sessionManager.getSessionId() || session.sessionId;
    if (!sessionId) {
      await this.disposeGraph(g);
      return null;
    }

    const candidateIdentity: HostIdentity = {
      hostInstanceId: server.identity.hostInstanceId,
      workspaceId: g.workspaceId,
      workspaceRevision: args.revision,
      sessionId,
      sessionRevision: args.sessionRevision,
      packageRevision: args.packageRevision,
    };

    try {
      const binding = await bindExtensionUi(session, g.extensionsResult, {
        emit: (event, payload) => server.emitForIdentity(candidateIdentity, event, payload),
        emitForIdentity: (identity, event, payload) =>
          server.emitForIdentity(identity, event, payload),
        getIdentity: () => candidateIdentity,
      });
      g.extensionUiActivate = binding.activate;
      g.extensionUiCleanup = binding.cleanup;
      g.extensionUiUpdateIdentity = binding.updateIdentity;
    } catch (err) {
      logger.warn("retained graph Extension rebind failed; rebuilding workspace", {
        cwd: args.canonical,
        error: err instanceof Error ? err.message : String(err),
      });
      await this.disposeGraph(g);
      return null;
    }

    g.unsubscribeAgent = session.subscribe((event) => {
      this.handleAgentEvent(g, session, event);
    });

    // Commit: park the outgoing graph, promote the retained one.
    if (args.previousGraph) {
      await this.retainGraph(args.previousGraph);
    }
    g.revision = args.revision;
    g.trustDecision = trustDecision;
    g.projectTrusted = true;
    this.graph = g;
    server.identity.workspaceId = g.workspaceId;
    server.identity.workspaceRevision = args.revision;
    server.identity.sessionId = sessionId;
    server.identity.sessionRevision = args.sessionRevision;
    server.identity.packageRevision = args.packageRevision;

    g.packageSnapshot = await buildPackageSnapshot({
      revision: args.packageRevision,
      workspaceId: g.workspaceId,
      scope: "all",
      packageManager: g.packageManager!,
      settingsManager: g.settingsManager!,
      packageUpdateCheck: this.deps.packageUpdateCheck,
      resourceIdMap: g.resourceIdMap,
      resourceReloadRequired: g.resourceReloadRequired,
    });
    g.sessionSnapshot = buildSessionSnapshot({
      session,
      sessionManager,
      cwd: args.canonical,
      sessionId,
      revision: args.sessionRevision,
      workspaceId: g.workspaceId,
      toolRevision: g.toolRevision,
    });

    let publishExtensionUi = () => {};
    try {
      publishExtensionUi = await this.activateExtensionUi(g);
    } catch (err) {
      logger.warn("retained graph Extension activate failed", {
        cwd: args.canonical,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    server.setPhase("ready");
    server.setLastError(undefined);
    const workspace = this.buildWorkspaceSnapshot(g);
    workspace.trust.required = args.requiresTrust;

    server.emit("workspace.changed", workspace);
    if (g.packageSnapshot) {
      server.emit("package.snapshot", g.packageSnapshot);
    }
    if (g.sessionSnapshot) {
      server.emit("session.snapshot", g.sessionSnapshot);
      server.emit("agent.toolsChanged", g.sessionSnapshot.tools);
    }
    publishExtensionUi();

    return {
      workspace,
      ...(g.sessionSnapshot ? { session: g.sessionSnapshot } : {}),
    };
  }

  /** @internal — session-lifecycle module */
  async activateExtensionUi(g: WorkspaceGraph): Promise<() => void> {
    const activate = g.extensionUiActivate;
    g.extensionUiActivate = null;
    if (!activate) return () => {};
    try {
      return await activate();
    } catch (err) {
      try {
        g.extensionUiCleanup?.();
      } finally {
        g.extensionUiCleanup = null;
        g.extensionUiUpdateIdentity = null;
      }
      throw err;
    }
  }

  private async commitWorkspaceFailure(args: {
    previousGraph: WorkspaceGraph | null;
    workspaceId: string;
    cwd: string;
    canonicalCwd: string;
    revision: number;
    trustDecision: TrustDecisionUi;
    projectTrusted: boolean;
    sessionRevision: number;
    packageRevision: number;
    error: HostError;
  }): Promise<WorkspaceSnapshot> {
    const server = this.server!;
    if (args.previousGraph) {
      await this.retainGraph(args.previousGraph);
    }
    const failedGraph: WorkspaceGraph = {
      workspaceId: args.workspaceId,
      cwd: args.cwd,
      canonicalCwd: args.canonicalCwd,
      revision: args.revision,
      trustDecision: args.trustDecision,
      projectTrusted: args.projectTrusted,
      servicesReady: false,
      settingsManager: null,
      packageManager: null,
      resourceLoader: null,
      sessionManager: null,
      agentSession: null,
      extensionsResult: null,
      packageSnapshot: null,
      sessionSnapshot: null,
      toolRevision: 0,
      resourceIdMap: new Map(),
      unsubscribeAgent: null,
      extensionUiActivate: null,
      extensionUiCleanup: null,
      extensionUiUpdateIdentity: null,
      resourceReloadRequired: false,
      backgroundSessions: new Map(),
    };
    this.graph = failedGraph;
    server.identity.workspaceId = args.workspaceId;
    server.identity.workspaceRevision = args.revision;
    server.identity.sessionId = null;
    server.identity.sessionRevision = args.sessionRevision;
    server.identity.packageRevision = args.packageRevision;
    server.setLastError(args.error);
    server.setPhase("workspaceError");
    const workspace = this.buildWorkspaceSnapshot(failedGraph);
    server.emit("workspace.changed", workspace);
    return workspace;
  }

  /**
   * Atomic workspace.setCurrent — PROJECT_SPEC §8.3
   */
  async setCurrent(
    cwd: string,
    requestId: string,
  ): Promise<
    | {
        workspace: WorkspaceSnapshot;
        session?: SessionSnapshot;
        trustOptions?: TrustOption[];
      }
    | { error: HostError }
  > {
    const server = this.server;
    if (!server) {
      return { error: createHostError("HOST_NOT_READY", "Server not bound") };
    }

    if (!server.serviceGraphLock.tryAcquire({ operationKind: "workspace.setCurrent", requestId })) {
      return {
        error: createHostError("SERVICE_GRAPH_BUSY", "Service graph is busy", {
          retryable: true,
          details: {
            operationKind: server.serviceGraphLock.getOwner()?.operationKind ?? null,
          },
        }),
      };
    }

    try {
      if (this.hasBusySessions()) {
        return { error: createHostError("AGENT_BUSY", "Agent is busy; stop it before switching workspace", { retryable: true }) };
      }

      let canonical: string;
      try {
        canonical = this.canonicalizeCwd(cwd);
      } catch (err) {
        const he = err as HostError;
        if (he && typeof he === "object" && "code" in he) {
          return { error: he };
        }
        return {
          error: createHostError("WORKSPACE_SWITCH_FAILED", String(err)),
        };
      }

      const previousGraph = this.graph;
      const workspaceId = randomUUID();
      const revision = server.identity.workspaceRevision + 1;
      const invalidatedSessionRevision =
        server.identity.sessionRevision + (previousGraph?.agentSession ? 1 : 0);
      const candidateSessionRevision = invalidatedSessionRevision + 1;
      const candidatePackageRevision = server.identity.packageRevision + 1;

      const requiresTrust = hasTrustRequiringProjectResources(canonical);
      const stored = this.deps.trustStore.get(canonical);

      // Fast path: a graph retained from an earlier visit reactivates in
      // milliseconds instead of a full rebuild. Trust is re-evaluated against
      // the store; a retained "session" (trust-once) grant stays valid for
      // the lifetime of this host instance.
      const reactivated = await this.tryReactivateRetainedGraph({
        canonical,
        requiresTrust,
        stored,
        previousGraph,
        revision,
        sessionRevision: candidateSessionRevision,
        packageRevision: candidatePackageRevision,
      });
      if (reactivated) return reactivated;

      let trustDecision: TrustDecisionUi;
      let projectTrusted: boolean;

      if (!requiresTrust) {
        trustDecision = "notRequired";
        projectTrusted = true;
      } else if (stored === true) {
        trustDecision = "trusted";
        projectTrusted = true;
      } else if (stored === false) {
        trustDecision = "denied";
        projectTrusted = false;
      } else {
        // Pending trust is a complete no-services candidate and still commits atomically.
        const candidateGraph: WorkspaceGraph = {
          workspaceId,
          cwd,
          canonicalCwd: canonical,
          revision,
          trustDecision: "pending",
          projectTrusted: false,
          servicesReady: false,
          settingsManager: null,
          packageManager: null,
          resourceLoader: null,
          sessionManager: null,
          agentSession: null,
          extensionsResult: null,
          packageSnapshot: null,
          sessionSnapshot: null,
          toolRevision: 0,
          resourceIdMap: new Map(),
          unsubscribeAgent: null,
          extensionUiActivate: null,
          extensionUiCleanup: null,
          extensionUiUpdateIdentity: null,
          resourceReloadRequired: false,
          backgroundSessions: new Map(),
        };
        if (previousGraph) {
          await this.retainGraph(previousGraph);
        }
        this.graph = candidateGraph;
        server.identity.workspaceId = workspaceId;
        server.identity.workspaceRevision = revision;
        server.identity.sessionId = null;
        server.identity.sessionRevision = invalidatedSessionRevision;
        server.setPhase("trustRequired");
        server.setLastError(undefined);
        const snap = this.buildWorkspaceSnapshot(candidateGraph);
        snap.trust.required = true;
        server.emit("workspace.trustRequired", {
          workspace: snap,
          options: TRUST_OPTIONS,
        });
        server.emit("workspace.changed", snap);
        return { workspace: snap, trustOptions: TRUST_OPTIONS };
      }

      const built = await this.buildServices({
        workspaceId,
        cwd,
        canonicalCwd: canonical,
        revision,
        trustDecision,
        projectTrusted,
        sessionRevision: candidateSessionRevision,
        packageRevision: candidatePackageRevision,
      });

      if ("error" in built) {
        await this.commitWorkspaceFailure({
          previousGraph,
          workspaceId,
          cwd,
          canonicalCwd: canonical,
          revision,
          trustDecision,
          projectTrusted,
          sessionRevision: invalidatedSessionRevision,
          packageRevision: candidatePackageRevision,
          error: built.error,
        });
        return { error: built.error };
      }

      if (previousGraph) {
        await this.retainGraph(previousGraph);
      }
      this.graph = built.graph;
      server.identity.workspaceId = workspaceId;
      server.identity.workspaceRevision = revision;
      server.identity.sessionId = built.graph.sessionSnapshot?.sessionId ?? null;
      server.identity.sessionRevision = candidateSessionRevision;
      server.identity.packageRevision = candidatePackageRevision;

      let publishExtensionUi = () => {};
      try {
        publishExtensionUi = await this.activateExtensionUi(this.graph);
      } catch (err) {
        const error = createHostError(
          "WORKSPACE_SWITCH_FAILED",
          err instanceof Error ? err.message : "Extension bind failed",
        );
        await this.disposeGraph(this.graph);
        await this.commitWorkspaceFailure({
          previousGraph: null,
          workspaceId,
          cwd,
          canonicalCwd: canonical,
          revision,
          trustDecision,
          projectTrusted,
          sessionRevision: invalidatedSessionRevision,
          packageRevision: candidatePackageRevision,
          error,
        });
        return { error };
      }

      server.setPhase("ready");
      server.setLastError(undefined);
      const workspace = this.buildWorkspaceSnapshot(built.graph);
      workspace.trust.required = requiresTrust;

      server.emit("workspace.changed", workspace);
      if (this.graph.packageSnapshot) {
        server.emit("package.snapshot", this.graph.packageSnapshot);
      }
      if (this.graph.sessionSnapshot) {
        server.emit("session.snapshot", this.graph.sessionSnapshot);
        server.emit("agent.toolsChanged", this.graph.sessionSnapshot.tools);
      }
      publishExtensionUi();

      return {
        workspace,
        ...(this.graph.sessionSnapshot ? { session: this.graph.sessionSnapshot } : {}),
      };
    } finally {
      server.serviceGraphLock.release(requestId);
    }
  }

  async setTrust(
    decision: "trustOnce" | "trust" | "deny",
    requestId: string,
  ): Promise<
    | { workspace: WorkspaceSnapshot; session?: SessionSnapshot }
    | { error: HostError }
  > {
    const server = this.server;
    if (!server || !this.graph) {
      return { error: createHostError("PROJECT_NOT_SELECTED", "No workspace selected") };
    }

    if (!server.serviceGraphLock.tryAcquire({ operationKind: "workspace.setTrust", requestId })) {
      return {
        error: createHostError("SERVICE_GRAPH_BUSY", "Service graph is busy", {
          retryable: true,
          details: {
            operationKind: server.serviceGraphLock.getOwner()?.operationKind ?? null,
          },
        }),
      };
    }

    try {
      if (this.hasBusySessions()) {
        return { error: createHostError("AGENT_BUSY", "Agent is busy", { retryable: true }) };
      }

      const g = this.graph;
      const canonical = g.canonicalCwd;

      let trustDecision: TrustDecisionUi;
      let projectTrusted: boolean;

      if (decision === "trustOnce") {
        trustDecision = "session";
        projectTrusted = true;
      } else if (decision === "trust") {
        trustDecision = "trusted";
        projectTrusted = true;
      } else {
        trustDecision = "denied";
        projectTrusted = false;
      }

      const revision = server.identity.workspaceRevision + 1;
      const invalidatedSessionRevision =
        server.identity.sessionRevision + (g.agentSession ? 1 : 0);
      const candidateSessionRevision = invalidatedSessionRevision + 1;
      const candidatePackageRevision = server.identity.packageRevision + 1;
      const built = await this.buildServices({
        workspaceId: g.workspaceId,
        cwd: g.cwd,
        canonicalCwd: canonical,
        revision,
        trustDecision,
        projectTrusted,
        sessionRevision: candidateSessionRevision,
        packageRevision: candidatePackageRevision,
      });

      if ("error" in built) {
        await this.commitWorkspaceFailure({
          previousGraph: g,
          workspaceId: g.workspaceId,
          cwd: g.cwd,
          canonicalCwd: canonical,
          revision,
          trustDecision,
          projectTrusted,
          sessionRevision: invalidatedSessionRevision,
          packageRevision: candidatePackageRevision,
          error: built.error,
        });
        return { error: built.error };
      }

      try {
        if (decision === "trust") {
          this.deps.trustStore.set(canonical, true);
        } else if (decision === "deny") {
          this.deps.trustStore.set(canonical, false);
        }
      } catch (err) {
        await this.disposeGraph(built.graph);
        const error = createHostError(
          "WORKSPACE_SWITCH_FAILED",
          err instanceof Error ? err.message : "Failed to persist trust decision",
        );
        await this.commitWorkspaceFailure({
          previousGraph: g,
          workspaceId: g.workspaceId,
          cwd: g.cwd,
          canonicalCwd: canonical,
          revision,
          trustDecision,
          projectTrusted,
          sessionRevision: invalidatedSessionRevision,
          packageRevision: candidatePackageRevision,
          error,
        });
        return { error };
      }

      await this.disposeGraph(g);
      this.graph = built.graph;
      server.identity.workspaceId = g.workspaceId;
      server.identity.workspaceRevision = revision;
      server.identity.sessionId = built.graph.sessionSnapshot?.sessionId ?? null;
      server.identity.sessionRevision = candidateSessionRevision;
      server.identity.packageRevision = candidatePackageRevision;

      let publishExtensionUi = () => {};
      try {
        publishExtensionUi = await this.activateExtensionUi(this.graph);
      } catch (err) {
        const error = createHostError(
          "WORKSPACE_SWITCH_FAILED",
          err instanceof Error ? err.message : "Extension bind failed",
        );
        await this.disposeGraph(this.graph);
        await this.commitWorkspaceFailure({
          previousGraph: null,
          workspaceId: g.workspaceId,
          cwd: g.cwd,
          canonicalCwd: canonical,
          revision,
          trustDecision,
          projectTrusted,
          sessionRevision: invalidatedSessionRevision,
          packageRevision: candidatePackageRevision,
          error,
        });
        return { error };
      }

      server.setPhase("ready");
      server.setLastError(undefined);

      const workspace = this.buildWorkspaceSnapshot(this.graph);
      workspace.trust.required = true;

      server.emit("workspace.changed", workspace);
      if (this.graph.packageSnapshot) {
        server.emit("package.snapshot", this.graph.packageSnapshot);
      }
      if (this.graph.sessionSnapshot) {
        server.emit("session.snapshot", this.graph.sessionSnapshot);
        server.emit("agent.toolsChanged", this.graph.sessionSnapshot.tools);
      }
      publishExtensionUi();

      return {
        workspace,
        ...(this.graph.sessionSnapshot ? { session: this.graph.sessionSnapshot } : {}),
      };
    } finally {
      server.serviceGraphLock.release(requestId);
    }
  }

  private async buildServices(args: {
    workspaceId: string;
    cwd: string;
    canonicalCwd: string;
    revision: number;
    trustDecision: TrustDecisionUi;
    projectTrusted: boolean;
    sessionRevision: number;
    packageRevision: number;
  }): Promise<{ graph: WorkspaceGraph } | { error: HostError }> {
    const server = this.server!;
    const { agentDir, authStorage, modelRegistry } = this.deps;
    let candidateSession: AgentSession | null = null;
    let candidateExtensionUiCleanup: (() => void) | null = null;
    let candidateUnsubscribeAgent: (() => void) | null = null;
    const buildStartedAt = Date.now();
    const stepTimings: Record<string, number> = {};
    let lastStepAt = buildStartedAt;
    const markStep = (name: string) => {
      const now = Date.now();
      stepTimings[name] = now - lastStepAt;
      lastStepAt = now;
    };

    try {
      // Explicit projectTrusted — never rely on SDK default true
      const settingsManager = SettingsManager.create(args.canonicalCwd, agentDir, {
        projectTrusted: args.projectTrusted,
      });

      const packageManager = new DefaultPackageManager({
        cwd: args.canonicalCwd,
        agentDir,
        settingsManager,
      });

      const resourceLoader = new DefaultResourceLoader({
        cwd: args.canonicalCwd,
        agentDir,
        settingsManager,
      });
      await resourceLoader.reload();
      markStep("resourceLoader.reload");

      // Create a new session for this workspace
      const sessionManager = SessionManager.create(args.canonicalCwd);

      await Promise.resolve(this.deps.refreshModelHealth());
      this.onModelHealthChanged?.();
      markStep("refreshModelHealth");

      const { session, extensionsResult } = await createAgentSession({
        cwd: args.canonicalCwd,
        agentDir,
        authStorage,
        modelRegistry,
        settingsManager,
        resourceLoader,
        sessionManager,
      });
      candidateSession = session;
      markStep("createAgentSession");

      const sessionId = sessionManager.getSessionId() || session.sessionId || randomUUID();

      const graph: WorkspaceGraph = {
        workspaceId: args.workspaceId,
        cwd: args.cwd,
        canonicalCwd: args.canonicalCwd,
        revision: args.revision,
        trustDecision: args.trustDecision,
        projectTrusted: args.projectTrusted,
        servicesReady: true,
        settingsManager,
        packageManager,
        resourceLoader,
        sessionManager,
        agentSession: session,
        extensionsResult,
        packageSnapshot: null,
        sessionSnapshot: null,
        toolRevision: 1,
        resourceIdMap: new Map(),
        unsubscribeAgent: null,
        extensionUiActivate: null,
        extensionUiCleanup: null,
        extensionUiUpdateIdentity: null,
        resourceReloadRequired: false,
        backgroundSessions: new Map(),
      };

      // Bind against the candidate generation, but defer session_start UI until commit.
      const candidateIdentity: HostIdentity = {
        hostInstanceId: server.identity.hostInstanceId,
        workspaceId: args.workspaceId,
        workspaceRevision: args.revision,
        sessionId,
        sessionRevision: args.sessionRevision,
        packageRevision: args.packageRevision,
      };
      const extensionUiBinding = await bindExtensionUi(session, extensionsResult, {
        emit: (event, payload) => server.emitForIdentity(candidateIdentity, event, payload),
        emitForIdentity: (identity, event, payload) =>
          server.emitForIdentity(identity, event, payload),
        getIdentity: () => candidateIdentity,
      });
      graph.extensionUiActivate = extensionUiBinding.activate;
      graph.extensionUiCleanup = extensionUiBinding.cleanup;
      graph.extensionUiUpdateIdentity = extensionUiBinding.updateIdentity;
      candidateExtensionUiCleanup = extensionUiBinding.cleanup;

      // Candidate subscriptions are inert until this graph becomes authoritative.
      graph.unsubscribeAgent = session.subscribe((event) => {
        this.handleAgentEvent(graph, session, event);
      });
      candidateUnsubscribeAgent = graph.unsubscribeAgent;
      markStep("bindExtensionUi");

      graph.packageSnapshot = await buildPackageSnapshot({
        revision: args.packageRevision,
        workspaceId: args.workspaceId,
        scope: "all",
        packageManager,
        settingsManager,
        packageUpdateCheck: this.deps.packageUpdateCheck,
        resourceIdMap: graph.resourceIdMap,
        resourceReloadRequired: graph.resourceReloadRequired,
      });
      markStep("buildPackageSnapshot");

      graph.sessionSnapshot = buildSessionSnapshot({
        session,
        sessionManager,
        cwd: args.canonicalCwd,
        sessionId,
        revision: args.sessionRevision,
        workspaceId: args.workspaceId,
        toolRevision: 1,
      });
      graph.toolRevision = 1;

      logger.info("workspace graph built", {
        cwd: args.canonicalCwd,
        totalMs: Date.now() - buildStartedAt,
        stepsMs: stepTimings,
      });

      return { graph };
    } catch (err) {
      try {
        candidateUnsubscribeAgent?.();
      } catch {
        /* ignore candidate subscription cleanup failure */
      }
      try {
        candidateExtensionUiCleanup?.();
      } catch {
        /* ignore candidate UI cleanup failure */
      }
      if (candidateSession) {
        await this.disposeAgentSessionOnly(candidateSession);
      }
      logger.error("buildServices failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        error: createHostError(
          "WORKSPACE_SWITCH_FAILED",
          err instanceof Error ? err.message : "Failed to build workspace services",
          { details: toJsonValue({ stack: err instanceof Error ? err.stack : undefined }) },
        ),
      };
    }
  }

  /** @internal — session-lifecycle module */
  handleAgentEvent(
    graph: WorkspaceGraph,
    sourceSession: AgentSession,
    event: unknown,
  ): void {
    const server = this.server;
    if (!server || this.graph !== graph) return;

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
    if (
      eventType === "session_info_changed" &&
      sourceSession
    ) {
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
      if (active) {
        server.emitForIdentity(eventIdentity, "session.snapshot", nextSnapshot);
      }
      return;
    }

    const runId = this.runIds.get(sourceSession) ?? this.currentRunId ?? randomUUID();
    const serialized = normalizeAgentEvent(event);
    if (active) {
      server.emitForIdentity(eventIdentity, "agent.event", { runId, event: serialized });
    }
    this.publishRuntimeState(sourceSession, eventIdentity, eventType, serialized);

    // Detect addedToolNames on tool results → full ToolSnapshot (PROJECT_SPEC §8.4)
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

    // Update idle/streaming flags on session snapshot cache
    const snapshot = active ? graph.sessionSnapshot : background?.sessionSnapshot;
    if (snapshot) {
      snapshot.isIdle = sourceSession.isIdle;
      snapshot.isStreaming = !sourceSession.isIdle;
      if (eventType === "agent_end" || eventType === "agent_settled") {
        if (!this.hasBusySessions()) server.setPhase("ready");
        const settledSnapshot = buildSessionSnapshot({
          session: sourceSession,
          sessionManager,
          cwd: graph.canonicalCwd,
          sessionId: eventIdentity.sessionId ?? "",
          revision: eventIdentity.sessionRevision,
          workspaceId: graph.workspaceId,
          toolRevision: active ? graph.toolRevision : background!.toolRevision,
        });
        if (active) {
          graph.sessionSnapshot = settledSnapshot;
          server.emitForIdentity(eventIdentity, "session.snapshot", settledSnapshot);
        } else if (background) {
          background.sessionSnapshot = settledSnapshot;
          setTimeout(() => {
            void this.disposeBackgroundRuntime(graph, background);
          }, 0);
        }
      }
    }
  }

  private publishRuntimeState(
    session: AgentSession,
    identity: HostIdentity,
    eventType: string,
    serializedEvent: Record<string, unknown>,
  ): void {
    const server = this.server;
    if (!server || !identity.sessionId) return;

    const state: SessionRuntimeState =
      eventType === "error"
        ? "error"
        : this.runtimeStateForSession(session);
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

  async listSessions() {
    return listSessions(this);
  }

  async archiveSession(
    requestId: string,
    sessionId: string,
    sessionPath: string,
  ) {
    return archiveSession(this, requestId, sessionId, sessionPath);
  }

  async restoreSession(
    requestId: string,
    sessionId: string,
    sessionPath: string,
  ) {
    return restoreSession(this, requestId, sessionId, sessionPath);
  }

  async deleteSession(
    requestId: string,
    sessionId: string,
    sessionPath: string,
  ) {
    return deleteSession(this, requestId, sessionId, sessionPath);
  }

  async cleanupArchivedSessions(requestId: string) {
    return cleanupArchivedSessions(this, requestId);
  }

  async renameSession(
    requestId: string,
    sessionId: string,
    sessionPath: string,
    name: string,
  ) {
    return renameSession(this, requestId, sessionId, sessionPath, name);
  }

  setActiveSessionName(name: string) {
    return setActiveSessionName(this, name);
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
    if (!left) return false;
    const resolvedLeft = pathResolve(left);
    const resolvedRight = pathResolve(right);
    return process.platform === "win32"
      ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
      : resolvedLeft === resolvedRight;
  }

  async createSession(
    requestId: string,
    name?: string,
  ) {
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
