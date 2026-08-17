import type { SessionSnapshot } from "@pideck/protocol";
import {
  applyAgentEvent,
  applyAgentEventBatch,
  type AgentEventEnvelope,
  type TimedAgentEventEnvelope,
} from "./transcript-reducer";

/** Per-workspace cap; matches Host `MAX_LIVE_SESSIONS`, not a global draft budget. */
export const MAX_TRANSCRIPT_DRAFTS = 5;

export function isLiveTranscriptSession(session: SessionSnapshot): boolean {
  return !session.isIdle || session.isStreaming || session.isCompacting || session.isRetrying;
}

export function dropTranscriptDraft(
  drafts: Record<string, SessionSnapshot>,
  sessionId: string,
): Record<string, SessionSnapshot> {
  if (!(sessionId in drafts)) return drafts;
  const next = { ...drafts };
  delete next[sessionId];
  return next;
}

function draftWorkspaceKey(session: SessionSnapshot): string {
  return session.tools.workspaceId || session.cwd;
}

function pruneWorkspaceDrafts(
  drafts: Record<string, SessionSnapshot>,
  sessionIds: string[],
): Record<string, SessionSnapshot> {
  if (sessionIds.length <= MAX_TRANSCRIPT_DRAFTS) return drafts;
  let next = drafts;
  const drop = (sessionId: string) => {
    if (!(sessionId in next)) return;
    if (next === drafts) next = { ...drafts };
    delete next[sessionId];
  };
  for (const sessionId of sessionIds) {
    const draft = next[sessionId];
    if (draft && !isLiveTranscriptSession(draft)) drop(sessionId);
  }
  const remaining = sessionIds.filter((sessionId) => sessionId in next);
  if (remaining.length <= MAX_TRANSCRIPT_DRAFTS) return next;
  for (const sessionId of remaining.slice(0, remaining.length - MAX_TRANSCRIPT_DRAFTS)) {
    drop(sessionId);
  }
  return next;
}

export function pruneTranscriptDrafts(
  drafts: Record<string, SessionSnapshot>,
): Record<string, SessionSnapshot> {
  const byWorkspace = new Map<string, string[]>();
  for (const [sessionId, draft] of Object.entries(drafts)) {
    const key = draftWorkspaceKey(draft);
    const group = byWorkspace.get(key);
    if (group) group.push(sessionId);
    else byWorkspace.set(key, [sessionId]);
  }
  let next = drafts;
  for (const sessionIds of byWorkspace.values()) {
    next = pruneWorkspaceDrafts(next, sessionIds);
  }
  return next;
}

export function parkTranscriptDraft(
  drafts: Record<string, SessionSnapshot>,
  session: SessionSnapshot | null,
): Record<string, SessionSnapshot> {
  if (!session || !isLiveTranscriptSession(session)) return drafts;
  return pruneTranscriptDrafts({ ...drafts, [session.sessionId]: session });
}

function messageText(message: { content?: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if ("text" in part && typeof part.text === "string") return part.text;
      return "";
    })
    .join("");
}

function messageSignatures(session: SessionSnapshot): string[] {
  return session.messages.map((message) => `${message.role}:${messageText(message)}`);
}

function isPrefixOrEqualTranscript(prefix: string[], full: string[]): boolean {
  if (prefix.length > full.length) return false;
  return prefix.every((value, index) => {
    const candidate = full[index];
    return candidate === value || candidate.startsWith(value);
  });
}

function preserveMessageStartedAt(
  snapshotMessages: SessionSnapshot["messages"],
  liveMessages: SessionSnapshot["messages"],
): SessionSnapshot["messages"] {
  return snapshotMessages.map((message, index) => {
    const live = liveMessages[index];
    if (!live || live.role !== message.role) return message;
    const startedAt = message.startedAt ?? live.startedAt;
    return startedAt === undefined ? message : { ...message, startedAt };
  });
}

function shouldKeepLiveMessages(snapshot: SessionSnapshot, live: SessionSnapshot): boolean {
  if (live.messages.length > snapshot.messages.length) return true;
  if (live.messages.length < snapshot.messages.length) return false;
  return isPrefixOrEqualTranscript(messageSignatures(snapshot), messageSignatures(live));
}

function treesShareLineage(
  liveEntries: NonNullable<SessionSnapshot["entries"]>,
  snapshotEntries: NonNullable<SessionSnapshot["entries"]>,
): boolean {
  if (liveEntries.length === 0 || snapshotEntries.length === 0) return true;
  const snapshotIds = new Set(snapshotEntries.map((entry) => entry.id));
  return liveEntries.some((entry) => snapshotIds.has(entry.id));
}

function shouldKeepLiveEntries(snapshot: SessionSnapshot, live: SessionSnapshot): boolean {
  const liveEntries = live.entries ?? [];
  const snapshotEntries = snapshot.entries ?? [];
  // A promote/file snapshot rematerializes the same turn with new IDs.
  // Same length plus unknown IDs is a fork, not a richer Host tree.
  if (!treesShareLineage(liveEntries, snapshotEntries)) return true;
  if (liveEntries.length > snapshotEntries.length) return true;
  if (liveEntries.length < snapshotEntries.length) return false;
  return !snapshot.leafId || snapshot.leafId === live.leafId;
}

function mergeExtensionMessageRenders(
  snapshot: SessionSnapshot,
  live: SessionSnapshot,
): SessionSnapshot["extensionMessageRenders"] {
  const fromLive = live.extensionMessageRenders;
  const fromSnapshot = snapshot.extensionMessageRenders;
  if (!fromLive) return fromSnapshot;
  if (!fromSnapshot) return fromLive;
  return { ...fromLive, ...fromSnapshot };
}

export type TranscriptOverlaySource = "promote" | "replay";

export function overlayLiveTranscriptMessages(
  snapshot: SessionSnapshot,
  live: SessionSnapshot | undefined,
  source: TranscriptOverlaySource = "replay",
): SessionSnapshot {
  if (!live || !isLiveTranscriptSession(live) || !isLiveTranscriptSession(snapshot)) {
    return snapshot;
  }
  const keepLiveMessages = shouldKeepLiveMessages(snapshot, live);
  // Promote applies Host revision/tools/idle only. The live messages/entries/
  // leafId pair stays together so the timer and Transcript tree stay continuous.
  if (source === "promote") {
    if (!keepLiveMessages) {
      return {
        ...snapshot,
        messages: preserveMessageStartedAt(snapshot.messages, live.messages),
        extensionMessageRenders: mergeExtensionMessageRenders(snapshot, live),
      };
    }
    return {
      ...snapshot,
      messages: live.messages,
      entries: live.entries,
      leafId: live.leafId,
      extensionMessageRenders: mergeExtensionMessageRenders(snapshot, live),
    };
  }
  // Rehydrate/replay may still be a later snapshot of the same live tree.
  // Take Host entries/leaf only when that tree is the same lineage and richer.
  const keepLiveEntries = shouldKeepLiveEntries(snapshot, live);
  return {
    ...snapshot,
    messages: keepLiveMessages
      ? live.messages
      : preserveMessageStartedAt(snapshot.messages, live.messages),
    entries: keepLiveEntries ? live.entries : snapshot.entries,
    leafId: keepLiveEntries ? live.leafId : snapshot.leafId,
    extensionMessageRenders: mergeExtensionMessageRenders(snapshot, live),
  };
}

export function adoptLiveTranscriptDraft(
  drafts: Record<string, SessionSnapshot>,
  snapshot: SessionSnapshot,
): { session: SessionSnapshot; drafts: Record<string, SessionSnapshot> } {
  return {
    session: overlayLiveTranscriptMessages(snapshot, drafts[snapshot.sessionId], "promote"),
    drafts: dropTranscriptDraft(drafts, snapshot.sessionId),
  };
}

function raiseSessionRevision(
  session: SessionSnapshot,
  sessionRevision: number | undefined,
): SessionSnapshot {
  if (sessionRevision === undefined || sessionRevision <= session.revision) return session;
  return { ...session, revision: sessionRevision };
}

export function applyAgentEventToTranscript(
  session: SessionSnapshot,
  payload: AgentEventEnvelope,
  eventTime?: number,
  sessionRevision?: number,
): SessionSnapshot | null {
  const next = applyAgentEvent(session, payload, eventTime);
  return next ? raiseSessionRevision(next, sessionRevision) : null;
}

export function applyAgentEventBatchToTranscript(
  session: SessionSnapshot,
  events: TimedAgentEventEnvelope[],
  sessionRevision?: number,
): SessionSnapshot | null {
  const next = applyAgentEventBatch(session, events);
  return next ? raiseSessionRevision(next, sessionRevision) : null;
}

export function groupTimedAgentEventsBySession(
  events: TimedAgentEventEnvelope[],
): Map<string, TimedAgentEventEnvelope[]> {
  const groups = new Map<string, TimedAgentEventEnvelope[]>();
  for (const event of events) {
    if (!event.sessionId) continue;
    const group = groups.get(event.sessionId);
    if (group) group.push(event);
    else groups.set(event.sessionId, [event]);
  }
  return groups;
}
