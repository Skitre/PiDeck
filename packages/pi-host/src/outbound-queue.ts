/**
 * OutboundWriter — bounded, ordered stdout queue with backpressure (A3).
 *
 * All host output (responses + events) flows through one queue so ordering
 * is preserved while honoring stream backpressure (`write() === false` →
 * wait for drain) instead of letting Node buffer unboundedly when the pipe
 * consumer stalls.
 *
 * Event sequence numbers are allocated at WRITE time, not enqueue time, so
 * the pressure policies below never create accidental sequence gaps:
 *
 * - Above the soft watermark, coalescible events collapse in place:
 *   customFrame data for the same panel concatenates (ANSI streams compose),
 *   and latest-wins snapshots (status/widget/runtime/progress/queue/host
 *   status) replace their queued predecessor.
 * - Above the hard cap, droppable events are discarded outright; if the
 *   queue is still over the cap, all queued events are dropped (responses
 *   are always kept) and one sequence number is deliberately skipped — the
 *   frontend's gap detection then drives its standard rehydrate recovery.
 */
import type { HostEventName, HostIdentity } from "@pideck/protocol";
import { createEvent } from "@pideck/protocol";
import { logger } from "./logger.js";

export type WritableLike = {
  write(chunk: string): boolean;
  once(event: "drain", listener: () => void): unknown;
};

type EventEntry = {
  kind: "event";
  identity: HostIdentity;
  event: HostEventName;
  payload: unknown;
  bytes: number;
  coalesceKey: string | null;
  dropped?: boolean;
};

type ResponseEntry = {
  kind: "response";
  line: string;
  bytes: number;
  dropped?: boolean;
};

type Entry = EventEntry | ResponseEntry;

export const OUTBOUND_SOFT_WATERMARK_BYTES = 1024 * 1024;
export const OUTBOUND_HARD_CAP_BYTES = 16 * 1024 * 1024;

/** Latest-wins or mergeable event classes — safe to collapse under pressure. */
function sessionScope(identity: HostIdentity): string {
  return [
    identity.hostInstanceId,
    identity.workspaceId ?? "",
    identity.workspaceRevision,
    identity.sessionId ?? "",
    identity.sessionRevision,
  ].join(":");
}

function coalesceKeyFor(
  identity: HostIdentity,
  event: HostEventName,
  payload: unknown,
): string | null {
  const p = payload as Record<string, unknown> | null;
  switch (event) {
    case "extensionUi.customFrame":
      return `frame:${String(p?.requestId ?? "")}`;
    case "extensionUi.statusChanged":
      return `status:${sessionScope(identity)}:${String(p?.key ?? "")}`;
    case "extensionUi.widgetChanged":
      return `widget:${sessionScope(identity)}:${String(p?.key ?? "")}`;
    case "extensionUi.widgetAttentionRequested":
      return `widget-attention:${sessionScope(identity)}:${String(p?.runId ?? "")}`;
    case "session.runtimeChanged":
      return `runtime:${String(p?.sessionId ?? "")}`;
    case "package.progress":
      return "package.progress";
    case "agent.queueChanged":
      return "agent.queueChanged";
    case "host.statusChanged":
      return "host.statusChanged";
    default:
      return null;
  }
}

export class OutboundWriter {
  private readonly stream: WritableLike;
  private readonly allocateSequence: () => number;
  private readonly softWatermark: number;
  private readonly hardCap: number;
  private readonly queue: Entry[] = [];
  private readonly coalesceIndex = new Map<string, EventEntry>();
  private pendingBytes = 0;
  private pumping = false;
  private pressureLoggedAt = 0;
  private idleResolvers: Array<() => void> = [];

  constructor(options: {
    stream: WritableLike;
    allocateSequence: () => number;
    softWatermark?: number;
    hardCap?: number;
  }) {
    this.stream = options.stream;
    this.allocateSequence = options.allocateSequence;
    this.softWatermark = options.softWatermark ?? OUTBOUND_SOFT_WATERMARK_BYTES;
    this.hardCap = options.hardCap ?? OUTBOUND_HARD_CAP_BYTES;
  }

  get queuedBytes(): number {
    return this.pendingBytes;
  }

  /** Responses are never coalesced or dropped. */
  enqueueResponse(body: unknown): void {
    const line = JSON.stringify(body) + "\n";
    this.push({ kind: "response", line, bytes: line.length });
  }

  enqueueEvent(identity: HostIdentity, event: HostEventName, payload: unknown): void {
    const bytes = JSON.stringify(payload)?.length ?? 0;
    const coalesceKey = coalesceKeyFor(identity, event, payload);

    if (event === "extensionUi.widgetAttentionRequested") {
      const widgetKey = `widget:${sessionScope(identity)}:${String(
        (payload as { key?: unknown } | null)?.key ?? "",
      )}`;
      const widgetSnapshot = this.coalesceIndex.get(widgetKey);
      // The Host emits attention immediately after the widget snapshot. If
      // that snapshot breached the hard cap and was shed on arrival, opening
      // the panel would reveal whatever stale widget content the client has.
      if (widgetSnapshot?.dropped) return;
      // Keep the causal pair ordered. Later same-key updates must be queued
      // after attention instead of replacing its snapshot in place.
      if (widgetSnapshot) this.coalesceIndex.delete(widgetKey);
    }

    if (coalesceKey && this.pendingBytes > this.softWatermark) {
      const existing = this.coalesceIndex.get(coalesceKey);
      if (existing && !existing.dropped) {
        if (event === "extensionUi.customFrame") {
          // ANSI streams compose — append instead of queueing another frame.
          const target = existing.payload as { data: string };
          const incoming = payload as { data: string };
          target.data += incoming.data;
          existing.bytes += bytes;
          this.pendingBytes += bytes;
        } else {
          // Latest wins for snapshot-style events.
          this.pendingBytes += bytes - existing.bytes;
          existing.identity = identity;
          existing.payload = payload;
          existing.bytes = bytes;
        }
        this.maybeEnforceHardCap();
        return;
      }
    }

    const entry: EventEntry = {
      kind: "event",
      identity,
      event,
      payload,
      bytes,
      coalesceKey,
    };
    if (coalesceKey) this.coalesceIndex.set(coalesceKey, entry);
    this.push(entry);
  }

  /** Resolves once the queue is fully written to the stream. */
  drain(): Promise<void> {
    if (this.queue.length === 0 && !this.pumping) return Promise.resolve();
    return new Promise((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  private push(entry: Entry): void {
    this.queue.push(entry);
    this.pendingBytes += entry.bytes;
    this.maybeEnforceHardCap();
    this.maybeLogPressure();
    if (!this.pumping) {
      this.pumping = true;
      queueMicrotask(() => void this.pump());
    }
  }

  private maybeEnforceHardCap(): void {
    if (this.pendingBytes <= this.hardCap) return;

    // First pass: shed everything coalescible/droppable.
    let shed = 0;
    for (const entry of this.queue) {
      if (entry.kind === "event" && entry.coalesceKey && !entry.dropped) {
        entry.dropped = true;
        shed += entry.bytes;
        this.pendingBytes -= entry.bytes;
      }
    }

    if (this.pendingBytes > this.hardCap) {
      // Catastrophic: consumer is effectively gone. Drop all events (keep
      // responses) and burn one sequence number so the client's gap
      // detection triggers a full rehydrate once the pipe recovers.
      let droppedEvents = 0;
      for (const entry of this.queue) {
        if (entry.kind === "event" && !entry.dropped) {
          entry.dropped = true;
          droppedEvents += 1;
          this.pendingBytes -= entry.bytes;
        }
      }
      this.allocateSequence();
      logger.error("Outbound queue exceeded hard cap; events dropped, sequence gap forced", {
        shedBytes: shed,
        droppedEvents,
        pendingBytes: this.pendingBytes,
      });
      return;
    }

    if (shed > 0) {
      logger.warn("Outbound queue over hard cap; coalescible events shed", {
        shedBytes: shed,
        pendingBytes: this.pendingBytes,
      });
    }
  }

  private maybeLogPressure(): void {
    if (this.pendingBytes <= this.softWatermark) return;
    const now = Date.now();
    if (now - this.pressureLoggedAt < 5_000) return;
    this.pressureLoggedAt = now;
    logger.warn("Outbound queue above soft watermark; coalescing latest-wins events", {
      pendingBytes: this.pendingBytes,
      queued: this.queue.length,
    });
  }

  private async pump(): Promise<void> {
    try {
      while (this.queue.length > 0) {
        const entry = this.queue.shift()!;
        if (entry.kind === "event" && entry.coalesceKey) {
          if (this.coalesceIndex.get(entry.coalesceKey) === entry) {
            this.coalesceIndex.delete(entry.coalesceKey);
          }
        }
        if (entry.dropped) continue;
        this.pendingBytes -= entry.bytes;

        let line: string;
        if (entry.kind === "response") {
          line = entry.line;
        } else {
          const envelope = createEvent(
            entry.identity,
            entry.event,
            this.allocateSequence(),
            entry.payload as never,
          );
          line = JSON.stringify(envelope) + "\n";
        }

        if (!this.stream.write(line)) {
          await new Promise<void>((resolve) => {
            this.stream.once("drain", resolve);
          });
        }
      }
    } catch (err) {
      // Broken pipe or similar — the peer is gone; drop the backlog so we
      // don't spin. The stdin-close path handles actual shutdown.
      logger.error("Outbound write failed; discarding queued output", {
        error: err instanceof Error ? err.message : String(err),
        discarded: this.queue.length,
      });
      this.queue.length = 0;
      this.coalesceIndex.clear();
      this.pendingBytes = 0;
    } finally {
      this.pumping = false;
      if (this.queue.length > 0) {
        // New entries arrived while the finally block unwound.
        this.pumping = true;
        queueMicrotask(() => void this.pump());
      } else {
        for (const resolve of this.idleResolvers.splice(0)) resolve();
      }
    }
  }
}
