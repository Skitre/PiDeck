import { describe, expect, it } from "vitest";
import { withStableGraphRead } from "./stable-graph-read.js";
import { IdentityState } from "./identity.js";
import { TryMutex } from "./locks.js";

describe("withStableGraphRead", () => {
  it("returns captured identity after successful read", async () => {
    const identity = new IdentityState();
    identity.workspaceId = "w1";
    identity.workspaceRevision = 2;
    const lock = new TryMutex();
    const out = await withStableGraphRead({
      requestId: "r1",
      identity,
      serviceGraphLock: lock,
      run: async () => ({ items: [1] }),
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.identity.workspaceId).toBe("w1");
      expect(out.identity.workspaceRevision).toBe(2);
      expect(out.result).toEqual({ items: [1] });
    }
    expect(lock.isHeld()).toBe(false);
  });

  it("returns SERVICE_GRAPH_BUSY when lock held", async () => {
    const identity = new IdentityState();
    const lock = new TryMutex();
    lock.tryAcquire({ operationKind: "package.mutation", requestId: "other" });
    const out = await withStableGraphRead({
      requestId: "r2",
      identity,
      serviceGraphLock: lock,
      run: async () => 1,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("SERVICE_GRAPH_BUSY");
    lock.release("other");
  });

  it("returns STALE_REVISION if graph revision changes during await", async () => {
    const identity = new IdentityState();
    identity.workspaceId = "w1";
    identity.workspaceRevision = 1;
    const lock = new TryMutex();
    const out = await withStableGraphRead({
      requestId: "r3",
      identity,
      serviceGraphLock: lock,
      run: async () => {
        identity.bumpWorkspaceRevision();
        return "data";
      },
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("STALE_REVISION");
    expect(lock.isHeld()).toBe(false);
  });

  it("concurrent switch cannot re-label old data with new identity (barrier)", async () => {
    const identity = new IdentityState();
    identity.workspaceId = "A";
    identity.workspaceRevision = 1;
    const lock = new TryMutex();

    let releaseRead: () => void = () => {};
    const readGate = new Promise<void>((r) => {
      releaseRead = r;
    });
    let readEntered = false;

    const readPromise = withStableGraphRead({
      requestId: "read-a",
      identity,
      serviceGraphLock: lock,
      run: async () => {
        readEntered = true;
        await readGate;
        return { cwd: "A-data" };
      },
    });

    // Wait until read holds lock
    while (!readEntered) {
      await new Promise((r) => setTimeout(r, 1));
    }

    // Concurrent workspace switch bumps revision while read is mid-await
    // (switch would take serviceGraphLock in real code; here we simulate identity change)
    identity.workspaceId = "B";
    identity.workspaceRevision = 2;
    releaseRead();

    const out = await readPromise;
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe("STALE_REVISION");
      // Must not return A-data under B identity
      expect(out.identity.workspaceId).toBe("B");
    }
    expect(lock.isHeld()).toBe(false);
  });

  it("successful read identity matches pre-await capture, not post-mutation host", async () => {
    const identity = new IdentityState();
    identity.workspaceId = "w1";
    identity.workspaceRevision = 5;
    identity.packageRevision = 3;
    const lock = new TryMutex();
    const out = await withStableGraphRead({
      requestId: "r4",
      identity,
      serviceGraphLock: lock,
      run: async () => ({ listed: true }),
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.identity.workspaceRevision).toBe(5);
      expect(out.identity.packageRevision).toBe(3);
    }
  });
});
