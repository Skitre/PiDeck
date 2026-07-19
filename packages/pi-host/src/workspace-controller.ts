import { createHostError } from "@pideck/protocol";
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

    "workspace.searchFiles": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, { requireWorkspace: true });
      if (stale) return { error: stale };
      const g = factory.getGraph();
      if (!g) {
        return { error: createHostError("PROJECT_NOT_SELECTED", "No workspace") };
      }
      const params = ctx.params as { query: string; limit?: number };
      const limit = params.limit ?? 20;
      return {
        result: {
          files: await searchWorkspaceFiles(g.canonicalCwd, params.query, limit),
        },
      };
    },
  };
}

const SEARCH_IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  "build",
  "out",
  ".next",
  ".venv",
  "venv",
  "__pycache__",
  ".idea",
  ".vs",
]);
const SEARCH_MAX_ENTRIES = 20_000;
const SEARCH_MAX_DEPTH = 12;

/**
 * Breadth-first workspace file search for @-completion: case-insensitive
 * substring over workspace-relative paths (forward slashes), name-prefix
 * matches ranked first, bounded scan so huge trees cannot stall the host.
 */
async function searchWorkspaceFiles(
  root: string,
  query: string,
  limit: number,
): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const needle = query.trim().toLocaleLowerCase();
  const prefixMatches: string[] = [];
  const substringMatches: string[] = [];
  let scanned = 0;

  const queue: { abs: string; rel: string; depth: number }[] = [
    { abs: root, rel: "", depth: 0 },
  ];
  while (queue.length > 0 && scanned < SEARCH_MAX_ENTRIES) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await readdir(dir.abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (scanned >= SEARCH_MAX_ENTRIES) break;
      scanned += 1;
      const rel = dir.rel ? `${dir.rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (
          dir.depth < SEARCH_MAX_DEPTH &&
          !SEARCH_IGNORED_DIRS.has(entry.name) &&
          !entry.name.startsWith(".")
        ) {
          queue.push({ abs: join(dir.abs, entry.name), rel, depth: dir.depth + 1 });
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (!needle) {
        if (prefixMatches.length < limit) prefixMatches.push(rel);
        continue;
      }
      const relLower = rel.toLocaleLowerCase();
      if (!relLower.includes(needle)) continue;
      const nameLower = entry.name.toLocaleLowerCase();
      if (nameLower.startsWith(needle)) {
        prefixMatches.push(rel);
      } else if (substringMatches.length < limit) {
        substringMatches.push(rel);
      }
      if (prefixMatches.length >= limit) break;
    }
    if (prefixMatches.length >= limit) break;
  }
  return [...prefixMatches, ...substringMatches].slice(0, limit);
}
