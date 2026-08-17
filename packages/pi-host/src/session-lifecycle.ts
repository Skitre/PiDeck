import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  AgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  createHostError,
  stripAttachmentReferenceBlocks,
  type HostError,
  type HostIdentity,
  type SessionSnapshot,
} from "@pideck/protocol";
import { logger } from "./logger.js";
import { buildSessionSnapshot } from "./session-snapshot.js";
import { getQueueSnapshot } from "./queue-state.js";
import { bindForCandidate } from "./extension-ui-lifecycle.js";
import { type GraphOperationKind } from "./locks.js";
import { extractLatestAssistantText, generateRefinedSessionTitle } from "./session-title.js";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";
import type { ManagedSessionInfo, WorkspaceGraph } from "./workspace-graph-types.js";
import {
  captureActiveSessionState,
  commitActiveSessionState,
  MAX_LIVE_SESSIONS,
} from "./session-runtime-cache.js";
import { sessionStorageDirs as resolveSessionStorageDirs } from "./session-storage.js";
import { withoutImplicitPackageInstall } from "./offline-package-resolution.js";
import { createReadAttachmentTool } from "./attachment-tool.js";
import { createHostAgentSession } from "./agent-session-factory.js";

function sessionStorageDirs(factory: WorkspaceGraphFactory, g: WorkspaceGraph) {
  return resolveSessionStorageDirs(factory.deps.agentDir, g.canonicalCwd);
}

const SESSION_FILE_ID = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

function sessionIdFromSessionPath(sessionPath: string): string | undefined {
  const match = basename(sessionPath).match(SESSION_FILE_ID);
  return match?.[1];
}

function findRetainedRuntime(
  factory: WorkspaceGraphFactory,
  graph: WorkspaceGraph,
  sessionPath: string,
) {
  const byPath = [...graph.backgroundSessions.values()].find((runtime) =>
    factory.sessionPathsEqual(runtime.sessionSnapshot.sessionPath, sessionPath),
  );
  if (byPath) return byPath;
  const sessionId = sessionIdFromSessionPath(sessionPath);
  return sessionId ? graph.backgroundSessions.get(sessionId) : undefined;
}

function isCurrentSessionPath(
  factory: WorkspaceGraphFactory,
  graph: WorkspaceGraph,
  sessionPath: string,
): boolean {
  const snapshot = graph.sessionSnapshot;
  if (!snapshot) return false;
  if (factory.sessionPathsEqual(snapshot.sessionPath, sessionPath)) return true;
  const sessionId = sessionIdFromSessionPath(sessionPath);
  return Boolean(sessionId && snapshot.sessionId === sessionId);
}

function sessionLimitError(): { error: HostError } {
  return {
    error: createHostError(
      "SESSION_LIMIT",
      `This workspace already has ${MAX_LIVE_SESSIONS} live sessions; stop one before opening another`,
      { retryable: false, details: { maxLiveSessions: MAX_LIVE_SESSIONS } },
    ),
  };
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

function sessionHasStarted(snapshot: SessionSnapshot): boolean {
  return (
    snapshot.messages.length > 0 ||
    !snapshot.isIdle ||
    snapshot.isStreaming ||
    snapshot.isCompacting ||
    snapshot.isRetrying
  );
}

function listEntryFromSnapshot(snapshot: SessionSnapshot): ManagedSessionInfo | null {
  if (!snapshot.sessionPath || !sessionHasStarted(snapshot)) return null;
  return {
    id: snapshot.sessionId,
    path: snapshot.sessionPath,
    cwd: snapshot.cwd,
    modified: new Date(),
    messageCount: snapshot.messages.length,
    archived: false,
    ...(snapshot.name ? { name: snapshot.name } : {}),
  } as ManagedSessionInfo;
}

function collectStartedLiveSessions(graph: WorkspaceGraph): ManagedSessionInfo[] {
  const entries: ManagedSessionInfo[] = [];
  if (graph.sessionSnapshot) {
    const entry = listEntryFromSnapshot(graph.sessionSnapshot);
    if (entry) entries.push(entry);
  }
  for (const runtime of graph.backgroundSessions.values()) {
    const entry = listEntryFromSnapshot(runtime.sessionSnapshot);
    if (entry) entries.push(entry);
  }
  return entries;
}

function mergeStartedLiveSessions(
  factory: WorkspaceGraphFactory,
  disk: ManagedSessionInfo[],
  live: ManagedSessionInfo[],
): ManagedSessionInfo[] {
  const merged = [...disk];
  for (const entry of live) {
    const index = merged.findIndex(
      (item) => item.id === entry.id || factory.sessionPathsEqual(item.path, entry.path),
    );
    if (index === -1) {
      merged.push(entry);
      continue;
    }
    const existing = merged[index]!;
    merged[index] = {
      ...existing,
      ...(entry.name ? { name: entry.name } : {}),
      messageCount: Math.max(existing.messageCount ?? 0, entry.messageCount ?? 0),
    };
  }
  return merged.sort((left, right) => right.modified.getTime() - left.modified.getTime());
}

export async function listSessions(factory: WorkspaceGraphFactory): Promise<ManagedSessionInfo[]> {
  const g = factory.graph;
  if (!g || !g.servicesReady) return [];
  const [active, archived] = await Promise.all([
    listSessionFiles(factory, g, false),
    listSessionFiles(factory, g, true),
  ]);
  return mergeStartedLiveSessions(factory, [...active, ...archived], collectStartedLiveSessions(g));
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
  const operation = server.graphOperations.begin({
    operationKind,
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
  if (!server.serviceGraphLock.tryAcquire({ operationKind, requestId })) {
    operation.finish();
    return {
      error: createHostError("SERVICE_GRAPH_BUSY", "Service graph is busy", {
        retryable: true,
      }),
    };
  }
  try {
    operation.signal.throwIfAborted();
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
    operation.finish();
  }
}

export async function archiveSession(
  factory: WorkspaceGraphFactory,
  requestId: string,
  sessionId: string,
  sessionPath: string,
): Promise<{ sessionId: string; sessionPath: string; archived: true } | { error: HostError }> {
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
    const { archiveDir } = sessionStorageDirs(factory, g);
    await mkdir(archiveDir, { recursive: true, mode: 0o700 });
    const archivedPath = join(archiveDir, basename(session.path));
    if (existsSync(archivedPath)) {
      return {
        error: createHostError("SESSION_SWITCH_FAILED", "Session is already archived"),
      };
    }
    await factory.invalidateRetainedWorkspaceGraph(g.canonicalCwd);
    await rename(session.path, archivedPath);
    return { sessionId, sessionPath: archivedPath, archived: true as const };
  });
}

export async function restoreSession(
  factory: WorkspaceGraphFactory,
  requestId: string,
  sessionId: string,
  sessionPath: string,
): Promise<{ sessionId: string; sessionPath: string; archived: false } | { error: HostError }> {
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
    await factory.invalidateRetainedWorkspaceGraph(g.canonicalCwd);
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
    const runtime = await factory.disposeBackgroundSessionRuntimeIfIdle(g, sessionId, sessionPath);
    if (runtime === "busy") {
      return {
        error: createHostError("AGENT_BUSY", "Wait for the Session run to finish", {
          retryable: true,
        }),
      };
    }
    await factory.invalidateRetainedWorkspaceGraph(g.canonicalCwd);
    await unlink(session.path);
    await factory.deps.attachmentStore?.releaseSession(sessionId).catch((error: unknown) => {
      logger.warn("Failed to release deleted Session attachments", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
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
    if (sessions.length > 0) {
      await factory.invalidateRetainedWorkspaceGraph(g.canonicalCwd);
    }
    for (const session of sessions) {
      try {
        await unlink(session.path);
        await factory.deps.attachmentStore?.releaseSession(session.id);
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
): Promise<{ sessionId: string; name: string; session?: SessionSnapshot } | { error: HostError }> {
  return withSessionFileMutation(factory, requestId, "session.rename", async (g) => {
    const [activeSessions, archivedSessions] = await Promise.all([
      listSessionFiles(factory, g, false),
      listSessionFiles(factory, g, true),
    ]);
    const target = [...activeSessions, ...archivedSessions].find(
      (item) => item.id === sessionId && factory.sessionPathsEqual(item.path, sessionPath),
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
      await factory.invalidateRetainedWorkspaceGraph(g.canonicalCwd);
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
    await factory.invalidateRetainedWorkspaceGraph(g.canonicalCwd);
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
  const g = factory.graph;
  if (!g?.agentSession) return null;
  return setSessionRuntimeName(factory, g.agentSession, name);
}

/** Write a Session name onto the foreground or a retained background runtime. */
export function setSessionRuntimeName(
  factory: WorkspaceGraphFactory,
  session: AgentSession,
  name: string,
): SessionSnapshot | null {
  const server = factory.server;
  const g = factory.graph;
  const runtime = factory.findRuntimeForSession(session);
  if (!server || !g || !runtime) return null;

  session.setSessionName(name);
  const snapshot = buildSessionSnapshot({
    session,
    sessionManager: runtime.sessionManager,
    cwd: g.canonicalCwd,
    sessionId: runtime.identity.sessionId ?? "",
    revision: runtime.identity.sessionRevision,
    workspaceId: g.workspaceId,
    toolRevision: runtime.toolRevision,
  });
  if (runtime.isActive) {
    if (g.sessionSnapshot?.name === session.sessionName) {
      return g.sessionSnapshot;
    }
    g.sessionSnapshot = snapshot;
    server.emit("session.infoChanged", {
      sessionId: snapshot.sessionId,
      name,
    });
    server.emit("session.snapshot", snapshot);
    return snapshot;
  }
  if (runtime.background) runtime.background.sessionSnapshot = snapshot;
  server.emitForIdentity(runtime.identity, "session.infoChanged", {
    sessionId: snapshot.sessionId,
    name,
  });
  return snapshot;
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
  const initialRuntime = factory.findRuntimeForSession(args.session);
  if (
    !initialGraph ||
    !initialRuntime ||
    initialRuntime.identity.sessionId !== args.sessionId ||
    args.session.sessionName !== args.provisionalTitle ||
    !args.session.model
  ) {
    return;
  }

  factory.markTitleRefine(args.session, true);
  let refinedTitle: string | undefined;
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
  } finally {
    factory.markTitleRefine(args.session, false);
  }

  const server = factory.server;
  const currentGraph = factory.graph;
  const currentRuntime = factory.findRuntimeForSession(args.session);
  const canApplyRefinedTitle =
    Boolean(refinedTitle) &&
    Boolean(server) &&
    currentGraph === initialGraph &&
    Boolean(currentRuntime) &&
    currentRuntime!.identity.sessionId === args.sessionId &&
    args.session.sessionName === args.provisionalTitle &&
    refinedTitle !== args.provisionalTitle &&
    args.session.isIdle &&
    !factory.getSessionOperationLock(args.session).isHeld() &&
    !server!.serviceGraphLock.isHeld();
  if (canApplyRefinedTitle && refinedTitle) {
    setSessionRuntimeName(factory, args.session, refinedTitle);
  }
  if (currentGraph && currentRuntime?.background && args.session.isIdle) {
    void factory.disposeSettledBackgroundRuntime(currentGraph, currentRuntime.background);
  }
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
  // Session create/open must not reach the network. Without this the SDK would
  // npm-install or git-clone any configured package missing from disk, in a
  // package manager PiDeck cannot cancel.
  await withoutImplicitPackageInstall(() => resourceLoader.reload());
  return resourceLoader;
}

/**
 * Create a new AgentSession in the current workspace (replaces active session).
 */
export async function createSession(
  factory: WorkspaceGraphFactory,
  requestId: string,
  name?: string,
  options?: {
    /** SDK newSession parity: restart the fresh manager's lineage from this parent. */
    parentSession?: string;
    /** Runs before the session is built, so setup-written entries are present from the start. */
    setup?: (sessionManager: SessionManager) => Promise<void>;
  },
): Promise<SessionSnapshot | { error: HostError }> {
  const server = factory.server;
  const g = factory.graph;
  if (!server || !g || !g.servicesReady || !g.settingsManager || !g.resourceLoader) {
    return { error: createHostError("AGENT_NOT_READY", "Workspace services not ready") };
  }

  const operation = server.graphOperations.begin({
    operationKind: "session.create",
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
  if (!server.serviceGraphLock.tryAcquire({ operationKind: "session.create", requestId })) {
    operation.finish();
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
  let extensionUiReplayState: (() => void) | null = null;
  let unsubscribeAgent: (() => void) | null = null;

  try {
    operation.signal.throwIfAborted();

    // A Workspace switch just built a pristine default Session; a "new
    // conversation" right after it would rebuild an identical empty Session
    // and tear this one down. Reuse the active Session instead so the create
    // resolves without touching the runtime.
    const pristineSession = g.agentSession;
    const pristineManager = g.sessionManager;
    const pristineSessionId = server.identity.sessionId;
    if (
      !name &&
      !options?.parentSession &&
      !options?.setup &&
      pristineSession &&
      pristineManager &&
      pristineSessionId &&
      pristineSession.isIdle &&
      pristineSession.messages.length === 0 &&
      !pristineSession.sessionName &&
      (typeof pristineManager.buildContextEntries !== "function" ||
        pristineManager.buildContextEntries().length === 0)
    ) {
      const pending = getQueueSnapshot(pristineSession);
      if (pending.steering.length === 0 && pending.followUp.length === 0) {
        const sessionSnapshot = buildSessionSnapshot({
          session: pristineSession,
          sessionManager: pristineManager,
          cwd: g.canonicalCwd,
          sessionId: pristineSessionId,
          revision: server.identity.sessionRevision,
          workspaceId: g.workspaceId,
          toolRevision: g.toolRevision,
        });
        g.sessionSnapshot = sessionSnapshot;
        logger.info("session create reused pristine active session", {
          sessionId: pristineSessionId,
        });
        return sessionSnapshot;
      }
    }

    if (factory.wouldExceedLiveSessionLimit()) {
      return sessionLimitError();
    }

    const startedAt = Date.now();
    const stepTimings: Record<string, number> = {};
    let lastStepAt = startedAt;
    const markStep = (step: string) => {
      const now = Date.now();
      stepTimings[step] = now - lastStepAt;
      lastStepAt = now;
    };

    // C4 candidate-commit: build new session fully before disposing old (B-SESSION-TXN-01)
    const prev = captureActiveSessionState(g, server.identity);

    const sessionManager = SessionManager.create(g.canonicalCwd);
    if (options?.parentSession) {
      sessionManager.newSession({ parentSession: options.parentSession });
    }
    if (name) {
      sessionManager.appendSessionInfo(name);
    }
    if (options?.setup) {
      await options.setup(sessionManager);
    }
    markStep("sessionManager.create");
    await Promise.resolve(factory.deps.refreshModelHealth());
    factory.onModelHealthChanged?.();
    markStep("refreshModelHealth");
    const candidateResourceLoader = await createSessionResourceLoader(factory, g);
    markStep("resourceLoader.reload");

    const created = await createHostAgentSession({
      cwd: g.canonicalCwd,
      agentDir: factory.deps.agentDir,
      modelRuntime: factory.deps.modelRuntime,
      settingsManager: g.settingsManager,
      resourceLoader: candidateResourceLoader,
      sessionManager,
      ...(factory.deps.attachmentStore
        ? { customTools: [createReadAttachmentTool(factory.deps.attachmentStore)] }
        : {}),
    });
    const session = created.session;
    const extensionsResult = created.extensionsResult;
    candidateSession = session;
    markStep("createAgentSession");

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
        factory.extensionCommandContextActions(session),
      );
      extensionUiActivate = extensionUiBinding.activate;
      extensionUiCleanup = extensionUiBinding.cleanup;
      extensionUiUpdateIdentity = extensionUiBinding.updateIdentity;
      extensionUiReplayState = extensionUiBinding.replayState;
      unsubscribeAgent = session.subscribe((event) => {
        factory.handleAgentEvent(g, session, event);
      });
      operation.signal.throwIfAborted();
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
          { retryable: operation.signal.aborted },
        ),
      };
    }

    markStep("bindExtensionUi");
    const sessionSnapshot = buildSessionSnapshot({
      session,
      sessionManager,
      cwd: g.canonicalCwd,
      sessionId,
      revision: sessionRevision,
      workspaceId: g.workspaceId,
      toolRevision: 1,
    });
    markStep("buildSessionSnapshot");

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
      extensionUiReplayState,
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
      extensionUiReplayState = null;
      unsubscribeAgent = null;
      return {
        error: createHostError(
          "SESSION_SWITCH_FAILED",
          bindErr instanceof Error ? bindErr.message : "Extension bind failed",
        ),
      };
    }

    markStep("activateExtensionUi");

    // The candidate is authoritative once commit and Extension activation
    // succeed. Publish it before the outgoing runtime's teardown so slow
    // Extension cleanup cannot delay the visible conversation (openSession
    // publishes in the same order).
    server.emit("session.snapshot", sessionSnapshot);
    server.emit("agent.toolsChanged", sessionSnapshot.tools);
    if (retainedPrevious) factory.announceRetainedRuntime(retainedPrevious);
    publishExtensionUi();
    candidateSession = null;
    extensionUiActivate = null;
    extensionUiCleanup = null;
    extensionUiUpdateIdentity = null;
    extensionUiReplayState = null;
    unsubscribeAgent = null;
    markStep("publish");

    if (prev.sessionId && prev.sessionId !== sessionId) {
      try {
        await factory.deps.attachmentStore?.discardSessionDrafts(prev.sessionId);
      } catch {
        /* ignore — drafts cleanup is best-effort once the candidate published */
      }
    }

    if (!retainedPrevious) {
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
    markStep("disposePrevious");

    logger.info("session created", {
      sessionId,
      totalMs: Date.now() - startedAt,
      stepsMs: stepTimings,
    });
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
        { retryable: operation.signal.aborted },
      ),
    };
  } finally {
    server.serviceGraphLock.release(requestId);
    operation.finish();
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

  const operationKind = options.forceReload ? "session.reload" : "session.open";
  const operation = server.graphOperations.begin({
    operationKind,
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
  if (
    !server.serviceGraphLock.tryAcquire({
      operationKind,
      requestId,
    })
  ) {
    operation.finish();
    return {
      error: createHostError("SERVICE_GRAPH_BUSY", "Service graph is busy", { retryable: true }),
    };
  }

  try {
    operation.signal.throwIfAborted();
    const isCurrentSession = isCurrentSessionPath(factory, g, sessionPath);
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

    // Live background runtimes belong to this workspace even before the JSONL
    // file exists. SessionManager.list only sees persisted files, so promote
    // first or a still-running new conversation cannot be switched back to.
    const retained = findRetainedRuntime(factory, g, sessionPath);
    if (retained) {
      operation.signal.throwIfAborted();
      return await factory.promoteBackgroundRuntime(g, retained);
    }

    const listed = await SessionManager.list(g.canonicalCwd);
    const match = listed.find((s) => factory.sessionPathsEqual(s.path, sessionPath));
    if (!match) {
      return {
        error: createHostError(
          "SESSION_NOT_FOUND",
          "Session is not in the current workspace; switch workspace first",
        ),
      };
    }
    if (factory.wouldExceedLiveSessionLimit()) {
      return sessionLimitError();
    }
    const startedAt = Date.now();
    const stepTimings: Record<string, number> = {};
    let lastStepAt = startedAt;
    const markStep = (step: string) => {
      const now = Date.now();
      stepTimings[step] = now - lastStepAt;
      lastStepAt = now;
    };

    // Opening a session written before the upgrade is the case the migration
    // backup exists for, so record it once the SDK has accepted the file.
    const sessionManager = SessionManager.open(sessionPath, undefined, g.canonicalCwd);
    await factory.deps.recordMigrationMilestone?.("sessionOpened");
    markStep("sessionManager.open");
    let candidateSession: AgentSession | null = null;
    let candidateExtensionUiCleanup: (() => void) | null = null;
    let candidateExtensionUiUpdateIdentity: ((identity: HostIdentity) => void) | null = null;
    let candidateExtensionUiReplayState: (() => void) | null = null;
    let candidateUnsubscribeAgent: (() => void) | null = null;
    try {
      await Promise.resolve(factory.deps.refreshModelHealth());
      factory.onModelHealthChanged?.();
      markStep("refreshModelHealth");
      const candidateResourceLoader = await createSessionResourceLoader(factory, g);
      markStep("resourceLoader.reload");

      const created = await createHostAgentSession({
        cwd: g.canonicalCwd,
        agentDir: factory.deps.agentDir,
        modelRuntime: factory.deps.modelRuntime,
        settingsManager: g.settingsManager,
        resourceLoader: candidateResourceLoader,
        sessionManager,
        ...(factory.deps.attachmentStore
          ? { customTools: [createReadAttachmentTool(factory.deps.attachmentStore)] }
          : {}),
      });
      candidateSession = created.session;
      const session = created.session;
      const extensionsResult = created.extensionsResult;
      markStep("createAgentSession");
      const sessionId = sessionManager.getSessionId() || session.sessionId || randomUUID();
      await factory.deps.attachmentStore?.reconcileSession(
        sessionId,
        sessionManager.getSessionFile(),
      );
      markStep("reconcileAttachments");
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
        factory.extensionCommandContextActions(session),
      );
      const candidateExtensionUiActivate = extensionUiBinding.activate;
      candidateExtensionUiCleanup = extensionUiBinding.cleanup;
      candidateExtensionUiUpdateIdentity = extensionUiBinding.updateIdentity;
      candidateExtensionUiReplayState = extensionUiBinding.replayState;
      candidateUnsubscribeAgent = session.subscribe((event) => {
        factory.handleAgentEvent(g, session, event);
      });
      operation.signal.throwIfAborted();
      markStep("bindExtensionUi");
      const sessionSnapshot = buildSessionSnapshot({
        session,
        sessionManager,
        cwd: g.canonicalCwd,
        sessionId,
        revision: sessionRevision,
        workspaceId: g.workspaceId,
        toolRevision: 1,
      });
      markStep("buildSessionSnapshot");

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
        extensionUiReplayState: candidateExtensionUiReplayState,
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
        candidateExtensionUiReplayState = null;
        candidateUnsubscribeAgent = null;
        return {
          error: createHostError(
            "SESSION_SWITCH_FAILED",
            bindErr instanceof Error ? bindErr.message : "Extension bind failed",
            { retryable: operation.signal.aborted },
          ),
        };
      }

      // The candidate is authoritative once commit and Extension activation succeed.
      // Publish it before awaiting outgoing idle shutdown so slow Extension cleanup
      // cannot hold the visible conversation on the previous Session.
      markStep("activateExtensionUi");
      server.emit("session.snapshot", sessionSnapshot);
      server.emit("agent.toolsChanged", sessionSnapshot.tools);
      if (retainedPrevious) factory.announceRetainedRuntime(retainedPrevious);
      publishExtensionUi();
      markStep("publish");
      if (prev.sessionId && prev.sessionId !== sessionId) {
        await factory.deps.attachmentStore?.discardSessionDrafts(prev.sessionId);
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
          await factory.disposeAgentSessionOnly(prev.agentSession);
        }
      }

      candidateSession = null;
      candidateExtensionUiCleanup = null;
      candidateExtensionUiUpdateIdentity = null;
      candidateExtensionUiReplayState = null;
      candidateUnsubscribeAgent = null;
      markStep("disposePrevious");
      logger.info("session opened", {
        sessionId,
        totalMs: Date.now() - startedAt,
        stepsMs: stepTimings,
      });
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
          { retryable: operation.signal.aborted },
        ),
      };
    }
  } catch (err) {
    return {
      error: createHostError(
        "SESSION_SWITCH_FAILED",
        err instanceof Error ? err.message : "Failed to open session",
        { retryable: operation.signal.aborted },
      ),
    };
  } finally {
    server.serviceGraphLock.release(requestId);
    operation.finish();
  }
}

function forkedUserText(content: unknown): string | undefined {
  if (typeof content === "string") return stripAttachmentReferenceBlocks(content);
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      return stripAttachmentReferenceBlocks((block as { text: string }).text);
    }
  }
  return undefined;
}

/**
 * Create a forked session file. `position: "before"` (default) branches
 * before the given user message and returns its text for the composer;
 * `position: "at"` keeps history through the given entry — used to fork
 * from the end of an assistant turn. Reads the persisted session from disk
 * (callers ensure the agent is idle, so disk matches memory) and never
 * touches the live graph.
 */
export function prepareForkFile(args: {
  sessionFile: string | null | undefined;
  canonicalCwd: string;
  entryId: string;
  position?: "before" | "at";
}): { error: HostError } | { forkedPath: string; selectedText?: string } {
  const { sessionFile, canonicalCwd, entryId, position = "before" } = args;
  if (!sessionFile || !existsSync(sessionFile)) {
    return {
      error: createHostError(
        "INVALID_REQUEST",
        "This session has not been saved yet. Wait for the first assistant response before forking.",
      ),
    };
  }
  let source: SessionManager;
  try {
    source = SessionManager.open(sessionFile, undefined, canonicalCwd);
  } catch (err) {
    return {
      error: createHostError(
        "SESSION_SWITCH_FAILED",
        err instanceof Error ? err.message : "Failed to read the session file",
      ),
    };
  }
  const entry = source.getEntry(entryId) as
    | {
        id: string;
        type: string;
        parentId?: string | null;
        message?: { role?: string; content?: unknown };
      }
    | undefined;
  let targetLeafId: string;
  if (position === "at") {
    if (!entry) {
      return { error: createHostError("INVALID_REQUEST", "Unknown fork entry") };
    }
    targetLeafId = entry.id;
  } else {
    if (!entry || entry.type !== "message" || entry.message?.role !== "user") {
      return {
        error: createHostError("INVALID_REQUEST", "Only user messages can be forked"),
      };
    }
    if (!entry.parentId) {
      return {
        error: createHostError(
          "INVALID_REQUEST",
          "Forking before the first message is not supported",
        ),
      };
    }
    targetLeafId = entry.parentId;
  }
  // Read the display name before branching: createBranchedSession switches
  // the manager to the forked file, and a name set after the branch point
  // would not be part of the copied history.
  const sourceName = source.getSessionName();
  let forkedPath: string | undefined;
  try {
    forkedPath = source.createBranchedSession(targetLeafId);
  } catch (err) {
    return {
      error: createHostError(
        "SESSION_SWITCH_FAILED",
        err instanceof Error ? err.message : "Failed to create the forked session",
      ),
    };
  }
  if (!forkedPath) {
    return {
      error: createHostError("SESSION_SWITCH_FAILED", "Failed to create the forked session"),
    };
  }
  if (sourceName) {
    // Mark the lineage in the forked session's display name. Unnamed sources
    // stay unnamed so the automatic title flow can still name the fork.
    try {
      source.appendSessionInfo(`Fork · ${sourceName}`);
    } catch (err) {
      logger.warn("could not name the forked session", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const selectedText = position === "before" ? forkedUserText(entry.message?.content) : undefined;
  return {
    forkedPath,
    ...(selectedText !== undefined ? { selectedText } : {}),
  };
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
