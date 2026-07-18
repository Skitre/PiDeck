/**
 * Decide whether a normalized/raw Agent event requires publishing a full ToolSnapshot.
 * PROJECT_SPEC §8.4 — addedToolNames is a signal only; Host re-reads real tools.
 */
export function toolResultNeedsToolsRefresh(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  const e = event as {
    type?: string;
    result?: { addedToolNames?: unknown };
  };
  if (e.type !== "tool_execution_end" && e.type !== "tool_result") return false;
  const names = e.result?.addedToolNames;
  return Array.isArray(names) && names.length > 0 && names.every((n) => typeof n === "string");
}
