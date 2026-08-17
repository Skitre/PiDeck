import { describe, expect, it } from "vitest";
import type { SessionSnapshot } from "@pideck/protocol";
import {
  emptySessionCatalog,
  isStaleForegroundSnapshot,
  replaceSessionCatalog,
  runtimeStateFromSnapshot,
  sessionCatalogItems,
  setSessionRuntimeState,
  shouldProjectSnapshotIntoCatalog,
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
    pending: { revision: 0, steering: [], followUp: [] },
    messages: [{ role: "user", content: "hi" }],
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
  it("keeps a new Session out of the catalog until its first message", () => {
    let catalog = upsertSessionSnapshot(
      emptySessionCatalog(),
      "w1",
      snapshot({ messages: [] }),
      10,
    );
    expect(sessionCatalogItems(catalog)).toEqual([]);

    catalog = upsertSessionSnapshot(catalog, "w1", snapshot(), 20);
    expect(sessionCatalogItems(catalog)).toMatchObject([{ sessionId: "s1", messageCount: 1 }]);
  });

  it("inserts a live Session before its first persisted message", () => {
    const catalog = upsertSessionSnapshot(
      emptySessionCatalog(),
      "w1",
      snapshot({ messages: [], isIdle: false, isStreaming: true }),
      10,
    );
    expect(sessionCatalogItems(catalog)).toMatchObject([
      { sessionId: "s1", runtimeState: "running", messageCount: 0 },
    ]);
  });

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
    expect(sessionCatalogItems(catalog)).toMatchObject([{ sessionId: "s1", runtimeState: "idle" }]);
  });

  it("drops stale error entries missing from session.list", () => {
    let catalog = upsertSessionSnapshot(emptySessionCatalog(), "w1", snapshot(), 10);
    catalog = setSessionRuntimeState(catalog, "s1", "error", "Session not found");
    catalog = replaceSessionCatalog(catalog, "w1", []);
    expect(sessionCatalogItems(catalog)).toEqual([]);
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
        snapshot({ pending: { revision: 1, steering: ["adjust"], followUp: [] } }),
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

  it("treats an older snapshot of another Session as stale", () => {
    expect(
      isStaleForegroundSnapshot(
        snapshot({ sessionId: "b", revision: 6 }),
        snapshot({ sessionId: "a", revision: 5 }),
      ),
    ).toBe(true);
    expect(
      isStaleForegroundSnapshot(
        snapshot({ sessionId: "a", revision: 5 }),
        snapshot({ sessionId: "b", revision: 6 }),
      ),
    ).toBe(false);
  });

  it("does not reorder a live Session on later transcript upserts", () => {
    let catalog = upsertSessionSnapshot(
      emptySessionCatalog(),
      "w1",
      snapshot({ sessionId: "a", isIdle: false, isStreaming: true }),
      10,
    );
    catalog = upsertSessionSnapshot(
      catalog,
      "w1",
      snapshot({ sessionId: "b", isIdle: false, isStreaming: true }),
      20,
    );
    expect(catalog.order).toEqual(["b", "a"]);

    catalog = upsertSessionSnapshot(
      catalog,
      "w1",
      snapshot({
        sessionId: "a",
        isIdle: false,
        isStreaming: true,
        messages: [{ role: "assistant", content: "more" }],
      }),
      30,
    );
    expect(catalog.entries.a?.updatedAt).toBe(10);
    expect(catalog.order).toEqual(["b", "a"]);
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

    catalog = setSessionRuntimeState(catalog, "s1", "running", undefined, 110, 9);
    expect(catalog.entries.s1?.sessionRevision).toBe(9);
    expect(catalog.entries.s1?.updatedAt).toBe(100);
  });

  it("projects a snapshot only when it belongs to the catalog Workspace", () => {
    const workspace = { id: "w1", cwd: "C:/w1", canonicalCwd: "C:/w1" };
    const catalog = upsertSessionSnapshot(emptySessionCatalog(), "w1", snapshot(), 10);

    expect(shouldProjectSnapshotIntoCatalog(catalog, workspace, snapshot())).toBe(true);
    expect(shouldProjectSnapshotIntoCatalog(emptySessionCatalog(), workspace, snapshot())).toBe(
      true,
    );
    expect(
      shouldProjectSnapshotIntoCatalog(
        emptySessionCatalog(),
        workspace,
        snapshot({
          cwd: "C:/w2",
          tools: { ...snapshot().tools, workspaceId: "w2" },
        }),
      ),
    ).toBe(false);
    expect(
      shouldProjectSnapshotIntoCatalog(
        catalog,
        workspace,
        snapshot({
          cwd: "C:/w2",
          tools: { ...snapshot().tools, workspaceId: "w2" },
        }),
      ),
    ).toBe(true);
  });
});
