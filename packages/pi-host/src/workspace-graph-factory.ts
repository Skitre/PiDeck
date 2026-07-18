import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, rename, unlink } from "node:fs/promises";
import { basename, join, resolve as pathResolve } from "node:path";
import {
  AgentSession,
  AuthStorage,
  createAgentSession,
  DefaultPackageManager,
  DefaultResourceLoader,
  hasTrustRequiringProjectResources,
  ModelRegistry,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import {
  createHostError,
  type HostError,
  type HostIdentity,
  type ModelConfigHealth,
  type PackageSnapshot,
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
import { AgentOperationLock, type GraphOperationKind } from "./locks.js";
import {
  extractLatestAssistantText,
  generateRefinedSessionTitle,
} from "./session-title.js";

export type TrustDecisionUi = "trusted" | "denied" | "session" | "pending" | "notRequired";

export type WorkspaceGraph = {
  workspaceId: string;
  cwd: string;
  canonicalCwd: string;
  revision: number;
  trustDecision: TrustDecisionUi;
  projectTrusted: boolean;
  servicesReady: boolean;
  settingsManager: SettingsManager | null;
  packageManager: DefaultPackageManager | null;
  resourceLoader: DefaultResourceLoader | null;
  sessionManager: SessionManager | null;
  agentSession: AgentSession | null;
  extensionsResult: unknown;
  packageSnapshot: PackageSnapshot | null;
  sessionSnapshot: SessionSnapshot | null;
  toolRevision: number;
  /** private resourceId -> metadata map for top-level toggles */
  resourceIdMap: Map<
    string,
    {
      type: "extension" | "skill" | "prompt" | "theme";
      scope: "user" | "project" | "temporary";
      path: string;
      baseDir?: string;
      origin: "package" | "top-level";
      packageSource?: string;
      packageScope?: "user" | "project";
    }
  >;
  unsubscribeAgent: (() => void) | null;
  extensionUiActivate: (() => Promise<() => void>) | null;
  extensionUiCleanup: (() => void) | null;
  extensionUiUpdateIdentity: ((identity: HostIdentity) => void) | null;
  /** After package mutation reload failure — block prompts until reload succeeds */
  resourceReloadRequired: boolean;
  backgroundSessions: Map<string, BackgroundSessionRuntime>;
};

export type BackgroundSessionRuntime = {
  sessionId: string;
  sessionRevision: number;
  sessionManager: SessionManager;
  agentSession: AgentSession;
  resourceLoader: DefaultResourceLoader;
  extensionsResult: unknown;
  toolRevision: number;
  sessionSnapshot: SessionSnapshot;
  unsubscribeAgent: (() => void) | null;
  extensionUiActivate: (() => Promise<() => void>) | null;
  extensionUiCleanup: (() => void) | null;
  extensionUiUpdateIdentity: ((identity: HostIdentity) => void) | null;
};

export type ManagedSessionInfo = SessionInfo & { archived: boolean };

export type GraphFactoryDeps = {
  agentDir: string;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  trustStore: ProjectTrustStore;
  getModelConfigHealth: () => ModelConfigHealth;
  refreshModelHealth: () => Promise<ModelConfigHealth> | ModelConfigHealth;
  packageUpdateCheck: boolean;
};

const TRUST_OPTIONS: TrustOption[] = [
  {
    id: "trustOnce",
    label: "Trust this project for this session only",
    trusted: true,
    persisted: false,
  },
  {
    id: "trust",
    label: "Trust this project (persist)",
    trusted: true,
    persisted: true,
  },
  {
    id: "deny",
    label: "Do not trust project resources",
    trusted: false,
    persisted: true,
  },
];

export class WorkspaceGraphFactory {
  private graph: WorkspaceGraph | null = null;
  private server: PiHostServer | null = null;
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

  /** Dispose a session instance without mutating graph slots (candidate discard/commit). */
  private async disposeAgentSessionOnly(session: {
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

  private retainBusySession(
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

  private announceRetainedRuntime(runtime: BackgroundSessionRuntime): void {
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

  private async promoteBackgroundRuntime(
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

  private async activateExtensionUi(g: WorkspaceGraph): Promise<() => void> {
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
      await this.disposeGraph(args.previousGraph);
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
          await this.disposeGraph(previousGraph);
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
        await this.disposeGraph(previousGraph);
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

      // Create a new session for this workspace
      const sessionManager = SessionManager.create(args.canonicalCwd);

      await Promise.resolve(this.deps.refreshModelHealth());
      this.onModelHealthChanged?.();

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

  private handleAgentEvent(
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

  private sessionStorageDirs(g: WorkspaceGraph): {
    activeDir: string;
    archiveDir: string;
  } {
    const resolvedCwd = pathResolve(g.canonicalCwd);
    const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    const activeDir = join(pathResolve(this.deps.agentDir), "sessions", safePath);
    return { activeDir, archiveDir: join(activeDir, ".archive") };
  }

  private async listSessionFiles(
    g: WorkspaceGraph,
    archived: boolean,
  ): Promise<ManagedSessionInfo[]> {
    const dirs = this.sessionStorageDirs(g);
    const dir = archived ? dirs.archiveDir : dirs.activeDir;
    const sessions = await SessionManager.list(g.canonicalCwd, dir);
    return sessions.map((session) => ({ ...session, archived }));
  }

  async listSessions(): Promise<ManagedSessionInfo[]> {
    const g = this.graph;
    if (!g || !g.servicesReady) return [];
    const [active, archived] = await Promise.all([
      this.listSessionFiles(g, false),
      this.listSessionFiles(g, true),
    ]);
    return [...active, ...archived].sort(
      (left, right) => right.modified.getTime() - left.modified.getTime(),
    );
  }

  private async withSessionFileMutation<T>(
    requestId: string,
    operationKind: GraphOperationKind,
    run: (g: WorkspaceGraph) => Promise<T | { error: HostError }>,
  ): Promise<T | { error: HostError }> {
    const server = this.server;
    const g = this.graph;
    if (!server || !g || !g.servicesReady) {
      return { error: createHostError("AGENT_NOT_READY", "Workspace services not ready") };
    }
    if (!server.serviceGraphLock.tryAcquire({ operationKind, requestId })) {
      return {
        error: createHostError("SERVICE_GRAPH_BUSY", "Service graph is busy", {
          retryable: true,
        }),
      };
    }
    try {
      return await run(g);
    } catch (error) {
      return {
        error: createHostError(
          "SESSION_SWITCH_FAILED",
          error instanceof Error ? error.message : "Session file operation failed",
        ),
      };
    } finally {
      server.serviceGraphLock.release(requestId);
    }
  }

  async archiveSession(
    requestId: string,
    sessionId: string,
    sessionPath: string,
  ): Promise<
    { sessionId: string; sessionPath: string; archived: true } | { error: HostError }
  > {
    return this.withSessionFileMutation(requestId, "session.archive", async (g) => {
      const session = (await this.listSessionFiles(g, false)).find(
        (item) => item.id === sessionId && this.sessionPathsEqual(item.path, sessionPath),
      );
      if (!session) {
        return { error: createHostError("SESSION_NOT_FOUND", "Session is not active") };
      }
      if (this.getSessionRuntimeInfo(session.id, session.path)) {
        return {
          error: createHostError(
            "AGENT_BUSY",
            "Switch away from the Session and wait for its run to finish before archiving",
            { retryable: true },
          ),
        };
      }
      const { archiveDir } = this.sessionStorageDirs(g);
      await mkdir(archiveDir, { recursive: true });
      const archivedPath = join(archiveDir, basename(session.path));
      if (existsSync(archivedPath)) {
        return {
          error: createHostError("SESSION_SWITCH_FAILED", "Session is already archived"),
        };
      }
      await rename(session.path, archivedPath);
      return { sessionId, sessionPath: archivedPath, archived: true as const };
    });
  }

  async restoreSession(
    requestId: string,
    sessionId: string,
    sessionPath: string,
  ): Promise<
    { sessionId: string; sessionPath: string; archived: false } | { error: HostError }
  > {
    return this.withSessionFileMutation(requestId, "session.restore", async (g) => {
      const session = (await this.listSessionFiles(g, true)).find(
        (item) => item.id === sessionId && this.sessionPathsEqual(item.path, sessionPath),
      );
      if (!session) {
        return { error: createHostError("SESSION_NOT_FOUND", "Archived Session not found") };
      }
      const { activeDir } = this.sessionStorageDirs(g);
      const restoredPath = join(activeDir, basename(session.path));
      if (existsSync(restoredPath)) {
        return {
          error: createHostError(
            "SESSION_SWITCH_FAILED",
            "A Session with the same file name already exists",
          ),
        };
      }
      await rename(session.path, restoredPath);
      return { sessionId, sessionPath: restoredPath, archived: false as const };
    });
  }

  async deleteArchivedSession(
    requestId: string,
    sessionId: string,
    sessionPath: string,
  ): Promise<{ sessionId: string; deleted: true } | { error: HostError }> {
    return this.withSessionFileMutation(requestId, "session.delete", async (g) => {
      const session = (await this.listSessionFiles(g, true)).find(
        (item) => item.id === sessionId && this.sessionPathsEqual(item.path, sessionPath),
      );
      if (!session) {
        return { error: createHostError("SESSION_NOT_FOUND", "Archived Session not found") };
      }
      await unlink(session.path);
      return { sessionId, deleted: true as const };
    });
  }

  async cleanupArchivedSessions(
    requestId: string,
  ): Promise<{ deletedCount: number; failedCount: number } | { error: HostError }> {
    return this.withSessionFileMutation(requestId, "session.cleanup", async (g) => {
      const sessions = await this.listSessionFiles(g, true);
      let deletedCount = 0;
      let failedCount = 0;
      for (const session of sessions) {
        try {
          await unlink(session.path);
          deletedCount += 1;
        } catch (error) {
          failedCount += 1;
          logger.warn("Failed to delete archived Session", {
            sessionId: session.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return { deletedCount, failedCount };
    });
  }

  /** Caller owns the relevant graph/agent lock. */
  setActiveSessionName(name: string): SessionSnapshot | null {
    const server = this.server;
    const g = this.graph;
    if (!server || !g?.agentSession || !g.sessionManager) return null;

    g.agentSession.setSessionName(name);
    if (g.sessionSnapshot?.name === g.agentSession.sessionName) {
      return g.sessionSnapshot;
    }
    g.sessionSnapshot = buildSessionSnapshot({
      session: g.agentSession,
      sessionManager: g.sessionManager,
      cwd: g.canonicalCwd,
      sessionId: server.identity.sessionId ?? "",
      revision: server.identity.sessionRevision,
      workspaceId: g.workspaceId,
      toolRevision: g.toolRevision,
    });
    server.emit("session.infoChanged", {
      sessionId: g.sessionSnapshot.sessionId,
      name,
    });
    server.emit("session.snapshot", g.sessionSnapshot);
    return g.sessionSnapshot;
  }

  async refineActiveSessionName(args: {
    session: AgentSession;
    sessionId: string;
    provisionalTitle: string;
    userPrompt: string;
  }): Promise<void> {
    const initialGraph = this.graph;
    if (
      !initialGraph ||
      initialGraph.agentSession !== args.session ||
      args.session.sessionName !== args.provisionalTitle ||
      !args.session.model
    ) {
      return;
    }

    let refinedTitle: string;
    try {
      refinedTitle = await generateRefinedSessionTitle({
        model: args.session.model,
        modelRegistry: this.deps.modelRegistry,
        userPrompt: args.userPrompt,
        assistantText: extractLatestAssistantText(args.session.messages),
      });
    } catch (err) {
      logger.warn("session title refinement failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const server = this.server;
    const currentGraph = this.graph;
    if (
      !server ||
      currentGraph !== initialGraph ||
      currentGraph.agentSession !== args.session ||
      server.identity.sessionId !== args.sessionId ||
      args.session.sessionName !== args.provisionalTitle ||
      refinedTitle === args.provisionalTitle ||
      !args.session.isIdle ||
      this.getSessionOperationLock(args.session).isHeld() ||
      server.serviceGraphLock.isHeld()
    ) {
      return;
    }
    this.setActiveSessionName(refinedTitle);
  }

  private async createSessionResourceLoader(g: WorkspaceGraph): Promise<DefaultResourceLoader> {
    const resourceLoader = new DefaultResourceLoader({
      cwd: g.canonicalCwd,
      agentDir: this.deps.agentDir,
      settingsManager: g.settingsManager!,
    });
    await resourceLoader.reload();
    return resourceLoader;
  }

  private sessionPathsEqual(left: string | undefined, right: string): boolean {
    if (!left) return false;
    const resolvedLeft = pathResolve(left);
    const resolvedRight = pathResolve(right);
    return process.platform === "win32"
      ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
      : resolvedLeft === resolvedRight;
  }

  /**
   * Create a new AgentSession in the current workspace (replaces active session).
   */
  async createSession(
    requestId: string,
    name?: string,
  ): Promise<SessionSnapshot | { error: HostError }> {
    const server = this.server;
    const g = this.graph;
    if (!server || !g || !g.servicesReady || !g.settingsManager || !g.resourceLoader) {
      return { error: createHostError("AGENT_NOT_READY", "Workspace services not ready") };
    }

    if (!server.serviceGraphLock.tryAcquire({ operationKind: "session.create", requestId })) {
      return {
        error: createHostError("SERVICE_GRAPH_BUSY", "Service graph is busy", {
          retryable: true,
        }),
      };
    }

    let candidateSession: AgentSession | null = null;
    let extensionUiActivate: (() => Promise<() => void>) | null = null;
    let extensionUiCleanup: (() => void) | null = null;
    let extensionUiUpdateIdentity: ((identity: HostIdentity) => void) | null = null;
    let unsubscribeAgent: (() => void) | null = null;

    try {
      // C4 candidate-commit: build new session fully before disposing old (B-SESSION-TXN-01)
      const prev = {
        sessionManager: g.sessionManager,
        agentSession: g.agentSession,
        extensionsResult: g.extensionsResult,
        resourceLoader: g.resourceLoader,
        toolRevision: g.toolRevision,
        sessionSnapshot: g.sessionSnapshot,
        extensionUiActivate: g.extensionUiActivate,
        extensionUiCleanup: g.extensionUiCleanup,
        extensionUiUpdateIdentity: g.extensionUiUpdateIdentity,
        unsubscribeAgent: g.unsubscribeAgent,
        sessionId: server.identity.sessionId,
        sessionRevision: server.identity.sessionRevision,
      };

      const sessionManager = SessionManager.create(g.canonicalCwd);
      if (name) {
        sessionManager.appendSessionInfo(name);
      }
      await Promise.resolve(this.deps.refreshModelHealth());
      this.onModelHealthChanged?.();
      const candidateResourceLoader = await this.createSessionResourceLoader(g);

      const created = await createAgentSession({
        cwd: g.canonicalCwd,
        agentDir: this.deps.agentDir,
        authStorage: this.deps.authStorage,
        modelRegistry: this.deps.modelRegistry,
        settingsManager: g.settingsManager,
        resourceLoader: candidateResourceLoader,
        sessionManager,
      });
      const session = created.session;
      const extensionsResult = created.extensionsResult;
      candidateSession = session;

      const sessionId = sessionManager.getSessionId() || session.sessionId || randomUUID();
      const sessionRevision = server.identity.sessionRevision + 1;
      const candidateIdentity: HostIdentity = {
        ...server.getIdentity(),
        sessionId,
        sessionRevision,
      };
      try {
        const extensionUiBinding = await bindExtensionUi(session, extensionsResult, {
          emit: (event, payload) =>
            server.emitForIdentity(candidateIdentity, event, payload),
          emitForIdentity: (identity, event, payload) =>
            server.emitForIdentity(identity, event, payload),
          getIdentity: () => candidateIdentity,
        });
        extensionUiActivate = extensionUiBinding.activate;
        extensionUiCleanup = extensionUiBinding.cleanup;
        extensionUiUpdateIdentity = extensionUiBinding.updateIdentity;
        unsubscribeAgent = session.subscribe((event) => {
          this.handleAgentEvent(g, session, event);
        });
      } catch (bindErr) {
        // Discard candidate — keep previous session.
        try {
          unsubscribeAgent?.();
        } catch {
          /* ignore */
        }
        try {
          extensionUiCleanup?.();
        } catch {
          /* ignore */
        }
        try {
          await this.disposeAgentSessionOnly(session);
        } catch {
          /* ignore */
        }
        candidateSession = null;
        return {
          error: createHostError(
            "SESSION_SWITCH_FAILED",
            bindErr instanceof Error ? bindErr.message : "Extension bind failed",
          ),
        };
      }

      const sessionSnapshot = buildSessionSnapshot({
        session,
        sessionManager,
        cwd: g.canonicalCwd,
        sessionId,
        revision: sessionRevision,
        workspaceId: g.workspaceId,
        toolRevision: 1,
      });

      const retainedPrevious = this.retainBusySession(g, prev);

      // Temporarily commit candidate identity so blocking Extension UI can respond,
      // but do not publish a ready Session until bindExtensions has completed.
      g.sessionManager = sessionManager;
      g.agentSession = session;
      g.extensionsResult = extensionsResult;
      g.resourceLoader = candidateResourceLoader;
      g.toolRevision = 1;
      g.extensionUiActivate = extensionUiActivate;
      g.extensionUiCleanup = extensionUiCleanup;
      g.extensionUiUpdateIdentity = extensionUiUpdateIdentity;
      g.unsubscribeAgent = unsubscribeAgent;
      server.identity.sessionId = sessionId;
      server.identity.sessionRevision = sessionRevision;
      g.sessionSnapshot = sessionSnapshot;

      let publishExtensionUi = () => {};
      try {
        publishExtensionUi = await this.activateExtensionUi(g);
      } catch (bindErr) {
        if (retainedPrevious) {
          g.backgroundSessions.delete(retainedPrevious.sessionId);
        }
        try {
          unsubscribeAgent?.();
        } catch {
          /* ignore */
        }
        await this.disposeAgentSessionOnly(session);
        g.sessionManager = prev.sessionManager;
        g.agentSession = prev.agentSession;
        g.extensionsResult = prev.extensionsResult;
        g.resourceLoader = prev.resourceLoader;
        g.toolRevision = prev.toolRevision;
        g.sessionSnapshot = prev.sessionSnapshot;
        g.extensionUiActivate = prev.extensionUiActivate;
        g.extensionUiCleanup = prev.extensionUiCleanup;
        g.extensionUiUpdateIdentity = prev.extensionUiUpdateIdentity;
        g.unsubscribeAgent = prev.unsubscribeAgent;
        server.identity.sessionId = prev.sessionId;
        server.identity.sessionRevision = prev.sessionRevision;
        candidateSession = null;
        extensionUiActivate = null;
        extensionUiCleanup = null;
        extensionUiUpdateIdentity = null;
        unsubscribeAgent = null;
        return {
          error: createHostError(
            "SESSION_SWITCH_FAILED",
            bindErr instanceof Error ? bindErr.message : "Extension bind failed",
          ),
        };
      }

      if (!retainedPrevious && prev.extensionUiCleanup) {
        try {
          prev.extensionUiCleanup();
        } catch {
          /* ignore */
        }
      }
      if (!retainedPrevious && prev.unsubscribeAgent) {
        try {
          prev.unsubscribeAgent();
        } catch {
          /* ignore */
        }
      }
      if (!retainedPrevious && prev.agentSession) {
        try {
          await this.disposeAgentSessionOnly(prev.agentSession);
        } catch {
          /* ignore */
        }
      }

      candidateSession = null;
      extensionUiActivate = null;
      extensionUiCleanup = null;
      extensionUiUpdateIdentity = null;
      unsubscribeAgent = null;

      server.emit("session.snapshot", g.sessionSnapshot);
      server.emit("agent.toolsChanged", g.sessionSnapshot.tools);
      if (retainedPrevious) this.announceRetainedRuntime(retainedPrevious);
      publishExtensionUi();
      return g.sessionSnapshot;
    } catch (err) {
      try {
        unsubscribeAgent?.();
      } catch {
        /* ignore */
      }
      try {
        extensionUiCleanup?.();
      } catch {
        /* ignore */
      }
      if (candidateSession) {
        await this.disposeAgentSessionOnly(candidateSession);
      }
      return {
        error: createHostError(
          "SESSION_SWITCH_FAILED",
          err instanceof Error ? err.message : "Failed to create session",
        ),
      };
    } finally {
      server.serviceGraphLock.release(requestId);
    }
  }

  async openSession(
    requestId: string,
    sessionPath: string,
    options: { forceReload?: boolean } = {},
  ): Promise<SessionSnapshot | { error: HostError }> {
    const server = this.server;
    const g = this.graph;
    if (!server || !g || !g.servicesReady || !g.settingsManager || !g.resourceLoader) {
      return { error: createHostError("AGENT_NOT_READY", "Workspace services not ready") };
    }

    if (
      !server.serviceGraphLock.tryAcquire({
        operationKind: options.forceReload ? "session.reload" : "session.open",
        requestId,
      })
    ) {
      return {
        error: createHostError("SERVICE_GRAPH_BUSY", "Service graph is busy", { retryable: true }),
      };
    }

    try {
      const isCurrentSession = Boolean(
        g.sessionSnapshot &&
          this.sessionPathsEqual(g.sessionSnapshot.sessionPath, sessionPath),
      );
      if (options.forceReload && !isCurrentSession) {
        return {
          error: createHostError("SESSION_NOT_FOUND", "Only the active Session can be reloaded"),
        };
      }
      if (options.forceReload) {
        if (
          !g.agentSession ||
          !g.agentSession.isIdle ||
          this.getSessionOperationLock(g.agentSession).isHeld()
        ) {
          return {
            error: createHostError(
              "AGENT_BUSY",
              "Wait for the active Session run to finish before reloading from disk",
              { retryable: true },
            ),
          };
        }
      } else if (isCurrentSession) {
        return g.sessionSnapshot!;
      }

      // Ensure session belongs to current cwd
      const listed = await SessionManager.list(g.canonicalCwd);
      const match = listed.find((s) => s.path === sessionPath);
      if (!match) {
        return {
          error: createHostError(
            "SESSION_NOT_FOUND",
            "Session is not in the current workspace; switch workspace first",
          ),
        };
      }

      const retained = [...g.backgroundSessions.values()].find((runtime) =>
        this.sessionPathsEqual(runtime.sessionSnapshot.sessionPath, sessionPath),
      );
      if (retained) {
        return await this.promoteBackgroundRuntime(g, retained);
      }

      const sessionManager = SessionManager.open(sessionPath, undefined, g.canonicalCwd);
      let candidateSession: AgentSession | null = null;
      let candidateExtensionUiCleanup: (() => void) | null = null;
      let candidateExtensionUiUpdateIdentity: ((identity: HostIdentity) => void) | null = null;
      let candidateUnsubscribeAgent: (() => void) | null = null;
      try {
        await Promise.resolve(this.deps.refreshModelHealth());
        this.onModelHealthChanged?.();
        const candidateResourceLoader = await this.createSessionResourceLoader(g);

        const created = await createAgentSession({
          cwd: g.canonicalCwd,
          agentDir: this.deps.agentDir,
          authStorage: this.deps.authStorage,
          modelRegistry: this.deps.modelRegistry,
          settingsManager: g.settingsManager,
          resourceLoader: candidateResourceLoader,
          sessionManager,
        });
        candidateSession = created.session;
        const session = created.session;
        const extensionsResult = created.extensionsResult;
        const sessionId = sessionManager.getSessionId() || session.sessionId || randomUUID();
        const sessionRevision = server.identity.sessionRevision + 1;

        const candidateIdentity: HostIdentity = {
          ...server.getIdentity(),
          sessionId,
          sessionRevision,
        };
        const extensionUiBinding = await bindExtensionUi(session, extensionsResult, {
          emit: (event, payload) =>
            server.emitForIdentity(candidateIdentity, event, payload),
          emitForIdentity: (identity, event, payload) =>
            server.emitForIdentity(identity, event, payload),
          getIdentity: () => candidateIdentity,
        });
        const candidateExtensionUiActivate = extensionUiBinding.activate;
        candidateExtensionUiCleanup = extensionUiBinding.cleanup;
        candidateExtensionUiUpdateIdentity = extensionUiBinding.updateIdentity;
        candidateUnsubscribeAgent = session.subscribe((event) => {
          this.handleAgentEvent(g, session, event);
        });
        const sessionSnapshot = buildSessionSnapshot({
          session,
          sessionManager,
          cwd: g.canonicalCwd,
          sessionId,
          revision: sessionRevision,
          workspaceId: g.workspaceId,
          toolRevision: 1,
        });

        const prev = {
          sessionManager: g.sessionManager,
          agentSession: g.agentSession,
          extensionsResult: g.extensionsResult,
          resourceLoader: g.resourceLoader,
          toolRevision: g.toolRevision,
          sessionSnapshot: g.sessionSnapshot,
          extensionUiActivate: g.extensionUiActivate,
          extensionUiCleanup: g.extensionUiCleanup,
          extensionUiUpdateIdentity: g.extensionUiUpdateIdentity,
          unsubscribeAgent: g.unsubscribeAgent,
          sessionId: server.identity.sessionId,
          sessionRevision: server.identity.sessionRevision,
        };

        const retainedPrevious = this.retainBusySession(g, prev);

        g.sessionManager = sessionManager;
        g.agentSession = session;
        g.extensionsResult = extensionsResult;
        g.resourceLoader = candidateResourceLoader;
        g.toolRevision = 1;
        g.extensionUiActivate = candidateExtensionUiActivate;
        g.extensionUiCleanup = candidateExtensionUiCleanup;
        g.extensionUiUpdateIdentity = candidateExtensionUiUpdateIdentity;
        g.unsubscribeAgent = candidateUnsubscribeAgent;
        g.sessionSnapshot = sessionSnapshot;
        server.identity.sessionId = sessionId;
        server.identity.sessionRevision = sessionRevision;

        let publishExtensionUi = () => {};
        try {
          publishExtensionUi = await this.activateExtensionUi(g);
        } catch (bindErr) {
          if (retainedPrevious) {
            g.backgroundSessions.delete(retainedPrevious.sessionId);
          }
          try {
            candidateUnsubscribeAgent?.();
          } catch {
            /* ignore */
          }
          await this.disposeAgentSessionOnly(session);
          g.sessionManager = prev.sessionManager;
          g.agentSession = prev.agentSession;
          g.extensionsResult = prev.extensionsResult;
          g.resourceLoader = prev.resourceLoader;
          g.toolRevision = prev.toolRevision;
          g.sessionSnapshot = prev.sessionSnapshot;
          g.extensionUiActivate = prev.extensionUiActivate;
          g.extensionUiCleanup = prev.extensionUiCleanup;
          g.extensionUiUpdateIdentity = prev.extensionUiUpdateIdentity;
          g.unsubscribeAgent = prev.unsubscribeAgent;
          server.identity.sessionId = prev.sessionId;
          server.identity.sessionRevision = prev.sessionRevision;
          candidateSession = null;
          candidateExtensionUiCleanup = null;
          candidateExtensionUiUpdateIdentity = null;
          candidateUnsubscribeAgent = null;
          return {
            error: createHostError(
              "SESSION_SWITCH_FAILED",
              bindErr instanceof Error ? bindErr.message : "Extension bind failed",
            ),
          };
        }

        if (!retainedPrevious) {
          try {
            prev.unsubscribeAgent?.();
          } catch {
            /* ignore */
          }
          try {
            prev.extensionUiCleanup?.();
          } catch {
            /* ignore */
          }
          if (prev.agentSession) {
            await this.disposeAgentSessionOnly(prev.agentSession);
          }
        }

        candidateSession = null;
        candidateExtensionUiCleanup = null;
        candidateExtensionUiUpdateIdentity = null;
        candidateUnsubscribeAgent = null;
        server.emit("session.snapshot", sessionSnapshot);
        server.emit("agent.toolsChanged", sessionSnapshot.tools);
        if (retainedPrevious) this.announceRetainedRuntime(retainedPrevious);
        publishExtensionUi();
        return sessionSnapshot;
      } catch (err) {
        try {
          candidateUnsubscribeAgent?.();
        } catch {
          /* ignore */
        }
        try {
          candidateExtensionUiCleanup?.();
        } catch {
          /* ignore */
        }
        if (candidateSession) {
          await this.disposeAgentSessionOnly(candidateSession);
        }
        return {
          error: createHostError(
            "SESSION_SWITCH_FAILED",
            err instanceof Error ? err.message : "Failed to open session",
          ),
        };
      }
    } catch (err) {
      return {
        error: createHostError(
          "SESSION_SWITCH_FAILED",
          err instanceof Error ? err.message : "Failed to open session",
        ),
      };
    } finally {
      server.serviceGraphLock.release(requestId);
    }
  }

  async reloadSession(
    requestId: string,
  ): Promise<SessionSnapshot | { error: HostError }> {
    const sessionPath = this.graph?.sessionSnapshot?.sessionPath;
    if (!sessionPath) {
      return {
        error: createHostError(
          "SESSION_NOT_FOUND",
          "The active Session has not been persisted to disk yet",
        ),
      };
    }
    return this.openSession(requestId, sessionPath, { forceReload: true });
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
