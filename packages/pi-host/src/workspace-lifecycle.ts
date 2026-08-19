import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { join, resolve as pathResolve, win32 } from "node:path";
import {
  DefaultPackageManager,
  SettingsManager,
  type AgentSession,
  type ExtensionCommandContextActions,
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
import type { ProviderOwnerToken } from "./extension-provider-ownership.js";
import { captureFilesystemFingerprint } from "./filesystem-fingerprint.js";
import { getInternalRuntime } from "./internal-runtime.js";
import { logger } from "./logger.js";
import { buildPackageSnapshot } from "./package-snapshot.js";
import { buildSessionSnapshot } from "./session-snapshot.js";
import { createReadAttachmentTool } from "./attachment-tool.js";
import type { SessionRuntimeCache } from "./session-runtime-cache.js";
import type { PiHostServer } from "./server.js";
import type { GraphFactoryDeps, WorkspaceGraph } from "./workspace-graph-types.js";
import { createHostAgentSession } from "./agent-session-factory.js";
import {
  createWorkspaceSessionManager,
  type WorkspaceSessionBootstrap,
} from "./workspace-session-bootstrap.js";

export type WorkspaceLifecycleContext = {
  deps: GraphFactoryDeps;
  getGraph: () => WorkspaceGraph | null;
  setGraph: (graph: WorkspaceGraph | null) => void;
  getServer: () => PiHostServer | null;
  onModelHealthChanged: () => void;
  getCommandContextActions?: (session: AgentSession) => ExtensionCommandContextActions;
  platform?: NodeJS.Platform;
};

export function workspaceIdentityKey(
  canonicalCwd: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32" ? win32.normalize(canonicalCwd).toLowerCase() : canonicalCwd;
}

function workspaceCanonicalPathsEqual(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return workspaceIdentityKey(left, platform) === workspaceIdentityKey(right, platform);
}

export class WorkspaceLifecycle {
  private static readonly MAX_RETAINED_GRAPHS = 5;
  private readonly retainedGraphs = new Map<string, WorkspaceGraph>();

  constructor(
    private readonly context: WorkspaceLifecycleContext,
    private readonly sessionRuntimeCache: SessionRuntimeCache,
  ) {}

  canonicalizeCwd(cwd: string): string {
    const resolved = pathResolve(cwd);
    if (!existsSync(resolved)) {
      throw createHostError("WORKSPACE_SWITCH_FAILED", `Directory does not exist: ${resolved}`, {
        retryable: false,
        details: { cwd: resolved },
      });
    }
    let canonical: string;
    try {
      canonical = realpathSync(resolved);
    } catch (err) {
      throw createHostError(
        "WORKSPACE_SWITCH_FAILED",
        `Unable to resolve Workspace directory: ${resolved}`,
        {
          retryable: false,
          details: {
            cwd: resolved,
            error: err instanceof Error ? err.message : String(err),
          },
        },
      );
    }
    let isDirectory: boolean;
    try {
      isDirectory = lstatSync(canonical).isDirectory();
    } catch (err) {
      throw createHostError(
        "WORKSPACE_SWITCH_FAILED",
        `Unable to inspect Workspace directory: ${canonical}`,
        {
          retryable: false,
          details: {
            cwd: canonical,
            error: err instanceof Error ? err.message : String(err),
          },
        },
      );
    }
    if (!isDirectory) {
      throw createHostError(
        "WORKSPACE_NOT_DIRECTORY",
        `Workspace path is not a directory: ${canonical}`,
        { retryable: false, details: { cwd: canonical } },
      );
    }
    return canonical;
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

  private suspendGraphProviders(graph: WorkspaceGraph): void {
    if (!graph.providerOwner || graph.suspendedProviders !== undefined) return;
    // A live turn still holds the registered client. Unregistering mid-stream
    // aborts model output on the parked Workspace.
    if (this.graphHasBusySessions(graph)) return;
    graph.suspendedProviders = this.context.deps.providerOwnership.suspendOwner(
      graph.providerOwner,
    );
  }

  hasBusyRetainedSessions(): boolean {
    for (const graph of this.retainedGraphs.values()) {
      if (this.graphHasBusySessions(graph)) return true;
    }
    return false;
  }

  suspendIdleRetainedProviders(graph: WorkspaceGraph): void {
    if (this.context.getGraph() === graph) return;
    if (![...this.retainedGraphs.values()].includes(graph)) return;
    this.suspendGraphProviders(graph);
  }

  private resumeGraphProviders(graph: WorkspaceGraph): void {
    if (!graph.providerOwner || graph.suspendedProviders === undefined) return;
    this.context.deps.providerOwnership.resumeOwner(graph.providerOwner, graph.suspendedProviders);
    graph.suspendedProviders = undefined;
  }

  async disposeGraph(graph: WorkspaceGraph): Promise<void> {
    await this.sessionRuntimeCache.disposeGraphSessionRuntimes(graph);
    if (graph.providerOwner) {
      this.context.deps.providerOwnership.releaseOwner(graph.providerOwner);
      graph.providerOwner = null;
    }
    graph.suspendedProviders = undefined;
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

  async invalidateRetainedWorkspaceGraph(canonicalCwd: string): Promise<void> {
    const key = this.retainedGraphKey(canonicalCwd);
    const graph = this.retainedGraphs.get(key);
    if (!graph) return;
    this.retainedGraphs.delete(key);
    await this.disposeGraph(graph);
  }

  async invalidateRetainedRuntimeCaches(): Promise<void> {
    await this.disposeRetainedGraphs();
  }

  async setCurrent(
    cwd: string,
    requestId: string,
    bootstrap: WorkspaceSessionBootstrap = {},
  ): Promise<{ workspace: WorkspaceSnapshot; session?: SessionSnapshot } | { error: HostError }> {
    const server = this.context.getServer();
    if (!server) {
      return { error: createHostError("HOST_NOT_READY", "Server not bound") };
    }
    const operation = server.graphOperations.begin({
      operationKind: "workspace.setCurrent",
      requestId,
      operationId: randomUUID(),
    });
    if (!operation) {
      return {
        error: createHostError("SERVICE_GRAPH_BUSY", "Service graph is busy", {
          retryable: true,
          details: {
            operationKind: server.graphOperations.getActive()?.operationKind ?? null,
          },
        }),
      };
    }
    if (!server.serviceGraphLock.tryAcquire({ operationKind: "workspace.setCurrent", requestId })) {
      operation.finish();
      return {
        error: createHostError("SERVICE_GRAPH_BUSY", "Service graph is busy", {
          retryable: true,
          details: {
            operationKind: server.serviceGraphLock.getOwner()?.operationKind ?? null,
          },
        }),
      };
    }

    let previousGraph: WorkspaceGraph | null = null;
    let pendingPublish: (() => void) | null = null;
    try {
      operation.signal.throwIfAborted();

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

      previousGraph = this.context.getGraph();
      if (!this.canAcceptOutgoingRetention(previousGraph, canonical)) {
        return {
          error: createHostError(
            "AGENT_BUSY",
            "Too many workspaces are still running. Stop one before switching.",
            { retryable: true },
          ),
        };
      }
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
        signal: operation.signal,
      });
      if (reactivated) {
        pendingPublish = reactivated.publish;
        return {
          workspace: reactivated.workspace,
          ...(reactivated.session ? { session: reactivated.session } : {}),
        };
      }

      if (previousGraph) this.suspendGraphProviders(previousGraph);
      const built = await this.buildServices({
        workspaceId,
        cwd,
        canonicalCwd: canonical,
        revision,
        sessionRevision: candidateSessionRevision,
        packageRevision: candidatePackageRevision,
        ...bootstrap,
      });
      if (operation.signal.aborted) {
        if ("graph" in built) await this.disposeGraph(built.graph);
        operation.signal.throwIfAborted();
      }
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
          signal: operation.signal,
        });
        return { error: built.error };
      }

      const previousIdentity = server.getIdentity();
      server.identity.workspaceId = workspaceId;
      server.identity.workspaceRevision = revision;
      server.identity.sessionId = built.graph.sessionSnapshot?.sessionId ?? null;
      server.identity.sessionRevision = candidateSessionRevision;
      server.identity.packageRevision = candidatePackageRevision;
      this.context.setGraph(built.graph);

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
          this.resumeGraphProviders(previousGraph);
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

      if (previousGraph) await this.retainGraph(previousGraph, operation.signal);
      if (previousIdentity.sessionId && previousIdentity.sessionId !== server.identity.sessionId) {
        await this.context.deps.attachmentStore?.discardSessionDrafts(previousIdentity.sessionId);
      }
      server.setPhase("ready");
      server.setLastError(undefined);
      const workspace = this.buildWorkspaceSnapshot(built.graph);
      pendingPublish = () => {
        this.publishWorkspaceSnapshots(server, built.graph, workspace);
        publishExtensionUi();
      };
      return {
        workspace,
        ...(built.graph.sessionSnapshot ? { session: built.graph.sessionSnapshot } : {}),
      };
    } catch (err) {
      pendingPublish = null;
      if (previousGraph && this.context.getGraph() === previousGraph) {
        this.resumeGraphProviders(previousGraph);
      }
      return {
        error: createHostError(
          "WORKSPACE_SWITCH_FAILED",
          err instanceof Error ? err.message : "Workspace switch cancelled",
          { retryable: operation.signal.aborted },
        ),
      };
    } finally {
      server.serviceGraphLock.release(requestId);
      operation.finish();
      // Desktop refreshes session.list / session.open as soon as
      // workspace.changed lands. Publish only after the lock is free so those
      // reads are not rejected as SERVICE_GRAPH_BUSY.
      try {
        pendingPublish?.();
      } catch (err) {
        logger.warn("Failed to publish Workspace snapshots after switch", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private retainedGraphKey(canonicalCwd: string): string {
    return workspaceIdentityKey(canonicalCwd, this.context.platform);
  }

  private async retainedGraphFingerprint(
    graph: WorkspaceGraph,
    signal?: AbortSignal,
  ): Promise<string> {
    const roots = new Set<string>([
      join(this.context.deps.agentDir, "settings.json"),
      join(this.context.deps.agentDir, "models.json"),
      join(this.context.deps.agentDir, "models-store.json"),
      join(this.context.deps.agentDir, "auth.json"),
    ]);
    for (const directory of ["packages", "npm", "git"]) {
      roots.add(join(this.context.deps.agentDir, directory));
    }
    const markers: string[] = [];
    if (graph.packageManager) {
      try {
        for (const item of graph.packageManager.listConfiguredPackages()) {
          const installedPath =
            item.installedPath ?? graph.packageManager.getInstalledPath(item.source, item.scope);
          if (installedPath) roots.add(installedPath);
        }
      } catch {
        markers.push("configured:error");
      }
    } else {
      markers.push("packageManager:null");
    }
    return captureFilesystemFingerprint({ roots, markers, signal });
  }

  private graphHasBusySessions(graph: WorkspaceGraph): boolean {
    return this.sessionRuntimeCache.graphHasBusySessions(graph);
  }

  private willRetainGraph(graph: WorkspaceGraph): boolean {
    if (!graph.servicesReady || !graph.agentSession) return false;
    if (this.graphHasBusySessions(graph)) return true;
    return graph.backgroundSessions.size === 0;
  }

  private oldestIdleRetainedKey(): string | undefined {
    for (const [key, graph] of this.retainedGraphs) {
      if (!this.graphHasBusySessions(graph)) return key;
    }
    return undefined;
  }

  private canAcceptOutgoingRetention(
    previousGraph: WorkspaceGraph | null,
    targetCanonical: string,
  ): boolean {
    if (!previousGraph || !this.willRetainGraph(previousGraph)) return true;
    if (this.retainedGraphs.has(this.retainedGraphKey(targetCanonical))) return true;
    if (this.retainedGraphs.size < WorkspaceLifecycle.MAX_RETAINED_GRAPHS) return true;
    return this.oldestIdleRetainedKey() !== undefined;
  }

  private detachExtensionUi(graph: WorkspaceGraph): void {
    graph.extensionUiActivate = null;
    try {
      graph.extensionUiCleanup?.();
    } catch {
      /* ignore */
    }
    graph.extensionUiCleanup = null;
    graph.extensionUiUpdateIdentity = null;
    graph.extensionUiReplayState = null;
  }

  private async retainGraph(graph: WorkspaceGraph, signal?: AbortSignal): Promise<void> {
    if (!this.willRetainGraph(graph)) {
      await this.disposeGraph(graph);
      return;
    }
    const busy = this.graphHasBusySessions(graph);
    if (!busy) {
      graph.unsubscribeAgent?.();
      graph.unsubscribeAgent = null;
    }
    this.detachExtensionUi(graph);
    // The switch path may already have parked this owner before building the
    // incoming graph. Preserve that pre-merge snapshot when retention finishes.
    this.suspendGraphProviders(graph);
    try {
      graph.retainedFingerprint = await this.retainedGraphFingerprint(graph, signal);
    } catch (error) {
      graph.retainedFingerprint = undefined;
      if (this.context.getGraph() !== graph) await this.disposeGraph(graph);
      throw error;
    }

    const key = this.retainedGraphKey(graph.canonicalCwd);
    const existing = this.retainedGraphs.get(key);
    this.retainedGraphs.delete(key);
    if (existing && existing !== graph) await this.disposeGraph(existing);
    this.retainedGraphs.set(key, graph);
    while (this.retainedGraphs.size > WorkspaceLifecycle.MAX_RETAINED_GRAPHS) {
      const oldestKey = this.oldestIdleRetainedKey();
      if (oldestKey === undefined) break;
      const evicted = this.retainedGraphs.get(oldestKey);
      this.retainedGraphs.delete(oldestKey);
      if (evicted) await this.disposeGraph(evicted);
    }
  }

  private takeRetainedGraph(canonicalCwd: string): WorkspaceGraph | null {
    const key = this.retainedGraphKey(canonicalCwd);
    const graph = this.retainedGraphs.get(key) ?? null;
    if (
      graph &&
      !workspaceCanonicalPathsEqual(graph.canonicalCwd, canonicalCwd, this.context.platform)
    ) {
      logger.warn("Retained Workspace identity mismatch", {
        requestedCwd: canonicalCwd,
        retainedCwd: graph.canonicalCwd,
      });
      return null;
    }
    this.retainedGraphs.delete(key);
    return graph;
  }

  private async tryReactivateRetainedGraph(args: {
    canonical: string;
    previousGraph: WorkspaceGraph | null;
    revision: number;
    sessionRevision: number;
    packageRevision: number;
    signal?: AbortSignal;
  }): Promise<{
    workspace: WorkspaceSnapshot;
    session?: SessionSnapshot;
    publish: () => void;
  } | null> {
    const server = this.context.getServer();
    if (!server) return null;
    const graph = this.takeRetainedGraph(args.canonical);
    if (!graph) return null;

    const retainedFingerprint = graph.retainedFingerprint;
    graph.retainedFingerprint = undefined;
    if (!retainedFingerprint) {
      logger.info("Retained workspace changed on disk; rebuilding", {
        cwd: args.canonical,
      });
      await this.disposeGraph(graph);
      return null;
    }

    let currentFingerprint: string;
    try {
      currentFingerprint = await this.retainedGraphFingerprint(graph, args.signal);
    } catch (err) {
      await this.disposeGraph(graph);
      throw err;
    }
    if (retainedFingerprint !== currentFingerprint) {
      if (this.graphHasBusySessions(graph)) {
        logger.warn("Retained workspace changed on disk; keeping live runtimes", {
          cwd: args.canonical,
        });
      } else {
        logger.info("Retained workspace changed on disk; rebuilding", {
          cwd: args.canonical,
        });
        await this.disposeGraph(graph);
        return null;
      }
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

    // The incoming owner must never re-register while the outgoing owner is
    // still present: ModelRuntime merges same-id extension Provider configs.
    if (args.previousGraph) this.suspendGraphProviders(args.previousGraph);
    this.resumeGraphProviders(graph);
    const candidateIdentity: HostIdentity = {
      hostInstanceId: server.identity.hostInstanceId,
      workspaceId: graph.workspaceId,
      workspaceRevision: args.revision,
      sessionId,
      sessionRevision: args.sessionRevision,
      packageRevision: args.packageRevision,
    };

    try {
      // The graph is not active yet, so a session_start handler registering a
      // provider would otherwise be attributed to the outgoing workspace.
      const binding = graph.providerOwner
        ? await this.context.deps.providerOwnership.runAsOwner(graph.providerOwner, () =>
            bindForCandidate(
              session,
              graph.extensionsResult,
              server,
              candidateIdentity,
              this.context.getCommandContextActions?.(session),
            ),
          )
        : await bindForCandidate(
            session,
            graph.extensionsResult,
            server,
            candidateIdentity,
            this.context.getCommandContextActions?.(session),
          );
      graph.extensionUiActivate = binding.activate;
      graph.extensionUiCleanup = binding.cleanup;
      graph.extensionUiUpdateIdentity = binding.updateIdentity;
      graph.extensionUiReplayState = binding.replayState;
      binding.updateIdentity(candidateIdentity);
      graph.packageSnapshot = await buildPackageSnapshot({
        revision: args.packageRevision,
        workspaceId: graph.workspaceId,
        scope: "user",
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
      if (!graph.unsubscribeAgent) {
        graph.unsubscribeAgent = session.subscribe((event) => {
          this.sessionRuntimeCache.handleAgentEvent(graph, session, event);
        });
      }
    } catch (err) {
      logger.warn("retained graph preparation failed; rebuilding workspace", {
        cwd: args.canonical,
        error: err instanceof Error ? err.message : String(err),
      });
      await this.disposeGraph(graph);
      args.signal?.throwIfAborted();
      return null;
    }

    if (args.signal?.aborted) {
      await this.disposeGraph(graph);
      args.signal.throwIfAborted();
    }

    const previousIdentity = server.getIdentity();
    graph.revision = args.revision;
    server.identity.workspaceId = graph.workspaceId;
    server.identity.workspaceRevision = args.revision;
    server.identity.sessionId = sessionId;
    server.identity.sessionRevision = args.sessionRevision;
    server.identity.packageRevision = args.packageRevision;
    this.context.setGraph(graph);

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

    if (args.previousGraph) await this.retainGraph(args.previousGraph, args.signal);
    if (previousIdentity.sessionId && previousIdentity.sessionId !== server.identity.sessionId) {
      await this.context.deps.attachmentStore?.discardSessionDrafts(previousIdentity.sessionId);
    }
    server.setPhase("ready");
    server.setLastError(undefined);
    const workspace = this.buildWorkspaceSnapshot(graph);
    return {
      workspace,
      ...(graph.sessionSnapshot ? { session: graph.sessionSnapshot } : {}),
      publish: () => {
        this.publishWorkspaceSnapshots(server, graph, workspace);
        publishExtensionUi();
      },
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
    signal?: AbortSignal;
  }): Promise<WorkspaceSnapshot> {
    const server = this.context.getServer()!;
    if (args.previousGraph) await this.retainGraph(args.previousGraph, args.signal);
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
      extensionUiReplayState: null,
      resourceReloadRequired: false,
      backgroundSessions: new Map(),
      providerOwner: null,
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
    sessionPath?: string;
    continueRecent?: boolean;
  }): Promise<{ graph: WorkspaceGraph } | { error: HostError }> {
    const server = this.context.getServer()!;
    const { agentDir, modelRuntime } = this.context.deps;
    let candidateSession: AgentSession | null = null;
    let candidateExtensionUiCleanup: (() => void) | null = null;
    let candidateUnsubscribeAgent: (() => void) | null = null;
    let candidateProviderOwner: ProviderOwnerToken | null = null;
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
        projectTrusted: false,
      });
      const packageManager = new DefaultPackageManager({
        cwd: args.canonicalCwd,
        agentDir,
        settingsManager,
        env: getInternalRuntime().env,
      });
      const cache = this.context.deps.userResourceCache;
      if (!cache) {
        throw new Error("User resource cache is required");
      }
      const resourceLoader = await cache.createWorkspaceLoader({
        cwd: args.canonicalCwd,
        settingsManager,
      });
      markStep("resourceLoader.reload");
      const sessionManager = await createWorkspaceSessionManager(args.canonicalCwd, {
        sessionPath: args.sessionPath,
        continueRecent: args.continueRecent,
      });
      await Promise.resolve(this.context.deps.refreshModelHealth());
      this.context.onModelHealthChanged();
      markStep("refreshModelHealth");

      // createAgentSession flushes the extension loader's queued
      // pi.registerProvider calls into the shared runtime; the owner scope
      // attributes them to this workspace even if another graph's agent turn
      // interleaves on the event loop.
      const providerOwner = this.context.deps.providerOwnership.createOwner(
        `workspace:${args.canonicalCwd}`,
      );
      candidateProviderOwner = providerOwner;
      const { session, extensionsResult } = await this.context.deps.providerOwnership.runAsOwner(
        providerOwner,
        () =>
          createHostAgentSession({
            cwd: args.canonicalCwd,
            agentDir,
            modelRuntime,
            settingsManager,
            resourceLoader,
            sessionManager,
            ...(this.context.deps.attachmentStore
              ? { customTools: [createReadAttachmentTool(this.context.deps.attachmentStore)] }
              : {}),
          }),
      );
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
        extensionUiReplayState: null,
        resourceReloadRequired: false,
        backgroundSessions: new Map(),
        providerOwner,
      };
      const candidateIdentity: HostIdentity = {
        hostInstanceId: server.identity.hostInstanceId,
        workspaceId: args.workspaceId,
        workspaceRevision: args.revision,
        sessionId,
        sessionRevision: args.sessionRevision,
        packageRevision: args.packageRevision,
      };
      // Still pre-activation: a session_start handler registering a provider
      // must land on this candidate workspace, not the outgoing one.
      const extensionUiBinding = await this.context.deps.providerOwnership.runAsOwner(
        providerOwner,
        () =>
          bindForCandidate(
            session,
            extensionsResult,
            server,
            candidateIdentity,
            this.context.getCommandContextActions?.(session),
          ),
      );
      graph.extensionUiActivate = extensionUiBinding.activate;
      graph.extensionUiCleanup = extensionUiBinding.cleanup;
      graph.extensionUiUpdateIdentity = extensionUiBinding.updateIdentity;
      graph.extensionUiReplayState = extensionUiBinding.replayState;
      candidateExtensionUiCleanup = extensionUiBinding.cleanup;
      graph.unsubscribeAgent = session.subscribe((event) => {
        this.sessionRuntimeCache.handleAgentEvent(graph, session, event);
      });
      candidateUnsubscribeAgent = graph.unsubscribeAgent;
      markStep("bindExtensionUi");

      graph.packageSnapshot = await buildPackageSnapshot({
        revision: args.packageRevision,
        workspaceId: args.workspaceId,
        scope: "user",
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
      if (candidateProviderOwner) {
        this.context.deps.providerOwnership.releaseOwner(candidateProviderOwner);
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
