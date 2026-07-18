import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiHostServer } from "./server.js";
import { TryMutex } from "./locks.js";
import {
  WorkspaceGraphFactory,
  type GraphFactoryDeps,
  type WorkspaceGraph,
} from "./workspace-graph-factory.js";

const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const SECOND_SESSION_ID = "44444444-4444-4444-8444-444444444444";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-desktop-session-files-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  mkdirSync(cwd, { recursive: true });
  const resolvedCwd = resolve(cwd);
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const activeDir = join(agentDir, "sessions", safePath);
  mkdirSync(activeDir, { recursive: true });

  const factory = new WorkspaceGraphFactory({ agentDir } as GraphFactoryDeps);
  const graph = {
    canonicalCwd: resolvedCwd,
    servicesReady: true,
    agentSession: null,
    sessionSnapshot: null,
    backgroundSessions: new Map(),
  } as unknown as WorkspaceGraph;
  Reflect.set(factory, "graph", graph);
  factory.bindServer({
    serviceGraphLock: new TryMutex(),
    identity: {
      sessionId: null,
      sessionRevision: 0,
    },
  } as unknown as PiHostServer);

  return { root, cwd: resolvedCwd, activeDir, factory };
}

function writeSession(dir: string, sessionId: string, cwd: string): string {
  const sessionPath = join(dir, `${sessionId}.jsonl`);
  writeFileSync(
    sessionPath,
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd,
      }),
      JSON.stringify({
        type: "session_info",
        id: "info-1",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        name: "Lifecycle test",
      }),
    ].join("\n") + "\n",
  );
  return sessionPath;
}

describe("Session file lifecycle", () => {
  it("archives, lists, restores, and permanently deletes a Session", async () => {
    const fixture = createFixture();
    const originalPath = writeSession(fixture.activeDir, SESSION_ID, fixture.cwd);

    const archived = await fixture.factory.archiveSession("archive", SESSION_ID, originalPath);
    expect(archived).toMatchObject({ sessionId: SESSION_ID, archived: true });
    expect(existsSync(originalPath)).toBe(false);
    expect("error" in archived).toBe(false);
    if ("error" in archived) return;
    expect(existsSync(archived.sessionPath)).toBe(true);
    expect(await fixture.factory.listSessions()).toEqual([
      expect.objectContaining({ id: SESSION_ID, archived: true }),
    ]);

    const restored = await fixture.factory.restoreSession(
      "restore",
      SESSION_ID,
      archived.sessionPath,
    );
    expect(restored).toEqual({
      sessionId: SESSION_ID,
      sessionPath: originalPath,
      archived: false,
    });
    expect(existsSync(originalPath)).toBe(true);

    const archivedAgain = await fixture.factory.archiveSession(
      "archive-again",
      SESSION_ID,
      originalPath,
    );
    expect("error" in archivedAgain).toBe(false);
    if ("error" in archivedAgain) return;
    const deleted = await fixture.factory.deleteArchivedSession(
      "delete",
      SESSION_ID,
      archivedAgain.sessionPath,
    );
    expect(deleted).toEqual({ sessionId: SESSION_ID, deleted: true });
    expect(await fixture.factory.listSessions()).toEqual([]);
  });

  it("rejects forged paths and Sessions owned by a Runtime", async () => {
    const fixture = createFixture();
    const sessionPath = writeSession(fixture.activeDir, SESSION_ID, fixture.cwd);
    const otherPath = writeSession(fixture.activeDir, SECOND_SESSION_ID, fixture.cwd);

    const forged = await fixture.factory.archiveSession("forged", SESSION_ID, otherPath);
    expect("error" in forged && forged.error.code).toBe("SESSION_NOT_FOUND");
    expect(existsSync(sessionPath)).toBe(true);
    expect(existsSync(otherPath)).toBe(true);

    vi.spyOn(fixture.factory, "getSessionRuntimeInfo").mockReturnValue({
      runtimeState: "idle",
      sessionRevision: 1,
    });
    const occupied = await fixture.factory.archiveSession(
      "occupied",
      SESSION_ID,
      sessionPath,
    );
    expect("error" in occupied && occupied.error.code).toBe("AGENT_BUSY");
    expect(existsSync(sessionPath)).toBe(true);
  });

  it("cleans all archived Sessions and reports the count", async () => {
    const fixture = createFixture();
    const first = writeSession(fixture.activeDir, SESSION_ID, fixture.cwd);
    const second = writeSession(fixture.activeDir, SECOND_SESSION_ID, fixture.cwd);
    await fixture.factory.archiveSession("archive-first", SESSION_ID, first);
    await fixture.factory.archiveSession("archive-second", SECOND_SESSION_ID, second);

    const result = await fixture.factory.cleanupArchivedSessions("cleanup");

    expect(result).toEqual({ deletedCount: 2, failedCount: 0 });
    expect(await fixture.factory.listSessions()).toEqual([]);
  });
});
