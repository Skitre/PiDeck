import { createHostError, toJsonValue } from "@pi-desktop/protocol";
import type { MethodHandler } from "./server.js";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";

export function createSessionHandlers(
  factory: WorkspaceGraphFactory,
): Partial<Record<string, MethodHandler>> {
  return {
    "session.list": async (ctx) => {
      const server = factory.getServer();
      if (!server) {
        return { error: createHostError("HOST_NOT_READY", "Server not bound") };
      }
      const { withStableGraphRead } = await import("./stable-graph-read.js");
      const out = await withStableGraphRead({
        requestId: ctx.id,
        identity: server.identity,
        serviceGraphLock: server.serviceGraphLock,
        precheck: () => factory.checkIdentity(ctx.context, { requireWorkspace: true }),
        run: async () => {
          const g = factory.getGraph();
          if (!g) throw new Error("No workspace");
          const items = await factory.listSessions();
          return {
            workspaceId: g.workspaceId,
            items: items.map((s) => {
              const runtime = factory.getSessionRuntimeInfo(s.id, s.path);
              return {
                sessionId: s.id,
                sessionPath: s.path,
                name: s.name,
                cwd: s.cwd,
                updatedAt: s.modified?.getTime?.() ?? Date.now(),
                messageCount: s.messageCount,
                archived: s.archived,
                ...(runtime ?? {}),
              };
            }),
          };
        },
      });
      if (!out.ok) return { error: out.error, identity: out.identity };
      return { result: out.result, identity: out.identity };
    },

    "session.create": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, {
        requireWorkspace: true,
        allowNullSession: true,
      });
      if (stale) return { error: stale };
      const params = (ctx.params ?? {}) as { name?: string };
      const result = await factory.createSession(ctx.id, params.name);
      if (result && typeof result === "object" && "error" in result) {
        return { error: result.error };
      }
      return { result };
    },

    "session.open": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, {
        requireWorkspace: true,
        allowNullSession: true,
      });
      if (stale) return { error: stale };
      const params = ctx.params as { sessionPath: string };
      const result = await factory.openSession(ctx.id, params.sessionPath);
      if (result && typeof result === "object" && "error" in result) {
        return { error: result.error };
      }
      return { result };
    },

    "session.reload": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, {
        requireWorkspace: true,
        requireSession: true,
      });
      if (stale) return { error: stale };
      const result = await factory.reloadSession(ctx.id);
      if ("error" in result) return { error: result.error };
      return { result };
    },

    "session.archive": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, { requireWorkspace: true });
      if (stale) return { error: stale };
      const params = ctx.params as { sessionId: string; sessionPath: string };
      const result = await factory.archiveSession(ctx.id, params.sessionId, params.sessionPath);
      if ("error" in result) return { error: result.error };
      return { result };
    },

    "session.restore": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, { requireWorkspace: true });
      if (stale) return { error: stale };
      const params = ctx.params as { sessionId: string; sessionPath: string };
      const result = await factory.restoreSession(ctx.id, params.sessionId, params.sessionPath);
      if ("error" in result) return { error: result.error };
      return { result };
    },

    "session.delete": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, { requireWorkspace: true });
      if (stale) return { error: stale };
      const params = ctx.params as { sessionId: string; sessionPath: string };
      const result = await factory.deleteArchivedSession(
        ctx.id,
        params.sessionId,
        params.sessionPath,
      );
      if ("error" in result) return { error: result.error };
      return { result };
    },

    "session.cleanupArchived": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, { requireWorkspace: true });
      if (stale) return { error: stale };
      const result = await factory.cleanupArchivedSessions(ctx.id);
      if ("error" in result) return { error: result.error };
      return { result };
    },

    "session.getSnapshot": async (ctx) => {
      const server = factory.getServer();
      if (!server) {
        return { error: createHostError("HOST_NOT_READY", "Server not bound") };
      }
      const { withStableGraphRead } = await import("./stable-graph-read.js");
      const out = await withStableGraphRead({
        requestId: ctx.id,
        identity: server.identity,
        serviceGraphLock: server.serviceGraphLock,
        precheck: () => factory.checkIdentity(ctx.context, { requireWorkspace: true }),
        run: async () => {
          const g = factory.getGraph();
          return g?.sessionSnapshot ?? null;
        },
      });
      if (!out.ok) return { error: out.error, identity: out.identity };
      return { result: out.result, identity: out.identity };
    },

    "session.setName": async (ctx) => {
      const server = factory.getServer();
      if (!server) {
        return { error: createHostError("HOST_NOT_READY", "Server not bound") };
      }
      if (
        !server.serviceGraphLock.tryAcquire({
          operationKind: "session.setName",
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
        if (!g?.sessionManager || !g.agentSession) {
          return { error: createHostError("AGENT_NOT_READY", "No active session") };
        }
        if (factory.getSessionOperationLock(g.agentSession).isHeld() || !g.agentSession.isIdle) {
          return { error: createHostError("AGENT_BUSY", "Agent is busy", { retryable: true }) };
        }

        const params = ctx.params as { name: string };
        const snapshot = factory.setActiveSessionName(params.name);
        if (!snapshot) {
          return { error: createHostError("AGENT_NOT_READY", "No active session") };
        }
        return { result: snapshot };
      } finally {
        server.serviceGraphLock.release(ctx.id);
      }
    },

    "session.getEntries": async (ctx) => {
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
          if (!g?.sessionManager) throw new Error("No active session");
          const entries = g.sessionManager.getEntries().map((e) => toJsonValue(e));
          return {
            entries,
            leafId: g.sessionManager.getLeafId(),
          };
        },
      });
      if (!out.ok) return { error: out.error, identity: out.identity };
      return { result: out.result, identity: out.identity };
    },

    "session.getTree": async (ctx) => {
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
          if (!g?.sessionManager) throw new Error("No active session");
          return {
            tree: toJsonValue(g.sessionManager.getTree()),
            leafId: g.sessionManager.getLeafId(),
          };
        },
      });
      if (!out.ok) return { error: out.error, identity: out.identity };
      return { result: out.result, identity: out.identity };
    },

    "session.getStats": async (ctx) => {
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
          if (!g?.agentSession) throw new Error("No active session");
          return {
            messageCount: g.agentSession.messages.length,
          };
        },
      });
      if (!out.ok) return { error: out.error, identity: out.identity };
      return { result: out.result, identity: out.identity };
    },
  };
}
