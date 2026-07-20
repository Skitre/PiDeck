import { describe, expect, it } from "vitest";
import type { HostIdentity } from "@pideck/protocol";
import { OutboundWriter, type WritableLike } from "./outbound-queue.js";

const identity: HostIdentity = {
  hostInstanceId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  workspaceRevision: 1,
  sessionId: "33333333-3333-4333-8333-333333333333",
  sessionRevision: 1,
  packageRevision: 1,
};

/** Fake stream: collects lines; can simulate a stalled pipe until drained. */
function fakeStream(options?: { stalled?: boolean }) {
  const lines: string[] = [];
  let stalled = options?.stalled ?? false;
  const drainListeners: Array<() => void> = [];
  const stream: WritableLike = {
    write(chunk: string) {
      lines.push(chunk);
      return !stalled;
    },
    once(_event, listener) {
      drainListeners.push(listener);
      return stream;
    },
  };
  return {
    stream,
    lines,
    parsed: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    unstall() {
      stalled = false;
      for (const listener of drainListeners.splice(0)) listener();
    },
  };
}

function writer(
  stream: WritableLike,
  options?: { softWatermark?: number; hardCap?: number },
) {
  let sequence = 0;
  const out = new OutboundWriter({
    stream,
    allocateSequence: () => {
      sequence += 1;
      return sequence;
    },
    ...options,
  });
  return { out, lastSequence: () => sequence };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("OutboundWriter", () => {
  it("preserves order across responses and events, sequences assigned at write", async () => {
    const fake = fakeStream();
    const { out } = writer(fake.stream);

    out.enqueueEvent(identity, "extensionUi.notification", { message: "a", level: "info" });
    out.enqueueResponse({ ok: true, id: "r1" });
    out.enqueueEvent(identity, "extensionUi.notification", { message: "b", level: "info" });
    await out.drain();

    const parsed = fake.parsed();
    expect(parsed).toHaveLength(3);
    expect(parsed[0]!.sequence).toBe(1);
    expect(parsed[1]!.id).toBe("r1");
    expect(parsed[2]!.sequence).toBe(2);
  });

  it("waits for stream drain when the pipe stalls, then flushes in order", async () => {
    const fake = fakeStream({ stalled: true });
    const { out } = writer(fake.stream);

    out.enqueueEvent(identity, "extensionUi.notification", { message: "one", level: "info" });
    out.enqueueEvent(identity, "extensionUi.notification", { message: "two", level: "info" });
    await settle();
    // First write went out (stream accepted it but reported backpressure).
    expect(fake.lines).toHaveLength(1);

    fake.unstall();
    await out.drain();
    expect(fake.lines).toHaveLength(2);
    const parsed = fake.parsed();
    expect((parsed[1]!.payload as { message: string }).message).toBe("two");
  });

  it("merges customFrame data for the same panel above the soft watermark", async () => {
    const fake = fakeStream({ stalled: true });
    const { out } = writer(fake.stream, { softWatermark: 1 });

    // First frame is written immediately; the stall queues the rest.
    out.enqueueEvent(identity, "extensionUi.customFrame", { requestId: "p1", data: "AAA" });
    await settle();
    out.enqueueEvent(identity, "extensionUi.customFrame", { requestId: "p1", data: "BBB" });
    out.enqueueEvent(identity, "extensionUi.customFrame", { requestId: "p2", data: "XXX" });
    out.enqueueEvent(identity, "extensionUi.customFrame", { requestId: "p1", data: "CCC" });

    fake.unstall();
    await out.drain();

    const frames = fake
      .parsed()
      .filter((message) => message.event === "extensionUi.customFrame")
      .map((message) => message.payload as { requestId: string; data: string });
    expect(frames).toEqual([
      { requestId: "p1", data: "AAA" },
      { requestId: "p1", data: "BBBCCC" },
      { requestId: "p2", data: "XXX" },
    ]);
    // No sequence gaps despite coalescing.
    const sequences = fake.parsed().map((message) => message.sequence);
    expect(sequences).toEqual([1, 2, 3]);
  });

  it("keeps only the latest snapshot-style event per key under pressure", async () => {
    const fake = fakeStream({ stalled: true });
    const { out } = writer(fake.stream, { softWatermark: 1 });

    out.enqueueEvent(identity, "extensionUi.notification", { message: "hold", level: "info" });
    await settle();
    out.enqueueEvent(identity, "extensionUi.statusChanged", { key: "k", text: "first" });
    out.enqueueEvent(identity, "extensionUi.statusChanged", { key: "k", text: "second" });
    out.enqueueEvent(identity, "extensionUi.statusChanged", { key: "other", text: "kept" });

    fake.unstall();
    await out.drain();

    const statuses = fake
      .parsed()
      .filter((message) => message.event === "extensionUi.statusChanged")
      .map((message) => (message.payload as { text: string }).text);
    expect(statuses).toEqual(["second", "kept"]);
  });

  it("never drops responses or agent events at the hard cap, and forces a sequence gap in catastrophe", async () => {
    const fake = fakeStream({ stalled: true });
    const { out, lastSequence } = writer(fake.stream, { softWatermark: 1, hardCap: 200 });

    out.enqueueEvent(identity, "extensionUi.notification", { message: "hold", level: "info" });
    await settle();
    // Droppable bulk that blows past the cap.
    out.enqueueEvent(identity, "extensionUi.customFrame", {
      requestId: "p1",
      data: "x".repeat(400),
    });
    // A response and a critical-ish notification queued after.
    out.enqueueResponse({ ok: true, id: "keep-me" });
    out.enqueueEvent(identity, "extensionUi.notification", {
      message: "y".repeat(400),
      level: "info",
    });

    fake.unstall();
    await out.drain();

    const parsed = fake.parsed();
    // The oversized frame was shed; the response survived.
    expect(parsed.some((message) => message.id === "keep-me")).toBe(true);
    expect(
      parsed.some((message) => message.event === "extensionUi.customFrame"),
    ).toBe(false);
    // A sequence number was burned to force client-side gap recovery.
    const written = parsed.filter((message) => typeof message.sequence === "number").length;
    expect(lastSequence()).toBeGreaterThan(written);
  });

  it("drain resolves immediately when idle", async () => {
    const fake = fakeStream();
    const { out } = writer(fake.stream);
    await out.drain();
    expect(fake.lines).toHaveLength(0);
  });
});
