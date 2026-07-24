import { createHostError, type PiSettingsSnapshot } from "@pideck/protocol";
import type { MethodHandler } from "./server.js";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";

export function createSettingsHandlers(
  factory: WorkspaceGraphFactory,
): Partial<Record<string, MethodHandler>> {
  return {
    "piSettings.get": async (ctx) => {
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
          if (!g?.settingsManager) {
            throw new Error("Settings not available");
          }
          return readPiSettings(g);
        },
      });
      if (!out.ok) {
        if (out.error.code === "INTERNAL_ERROR") {
          return {
            error: createHostError("SETTINGS_READ_FAILED", out.error.message),
            identity: out.identity,
          };
        }
        return { error: out.error, identity: out.identity };
      }
      return { result: out.result, identity: out.identity };
    },

    "piSettings.patch": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, {
        requireWorkspace: true,
        allowNullSession: true,
      });
      if (stale) return { error: stale };
      const g = factory.getGraph();
      const server = factory.getServer();
      if (!g?.settingsManager || !server) {
        return { error: createHostError("SETTINGS_WRITE_FAILED", "Settings not available") };
      }

      if (
        !server.serviceGraphLock.tryAcquire({
          operationKind: "piSettings.patch",
          requestId: ctx.id,
        })
      ) {
        return {
          error: createHostError("SERVICE_GRAPH_BUSY", "Service graph busy", { retryable: true }),
        };
      }

      try {
        const staleAfterLock = factory.checkIdentity(ctx.context, {
          requireWorkspace: true,
          allowNullSession: true,
        });
        if (staleAfterLock) return { error: staleAfterLock };
        if (factory.hasBusySessions()) {
          return { error: createHostError("AGENT_BUSY", "Agent is busy", { retryable: true }) };
        }

        await factory.invalidateRetainedRuntimeCaches?.();

        const params = ctx.params as {
          patch: {
            defaultThinkingLevel?: string;
            steeringMode?: "all" | "one-at-a-time";
            followUpMode?: "all" | "one-at-a-time";
            autoCompaction?: boolean;
            autoRetry?: boolean;
          };
        };
        const sm = g.settingsManager as unknown as Record<string, (...args: unknown[]) => unknown>;
        const patch = params.patch;

        if (patch.defaultThinkingLevel !== undefined && sm.setDefaultThinkingLevel) {
          sm.setDefaultThinkingLevel(patch.defaultThinkingLevel);
        }
        if (patch.steeringMode !== undefined && sm.setSteeringMode) {
          sm.setSteeringMode(patch.steeringMode);
        }
        if (patch.followUpMode !== undefined && sm.setFollowUpMode) {
          sm.setFollowUpMode(patch.followUpMode);
        }
        if (patch.autoCompaction !== undefined) {
          g.agentSession?.setAutoRetryEnabled; // no-op guard
          if (typeof (g.agentSession as unknown as { setAutoCompactionEnabled?: (v: boolean) => void })?.setAutoCompactionEnabled === "function") {
            (g.agentSession as unknown as { setAutoCompactionEnabled: (v: boolean) => void }).setAutoCompactionEnabled(patch.autoCompaction);
          }
        }
        if (patch.autoRetry !== undefined && g.agentSession) {
          g.agentSession.setAutoRetryEnabled(patch.autoRetry);
        }

        await g.settingsManager.flush();
        const errors = g.settingsManager.drainErrors();
        if (errors?.length) {
          return {
            error: createHostError(
              "SETTINGS_WRITE_FAILED",
              errors.map((e) => e.error?.message ?? String(e.error ?? e)).join("; "),
            ),
          };
        }

        return { result: readPiSettings(g) };
      } finally {
        server.serviceGraphLock.release(ctx.id);
      }
    },
  };
}

function readPiSettings(g: NonNullable<ReturnType<WorkspaceGraphFactory["getGraph"]>>): PiSettingsSnapshot {
  const session = g.agentSession;
  return {
    defaultThinkingLevel: session ? String(session.thinkingLevel) : undefined,
    steeringMode: session?.steeringMode ?? "all",
    followUpMode: session?.followUpMode ?? "all",
    autoCompaction: session?.autoCompactionEnabled ?? true,
    autoRetry: session?.autoRetryEnabled ?? true,
    defaultModel: session?.model
      ? {
          provider: session.model.provider,
          modelId: session.model.id,
          name: session.model.name ?? session.model.id,
        }
      : undefined,
  };
}
