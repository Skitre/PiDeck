import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceSessionManager } from "./workspace-session-bootstrap.js";

const roots: string[] = [];
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempWorkspace(): { cwd: string } {
  const root = mkdtempSync(join(tmpdir(), "pideck-session-bootstrap-"));
  roots.push(root);
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  return { cwd };
}

function sessionDirFor(cwd: string): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  if (!agentDir) throw new Error("PI_CODING_AGENT_DIR is required");
  const resolvedCwd = resolve(cwd);
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(resolve(agentDir), "sessions", safePath);
}

function writeNamedSession(cwd: string, id: string, name: string, mtime: Date): string {
  const dir = sessionDirFor(cwd);
  mkdirSync(dir, { recursive: true });
  const sessionPath = join(dir, `${id}.jsonl`);
  const timestamp = mtime.toISOString();
  writeFileSync(
    sessionPath,
    [
      JSON.stringify({ type: "session", version: 3, id, timestamp, cwd }),
      JSON.stringify({
        type: "session_info",
        id: "info-1",
        parentId: null,
        timestamp,
        name,
      }),
      "",
    ].join("\n"),
  );
  utimesSync(sessionPath, mtime, mtime);
  return sessionPath;
}

describe("createWorkspaceSessionManager", () => {
  it("creates a new session by default", async () => {
    const { cwd } = tempWorkspace();
    const first = await createWorkspaceSessionManager(cwd);
    const second = await createWorkspaceSessionManager(cwd);
    expect(first.getSessionFile()).not.toBe(second.getSessionFile());
  });

  it("opens the requested session path", async () => {
    const { cwd } = tempWorkspace();
    const sessionPath = writeNamedSession(
      cwd,
      "11111111-1111-4111-8111-111111111111",
      "kept",
      new Date("2026-01-01T00:00:00.000Z"),
    );
    const opened = await createWorkspaceSessionManager(cwd, { sessionPath });
    expect(opened.getSessionFile()).toBe(sessionPath);
    expect(opened.getSessionName()).toBe("kept");
  });

  it("continues the most recent session when asked", async () => {
    const { cwd } = tempWorkspace();
    writeNamedSession(
      cwd,
      "11111111-1111-4111-8111-111111111111",
      "older",
      new Date("2026-01-01T00:00:00.000Z"),
    );
    const recentPath = writeNamedSession(
      cwd,
      "22222222-2222-4222-8222-222222222222",
      "recent",
      new Date("2026-01-02T00:00:00.000Z"),
    );
    const continued = await createWorkspaceSessionManager(cwd, { continueRecent: true });
    expect(continued.getSessionFile()).toBe(recentPath);
  });

  it("falls back to continueRecent when the requested path is missing", async () => {
    const { cwd } = tempWorkspace();
    const recentPath = writeNamedSession(
      cwd,
      "22222222-2222-4222-8222-222222222222",
      "recent",
      new Date("2026-01-02T00:00:00.000Z"),
    );
    const opened = await createWorkspaceSessionManager(cwd, {
      sessionPath: join(cwd, "missing.jsonl"),
      continueRecent: true,
    });
    expect(opened.getSessionFile()).toBe(recentPath);
  });

  it("does not open a session file that belongs to another workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "pideck-session-bootstrap-"));
    roots.push(root);
    const cwdA = join(root, "workspace-a");
    const cwdB = join(root, "workspace-b");
    const agentDir = join(root, "agent");
    mkdirSync(cwdA, { recursive: true });
    mkdirSync(cwdB, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const foreignPath = writeNamedSession(
      cwdB,
      "11111111-1111-4111-8111-111111111111",
      "foreign",
      new Date("2026-01-01T00:00:00.000Z"),
    );
    const localPath = writeNamedSession(
      cwdA,
      "22222222-2222-4222-8222-222222222222",
      "local",
      new Date("2026-01-02T00:00:00.000Z"),
    );

    const opened = await createWorkspaceSessionManager(cwdA, {
      sessionPath: foreignPath,
      continueRecent: true,
    });
    expect(opened.getSessionFile()).toBe(localPath);
    expect(opened.getSessionName()).toBe("local");
  });
});
