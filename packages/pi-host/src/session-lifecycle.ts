import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  createHostError,
  type HostError,
  type HostIdentity,
  type SessionSnapshot,
} from "@pideck/protocol";
import { logger } from "./logger.js";
import { buildSessionSnapshot } from "./session-snapshot.js";
import { bindForCandidate } from "./extension-ui-lifecycle.js";
import { type GraphOperationKind } from "./locks.js";
import {
  extractLatestAssistantText,
  generateRefinedSessionTitle,
} from "./session-title.js";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";
import type { ManagedSessionInfo, WorkspaceGraph } from "./workspace-graph-types.js";
import {
  captureActiveSessionState,
  commitActiveSessionState,
} from "./session-runtime-cache.js";
import { sessionStorageDirs as resolveSessionStorageDirs } from "./session-storage.js";

function sessionStorageDirs(factory: WorkspaceGraphFactory, g: WorkspaceGraph) {
  return resolveSessionStorageDirs(factory.deps.agentDir, g.canonicalCwd);
}

async function listSessionFiles(
  factory: WorkspaceGraphFactory,
  g: WorkspaceGraph,
  archived: boolean,
): Promise<ManagedSessionInfo[]> {
  const dirs = sessionStorageDirs(factory, g);
  const dir = archived ? dirs.archiveDir : dirs.activeDir;
  const sessions = await SessionManager.list(g.canonicalCwd, dir);
  return sessions.map((session) => ({ ...session, archived }));
}

export async function listSessions(
  factory: WorkspaceGraphFactory,
): Promise<ManagedSessionInfo[]> {
  const g = factory.graph;
  if (!g || !g.servicesReady) return [];
  const [active, archived] = await Promise.all([
    listSessionFiles(factory, g, false),
    listSessionFiles(factory, g, true),
  ]);
  return [...active, ...archived].sort(
    (left, right) => right.modified.getTime() - left.modified.getTime(),
  );
}

async function withSessionFileMutation<T>(
  factory: WorkspaceGraphFactory,
  requestId: string,
  operationKind: GraphOperationKind,
  run: (g: WorkspaceGraph) => Promise<T | { error: HostError }>,
): Promise<T | { error: HostError }> {
  const server = factory.server;
  const g = factory.graph;
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

export async function archiveSession(
  factory: WorkspaceGraphFactory,
  requestId: string,
  sessionId: string,
  sessionPath: string,
): Promise<
  { sessionId: string; sessionPath: string; archived: true } | { error: HostError }
> {
  return withSessionFileMutation(factory, requestId, "session.archive", async (g) => {
    const session = (await listSessionFiles(factory, g, false)).find(
      (item) => item.id === sessionId && factory.sessionPathsEqual(item.path, sessionPath),
    );
    if (!session) {
      return { error: createHostError("SESSION_NOT_FOUND", "Session is not active") };
    }
    if (factory.getSessionRuntimeInfo(session.id, session.path)) {
      return {
        error: createHostError(
          "AGENT_BUSY",
          "Switch away from the Session and wait for its run to finish before archiving",
          { retryable: true },
        ),
      };
    }
    await factory.disposeRetainedSessionRuntimeIfPresent(g, session.id, session.path);
    const { archiveDir } = sessionStorageDirs(factory, g);
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

export async function restoreSession(
  factory: WorkspaceGraphFactory,
  requestId: string,
  sessionId: string,
  sessionPath: string,
): Promise<
  { sessionId: string; sessionPath: string; archived: false } | { error: HostError }
> {
  return withSessionFileMutation(factory, requestId, "session.restore", async (g) => {
    const session = (await listSessionFiles(factory, g, true)).find(
      (item) => item.id === sessionId && factory.sessionPathsEqual(item.path, sessionPath),
    );
    if (!session) {
      return { error: createHostError("SESSION_NOT_FOUND", "Archived Session not found") };
    }
    const { activeDir } = sessionStorageDirs(factory, g);
    const restoredPath = join(activeDir, basename(session.path));
    if (existsSync(restoredPath)) {
      return {
        error: createHostError(
          "SESSION_SWITCH_FAILED",
          "A Session with the same file name already exists",
        ),
      };
    }
    await factory.disposeRetainedSessionRuntimeIfPresent(g, session.id, session.path);
    await rename(session.path, restoredPath);
    return { sessionId, sessionPath: restoredPath, archived: false as const };
  });
}

export async function deleteSession(
  factory: WorkspaceGraphFactory,
  requestId: string,
  sessionId: string,
  sessionPath: string,
): Promise<{ sessionId: string; deleted: true } | { error: HostError }> {
  return withSessionFileMutation(factory, requestId, "session.delete", async (g) => {
    const [activeSessions, archivedSessions] = await Promise.all([
      listSessionFiles(factory, g, false),
      listSessionFiles(factory, g, true),
    ]);
    const session = [...activeSessions, ...archivedSessions].find(
      (item) => item.id === sessionId && factory.sessionPathsEqual(item.path, sessionPath),
    );
    if (!session) {
      return { error: createHostError("SESSION_NOT_FOUND", "Session not found") };
    }
    if (
      g.sessionSnapshot?.sessionId === sessionId &&
      factory.sessionPathsEqual(g.sessionSnapshot.sessionPath, sessionPath)
    ) {
      return {
        error: createHostError(
          "AGENT_BUSY",
          "Switch away from the active Session before deleting it",
          { retryable: true },
        ),
      };
    }
    const runtime = await factory.disposeBackgroundSessionRuntimeIfIdle(
      g,
      sessionId,
      sessionPath,
    );
    if (runtime === "busy") {
      return {
        error: createHostError("AGENT_BUSY", "Wait for the Session run to finish", {
          retryable: true,
        }),
      };
    }
    await factory.disposeRetainedSessionRuntimeIfPresent(g, sessionId, sessionPath);
    await unlink(session.path);
    return { sessionId, deleted: true as const };
  });
}

export async function cleanupArchivedSessions(
  factory: WorkspaceGraphFactory,
  requestId: string,
): Promise<{ deletedCount: number; failedCount: number } | { error: HostError }> {
  return withSessionFileMutation(factory, requestId, "session.cleanup", async (g) => {
    const sessions = await listSessionFiles(factory, g, true);
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

export async function renameSession(
  factory: WorkspaceGraphFactory,
  requestId: string,
  sessionId: string,
  sessionPath: string,
  name: string,
): Promise<
  { sessionId: string; name: string; session?: SessionSnapshot } | { error: HostError }
> {
  return withSessionFileMutation(factory, requestId, "session.rename", async (g) => {
    const [activeSessions, archivedSessions] = await Promise.all([
      listSessionFiles(factory, g, false),
      listSessionFiles(factory, g, true),
    ]);
    const target = [...activeSessions, ...archivedSessions].find(
      (item) =>
        item.id === sessionId && factory.sessionPathsEqual(item.path, sessionPath),
    );
    if (!target) {
      return { error: createHostError("SESSION_NOT_FOUND", "Session not found") };
    }

    const isActive = Boolean(
      g.sessionSnapshot?.sessionId === sessionId &&
        factory.sessionPathsEqual(g.sessionSnapshot.sessionPath, sessionPath),
    );
    if (isActive) {
      if (
        !g.agentSession ||
        !g.agentSession.isIdle ||
        factory.getSessionOperationLock(g.agentSession).isHeld()
      ) {
        return {
          error: createHostError("AGENT_BUSY", "Wait for the Session run to finish", {
            retryable: true,
          }),
        };
      }
      const snapshot = factory.setActiveSessionName(name);
      if (!snapshot) {
        return { error: createHostError("AGENT_NOT_READY", "No active session") };
      }
      return {
        sessionId,
        name: snapshot.name ?? name,
        session: snapshot,
      };
    }

    if (factory.getSessionRuntimeInfo(target.id, target.path)) {
      return {
        error: createHostError("AGENT_BUSY", "Wait for the Session run to finish", {
          retryable: true,
        }),
      };
    }
    await factory.disposeRetainedSessionRuntimeIfPresent(g, target.id, target.path);
    const sessionManager = SessionManager.open(target.path, undefined, g.canonicalCwd);
    sessionManager.appendSessionInfo(name);
    return { sessionId, name: sessionManager.getSessionName() ?? name };
  });
}

/** Caller owns the relevant graph/agent lock. */
export function setActiveSessionName(
  factory: WorkspaceGraphFactory,
  name: string,
): SessionSnapshot | null {
  const server = factory.server;
  const g = factory.graph;
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

export async function refineActiveSessionName(
  factory: WorkspaceGraphFactory,
  args: {
    session: AgentSession;
    sessionId: string;
    provisionalTitle: string;
    userPrompt: string;
  },
): Promise<void> {
  const initialGraph = factory.graph;
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
      modelRegistry: factory.deps.modelRegistry,
      userPrompt: args.userPrompt,
      assistantText: extractLatestAssistantText(args.session.messages),
    });
  } catch (err) {
    logger.warn("session title refinement failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const server = factory.server;
  const currentGraph = factory.graph;
  if (
    !server ||
    currentGraph !== initialGraph ||
    currentGraph.agentSession !== args.session ||
    server.identity.sessionId !== args.sessionId ||
    args.session.sessionName !== args.provisionalTitle ||
    refinedTitle === args.provisionalTitle ||
    !args.session.isIdle ||
    factory.getSessionOperationLock(args.session).isHeld() ||
    server.serviceGraphLock.isHeld()
  ) {
    return;
  }
  setActiveSessionName(factory, refinedTitle);
}

async function createSessionResourceLoader(
  factory: WorkspaceGraphFactory,
  g: WorkspaceGraph,
): Promise<DefaultResourceLoader> {
  const resourceLoader = new DefaultResourceLoader({
    cwd: g.canonicalCwd,
    agentDir: factory.deps.agentDir,
    settingsManager: g.settingsManager!,
  });
  await resourceLoader.reload();
  return resourceLoader;
}

/**
 * Create a new AgentSession in the current workspace (replaces active session).
 */
export async function createSession(
  factory: WorkspaceGraphFactory,
  requestId: string,
  name?: string,
): Promise<SessionSnapshot | { error: HostError }> {
  const server = factory.server;
  const g = factory.graph;
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
    const prev = captureActiveSessionState(g, server.identity);

    const sessionManager = SessionManager.create(g.canonicalCwd);
    if (name) {
      sessionManager.appendSessionInfo(name);
    }
    await Promise.resolve(factory.deps.refreshModelHealth());
    factory.onModelHealthChanged?.();
    const candidateResourceLoader = await createSessionResourceLoader(factory, g);

    const created = await createAgentSession({
      cwd: g.canonicalCwd,
      agentDir: factory.deps.agentDir,
      authStorage: factory.deps.authStorage,
      modelRegistry: factory.deps.modelRegistry,
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
      const extensionUiBinding = await bindForCandidate(
        session,
        extensionsResult,
        server,
        candidateIdentity,
      );
      extensionUiActivate = extensionUiBinding.activate;
      extensionUiCleanup = extensionUiBinding.cleanup;
      extensionUiUpdateIdentity = extensionUiBinding.updateIdentity;
      unsubscribeAgent = session.subscribe((event) => {
        factory.handleAgentEvent(g, session, event);
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
        await factory.disposeAgentSessionOnly(session);
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

    const retainedPrevious = factory.retainBusySession(g, prev);

    // Temporarily commit candidate identity so blocking Extension UI can respond,
    // but do not publish a ready Session until bindExtensions has completed.
    commitActiveSessionState(g, server.identity, {
      sessionManager,
      agentSession: session,
      extensionsResult,
      resourceLoader: candidateResourceLoader,
      toolRevision: 1,
      sessionSnapshot,
      extensionUiActivate,
      extensionUiCleanup,
      extensionUiUpdateIdentity,
      unsubscribeAgent,
      sessionId,
      sessionRevision,
    });

    let publishExtensionUi = () => {};
    try {
      publishExtensionUi = await factory.activateExtensionUi(g);
    } catch (bindErr) {
      if (retainedPrevious) {
        g.backgroundSessions.delete(retainedPrevious.sessionId);
      }
      try {
        unsubscribeAgent?.();
      } catch {
        /* ignore */
      }
      await factory.disposeAgentSessionOnly(session);
      commitActiveSessionState(g, server.identity, prev);
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

    if (!retainedPrevious) {
      const retainedIdle = prev.agentSession?.isIdle
        ? await factory.retainIdleSession(g, prev)
        : null;
      if (!retainedIdle) {
        try {
          prev.extensionUiCleanup?.();
        } catch {
          /* ignore */
        }
        try {
          prev.unsubscribeAgent?.();
        } catch {
          /* ignore */
        }
        if (prev.agentSession) {
          try {
            await factory.disposeAgentSessionOnly(prev.agentSession);
          } catch {
            /* ignore */
          }
        }
      }
    }

    candidateSession = null;
    extensionUiActivate = null;
    extensionUiCleanup = null;
    extensionUiUpdateIdentity = null;
    unsubscribeAgent = null;

    server.emit("session.snapshot", sessionSnapshot);
    server.emit("agent.toolsChanged", sessionSnapshot.tools);
    if (retainedPrevious) factory.announceRetainedRuntime(retainedPrevious);
    publishExtensionUi();
    return sessionSnapshot;
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
      await factory.disposeAgentSessionOnly(candidateSession);
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

export async function openSession(
  factory: WorkspaceGraphFactory,
  requestId: string,
  sessionPath: string,
  options: { forceReload?: boolean } = {},
): Promise<SessionSnapshot | { error: HostError }> {
  const server = factory.server;
  const g = factory.graph;
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
        factory.sessionPathsEqual(g.sessionSnapshot.sessionPath, sessionPath),
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
        factory.getSessionOperationLock(g.agentSession).isHeld()
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
      factory.sessionPathsEqual(runtime.sessionSnapshot.sessionPath, sessionPath),
    );
    if (retained) {
      return await factory.promoteBackgroundRuntime(g, retained);
    }
    const retainedIdle = [...(g.retainedSessions?.values() ?? [])].find((runtime) =>
      factory.sessionPathsEqual(runtime.sessionSnapshot.sessionPath, sessionPath),
    );
    if (retainedIdle) {
      const promoted = await factory.promoteRetainedSessionRuntime(g, retainedIdle);
      if (promoted !== null) return promoted;
    }

    const sessionManager = SessionManager.open(sessionPath, undefined, g.canonicalCwd);
    let candidateSession: AgentSession | null = null;
    let candidateExtensionUiCleanup: (() => void) | null = null;
    let candidateExtensionUiUpdateIdentity: ((identity: HostIdentity) => void) | null = null;
    let candidateUnsubscribeAgent: (() => void) | null = null;
    try {
      await Promise.resolve(factory.deps.refreshModelHealth());
      factory.onModelHealthChanged?.();
      const candidateResourceLoader = await createSessionResourceLoader(factory, g);

      const created = await createAgentSession({
        cwd: g.canonicalCwd,
        agentDir: factory.deps.agentDir,
        authStorage: factory.deps.authStorage,
        modelRegistry: factory.deps.modelRegistry,
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
      const extensionUiBinding = await bindForCandidate(
        session,
        extensionsResult,
        server,
        candidateIdentity,
      );
      const candidateExtensionUiActivate = extensionUiBinding.activate;
      candidateExtensionUiCleanup = extensionUiBinding.cleanup;
      candidateExtensionUiUpdateIdentity = extensionUiBinding.updateIdentity;
      candidateUnsubscribeAgent = session.subscribe((event) => {
        factory.handleAgentEvent(g, session, event);
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

      const prev = captureActiveSessionState(g, server.identity);

      const retainedPrevious = factory.retainBusySession(g, prev);

      commitActiveSessionState(g, server.identity, {
        sessionManager,
        agentSession: session,
        extensionsResult,
        resourceLoader: candidateResourceLoader,
        toolRevision: 1,
        sessionSnapshot,
        extensionUiActivate: candidateExtensionUiActivate,
        extensionUiCleanup: candidateExtensionUiCleanup,
        extensionUiUpdateIdentity: candidateExtensionUiUpdateIdentity,
        unsubscribeAgent: candidateUnsubscribeAgent,
        sessionId,
        sessionRevision,
      });

      let publishExtensionUi = () => {};
      try {
        publishExtensionUi = await factory.activateExtensionUi(g);
      } catch (bindErr) {
        if (retainedPrevious) {
          g.backgroundSessions.delete(retainedPrevious.sessionId);
        }
        try {
          candidateUnsubscribeAgent?.();
        } catch {
          /* ignore */
        }
        await factory.disposeAgentSessionOnly(session);
        commitActiveSessionState(g, server.identity, prev);
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
        const retainedIdle = prev.agentSession?.isIdle
          ? await factory.retainIdleSession(g, prev)
          : null;
        if (!retainedIdle) {
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
            await factory.disposeAgentSessionOnly(prev.agentSession);
          }
        }
      }

      candidateSession = null;
      candidateExtensionUiCleanup = null;
      candidateExtensionUiUpdateIdentity = null;
      candidateUnsubscribeAgent = null;
      server.emit("session.snapshot", sessionSnapshot);
      server.emit("agent.toolsChanged", sessionSnapshot.tools);
      if (retainedPrevious) factory.announceRetainedRuntime(retainedPrevious);
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
        await factory.disposeAgentSessionOnly(candidateSession);
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

export async function reloadSession(
  factory: WorkspaceGraphFactory,
  requestId: string,
): Promise<SessionSnapshot | { error: HostError }> {
  const sessionPath = factory.graph?.sessionSnapshot?.sessionPath;
  if (!sessionPath) {
    return {
      error: createHostError(
        "SESSION_NOT_FOUND",
        "The active Session has not been persisted to disk yet",
      ),
    };
  }
  return openSession(factory, requestId, sessionPath, { forceReload: true });
}
