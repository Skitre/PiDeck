import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { buildSessionSnapshot } from "./session-snapshot.js";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";

/** Safe sentinel used while PiDeck has no enabled Provider. */
export const PIDECK_NO_MODEL = Object.freeze({
  id: "unknown",
  name: "unknown",
  api: "unknown",
  provider: "unknown",
  baseUrl: "",
  reasoning: false,
  input: [],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 0,
  maxTokens: 0,
}) as Model<Api>;

export function isPideckNoModel(
  model: { provider?: string; id?: string } | null | undefined,
): boolean {
  return model?.provider === "unknown" && model?.id === "unknown";
}

/**
 * Clear the active model without changing the persisted default.
 * Does not publish a Host session snapshot — callers with a graph must do that.
 */
export async function clearSessionModel(session: AgentSession): Promise<void> {
  const previous = session.model;
  session.agent.state.model = PIDECK_NO_MODEL;
  session.setThinkingLevel("off");
  if (!isPideckNoModel(previous)) {
    await session.extensionRunner.emit({
      type: "model_select",
      model: PIDECK_NO_MODEL,
      previousModel: previous,
      source: "set",
    });
  }
}

/**
 * Rebuild and emit the active graph snapshot after an idle no-model reconcile.
 * Revision stays the same — this is not a session switch.
 */
export function publishIdleActiveSessionSnapshot(factory: WorkspaceGraphFactory): void {
  const graph = factory.getGraph();
  const server = factory.server;
  const session = graph?.agentSession;
  const sessionManager = graph?.sessionManager;
  const current = graph?.sessionSnapshot;
  if (!graph || !server || !session || !sessionManager || !current) return;

  const snapshot = buildSessionSnapshot({
    session,
    sessionManager,
    cwd: graph.canonicalCwd,
    sessionId: current.sessionId,
    revision: current.revision,
    workspaceId: graph.workspaceId,
    toolRevision: graph.toolRevision,
  });
  graph.sessionSnapshot = snapshot;
  server.emit("session.snapshot", snapshot);
}
