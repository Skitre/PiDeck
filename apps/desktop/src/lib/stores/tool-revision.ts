import type { ToolSnapshot } from "@pideck/protocol";

export type ToolSnapshotAction = "apply" | "drop" | "recover";

export function classifyToolSnapshot(
  current: ToolSnapshot | null,
  incoming: ToolSnapshot,
): ToolSnapshotAction {
  if (!current) return "apply";
  if (incoming.revision === current.revision + 1) return "apply";
  if (incoming.revision !== current.revision) return "recover";
  return JSON.stringify(incoming) === JSON.stringify(current) ? "drop" : "recover";
}
