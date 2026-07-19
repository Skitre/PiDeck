import type {
  SessionRuntimeState,
  SessionSnapshot,
  SessionSummary,
} from "@pideck/protocol";

export type { SessionRuntimeState } from "@pideck/protocol";

export type SessionCatalogEntry = SessionSummary & {
  runtimeState: SessionRuntimeState;
  lastError?: string;
};

export type SessionCatalogState = {
  workspaceId: string | null;
  entries: Record<string, SessionCatalogEntry>;
  order: string[];
  loaded: boolean;
};

export function emptySessionCatalog(): SessionCatalogState {
  return {
    workspaceId: null,
    entries: {},
    order: [],
    loaded: false,
  };
}

export function replaceSessionCatalog(
  current: SessionCatalogState,
  workspaceId: string,
  items: SessionSummary[],
): SessionCatalogState {
  const sameWorkspace = current.workspaceId === workspaceId;
  const entries: Record<string, SessionCatalogEntry> = {};

  for (const item of items) {
    const previous = sameWorkspace ? current.entries[item.sessionId] : undefined;
    entries[item.sessionId] = {
      ...item,
      runtimeState: item.runtimeState ?? previous?.runtimeState ?? "inactive",
      ...(previous?.lastError ? { lastError: previous.lastError } : {}),
    };
  }

  if (sameWorkspace) {
    for (const id of current.order) {
      if (!entries[id] && current.entries[id]?.runtimeState !== "inactive") {
        entries[id] = current.entries[id];
      }
    }
  }

  return {
    workspaceId,
    entries,
    order: sortSessionIds(entries),
    loaded: true,
  };
}

export function upsertSessionSnapshot(
  current: SessionCatalogState,
  workspaceId: string,
  snapshot: SessionSnapshot,
  now = Date.now(),
): SessionCatalogState {
  const base = current.workspaceId === workspaceId ? current : emptySessionCatalog();
  const previous = base.entries[snapshot.sessionId];
  const runtimeState = runtimeStateFromSnapshot(snapshot);
  const entry: SessionCatalogEntry = {
    sessionId: snapshot.sessionId,
    sessionPath: snapshot.sessionPath ?? previous?.sessionPath ?? "",
    name: snapshot.name,
    cwd: snapshot.cwd,
    // Merely opening/rehydrating a session yields an idle snapshot and is not
    // activity: keep the listed timestamp so the entry does not jump to the
    // top of the recency sort and then snap back on the next session.list.
    updatedAt: runtimeState === "idle" && previous ? previous.updatedAt : now,
    messageCount: snapshot.messages.length,
    sessionRevision: snapshot.revision,
    runtimeState,
  };
  const entries = { ...base.entries, [snapshot.sessionId]: entry };
  return {
    workspaceId,
    entries,
    order: sortSessionIds(entries),
    loaded: base.loaded,
  };
}

export function updateSessionCatalogInfo(
  current: SessionCatalogState,
  sessionId: string,
  name: string | undefined,
): SessionCatalogState {
  const entry = current.entries[sessionId];
  if (!entry) return current;
  return {
    ...current,
    entries: {
      ...current.entries,
      [sessionId]: { ...entry, name },
    },
  };
}

export function setSessionRuntimeState(
  current: SessionCatalogState,
  sessionId: string,
  runtimeState: SessionRuntimeState,
  lastError?: string,
  updatedAt?: number,
): SessionCatalogState {
  const entry = current.entries[sessionId];
  if (!entry) return current;
  const entries = {
    ...current.entries,
    [sessionId]: {
      ...entry,
      runtimeState,
      // Recency policy (matches upsertSessionSnapshot): only genuine activity
      // reorders the list. The host stamps idle announcements with Date.now()
      // right after session.open, and local optimistic transitions
      // (starting/inactive/error rollback) carry no timestamp — neither may
      // jump the entry to the top of the recency sort.
      updatedAt:
        updatedAt !== undefined && (runtimeState === "running" || runtimeState === "queued")
          ? updatedAt
          : entry.updatedAt,
      ...(lastError ? { lastError } : { lastError: undefined }),
    },
  };
  return {
    ...current,
    entries,
    order: sortSessionIds(entries),
  };
}

export function runtimeStateFromSnapshot(
  snapshot: Pick<
    SessionSnapshot,
    "isIdle" | "isStreaming" | "isCompacting" | "isRetrying" | "pending"
  >,
): SessionRuntimeState {
  if (
    snapshot.isStreaming ||
    snapshot.isCompacting ||
    snapshot.isRetrying ||
    !snapshot.isIdle
  ) {
    return "running";
  }
  if (snapshot.pending.steering.length > 0 || snapshot.pending.followUp.length > 0) {
    return "queued";
  }
  return "idle";
}

export function sessionCatalogItems(catalog: SessionCatalogState): SessionCatalogEntry[] {
  return catalog.order.flatMap((id) => {
    const entry = catalog.entries[id];
    return entry ? [entry] : [];
  });
}

function sortSessionIds(entries: Record<string, SessionCatalogEntry>): string[] {
  return Object.values(entries)
    .sort((a, b) => b.updatedAt - a.updatedAt || a.sessionId.localeCompare(b.sessionId))
    .map((entry) => entry.sessionId);
}
