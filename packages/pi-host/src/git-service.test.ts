import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitService, parseGitStatusPorcelain, parseUnifiedGitDiffHunks } from "./git-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

async function createRepository(): Promise<{ root: string; workspace: string }> {
  const root = await mkdtemp(join(tmpdir(), "pideck-git-"));
  temporaryDirectories.push(root);
  const workspace = join(root, "packages", "app");
  await mkdir(workspace, { recursive: true });
  git(root, "init");
  git(root, "config", "user.name", "PiDeck Test");
  git(root, "config", "user.email", "pideck@example.invalid");
  git(root, "config", "core.autocrlf", "false");
  await writeFile(join(workspace, "tracked.txt"), "first\n", "utf8");
  git(root, "add", ".");
  git(root, "commit", "-m", "initial");
  return { root, workspace };
}

describe("parseGitStatusPorcelain", () => {
  it("parses branch, ordinary, renamed, conflicted, and untracked records", () => {
    const oid = "a".repeat(40);
    const zero = "0".repeat(40);
    const output = Buffer.from(
      [
        `# branch.oid ${oid}`,
        "# branch.head main",
        "# branch.upstream origin/main",
        "# branch.ab +2 -3",
        `1 .M N... 100644 100644 100644 ${oid} ${oid} src/app.ts`,
        `2 R. N... 100644 100644 100644 ${oid} ${oid} R100 src/new name.ts`,
        "src/old name.ts",
        `u UU N... 100644 100644 100644 100644 ${oid} ${zero} ${oid} conflict.ts`,
        "? notes.txt",
      ].join("\0") + "\0",
    );

    const parsed = parseGitStatusPorcelain(output);
    expect(parsed).toMatchObject({
      branch: "main",
      detached: false,
      unborn: false,
      upstream: "origin/main",
      ahead: 2,
      behind: 3,
    });
    expect(parsed.files).toEqual([
      {
        path: "src/app.ts",
        staged: null,
        unstaged: "modified",
        conflict: false,
        submodule: false,
        pathSupported: true,
      },
      {
        path: "src/new name.ts",
        originalPath: "src/old name.ts",
        staged: "renamed",
        unstaged: null,
        conflict: false,
        submodule: false,
        pathSupported: true,
      },
      {
        path: "conflict.ts",
        staged: "conflicted",
        unstaged: "conflicted",
        conflict: true,
        submodule: false,
        pathSupported: true,
      },
      {
        path: "notes.txt",
        staged: null,
        unstaged: "untracked",
        conflict: false,
        submodule: false,
        pathSupported: true,
      },
    ]);
    expect(parsed.indexGeneration).toMatch(/^[0-9a-f]{64}$/);
  });

  it("marks non-UTF-8 paths read-only without losing the status record", () => {
    const output = Buffer.concat([
      Buffer.from("? bad-"),
      Buffer.from([0xff]),
      Buffer.from(".txt\0"),
    ]);
    const parsed = parseGitStatusPorcelain(output);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]).toMatchObject({ unstaged: "untracked", pathSupported: false });
    expect(parsed.warnings).toHaveLength(1);
  });
});

describe("parseUnifiedGitDiffHunks", () => {
  it("returns stable metadata and standalone patches for each unified hunk", () => {
    const patch = [
      "diff --git a/file.txt b/file.txt",
      "index 1111111..2222222 100644",
      "--- a/file.txt",
      "+++ b/file.txt",
      "@@ -1,2 +1,2 @@",
      "-old one",
      "+new one",
      " keep",
      "@@ -10 +10 @@",
      "-old ten",
      "+new ten",
      "",
    ].join("\n");

    const hunks = parseUnifiedGitDiffHunks(patch);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({
      header: "@@ -1,2 +1,2 @@",
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 2,
      additions: 1,
      deletions: 1,
    });
    expect(hunks[0]?.id).toMatch(/^[0-9a-f]{64}$/);
    expect(hunks[0]?.patch).toContain("diff --git a/file.txt b/file.txt");
    expect(hunks[0]?.patch).not.toContain("@@ -10 +10 @@");
  });
});

describe("GitService", () => {
  it("returns an expected empty state outside a repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "pideck-not-git-"));
    temporaryDirectories.push(root);
    await expect(new GitService().getStatus(root)).resolves.toEqual({
      state: "not_repository",
      revision: 1,
    });
  });

  it("reports a missing Git executable as unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "pideck-no-git-"));
    temporaryDirectories.push(root);
    const status = await new GitService(join(root, "missing-git")).getStatus(root);
    expect(status.state).toBe("unavailable");
  });

  it("discovers the parent repository and preserves unstaged work across commit", async () => {
    const { root, workspace } = await createRepository();
    const service = new GitService();
    await writeFile(join(workspace, "tracked.txt"), "second\n", "utf8");
    await writeFile(join(workspace, "new.txt"), "new file\n", "utf8");

    const initial = await service.getStatus(workspace);
    expect(initial.state).toBe("ready");
    if (initial.state !== "ready") return;
    expect(initial.repositoryRoot).toBe(await realpath(root));
    expect(initial.workspaceIsRepositoryRoot).toBe(false);
    expect(initial.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "packages/app/tracked.txt", unstaged: "modified" }),
        expect.objectContaining({ path: "packages/app/new.txt", unstaged: "untracked" }),
      ]),
    );

    const trackedDiff = await service.getDiff(
      workspace,
      "packages/app/tracked.txt",
      "unstaged",
      initial.revision,
    );
    expect(trackedDiff.patch).toContain("+second");
    const newDiff = await service.getDiff(
      workspace,
      "packages/app/new.txt",
      "unstaged",
      initial.revision,
    );
    expect(newDiff.patch).toContain("+new file");

    const stagedResult = await service.stage(
      workspace,
      "packages/app/tracked.txt",
      initial.revision,
    );
    expect(stagedResult.applied).toBe(true);
    const staged = stagedResult.snapshot;
    expect(staged?.state).toBe("ready");
    if (!staged || staged.state !== "ready") return;
    expect(staged.files).toContainEqual(
      expect.objectContaining({
        path: "packages/app/tracked.txt",
        staged: "modified",
        unstaged: null,
      }),
    );

    await writeFile(join(workspace, "tracked.txt"), "third\n", "utf8");
    const both = await service.getStatus(workspace);
    expect(both.state).toBe("ready");
    if (both.state !== "ready") return;
    expect(both.files).toContainEqual(
      expect.objectContaining({
        path: "packages/app/tracked.txt",
        staged: "modified",
        unstaged: "modified",
      }),
    );

    const committed = await service.commit(workspace, "update tracked", both.indexGeneration);
    expect(committed.applied).toBe(true);
    expect(committed.commitSha).toMatch(/^[0-9a-f]{40,64}$/);
    expect(git(root, "show", "HEAD:packages/app/tracked.txt")).toBe("second");
    expect(await service.getStatus(workspace)).toMatchObject({
      state: "ready",
      files: expect.arrayContaining([
        expect.objectContaining({
          path: "packages/app/tracked.txt",
          staged: null,
          unstaged: "modified",
        }),
      ]),
    });
  });

  it("unstages an indexed file without changing its working bytes", async () => {
    const { workspace } = await createRepository();
    const service = new GitService();
    await writeFile(join(workspace, "tracked.txt"), "changed\n", "utf8");
    const initial = await service.getStatus(workspace);
    if (initial.state !== "ready") throw new Error("expected ready status");
    const staged = await service.stage(workspace, "packages/app/tracked.txt", initial.revision);
    if (!staged.snapshot || staged.snapshot.state !== "ready") throw new Error("expected status");
    const unstaged = await service.unstage(
      workspace,
      "packages/app/tracked.txt",
      staged.snapshot.revision,
    );
    expect(unstaged.snapshot).toMatchObject({
      state: "ready",
      files: [
        expect.objectContaining({
          path: "packages/app/tracked.txt",
          staged: null,
          unstaged: "modified",
        }),
      ],
    });
  });

  it("stages and unstages all repository changes without changing working bytes", async () => {
    const { workspace } = await createRepository();
    const service = new GitService();
    await writeFile(join(workspace, "tracked.txt"), "changed\n", "utf8");
    await writeFile(join(workspace, "new.txt"), "new\n", "utf8");

    const initial = await service.getStatus(workspace);
    if (initial.state !== "ready") throw new Error("expected ready status");
    const staged = await service.stageAll(workspace, initial.revision);
    if (!staged.snapshot || staged.snapshot.state !== "ready") throw new Error("expected status");
    expect(staged.snapshot.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "packages/app/tracked.txt",
          staged: "modified",
          unstaged: null,
        }),
        expect.objectContaining({ path: "packages/app/new.txt", staged: "added", unstaged: null }),
      ]),
    );

    const unstaged = await service.unstageAll(workspace, staged.snapshot.revision);
    expect(unstaged.snapshot).toMatchObject({
      state: "ready",
      files: expect.arrayContaining([
        expect.objectContaining({
          path: "packages/app/tracked.txt",
          staged: null,
          unstaged: "modified",
        }),
        expect.objectContaining({
          path: "packages/app/new.txt",
          staged: null,
          unstaged: "untracked",
        }),
      ]),
    });
    await expect(readFile(join(workspace, "tracked.txt"), "utf8")).resolves.toBe("changed\n");
    await expect(readFile(join(workspace, "new.txt"), "utf8")).resolves.toBe("new\n");
  });

  it("discards tracked worktree changes while preserving reviewed staged bytes", async () => {
    const { root, workspace } = await createRepository();
    const service = new GitService();
    const path = "packages/app/tracked.txt";
    await writeFile(join(workspace, "tracked.txt"), "reviewed\n", "utf8");
    const initial = await service.getStatus(workspace);
    if (initial.state !== "ready") throw new Error("expected ready status");
    const staged = await service.stage(workspace, path, initial.revision);
    if (!staged.snapshot || staged.snapshot.state !== "ready") throw new Error("expected status");

    await writeFile(join(workspace, "tracked.txt"), "discard me\n", "utf8");
    const changed = await service.getStatus(workspace);
    if (changed.state !== "ready") throw new Error("expected ready status");
    const discarded = await service.discard(workspace, path, changed.revision);
    expect(discarded.snapshot).toMatchObject({
      state: "ready",
      files: [expect.objectContaining({ path, staged: "modified", unstaged: null })],
    });
    await expect(readFile(join(workspace, "tracked.txt"), "utf8")).resolves.toBe("reviewed\n");
    expect(git(root, "show", `:${path}`)).toBe("reviewed");

    await writeFile(join(workspace, "untracked.txt"), "keep me\n", "utf8");
    const withUntracked = await service.getStatus(workspace);
    if (withUntracked.state !== "ready") throw new Error("expected ready status");
    await expect(
      service.discard(workspace, "packages/app/untracked.txt", withUntracked.revision),
    ).rejects.toMatchObject({ code: "GIT_OPERATION_FAILED" });
    await expect(readFile(join(workspace, "untracked.txt"), "utf8")).resolves.toBe("keep me\n");
  });

  it("rejects commit when staged bytes change after review", async () => {
    const { workspace } = await createRepository();
    const service = new GitService();
    const path = "packages/app/tracked.txt";
    await writeFile(join(workspace, "tracked.txt"), "reviewed\n", "utf8");
    const initial = await service.getStatus(workspace);
    if (initial.state !== "ready") throw new Error("expected ready status");
    const reviewed = await service.stage(workspace, path, initial.revision);
    if (!reviewed.snapshot || reviewed.snapshot.state !== "ready") {
      throw new Error("expected staged status");
    }
    const expectedIndexGeneration = reviewed.snapshot.indexGeneration;

    await writeFile(join(workspace, "tracked.txt"), "changed after review\n", "utf8");
    const changed = await service.getStatus(workspace);
    if (changed.state !== "ready") throw new Error("expected changed status");
    const restaged = await service.stage(workspace, path, changed.revision);
    if (!restaged.snapshot || restaged.snapshot.state !== "ready") {
      throw new Error("expected restaged status");
    }
    expect(restaged.snapshot.indexGeneration).not.toBe(expectedIndexGeneration);
    await expect(
      service.commit(workspace, "must not commit", expectedIndexGeneration),
    ).rejects.toMatchObject({ code: "STALE_REVISION" });
  });

  it("stages and discards individual hunks without touching the other hunk", async () => {
    const { root, workspace } = await createRepository();
    const service = new GitService();
    const path = "packages/app/tracked.txt";
    const original = Array.from({ length: 24 }, (_, index) => `line ${index + 1}`);
    await writeFile(join(workspace, "tracked.txt"), `${original.join("\n")}\n`, "utf8");
    git(root, "add", path);
    git(root, "commit", "-m", "expand fixture");

    const changed = [...original];
    changed[1] = "changed near top";
    changed[21] = "changed near bottom";
    await writeFile(join(workspace, "tracked.txt"), `${changed.join("\n")}\n`, "utf8");
    const status = await service.getStatus(workspace);
    if (status.state !== "ready") throw new Error("expected ready status");
    const diff = await service.getDiff(workspace, path, "unstaged", status.revision);
    expect(diff.hunks).toHaveLength(2);

    const staged = await service.mutateHunk(
      workspace,
      path,
      "unstaged",
      diff.hunks[0]!.id,
      "stage",
      status.revision,
      diff.contentGeneration,
    );
    if (!staged.snapshot || staged.snapshot.state !== "ready") throw new Error("expected status");
    expect(git(root, "show", `:${path}`)).toContain("changed near top");
    expect(git(root, "show", `:${path}`)).toContain("line 22");

    const remaining = await service.getDiff(workspace, path, "unstaged", staged.snapshot.revision);
    expect(remaining.hunks).toHaveLength(1);
    const discarded = await service.mutateHunk(
      workspace,
      path,
      "unstaged",
      remaining.hunks[0]!.id,
      "discard",
      staged.snapshot.revision,
      remaining.contentGeneration,
    );
    expect(discarded.applied).toBe(true);
    const worktree = await readFile(join(workspace, "tracked.txt"), "utf8");
    expect(worktree).toContain("changed near top");
    expect(worktree).toContain("line 22");
    expect(worktree).not.toContain("changed near bottom");
  });

  it("unstages one reviewed hunk and rejects a stale hunk identity", async () => {
    const { root, workspace } = await createRepository();
    const service = new GitService();
    const path = "packages/app/tracked.txt";
    const original = Array.from({ length: 24 }, (_, index) => `row ${index + 1}`);
    await writeFile(join(workspace, "tracked.txt"), `${original.join("\n")}\n`, "utf8");
    git(root, "add", path);
    git(root, "commit", "-m", "expand fixture");
    const changed = [...original];
    changed[1] = "reviewed top";
    changed[21] = "reviewed bottom";
    await writeFile(join(workspace, "tracked.txt"), `${changed.join("\n")}\n`, "utf8");
    git(root, "add", path);

    const status = await service.getStatus(workspace);
    if (status.state !== "ready") throw new Error("expected ready status");
    const diff = await service.getDiff(workspace, path, "staged", status.revision);
    expect(diff.hunks).toHaveLength(2);
    await expect(
      service.mutateHunk(
        workspace,
        path,
        "staged",
        "0".repeat(64),
        "unstage",
        status.revision,
        diff.contentGeneration,
      ),
    ).rejects.toMatchObject({ code: "STALE_REVISION" });

    const result = await service.mutateHunk(
      workspace,
      path,
      "staged",
      diff.hunks[0]!.id,
      "unstage",
      status.revision,
      diff.contentGeneration,
    );
    expect(result.applied).toBe(true);
    expect(git(root, "show", `:${path}`)).toContain("row 2");
    expect(git(root, "show", `:${path}`)).toContain("reviewed bottom");
    expect(await readFile(join(workspace, "tracked.txt"), "utf8")).toContain("reviewed top");
  });

  it("stages a selected hunk from an untracked text file", async () => {
    const { root, workspace } = await createRepository();
    const service = new GitService();
    const path = "packages/app/new.txt";
    await writeFile(join(workspace, "new.txt"), "first\nsecond\nthird\n", "utf8");
    const status = await service.getStatus(workspace);
    if (status.state !== "ready") throw new Error("expected ready status");
    const diff = await service.getDiff(workspace, path, "unstaged", status.revision);
    expect(diff.hunks).toHaveLength(1);
    expect(diff.hunkOperations).toEqual(["stage"]);

    const result = await service.mutateHunk(
      workspace,
      path,
      "unstaged",
      diff.hunks[0]!.id,
      "stage",
      status.revision,
      diff.contentGeneration,
    );
    expect(result.applied).toBe(true);
    expect(git(root, "show", `:${path}`)).toBe("first\nsecond\nthird");
  });

  it("creates and switches local branches and pages first-parent history", async () => {
    const { root, workspace } = await createRepository();
    const service = new GitService();
    const initial = await service.getStatus(workspace);
    if (initial.state !== "ready") throw new Error("expected ready status");

    const created = await service.createBranch(workspace, "feature/history", initial.revision);
    if (!created.snapshot || created.snapshot.state !== "ready") throw new Error("expected status");
    expect(created.snapshot.branch).toBe("feature/history");
    const branches = await service.listBranches(workspace);
    expect(branches.branches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "feature/history", current: true }),
        expect.objectContaining({ name: initial.branch, current: false }),
      ]),
    );

    await writeFile(join(workspace, "history.txt"), "history change\n", "utf8");
    git(root, "add", ".");
    git(root, "commit", "-m", "history change");
    const history = await service.listHistory(workspace, 1);
    expect(history.commits).toHaveLength(1);
    expect(history.commits[0]).toMatchObject({
      subject: "history change",
      authorName: "PiDeck Test",
    });
    expect(history.nextCursor).toBe(history.commits[0]?.sha);
    const older = await service.listHistory(workspace, 10, history.nextCursor!);
    expect(older.commits[0]?.subject).toBe("initial");

    const commitDiff = await service.getCommitDiff(workspace, history.commits[0]!.sha);
    expect(commitDiff.patch).toContain("+history change");
    expect(commitDiff.parentSha).toMatch(/^[0-9a-f]{40,64}$/);
    const rootDiff = await service.getCommitDiff(workspace, older.commits[0]!.sha);
    expect(rootDiff.parentSha).toBeNull();
    expect(rootDiff.patch).toContain("+first");

    const latest = await service.getStatus(workspace);
    if (latest.state !== "ready") throw new Error("expected ready status");
    const switched = await service.switchBranch(workspace, initial.branch!, latest.revision);
    expect(switched.snapshot).toMatchObject({ state: "ready", branch: initial.branch });
  });

  it("uses the explicit executable and isolated env when user PATH has no Git", async () => {
    const { root } = await createRepository();
    const gitExecutable = execFileSync(process.platform === "win32" ? "where" : "which", ["git"], {
      encoding: "utf8",
    })
      .trim()
      .split(/\r?\n/)[0];
    expect(gitExecutable).toBeTruthy();
    const isolatedPath =
      process.platform === "win32"
        ? join(process.env.SystemRoot ?? "C:\\Windows", "System32")
        : "/usr/bin";
    const service = new GitService(gitExecutable, {
      ...process.env,
      PATH: isolatedPath,
      HTTP_PROXY: "http://git-proxy.test:8080",
    });
    await expect(service.getStatus(root)).resolves.toMatchObject({ state: "ready" });
  });

  it("does not crash the Host when Git is cancelled with a PATH that omits System32", async () => {
    const { root } = await createRepository();
    const gitExecutable = execFileSync(process.platform === "win32" ? "where" : "which", ["git"], {
      encoding: "utf8",
    })
      .trim()
      .split(/\r?\n/)[0];
    const isolatedPath = join(root, "no-system32");
    const previousPath = process.env.PATH;
    process.env.PATH = isolatedPath;
    try {
      const service = new GitService(gitExecutable, {
        ...process.env,
        PATH: isolatedPath,
        Path: undefined,
      });
      const controller = new AbortController();
      controller.abort();
      await expect(service.getStatus(root, controller.signal)).resolves.toMatchObject({
        state: "error",
        message: "Git command was cancelled",
      });
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it("does not fall back to user PATH Git when the executable is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "pideck-explicit-git-"));
    temporaryDirectories.push(root);
    const status = await new GitService(join(root, "missing-git"), {
      ...process.env,
    }).getStatus(root);
    expect(status.state).toBe("unavailable");
  });
});
