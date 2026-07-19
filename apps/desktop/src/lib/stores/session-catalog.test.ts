import { describe, expect, it } from "vitest";
import type { SessionSnapshot } from "@pideck/protocol";
import {
  emptySessionCatalog,
  replaceSessionCatalog,
  runtimeStateFromSnapshot,
  sessionCatalogItems,
  setSessionRuntimeState,
  updateSessionCatalogInfo,
  upsertSessionSnapshot,
} from "./session-catalog";

function snapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: "s1",
    sessionPath: "C:/sessions/s1.jsonl",
    cwd: "C:/workspace",
    revision: 1,
    isStreaming: false,
    isIdle: true,
    isCompacting: false,
    isRetrying: false,
    thinkingLevel: "off",
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    steeringMode: "all",
    followUpMode: "all",
    pending: { steering: [], followUp: [] },
    messages: [],
    tools: {
      revision: 1,
      workspaceId: "w1",
      sessionId: "s1",
      sessionRevision: 1,
      tools: [],
      active: [],
    },
    ...overrides,
  };
}

describe("session catalog", () => {
  it("replaces persisted summaries without discarding live runtime state", () => {
    let catalog = replaceSessionCatalog(emptySessionCatalog(), "w1", [
      {
        sessionId: "s1",
        sessionPath: "C:/sessions/s1.jsonl",
        cwd: "C:/workspace",
        updatedAt: 1,
      },
    ]);
    catalog = setSessionRuntimeState(catalog, "s1", "running");
    catalog = replaceSessionCatalog(catalog, "w1", [
      {
        sessionId: "s1",
        sessionPath: "C:/sessions/s1.jsonl",
        name: "Updated",
        cwd: "C:/workspace",
        updatedAt: 2,
      },
    ]);

    expect(catalog.entries.s1).toMatchObject({
      name: "Updated",
      runtimeState: "running",
    });
  });

  it("restores server runtime metadata after client state is reloaded", () => {
    const catalog = replaceSessionCatalog(emptySessionCatalog(), "w1", [
      {
        sessionId: "s1",
        sessionPath: "C:/sessions/s1.jsonl",
        cwd: "C:/workspace",
        updatedAt: 1,
        runtimeState: "running",
        sessionRevision: 7,
      },
    ]);

    expect(catalog.entries.s1).toMatchObject({
      runtimeState: "running",
      sessionRevision: 7,
    });
  });

  it("optimistically keeps a live snapshot missing from session.list", () => {
    let catalog = upsertSessionSnapshot(emptySessionCatalog(), "w1", snapshot(), 10);
    catalog = replaceSessionCatalog(catalog, "w1", []);
    expect(sessionCatalogItems(catalog)).toMatchObject([
      { sessionId: "s1", runtimeState: "idle" },
    ]);
  });

  it("sorts snapshots by latest activity and updates names", () => {
    let catalog = upsertSessionSnapshot(
      emptySessionCatalog(),
      "w1",
      snapshot({ sessionId: "older" }),
      10,
    );
    catalog = upsertSessionSnapshot(catalog, "w1", snapshot({ sessionId: "newer" }), 20);
    catalog = updateSessionCatalogInfo(catalog, "newer", "New name");

    expect(catalog.order).toEqual(["newer", "older"]);
    expect(catalog.entries.newer?.name).toBe("New name");
  });

  it("derives visible runtime states from Pi snapshots", () => {
    expect(runtimeStateFromSnapshot(snapshot())).toBe("idle");
    expect(runtimeStateFromSnapshot(snapshot({ isIdle: false, isStreaming: true }))).toBe(
      "running",
    );
    expect(
      runtimeStateFromSnapshot(
        snapshot({ pending: { steering: ["adjust"], followUp: [] } }),
      ),
    ).toBe("queued");
  });

  it("does not treat opening an existing idle session as activity", () => {
    let catalog = replaceSessionCatalog(emptySessionCatalog(), "w1", [
      { sessionId: "top", sessionPath: "C:/sessions/top.jsonl", cwd: "C:/w", updatedAt: 30 },
      { sessionId: "s1", sessionPath: "C:/sessions/s1.jsonl", cwd: "C:/w", updatedAt: 10 },
    ]);
    // session.open applies an idle snapshot — the entry must keep its listed
    // timestamp instead of jumping to the top of the recency sort.
    catalog = upsertSessionSnapshot(catalog, "w1", snapshot(), 40);
    expect(catalog.entries.s1?.updatedAt).toBe(10);
    expect(catalog.order).toEqual(["top", "s1"]);

    // Real activity (streaming) still bumps recency.
    catalog = upsertSessionSnapshot(
      catalog,
      "w1",
      snapshot({ isIdle: false, isStreaming: true }),
      50,
    );
    expect(catalog.entries.s1?.updatedAt).toBe(50);
    expect(catalog.order).toEqual(["s1", "top"]);
  });

  it("reorders on runtime state changes only for genuine activity", () => {
    let catalog = replaceSessionCatalog(emptySessionCatalog(), "w1", [
      { sessionId: "top", sessionPath: "C:/sessions/top.jsonl", cwd: "C:/w", updatedAt: 30 },
      { sessionId: "s1", sessionPath: "C:/sessions/s1.jsonl", cwd: "C:/w", updatedAt: 10 },
    ]);
    // Host stamps idle announcements with Date.now() after session.open —
    // must not reorder. Local optimistic "starting" has no timestamp — same.
    catalog = setSessionRuntimeState(catalog, "s1", "starting");
    catalog = setSessionRuntimeState(catalog, "s1", "idle", undefined, 99);
    expect(catalog.entries.s1?.updatedAt).toBe(10);
    expect(catalog.order).toEqual(["top", "s1"]);

    catalog = setSessionRuntimeState(catalog, "s1", "running", undefined, 100);
    expect(catalog.entries.s1?.updatedAt).toBe(100);
    expect(catalog.order).toEqual(["s1", "top"]);
  });
});
