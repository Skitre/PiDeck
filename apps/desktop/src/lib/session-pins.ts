const SESSION_PINS_KEY_PREFIX = "pideck.sessions.pinned.";

export function readPinnedSessionIds(workspaceId: string | null | undefined): string[] {
  if (!workspaceId) return [];
  try {
    const raw = globalThis.localStorage?.getItem(`${SESSION_PINS_KEY_PREFIX}${workspaceId}`);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

export function writePinnedSessionIds(workspaceId: string, sessionIds: string[]): void {
  try {
    globalThis.localStorage?.setItem(
      `${SESSION_PINS_KEY_PREFIX}${workspaceId}`,
      JSON.stringify([...new Set(sessionIds)]),
    );
  } catch {
    /* ignore unavailable localStorage */
  }
}

export function prioritizePinnedSessions<T extends { sessionId: string }>(
  items: T[],
  pinnedSessionIds: readonly string[],
): T[] {
  if (pinnedSessionIds.length === 0) return items;
  const pinned = new Set(pinnedSessionIds);
  return [
    ...items.filter((item) => pinned.has(item.sessionId)),
    ...items.filter((item) => !pinned.has(item.sessionId)),
  ];
}
