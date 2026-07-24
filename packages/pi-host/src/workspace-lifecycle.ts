import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve as pathResolve } from "node:path";
import {
  createAgentSession,
  DefaultPackageManager,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import {
  createHostError,
  type HostError,
  type HostIdentity,
  type SessionSnapshot,
  type WorkspaceSnapshot,
  toJsonValue,
} from "@pideck/protocol";
import { activateOnce, bindForCandidate } from "./extension-ui-lifecycle.js";
import { logger } from "./logger.js";
import { buildPackageSnapshot } from "./package-snapshot.js";
import { buildSessionSnapshot } from "./session-snapshot.js";
import type { SessionRuntimeCache } from "./session-runtime-cache.js";
import type { PiHostServer } from "./server.js";
import type {
  GraphFactoryDeps,
  WorkspaceGraph,
} from "./workspace-graph-types.js";

export type WorkspaceLifecycleContext = {
  deps: GraphFactoryDeps;
  getGraph: () => WorkspaceGraph | null;
  setGraph: (graph: WorkspaceGraph | null) => void;
  getServer: () => PiHostServer | null;
  onModelHealthChanged: () => void;
};

export class WorkspaceLifecycle {
  private static readonly MAX_RETAINED_GRAPHS = 3;
  private readonly retainedGraphs = new Map<string, WorkspaceGraph>();

  constructor(
    private readonly context: WorkspaceLifecycleContext,
    private readonly sessionRuntimeCache: SessionRuntimeCache,
  ) {}

  canonicalizeCwd(cwd: string): string {
    const resolved = pathResolve(cwd);
    if (!existsSync(resolved)) {
      throw createHostError(
        "WORKSPACE_SWITCH_FAILED",
        `Directory does not exist: ${resolved}`,
        { retryable: false, details: { cwd: resolved } },
      );
    }
    try {
      return realpathSync(resolved);
    } catch {
      return resolved;
    }
  }

  buildWorkspaceSnapshot(graph: WorkspaceGraph): WorkspaceSnapshot {
    return {
      id: graph.workspaceId,
      cwd: graph.cwd,
      canonicalCwd: graph.canonicalCwd,
      revision: graph.revision,
      servicesReady: graph.servicesReady,
    };
  }

  async disposeGraph(graph: WorkspaceGraph): Promise<void> {
    await this.sessionRuntimeCache.disposeGraphSessionRuntimes(graph);
    graph.settingsManager = null;
    graph.packageManager = null;
    graph.resourceLoader = null;
    graph.extensionsResult = null;
    graph.packageSnapshot = null;
    graph.resourceIdMap.clear();
    graph.servicesReady = false;
  }

  async disposeRetainedGraphs(): Promise<void> {
    const graphs = [...this.retainedGraphs.values()];
    this.retainedGraphs.clear();
    for (const graph of graphs) {
      await this.disposeGraph(graph);
    }
  }

  async invalidateRetainedRuntimeCaches(): Promise<void> {
    const graph = this.context.getGraph();
    if (graph) {
      await this.sessionRuntimeCache.disposeRetainedSessionRuntimes(graph);
    }
    await this.disposeRetainedGraphs();
  }

  async setCurrent(
    cwd: string,
    requestId: string,
  ): Promise<
    | { workspace: WorkspaceSnapshot; session?: SessionSnapshot }
    | { error: HostError }
  > {
    const server = this.context.getServer();
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
      if (this.sessionRuntimeCache.hasBusySessions()) {
        return {
          error: createHostError(
            "AGENT_BUSY",
            "Agent is busy; stop it before switching workspace",
            { retryable: true },
          ),
        };
      }

      let canonical: string;
      try {
        canonical = this.canonicalizeCwd(cwd);
      } catch (err) {
        const hostError = err as HostError;
        if (hostError && typeof hostError === "object" && "code" in hostError) {
          return { error: hostError };
        }
        return {
          error: createHostError("WORKSPACE_SWITCH_FAILED", String(err)),
        };
      }

      const previousGraph = this.context.getGraph();
      const workspaceId = randomUUID();
      const revision = server.identity.workspaceRevision + 1;
      const invalidatedSessionRevision =
        server.identity.sessionRevision + (previousGraph?.agentSession ? 1 : 0);
      const candidateSessionRevision = invalidatedSessionRevision + 1;
      const candidatePackageRevision = server.identity.packageRevision + 1;

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
      this.context.setGraph(built.graph);
      server.identity.workspaceId = workspaceId;
      server.identity.workspaceRevision = revision;
      server.identity.sessionId = built.graph.sessionSnapshot?.sessionId ?? null;
      server.identity.sessionRevision = candidateSessionRevision;
      server.identity.packageRevision = candidatePackageRevision;

      let publishExtensionUi = () => {};
      try {
        publishExtensionUi = await activateOnce(built.graph);
      } catch (err) {
        const error = createHostError(
          "WORKSPACE_SWITCH_FAILED",
          err instanceof Error ? err.message : "Extension bind failed",
        );
        await this.disposeGraph(built.graph);
        if (previousGraph) {
          this.context.setGraph(previousGraph);
          this.restoreIdentity(server, previousIdentity);
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

      if (previousGraph) await this.retainGraph(previousGraph);
      server.setPhase("ready");
      server.setLastError(undefined);
      const workspace = this.buildWorkspaceSnapshot(built.graph);
      this.publishWorkspaceSnapshots(server, built.graph, workspace);
      publishExtensionUi();
      return {
        workspace,
        ...(built.graph.sessionSnapshot ? { session: built.graph.sessionSnapshot } : {}),
      };
    } finally {
      server.serviceGraphLock.release(requestId);
    }
  }

  private retainedGraphKey(canonicalCwd: string): string {
    return canonicalCwd.toLocaleLowerCase();
  }

  private retainedGraphFingerprint(graph: WorkspaceGraph): string {
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
        hash.update(`error:${path}:${err instanceof Error ? err.message : String(err)}\n`);
      }
    };

    visit(join(graph.canonicalCwd, ".pi"));
    visit(join(this.context.deps.agentDir, "settings.json"));
    visit(join(this.context.deps.agentDir, "models.json"));
    visit(join(this.context.deps.agentDir, "auth.json"));
    for (const directory of ["packages", "npm", "git"]) {
      visit(join(this.context.deps.agentDir, directory));
    }
    return hash.digest("hex");
  }

  private async retainGraph(graph: WorkspaceGraph): Promise<void> {
    if (
      !graph.servicesReady ||
      !graph.agentSession ||
      !graph.agentSession.isIdle ||
      graph.backgroundSessions.size > 0
    ) {
      await this.disposeGraph(graph);
      return;
    }
    await this.sessionRuntimeCache.disposeRetainedSessionRuntimes(graph);
    graph.unsubscribeAgent?.();
    graph.unsubscribeAgent = null;
    graph.extensionUiActivate = null;
    try {
      graph.extensionUiCleanup?.();
    } catch {
      /* ignore */
    }
    graph.extensionUiCleanup = null;
    graph.extensionUiUpdateIdentity = null;
    graph.retainedFingerprint = this.retainedGraphFingerprint(graph);

    const key = this.retainedGraphKey(graph.canonicalCwd);
    const existing = this.retainedGraphs.get(key);
    this.retainedGraphs.delete(key);
    if (existing && existing !== graph) await this.disposeGraph(existing);
    this.retainedGraphs.set(key, graph);
    while (this.retainedGraphs.size > WorkspaceLifecycle.MAX_RETAINED_GRAPHS) {
      const oldestKey = this.retainedGraphs.keys().next().value;
      if (oldestKey === undefined) break;
      const evicted = this.retainedGraphs.get(oldestKey);
      this.retainedGraphs.delete(oldestKey);
      if (evicted) await this.disposeGraph(evicted);
    }
  }

  private takeRetainedGraph(canonicalCwd: string): WorkspaceGraph | null {
    const key = this.retainedGraphKey(canonicalCwd);
    const graph = this.retainedGraphs.get(key) ?? null;
    this.retainedGraphs.delete(key);
    return graph;
  }

  private async tryReactivateRetainedGraph(args: {
    canonical: string;
    previousGraph: WorkspaceGraph | null;
    revision: number;
    sessionRevision: number;
    packageRevision: number;
  }): Promise<{ workspace: WorkspaceSnapshot; session?: SessionSnapshot } | null> {
    const server = this.context.getServer();
    if (!server) return null;
    const graph = this.takeRetainedGraph(args.canonical);
    if (!graph) return null;

    const retainedFingerprint = graph.retainedFingerprint;
    graph.retainedFingerprint = undefined;
    if (
      !retainedFingerprint ||
      retainedFingerprint !== this.retainedGraphFingerprint(graph)
    ) {
      logger.info("Retained workspace changed on disk; rebuilding", {
        cwd: args.canonical,
      });
      await this.disposeGraph(graph);
      return null;
    }
    if (!graph.servicesReady || !graph.agentSession || !graph.sessionManager) {
      await this.disposeGraph(graph);
      return null;
    }

    const session = graph.agentSession;
    const sessionManager = graph.sessionManager;
    const sessionId =
      graph.sessionSnapshot?.sessionId || sessionManager.getSessionId() || session.sessionId;
    if (!sessionId) {
      await this.disposeGraph(graph);
      return null;
    }
    const candidateIdentity: HostIdentity = {
      hostInstanceId: server.identity.hostInstanceId,
      workspaceId: graph.workspaceId,
      workspaceRevision: args.revision,
      sessionId,
      sessionRevision: args.sessionRevision,
      packageRevision: args.packageRevision,
    };

    try {
      const binding = await bindForCandidate(
        session,
        graph.extensionsResult,
        server,
        candidateIdentity,
      );
      graph.extensionUiActivate = binding.activate;
      graph.extensionUiCleanup = binding.cleanup;
      graph.extensionUiUpdateIdentity = binding.updateIdentity;
      binding.updateIdentity(candidateIdentity);
      graph.packageSnapshot = await buildPackageSnapshot({
        revision: args.packageRevision,
        workspaceId: graph.workspaceId,
        scope: "all",
        packageManager: graph.packageManager!,
        settingsManager: graph.settingsManager!,
        resourceLoader: graph.resourceLoader,
        cwd: graph.canonicalCwd,
        agentDir: this.context.deps.agentDir,
        packageUpdateCheck: this.context.deps.packageUpdateCheck,
        resourceIdMap: graph.resourceIdMap,
        resourceReloadRequired: graph.resourceReloadRequired,
      });
      graph.sessionSnapshot = buildSessionSnapshot({
        session,
        sessionManager,
        cwd: args.canonical,
        sessionId,
        revision: args.sessionRevision,
        workspaceId: graph.workspaceId,
        toolRevision: graph.toolRevision,
      });
      graph.unsubscribeAgent = session.subscribe((event) => {
        this.sessionRuntimeCache.handleAgentEvent(graph, session, event);
      });
    } catch (err) {
      logger.warn("retained graph preparation failed; rebuilding workspace", {
        cwd: args.canonical,
        error: err instanceof Error ? err.message : String(err),
      });
      await this.disposeGraph(graph);
      return null;
    }

    const previousIdentity = server.getIdentity();
    graph.revision = args.revision;
    this.context.setGraph(graph);
    server.identity.workspaceId = graph.workspaceId;
    server.identity.workspaceRevision = args.revision;
    server.identity.sessionId = sessionId;
    server.identity.sessionRevision = args.sessionRevision;
    server.identity.packageRevision = args.packageRevision;

    let publishExtensionUi = () => {};
    try {
      publishExtensionUi = await activateOnce(graph);
    } catch (err) {
      logger.warn("retained graph Extension activate failed; rebuilding workspace", {
        cwd: args.canonical,
        error: err instanceof Error ? err.message : String(err),
      });
      this.context.setGraph(args.previousGraph);
      this.restoreIdentity(server, previousIdentity);
      await this.disposeGraph(graph);
      return null;
    }

    if (args.previousGraph) await this.retainGraph(args.previousGraph);
    server.setPhase("ready");
    server.setLastError(undefined);
    const workspace = this.buildWorkspaceSnapshot(graph);
    this.publishWorkspaceSnapshots(server, graph, workspace);
    publishExtensionUi();
    return {
      workspace,
      ...(graph.sessionSnapshot ? { session: graph.sessionSnapshot } : {}),
    };
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
    const server = this.context.getServer()!;
    if (args.previousGraph) await this.retainGraph(args.previousGraph);
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
    this.context.setGraph(failedGraph);
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

  private async buildServices(args: {
    workspaceId: string;
    cwd: string;
    canonicalCwd: string;
    revision: number;
    sessionRevision: number;
    packageRevision: number;
  }): Promise<{ graph: WorkspaceGraph } | { error: HostError }> {
    const server = this.context.getServer()!;
    const { agentDir, authStorage, modelRegistry } = this.context.deps;
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
      await Promise.resolve(this.context.deps.refreshModelHealth());
      this.context.onModelHealthChanged();
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
      const candidateIdentity: HostIdentity = {
        hostInstanceId: server.identity.hostInstanceId,
        workspaceId: args.workspaceId,
        workspaceRevision: args.revision,
        sessionId,
        sessionRevision: args.sessionRevision,
        packageRevision: args.packageRevision,
      };
      const extensionUiBinding = await bindForCandidate(
        session,
        extensionsResult,
        server,
        candidateIdentity,
      );
      graph.extensionUiActivate = extensionUiBinding.activate;
      graph.extensionUiCleanup = extensionUiBinding.cleanup;
      graph.extensionUiUpdateIdentity = extensionUiBinding.updateIdentity;
      candidateExtensionUiCleanup = extensionUiBinding.cleanup;
      graph.unsubscribeAgent = session.subscribe((event) => {
        this.sessionRuntimeCache.handleAgentEvent(graph, session, event);
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
        agentDir: this.context.deps.agentDir,
        packageUpdateCheck: this.context.deps.packageUpdateCheck,
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
        await this.sessionRuntimeCache.disposeAgentSessionOnly(candidateSession);
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

  private restoreIdentity(server: PiHostServer, identity: HostIdentity): void {
    server.identity.workspaceId = identity.workspaceId;
    server.identity.workspaceRevision = identity.workspaceRevision;
    server.identity.sessionId = identity.sessionId;
    server.identity.sessionRevision = identity.sessionRevision;
    server.identity.packageRevision = identity.packageRevision;
  }

  private publishWorkspaceSnapshots(
    server: PiHostServer,
    graph: WorkspaceGraph,
    workspace: WorkspaceSnapshot,
  ): void {
    server.emit("workspace.changed", workspace);
    if (graph.packageSnapshot) server.emit("package.snapshot", graph.packageSnapshot);
    if (graph.sessionSnapshot) {
      server.emit("session.snapshot", graph.sessionSnapshot);
      server.emit("agent.toolsChanged", graph.sessionSnapshot.tools);
    }
  }
}
