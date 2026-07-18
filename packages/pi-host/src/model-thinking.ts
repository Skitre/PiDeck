import type { AgentSession, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { detectModelThinking } from "@pi-desktop/protocol";

type MutableModelThinking = {
  id: string;
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null>;
};

/** Apply exact built-in capability profiles without overriding explicit user configuration. */
export function applyKnownThinkingProfiles(modelRegistry: ModelRegistry): number {
  let applied = 0;
  for (const model of modelRegistry.getAll() as MutableModelThinking[]) {
    if (!model.reasoning || model.thinkingLevelMap !== undefined) continue;
    const detected = detectModelThinking(model.id);
    if (detected.source !== "profile" || !detected.thinkingLevelMap) continue;
    model.thinkingLevelMap = { ...detected.thinkingLevelMap };
    applied += 1;
  }
  return applied;
}

/** Rebind a live session after ModelRegistry.refresh() without appending a model-change entry. */
export function rebindCurrentSessionModel(
  session: AgentSession,
  modelRegistry: ModelRegistry,
): boolean {
  const current = session.model;
  if (!current) return false;
  const refreshed = modelRegistry.find(current.provider, current.id);
  if (!refreshed || refreshed === current) return false;
  session.state.model = refreshed;
  session.setThinkingLevel(session.thinkingLevel);
  return true;
}
