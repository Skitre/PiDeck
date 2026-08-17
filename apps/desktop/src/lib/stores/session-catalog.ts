import type { SessionRuntimeState, SessionSnapshot, SessionSummary } from "@pideck/protocol";

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
      const runtimeState = current.entries[id]?.runtimeState;
      if (
        !entries[id] &&
        runtimeState !== undefined &&
        runtimeState !== "inactive" &&
        runtimeState !== "error"
      ) {
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

/** Parked Sessions from another Workspace must not appear in this catalog. */
export function shouldProjectSnapshotIntoCatalog(
  catalog: SessionCatalogState,
  workspace: { id: string; cwd: string; canonicalCwd: string },
  snapshot: Pick<SessionSnapshot, "sessionId" | "cwd" | "tools">,
): boolean {
  if (catalog.workspaceId === workspace.id && catalog.entries[snapshot.sessionId]) {
    return true;
  }
  const snapshotWorkspaceId = snapshot.tools?.workspaceId;
  if (snapshotWorkspaceId && snapshotWorkspaceId === workspace.id) return true;
  return Boolean(
    snapshot.cwd && (snapshot.cwd === workspace.canonicalCwd || snapshot.cwd === workspace.cwd),
  );
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
  // SessionManager assigns a future file path immediately, but does not write
  // the JSONL file until the first message. Keep a blank idle Session out of
  // the sidebar. A live Session must appear even before that file exists, or
  // switching away hides it until the turn settles and session.list sees disk.
  if (!previous && snapshot.messages.length === 0 && runtimeState === "idle") return base;
  const becameActive = runtimeState === "running" || runtimeState === "queued";
  const wasActive = previous?.runtimeState === "running" || previous?.runtimeState === "queued";
  const entry: SessionCatalogEntry = {
    sessionId: snapshot.sessionId,
    sessionPath: snapshot.sessionPath ?? previous?.sessionPath ?? "",
    name: snapshot.name,
    cwd: snapshot.cwd,
    // Recency is for "this Session just became active", not for every later
    // token. Streaming upserts and switch-away parks must keep the listed
    // timestamp or two live Sessions fight for the top of the sidebar.
    updatedAt: !previous ? now : becameActive && !wasActive ? now : previous.updatedAt,
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

/** A previous Session's snapshot must not steal the foreground after a newer promote. */
export function isStaleForegroundSnapshot(
  current: SessionSnapshot | null,
  incoming: SessionSnapshot | null,
): boolean {
  if (!current || !incoming) return false;
  return incoming.sessionId !== current.sessionId && incoming.revision < current.revision;
}

export function isLiveCatalogRuntime(state: SessionRuntimeState | undefined): boolean {
  return state === "starting" || state === "running" || state === "queued";
}

export function setSessionRuntimeState(
  current: SessionCatalogState,
  sessionId: string,
  runtimeState: SessionRuntimeState,
  lastError?: string,
  updatedAt?: number,
  sessionRevision?: number,
): SessionCatalogState {
  const entry = current.entries[sessionId];
  if (!entry) return current;
  const entries = {
    ...current.entries,
    [sessionId]: {
      ...entry,
      runtimeState,
      sessionRevision: sessionRevision ?? entry.sessionRevision,
      // Recency policy (matches upsertSessionSnapshot): only genuine activity
      // reorders the list. The host stamps idle announcements with Date.now()
      // right after session.open, and local optimistic transitions
      // (starting/inactive/error rollback) carry no timestamp — neither may
      // jump the entry to the top of the recency sort.
      updatedAt:
        updatedAt !== undefined &&
        (runtimeState === "running" || runtimeState === "queued") &&
        entry.runtimeState !== "running" &&
        entry.runtimeState !== "queued"
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
  if (snapshot.isStreaming || snapshot.isCompacting || snapshot.isRetrying || !snapshot.isIdle) {
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
