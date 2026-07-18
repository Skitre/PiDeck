import { randomUUID } from "node:crypto";
import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import { createHostError, type ModelSummary } from "@pi-desktop/protocol";
import type { MethodHandler } from "./server.js";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";
import { buildSessionSnapshot, buildToolSnapshot } from "./session-snapshot.js";
import { rebindCurrentSessionModel } from "./model-thinking.js";
import { createProvisionalSessionTitle } from "./session-title.js";
import { withStableGraphRead } from "./stable-graph-read.js";
import { logger } from "./logger.js";

export function summarizeModel(model: Model<any>): ModelSummary {
  return {
    provider: model.provider,
    modelId: model.id,
    name: model.name ?? model.id,
    thinkingLevels: getSupportedThinkingLevels(model).map(String),
  };
}

export function createAgentHandlers(
  factory: WorkspaceGraphFactory,
): Partial<Record<string, MethodHandler>> {
  return {
    "agent.prompt": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, {
        requireWorkspace: true,
        requireSession: true,
      });
      if (stale) return { error: stale };

      const g = factory.getGraph();
      const server = factory.getServer();
      if (!g?.agentSession || !server) {
        return { error: createHostError("AGENT_NOT_READY", "No active agent session") };
      }

      if (g.resourceReloadRequired) {
        return {
          error: createHostError(
            "RESOURCE_RELOAD_FAILED",
            "Session resources require reload before prompting; run package.reloadResources",
            { retryable: true },
          ),
        };
      }

      if (server.serviceGraphLock.isHeld()) {
        const kind = server.serviceGraphLock.getOwner()?.operationKind;
        if (kind?.startsWith("package") || kind === "resource.setTopLevelEnabled") {
          return {
            error: createHostError("PACKAGE_MUTATION_BUSY", "Package mutation in progress", {
              retryable: true,
            }),
          };
        }
        return {
          error: createHostError("SERVICE_GRAPH_BUSY", "Service graph is busy", {
            retryable: true,
          }),
        };
      }

      const operationLock = factory.getSessionOperationLock(g.agentSession);
      if (!operationLock.tryAcquire(ctx.id)) {
        return {
          error: createHostError("AGENT_BUSY", "Agent operation already in progress", {
            retryable: true,
          }),
        };
      }

      if (server.serviceGraphLock.isHeld()) {
        const kind = server.serviceGraphLock.getOwner()?.operationKind;
        operationLock.release(ctx.id);
        return {
          error: createHostError(
            kind?.startsWith("package") || kind === "resource.setTopLevelEnabled"
              ? "PACKAGE_MUTATION_BUSY"
              : "SERVICE_GRAPH_BUSY",
            kind?.startsWith("package") || kind === "resource.setTopLevelEnabled"
              ? "Package mutation in progress"
              : "Service graph is busy",
            { retryable: true },
          ),
        };
      }

      // Re-check identity after both sides of the lock handoff.
      const stale2 = factory.checkIdentity(ctx.context, {
        requireWorkspace: true,
        requireSession: true,
      });
      if (stale2) {
        operationLock.release(ctx.id);
        return { error: stale2 };
      }

      const params = ctx.params as {
        text: string;
        streamingBehavior?: "steer" | "followUp";
      };
      const runId = randomUUID();
      const runIdentity = server.getIdentity();
      factory.currentRunId = runId;
      factory.setSessionRunId(g.agentSession, runId);
      server.setPhase("agentBusy");
      const provisionalTitle = g.agentSession.sessionName?.trim()
        ? null
        : createProvisionalSessionTitle(params.text);
      const titleSession = g.agentSession;
      const titleSessionId = server.identity.sessionId;
      if (provisionalTitle) {
        factory.setActiveSessionName(provisionalTitle);
      }

      // Fire-and-forget prompt; response acknowledges acceptance
      void (async () => {
        let completed = false;
        try {
          await g.agentSession!.prompt(params.text, {
            streamingBehavior: params.streamingBehavior,
          });
          completed = true;
        } catch (err) {
          server.emitForIdentity(runIdentity, "agent.event", {
            runId,
            event: {
              type: "error",
              message: err instanceof Error ? err.message : String(err),
            },
          });
          server.emitForIdentity(runIdentity, "session.runtimeChanged", {
            sessionId: runIdentity.sessionId!,
            sessionRevision: runIdentity.sessionRevision,
            state: "error",
            updatedAt: Date.now(),
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          operationLock.release(ctx.id);
          factory.clearSessionRunId(titleSession);
          if (server.getPhase() === "agentBusy" && !factory.hasBusySessions()) {
            server.setPhase("ready");
          }
          factory.currentRunId = null;
        }
        if (completed && provisionalTitle && titleSessionId) {
          await factory.refineActiveSessionName({
            session: titleSession,
            sessionId: titleSessionId,
            provisionalTitle,
            userPrompt: params.text,
          });
        }
      })().catch((err: unknown) => {
        logger.error("Detached agent prompt task failed", {
          runId,
          error: err instanceof Error ? err.message : String(err),
        });
      });

      return { result: { accepted: true, runId } };
    },

    "agent.steer": async (ctx) => {
      const server = factory.getServer();
      if (!server) {
        return { error: createHostError("AGENT_NOT_READY", "No active session") };
      }
      const params = ctx.params as { text: string };
      const out = await withStableGraphRead({
        requestId: ctx.id,
        identity: server.identity,
        serviceGraphLock: server.serviceGraphLock,
        precheck: () =>
          factory.checkIdentity(ctx.context, {
            requireWorkspace: true,
            requireSession: true,
          }),
        run: async () => {
          const session = factory.getGraph()?.agentSession;
          if (!session) throw new Error("No active session");
          await session.steer(params.text);
          server.emit("agent.queueChanged", {
            steering: [...session.getSteeringMessages()],
            followUp: [...session.getFollowUpMessages()],
          });
          return { accepted: true as const };
        },
      });
      return out.ok
        ? { result: out.result, identity: out.identity }
        : { error: out.error, identity: out.identity };
    },

    "agent.followUp": async (ctx) => {
      const server = factory.getServer();
      if (!server) {
        return { error: createHostError("AGENT_NOT_READY", "No active session") };
      }
      const params = ctx.params as { text: string };
      const out = await withStableGraphRead({
        requestId: ctx.id,
        identity: server.identity,
        serviceGraphLock: server.serviceGraphLock,
        precheck: () =>
          factory.checkIdentity(ctx.context, {
            requireWorkspace: true,
            requireSession: true,
          }),
        run: async () => {
          const session = factory.getGraph()?.agentSession;
          if (!session) throw new Error("No active session");
          await session.followUp(params.text);
          server.emit("agent.queueChanged", {
            steering: [...session.getSteeringMessages()],
            followUp: [...session.getFollowUpMessages()],
          });
          return { accepted: true as const };
        },
      });
      return out.ok
        ? { result: out.result, identity: out.identity }
        : { error: out.error, identity: out.identity };
    },

    "agent.abort": async (ctx) => {
      const server = factory.getServer();
      if (!server) {
        return { error: createHostError("AGENT_NOT_READY", "No active session") };
      }
      const out = await withStableGraphRead({
        requestId: ctx.id,
        identity: server.identity,
        serviceGraphLock: server.serviceGraphLock,
        precheck: () =>
          factory.checkIdentity(ctx.context, {
            requireWorkspace: true,
            requireSession: true,
          }),
        run: async () => {
          const g = factory.getGraph();
          if (!g?.agentSession || !g.sessionManager) throw new Error("No active session");
          let aborted = false;
          if (!g.agentSession.isIdle) {
            await g.agentSession.abort();
            aborted = true;
          }
          const identity = server.getIdentity();
          const snap = buildSessionSnapshot({
            session: g.agentSession,
            sessionManager: g.sessionManager,
            cwd: g.canonicalCwd,
            sessionId: identity.sessionId ?? "",
            revision: identity.sessionRevision,
            workspaceId: g.workspaceId,
            toolRevision: g.toolRevision,
          });
          g.sessionSnapshot = snap;
          return { aborted, session: snap };
        },
      });
      return out.ok
        ? { result: out.result, identity: out.identity }
        : { error: out.error, identity: out.identity };
    },

    "agent.clearQueue": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, {
        requireWorkspace: true,
        requireSession: true,
      });
      if (stale) return { error: stale };
      const g = factory.getGraph();
      if (!g?.agentSession) {
        return { error: createHostError("AGENT_NOT_READY", "No active session") };
      }
      const cleared = g.agentSession.clearQueue?.() ?? {
        steering: [...g.agentSession.getSteeringMessages()],
        followUp: [...g.agentSession.getFollowUpMessages()],
      };
      // If clearQueue doesn't exist, manually clear isn't possible; return current
      if (typeof g.agentSession.clearQueue === "function") {
        return { result: cleared };
      }
      return {
        result: {
          steering: [...g.agentSession.getSteeringMessages()],
          followUp: [...g.agentSession.getFollowUpMessages()],
        },
      };
    },

    "agent.compact": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, {
        requireWorkspace: true,
        requireSession: true,
      });
      if (stale) return { error: stale };
      const g = factory.getGraph();
      const server = factory.getServer();
      if (!g?.agentSession || !g.sessionManager || !server) {
        return { error: createHostError("AGENT_NOT_READY", "No active session") };
      }
      if (server.serviceGraphLock.isHeld()) {
        return {
          error: createHostError("SERVICE_GRAPH_BUSY", "Service graph is busy", {
            retryable: true,
          }),
        };
      }
      if (!g.agentSession.isIdle) {
        return { error: createHostError("AGENT_BUSY", "Agent busy", { retryable: true }) };
      }
      // Same per-session lock as agent.prompt — compaction and prompting are
      // mutually exclusive on one session.
      const operationLock = factory.getSessionOperationLock(g.agentSession);
      if (!operationLock.tryAcquire(ctx.id)) {
        return { error: createHostError("AGENT_BUSY", "Agent busy", { retryable: true }) };
      }
      try {
        if (server.serviceGraphLock.isHeld()) {
          return {
            error: createHostError("SERVICE_GRAPH_BUSY", "Service graph is busy", {
              retryable: true,
            }),
          };
        }
        const staleAfterLock = factory.checkIdentity(ctx.context, {
          requireWorkspace: true,
          requireSession: true,
        });
        if (staleAfterLock) return { error: staleAfterLock };

        const params = (ctx.params ?? {}) as { instructions?: string };
        const result = await g.agentSession.compact(params.instructions);
        const identity = server.getIdentity();
        const snap = buildSessionSnapshot({
          session: g.agentSession,
          sessionManager: g.sessionManager,
          cwd: g.canonicalCwd,
          sessionId: identity.sessionId ?? "",
          revision: identity.sessionRevision,
          workspaceId: g.workspaceId,
          toolRevision: g.toolRevision,
        });
        g.sessionSnapshot = snap;
        return { result: { result, session: snap } };
      } finally {
        operationLock.release(ctx.id);
      }
    },

    "agent.abortCompaction": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, {
        requireWorkspace: true,
        requireSession: true,
      });
      if (stale) return { error: stale };
      const g = factory.getGraph();
      const abort = (
        g?.agentSession as unknown as { abortCompaction?: () => void }
      )?.abortCompaction;
      abort?.call(g?.agentSession);
      return { result: { accepted: true } };
    },

    "agent.setAutoCompaction": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, {
        requireWorkspace: true,
        requireSession: true,
      });
      if (stale) return { error: stale };
      const g = factory.getGraph();
      const server = factory.getServer();
      if (!g?.agentSession || !server) {
        return { error: createHostError("AGENT_NOT_READY", "No active session") };
      }
      const params = ctx.params as { enabled: boolean };
      const fn = (
        g.agentSession as unknown as {
          setAutoCompactionEnabled?: (v: boolean) => void;
        }
      ).setAutoCompactionEnabled;
      fn?.call(g.agentSession, params.enabled);
      const snap = buildSessionSnapshot({
        session: g.agentSession,
        sessionManager: g.sessionManager!,
        cwd: g.canonicalCwd,
        sessionId: server.identity.sessionId ?? "",
        revision: server.identity.sessionRevision,
        workspaceId: g.workspaceId,
        toolRevision: g.toolRevision,
      });
      g.sessionSnapshot = snap;
      return { result: snap };
    },

    "agent.setAutoRetry": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, {
        requireWorkspace: true,
        requireSession: true,
      });
      if (stale) return { error: stale };
      const g = factory.getGraph();
      const server = factory.getServer();
      if (!g?.agentSession || !server) {
        return { error: createHostError("AGENT_NOT_READY", "No active session") };
      }
      const params = ctx.params as { enabled: boolean };
      g.agentSession.setAutoRetryEnabled(params.enabled);
      const snap = buildSessionSnapshot({
        session: g.agentSession,
        sessionManager: g.sessionManager!,
        cwd: g.canonicalCwd,
        sessionId: server.identity.sessionId ?? "",
        revision: server.identity.sessionRevision,
        workspaceId: g.workspaceId,
        toolRevision: g.toolRevision,
      });
      g.sessionSnapshot = snap;
      return { result: snap };
    },

    "agent.abortRetry": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, {
        requireWorkspace: true,
        requireSession: true,
      });
      if (stale) return { error: stale };
      factory.getGraph()?.agentSession?.abortRetry();
      return { result: { accepted: true } };
    },

    "agent.getTools": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, {
        requireWorkspace: true,
        requireSession: true,
      });
      if (stale) return { error: stale };
      const g = factory.getGraph();
      const server = factory.getServer();
      if (!g?.agentSession || !server) {
        return { error: createHostError("AGENT_NOT_READY", "No active session") };
      }
      const tools = buildToolSnapshot({
        session: g.agentSession,
        workspaceId: g.workspaceId,
        sessionId: server.identity.sessionId ?? "",
        sessionRevision: server.identity.sessionRevision,
        toolRevision: g.toolRevision,
      });
      return { result: tools };
    },

    "agent.setActiveTools": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, {
        requireWorkspace: true,
        requireSession: true,
        requireTool: true,
      });
      if (stale) return { error: stale };

      const g = factory.getGraph();
      const server = factory.getServer();
      if (!g?.agentSession || !server) {
        return { error: createHostError("AGENT_NOT_READY", "No active session") };
      }

      if (!g.agentSession.isIdle) {
        return { error: createHostError("AGENT_BUSY", "Agent is busy", { retryable: true }) };
      }

      if (
        !server.serviceGraphLock.tryAcquire({
          operationKind: "agent.setActiveTools",
          requestId: ctx.id,
        })
      ) {
        return {
          error: createHostError("SERVICE_GRAPH_BUSY", "Service graph busy", { retryable: true }),
        };
      }

      try {
        const stale2 = factory.checkIdentity(ctx.context, {
          requireWorkspace: true,
          requireSession: true,
          requireTool: true,
        });
        if (stale2) return { error: stale2 };
        if (factory.getSessionOperationLock(g.agentSession).isHeld() || !g.agentSession.isIdle) {
          return { error: createHostError("AGENT_BUSY", "Agent is busy", { retryable: true }) };
        }

        const params = ctx.params as { names: string[] };
        g.agentSession.setActiveToolsByName(params.names);
        g.toolRevision += 1;
        const tools = buildToolSnapshot({
          session: g.agentSession,
          workspaceId: g.workspaceId,
          sessionId: server.identity.sessionId ?? "",
          sessionRevision: server.identity.sessionRevision,
          toolRevision: g.toolRevision,
        });
        if (g.sessionSnapshot) g.sessionSnapshot.tools = tools;
        server.emit("agent.toolsChanged", tools);
        return { result: tools };
      } finally {
        server.serviceGraphLock.release(ctx.id);
      }
    },

    "model.list": async (ctx) => {
      const server = factory.getServer();
      if (!server) {
        return { error: createHostError("HOST_NOT_READY", "Server not bound") };
      }
      const { withStableGraphRead } = await import("./stable-graph-read.js");
      const out = await withStableGraphRead({
        requestId: ctx.id,
        identity: server.identity,
        serviceGraphLock: server.serviceGraphLock,
        precheck: () =>
          factory.checkIdentity(ctx.context, {
            requireWorkspace: true,
            requireSession: true,
          }),
        run: async () => {
          const g = factory.getGraph();
          if (!g?.agentSession) {
            throw new Error("No active session");
          }
          await Promise.resolve(factory.deps.refreshModelHealth());
          factory.onModelHealthChanged?.();

          const registry = factory.deps.modelRegistry;
          rebindCurrentSessionModel(g.agentSession, registry);
          const all = registry.getAvailable?.() ?? [];
          const models: ModelSummary[] = all.map((model: Model<any>) => summarizeModel(model));
          const current = g.agentSession.model;
          return {
            models,
            current: current
              ? {
                  provider: current.provider,
                  modelId: current.id,
                  name: current.name ?? current.id,
                }
              : undefined,
            thinkingLevels: g.agentSession.getAvailableThinkingLevels().map(String),
            configHealth: factory.deps.getModelConfigHealth(),
          };
        },
      });
      if (!out.ok) return { error: out.error, identity: out.identity };
      return { result: out.result, identity: out.identity };
    },

    "model.setCurrent": async (ctx) => {
      const server = factory.getServer();
      if (!server) {
        return { error: createHostError("HOST_NOT_READY", "Server not bound") };
      }
      if (
        !server.serviceGraphLock.tryAcquire({
          operationKind: "model.setCurrent",
          requestId: ctx.id,
        })
      ) {
        return {
          error: createHostError("SERVICE_GRAPH_BUSY", "Service graph busy", {
            retryable: true,
          }),
        };
      }

      try {
        const stale = factory.checkIdentity(ctx.context, {
          requireWorkspace: true,
          requireSession: true,
        });
        if (stale) return { error: stale };
        const g = factory.getGraph();
        if (!g?.agentSession || !g.sessionManager) {
          return { error: createHostError("AGENT_NOT_READY", "No active session") };
        }
        if (factory.getSessionOperationLock(g.agentSession).isHeld() || !g.agentSession.isIdle) {
          return { error: createHostError("AGENT_BUSY", "Agent is busy", { retryable: true }) };
        }

        const params = ctx.params as { provider: string; modelId: string };
        const registry = factory.deps.modelRegistry;
        const all = registry.getAvailable?.() ?? [];
        const model = all.find(
          (m: { provider: string; id: string }) =>
            m.provider === params.provider && m.id === params.modelId,
        );
        if (!model) {
          return {
            error: createHostError(
              "MODEL_NOT_FOUND",
              `Model not found: ${params.provider}/${params.modelId}`,
            ),
          };
        }

        await g.agentSession.setModel(model);
        const identity = server.getIdentity();
        const snap = buildSessionSnapshot({
          session: g.agentSession,
          sessionManager: g.sessionManager,
          cwd: g.canonicalCwd,
          sessionId: identity.sessionId ?? "",
          revision: identity.sessionRevision,
          workspaceId: g.workspaceId,
          toolRevision: g.toolRevision,
        });
        g.sessionSnapshot = snap;
        const thinkingLevels = g.agentSession.getAvailableThinkingLevels().map(String);
        server.emit("model.changed", {
          model: snap.model,
          thinkingLevel: snap.thinkingLevel,
          availableThinkingLevels: thinkingLevels,
        });
        return {
          result: {
            model: snap.model!,
            thinkingLevels,
            session: snap,
          },
          identity,
        };
      } finally {
        server.serviceGraphLock.release(ctx.id);
      }
    },

    "model.setThinkingLevel": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, {
        requireWorkspace: true,
        requireSession: true,
      });
      if (stale) return { error: stale };
      const g = factory.getGraph();
      const server = factory.getServer();
      if (!g?.agentSession || !server) {
        return { error: createHostError("AGENT_NOT_READY", "No active session") };
      }
      const params = ctx.params as { level: string };
      g.agentSession.setThinkingLevel(params.level as never);
      const snap = buildSessionSnapshot({
        session: g.agentSession,
        sessionManager: g.sessionManager!,
        cwd: g.canonicalCwd,
        sessionId: server.identity.sessionId ?? "",
        revision: server.identity.sessionRevision,
        workspaceId: g.workspaceId,
        toolRevision: g.toolRevision,
      });
      g.sessionSnapshot = snap;
      server.emit("model.changed", {
        model: snap.model,
        thinkingLevel: snap.thinkingLevel,
        availableThinkingLevels: g.agentSession.getAvailableThinkingLevels().map(String),
      });
      return { result: snap };
    },
  };
}
