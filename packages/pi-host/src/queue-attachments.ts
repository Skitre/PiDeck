/**
 * Queue attachment side-table.
 *
 * The SDK queue mirrors (getSteeringMessages/getFollowUpMessages) are
 * text-only, so any clear-and-rebuild (agent.setQueue reorder/edit/delete,
 * agent.abort's park/restore) would silently drop the images attached to
 * queued messages. This table remembers images per queued text (keyed by
 * the template-expanded mirror text) so rebuilds can re-attach them.
 *
 * Keyed weakly by AgentSession — disposed sessions release their images.
 * Texts are a multiset: duplicate texts pop in insertion order.
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";

type AttachmentEntry = { text: string; images: ImageContent[] };

const tables = new WeakMap<AgentSession, AttachmentEntry[]>();

function tableFor(session: AgentSession): AttachmentEntry[] {
  let entries = tables.get(session);
  if (!entries) {
    entries = [];
    tables.set(session, entries);
  }
  return entries;
}

/** Remember images for a queued message (call after a successful enqueue). */
export function recordQueuedImages(
  session: AgentSession,
  text: string,
  images: ImageContent[],
): void {
  if (images.length === 0) return;
  tableFor(session).push({ text, images });
}

/** Pop the images for the first entry matching `text`, if any. */
export function takeQueuedImages(
  session: AgentSession,
  text: string,
): ImageContent[] | undefined {
  const entries = tables.get(session);
  if (!entries) return undefined;
  const index = entries.findIndex((entry) => entry.text === text);
  if (index < 0) return undefined;
  const [entry] = entries.splice(index, 1);
  return entry!.images;
}

/** Drop entries whose text no longer appears in the live queue (delivered
 * or removed elsewhere). `currentTexts` is treated as a multiset. */
export function pruneQueuedImages(session: AgentSession, currentTexts: string[]): void {
  const entries = tables.get(session);
  if (!entries || entries.length === 0) return;
  const counts = new Map<string, number>();
  for (const text of currentTexts) {
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  const kept: AttachmentEntry[] = [];
  for (const entry of entries) {
    const remaining = counts.get(entry.text) ?? 0;
    if (remaining > 0) {
      counts.set(entry.text, remaining - 1);
      kept.push(entry);
    }
  }
  entries.length = 0;
  entries.push(...kept);
}

/**
 * Single-edit transfer heuristic: the queue UI edits one item per rebuild.
 * When exactly one imaged text disappears and exactly one unknown text
 * appears, the rebuild is an edit of that item — rename the entry so the
 * images survive the text change.
 */
export function carryImagesAcrossEdit(
  session: AgentSession,
  oldTexts: string[],
  newTexts: string[],
): void {
  const entries = tables.get(session);
  if (!entries || entries.length === 0) return;

  const counts = new Map<string, number>();
  for (const text of oldTexts) {
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  const unknownNew: string[] = [];
  for (const text of newTexts) {
    const available = counts.get(text) ?? 0;
    if (available > 0) counts.set(text, available - 1);
    else unknownNew.push(text);
  }
  const removedImaged: string[] = [];
  for (const [text, count] of counts) {
    if (count > 0 && entries.some((entry) => entry.text === text)) {
      for (let i = 0; i < count; i += 1) removedImaged.push(text);
    }
  }

  if (unknownNew.length !== 1 || removedImaged.length !== 1) return;
  const entry = entries.find((candidate) => candidate.text === removedImaged[0]);
  if (entry) entry.text = unknownNew[0]!;
}
