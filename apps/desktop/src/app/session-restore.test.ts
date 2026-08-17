import { describe, expect, it } from "vitest";
import { shouldRestoreLastSession } from "./session-restore";

describe("shouldRestoreLastSession", () => {
  const lastSessionPath = "C:/sessions/kept.jsonl";
  const lastWorkspace = "C:/repo";

  it("restores on first Host ready when the preloaded session is not the last one", () => {
    expect(
      shouldRestoreLastSession({
        reason: "host ready",
        restoreLastSession: true,
        lastSessionPath,
        lastWorkspace,
        currentWorkspacePath: lastWorkspace,
        currentSessionPath: "C:/sessions/new.jsonl",
      }),
    ).toBe(true);
  });

  it("skips restore when Host already opened the last session", () => {
    expect(
      shouldRestoreLastSession({
        reason: "host ready",
        restoreLastSession: true,
        lastSessionPath,
        lastWorkspace,
        currentWorkspacePath: lastWorkspace,
        currentSessionPath: lastSessionPath,
      }),
    ).toBe(false);
  });

  it("does not clobber a live Host during recovery", () => {
    expect(
      shouldRestoreLastSession({
        reason: "sequence gap at 12",
        restoreLastSession: true,
        lastSessionPath,
        lastWorkspace,
        currentWorkspacePath: lastWorkspace,
        currentSessionPath: "C:/sessions/live.jsonl",
      }),
    ).toBe(false);
  });

  it("does not open a last session that belongs to another workspace", () => {
    expect(
      shouldRestoreLastSession({
        reason: "bootstrap hello",
        restoreLastSession: true,
        lastSessionPath,
        lastWorkspace,
        currentWorkspacePath: "C:/other",
        currentSessionPath: "C:/sessions/other.jsonl",
      }),
    ).toBe(false);
  });

  it("respects the restoreLastSession setting", () => {
    expect(
      shouldRestoreLastSession({
        reason: "host ready",
        restoreLastSession: false,
        lastSessionPath,
        lastWorkspace,
        currentWorkspacePath: lastWorkspace,
        currentSessionPath: "C:/sessions/new.jsonl",
      }),
    ).toBe(false);
  });
});
