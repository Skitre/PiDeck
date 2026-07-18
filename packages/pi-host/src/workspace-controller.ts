import { createHostError } from "@pi-desktop/protocol";
import type { MethodHandler } from "./server.js";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";

export function createWorkspaceHandlers(
  factory: WorkspaceGraphFactory,
): Partial<Record<string, MethodHandler>> {
  return {
    "workspace.setCurrent": async (ctx) => {
      const params = ctx.params as { cwd: string };
      // First setCurrent uses expectedWorkspaceId=null, revision 0
      const stale = factory.checkIdentity(ctx.context, { requireWorkspace: true });
      // Allow initial: expectedWorkspaceId null and revision 0 when no workspace yet
      const server = factory.getServer();
      if (server && server.identity.workspaceId === null) {
        if (
          ctx.context.expectedWorkspaceId !== null ||
          ctx.context.expectedWorkspaceRevision !== 0
        ) {
          // still validate host
          if (
            ctx.context.expectedHostInstanceId !== server.identity.hostInstanceId
          ) {
            return { error: createHostError("STALE_REVISION", "Host instance mismatch") };
          }
        } else if (
          ctx.context.expectedHostInstanceId !== server.identity.hostInstanceId
        ) {
          return { error: createHostError("STALE_REVISION", "Host instance mismatch") };
        }
      } else if (stale) {
        return { error: stale };
      }

      const result = await factory.setCurrent(params.cwd, ctx.id);
      if ("error" in result) return { error: result.error };
      return { result };
    },

    "workspace.getCurrent": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, { requireWorkspace: true });
      const server = factory.getServer();
      if (server && server.identity.workspaceId === null) {
        if (ctx.context.expectedHostInstanceId !== server.identity.hostInstanceId) {
          return { error: createHostError("STALE_REVISION", "Host instance mismatch") };
        }
        return { result: null };
      }
      if (stale) return { error: stale };
      const g = factory.getGraph();
      if (!g) return { result: null };
      return { result: factory.buildWorkspaceSnapshot(g) };
    },

    "workspace.getTrust": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, { requireWorkspace: true });
      if (stale) return { error: stale };
      const g = factory.getGraph();
      if (!g) {
        return { error: createHostError("PROJECT_NOT_SELECTED", "No workspace") };
      }
      return {
        result: {
          workspace: factory.buildWorkspaceSnapshot(g),
          options: factory.getTrustOptions(),
        },
      };
    },

    "workspace.setTrust": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, { requireWorkspace: true });
      if (stale) return { error: stale };
      const params = ctx.params as { decision: "trustOnce" | "trust" | "deny" };
      const result = await factory.setTrust(params.decision, ctx.id);
      if ("error" in result) return { error: result.error };
      return { result };
    },
  };
}
