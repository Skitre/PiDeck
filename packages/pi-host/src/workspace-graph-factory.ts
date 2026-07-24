import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve as pathResolve } from "node:path";
import {
  AgentSession,
  createAgentSession,
  DefaultPackageManager,
  DefaultResourceLoader,
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
  type BackgroundSessionRuntime,
  type GraphFactoryDeps,
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
      servicesReady: g.servicesReady,
    };
  }

  /**
   * Dispose agent session and optionally entire graph services.
   */
  async disposeAgentSession(g: WorkspaceGraph): Promise<void> {
    g.extensionUiActivate = null;
    try {
      g.extensionUiCleanup?.();
    } catch {
      /* ignore Extension UI cleanup failure during disposal */
    }
    g.extensionUiCleanup = null;
    g.extensionUiUpdateIdentity = null;
    try {
      g.unsubscribeAgent?.();
    } catch {
      /* ignore subscription cleanup failure during disposal */
    }
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

  private static readonly MAX_RETAINED_SESSIONS = 3;

  private retainedSessionRuntimes(
    graph: WorkspaceGraph,
  ): Map<string, BackgroundSessionRuntime> {
    return graph.retainedSessions ?? (graph.retainedSessions = new Map());
  }

  /** Park an idle runtime after the replacement Session has activated. */
  async retainIdleSession(
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
  ): Promise<BackgroundSessionRuntime | null> {
    if (
      !previous.sessionId ||
      !previous.sessionManager ||
      !previous.agentSession ||
      !previous.resourceLoader ||
      !previous.sessionSnapshot ||
      !previous.sessionSnapshot.sessionPath ||
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

    while (retainedSessions.size > WorkspaceGraphFactory.MAX_RETAINED_SESSIONS) {
      const oldestId = retainedSessions.keys().next().value;
      if (oldestId === undefined) break;
      const evicted = retainedSessions.get(oldestId);
      retainedSessions.delete(oldestId);
      if (evicted) await this.disposeRetainedSessionRuntime(graph, evicted, false);
    }
    return runtime;
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
        this.sessionPathsEqual(candidate.sessionSnapshot.sessionPath, sessionPath),
    );
    if (!runtime) return false;
    await this.disposeRetainedSessionRuntime(graph, runtime);
    return true;
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

  /** Reactivate an idle runtime retained from an earlier Session visit. */
  async promoteRetainedSessionRuntime(
    graph: WorkspaceGraph,
    runtime: BackgroundSessionRuntime,
  ): Promise<SessionSnapshot | { error: HostError } | null> {
    const server = this.server;
    const retainedSessions = this.retainedSessionRuntimes(graph);
    if (!server || retainedSessions.get(runtime.sessionId) !== runtime) return null;

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
    const sessionRevision = server.identity.sessionRevision + 1;
    const candidateIdentity: HostIdentity = {
      ...server.getIdentity(),
      sessionId: runtime.sessionId,
      sessionRevision,
    };

    let binding: Awaited<ReturnType<typeof bindExtensionUi>>;
    try {
      binding = await bindExtensionUi(runtime.agentSession, runtime.extensionsResult, {
        emit: (event, payload) => server.emitForIdentity(candidateIdentity, event, payload),
        emitForIdentity: (identity, event, payload) =>
          server.emitForIdentity(identity, event, payload),
        getIdentity: () => candidateIdentity,
      });
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

    let publishExtensionUi = () => {};
    try {
      publishExtensionUi = await this.activateExtensionUi(graph);
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
      graph.sessionManager = previous.sessionManager;
      graph.agentSession = previous.agentSession;
      graph.extensionsResult = previous.extensionsResult;
      graph.resourceLoader = previous.resourceLoader;
      graph.toolRevision = previous.toolRevision;
      graph.sessionSnapshot = previous.sessionSnapshot;
      graph.extensionUiActivate = previous.extensionUiActivate;
      graph.extensionUiCleanup = previous.extensionUiCleanup;
      graph.extensionUiUpdateIdentity = previous.extensionUiUpdateIdentity;
      graph.unsubscribeAgent = previous.unsubscribeAgent;
      server.identity.sessionId = previous.sessionId;
      server.identity.sessionRevision = previous.sessionRevision;
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

  async disposeGraph(g: WorkspaceGraph): Promise<void> {
    await this.disposeAgentSession(g);
    for (const runtime of [...g.backgroundSessions.values()]) {
      await this.disposeBackgroundRuntime(g, runtime);
    }
    await this.disposeRetainedSessionRuntimes(g);
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

  private retainedGraphFingerprint(g: WorkspaceGraph): string {
    const hash = createHash("sha256");
    const visit = (path: string): void => {
      if (!existsSync(path)) {
        hash.update(`missing:${path}\n`);
        return;
      }
      try {
        const stat = lstatSync(path);
        hash.update(`${path}|${stat.mode}|${stat.size}|${Math.trunc(stat.mtimeMs)}\n`);
        if (!stat.isDirectory()) return;
        for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) =>
          a.name.localeCompare(b.name),
        )) {
          visit(join(path, entry.name));
        }
      } catch (err) {
        hash.update(
          `error:${path}:${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    };

    visit(join(g.canonicalCwd, ".pi"));
    visit(join(this.deps.agentDir, "settings.json"));
    visit(join(this.deps.agentDir, "models.json"));
    visit(join(this.deps.agentDir, "auth.json"));
    for (const directory of ["packages", "npm", "git"]) {
      visit(join(this.deps.agentDir, directory));
    }
    return hash.digest("hex");
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
    await this.disposeRetainedSessionRuntimes(g);
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
    g.retainedFingerprint = this.retainedGraphFingerprint(g);

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

  /** Drop every idle runtime that may have captured old settings or resources. */
  async invalidateRetainedRuntimeCaches(): Promise<void> {
    if (this.graph) {
      await this.disposeRetainedSessionRuntimes(this.graph);
    }
    await this.disposeRetainedGraphs();
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

    const retainedFingerprint = g.retainedFingerprint;
    g.retainedFingerprint = undefined;
    if (!retainedFingerprint || retainedFingerprint !== this.retainedGraphFingerprint(g)) {
      logger.info("Retained workspace changed on disk; rebuilding", {
        cwd: args.canonical,
      });
      await this.disposeGraph(g);
      return null;
    }

    if (!g.servicesReady || !g.agentSession) {
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
      binding.updateIdentity(candidateIdentity);

      g.packageSnapshot = await buildPackageSnapshot({
        revision: args.packageRevision,
        workspaceId: g.workspaceId,
        scope: "all",
        packageManager: g.packageManager!,
        settingsManager: g.settingsManager!,
        resourceLoader: g.resourceLoader,
        cwd: g.canonicalCwd,
        agentDir: this.deps.agentDir,
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
      g.unsubscribeAgent = session.subscribe((event) => {
        this.handleAgentEvent(g, session, event);
      });
    } catch (err) {
      logger.warn("retained graph preparation failed; rebuilding workspace", {
        cwd: args.canonical,
        error: err instanceof Error ? err.message : String(err),
      });
      await this.disposeGraph(g);
      return null;
    }

    const previousIdentity = server.getIdentity();
    g.revision = args.revision;
    this.graph = g;
    server.identity.workspaceId = g.workspaceId;
    server.identity.workspaceRevision = args.revision;
    server.identity.sessionId = sessionId;
    server.identity.sessionRevision = args.sessionRevision;
    server.identity.packageRevision = args.packageRevision;

    let publishExtensionUi = () => {};
    try {
      publishExtensionUi = await this.activateExtensionUi(g);
    } catch (err) {
      logger.warn("retained graph Extension activate failed; rebuilding workspace", {
        cwd: args.canonical,
        error: err instanceof Error ? err.message : String(err),
      });
      this.graph = args.previousGraph;
      server.identity.workspaceId = previousIdentity.workspaceId;
      server.identity.workspaceRevision = previousIdentity.workspaceRevision;
      server.identity.sessionId = previousIdentity.sessionId;
      server.identity.sessionRevision = previousIdentity.sessionRevision;
      server.identity.packageRevision = previousIdentity.packageRevision;
      await this.disposeGraph(g);
      return null;
    }

    // Commit: only quiesce the outgoing graph after the retained candidate is ready.
    if (args.previousGraph) {
      await this.retainGraph(args.previousGraph);
    }

    server.setPhase("ready");
    server.setLastError(undefined);
    const workspace = this.buildWorkspaceSnapshot(g);

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
      retainedSessions: new Map(),
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

      // Fast path: a graph retained from an earlier visit reactivates in
      // milliseconds instead of a full rebuild.
      const reactivated = await this.tryReactivateRetainedGraph({
        canonical,
        previousGraph,
        revision,
        sessionRevision: candidateSessionRevision,
        packageRevision: candidatePackageRevision,
      });
      if (reactivated) return reactivated;

      const built = await this.buildServices({
        workspaceId,
        cwd,
        canonicalCwd: canonical,
        revision,
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
          sessionRevision: invalidatedSessionRevision,
          packageRevision: candidatePackageRevision,
          error: built.error,
        });
        return { error: built.error };
      }

      const previousIdentity = server.getIdentity();
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
        if (previousGraph) {
          this.graph = previousGraph;
          server.identity.workspaceId = previousIdentity.workspaceId;
          server.identity.workspaceRevision = previousIdentity.workspaceRevision;
          server.identity.sessionId = previousIdentity.sessionId;
          server.identity.sessionRevision = previousIdentity.sessionRevision;
          server.identity.packageRevision = previousIdentity.packageRevision;
          server.setPhase("ready");
          server.setLastError(undefined);
          return { error };
        }
        await this.commitWorkspaceFailure({
          previousGraph: null,
          workspaceId,
          cwd,
          canonicalCwd: canonical,
          revision,
          sessionRevision: invalidatedSessionRevision,
          packageRevision: candidatePackageRevision,
          error,
        });
        return { error };
      }

      if (previousGraph) {
        await this.retainGraph(previousGraph);
      }

      server.setPhase("ready");
      server.setLastError(undefined);
      const workspace = this.buildWorkspaceSnapshot(built.graph);

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
        projectTrusted: true,
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
        retainedSessions: new Map(),
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
        resourceLoader,
        cwd: args.canonicalCwd,
        agentDir: this.deps.agentDir,
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
                  this.graph === graph &&
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
