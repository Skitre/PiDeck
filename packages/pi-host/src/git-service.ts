import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { terminateWindowsProcessTree } from "./windows-process.js";
import {
  MAX_GIT_DIFF_LINES,
  MAX_GIT_DIFF_OUTPUT_BYTES,
  MAX_GIT_BRANCHES,
  MAX_GIT_HISTORY_PAGE_SIZE,
  MAX_GIT_METADATA_OUTPUT_BYTES,
  MAX_GIT_STATUS_ENTRIES,
  MAX_GIT_STATUS_OUTPUT_BYTES,
  type GitBranchList,
  type GitChangeKind,
  type GitCommitDiffSnapshot,
  type GitCommitResult,
  type GitDiffHunk,
  type GitDiffSnapshot,
  type GitFileChange,
  type GitHistoryResult,
  type GitHunkOperation,
  type GitMutationResult,
  type GitStatusSnapshot,
  type HostErrorCode,
} from "@pideck/protocol";

const GIT_READ_TIMEOUT_MS = 10_000;
const GIT_MUTATION_TIMEOUT_MS = 30_000;
const GIT_COMMIT_TIMEOUT_MS = 60_000;
const GIT_STDERR_LIMIT_BYTES = 256 * 1024;
const GIT_MUTATION_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const GIT_WATCH_INTERVAL_MS = 2_000;

type GitCommandResult = {
  exitCode: number | null;
  stdout: Buffer;
  stderr: string;
  stdoutTruncated: boolean;
};

type GitCommandOptions = {
  cwd: string;
  args: string[];
  timeoutMs: number;
  maxStdoutBytes: number;
  signal?: AbortSignal;
  stdin?: string;
  optionalLocks?: boolean;
  truncateStdout?: boolean;
  env?: NodeJS.ProcessEnv;
};

type WithoutRevision<T> = T extends unknown ? Omit<T, "revision"> : never;
type GitStatusCandidate = WithoutRevision<GitStatusSnapshot>;

export class GitServiceError extends Error {
  constructor(
    readonly code: Extract<
      HostErrorCode,
      "GIT_UNAVAILABLE" | "GIT_OPERATION_FAILED" | "GIT_OUTPUT_LIMIT" | "STALE_REVISION"
    >,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "GitServiceError";
  }
}

function terminateProcessTree(child: ChildProcessWithoutNullStreams): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    terminateWindowsProcessTree(child);
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

function boundedText(chunks: Buffer[], limit: number): string {
  const source = Buffer.concat(chunks);
  return source
    .subarray(0, limit)
    .toString("utf8")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

async function runGitCommand(
  executable: string,
  options: GitCommandOptions,
): Promise<GitCommandResult> {
  return new Promise((resolvePromise, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(executable, ["-C", options.cwd, "--no-pager", ...options.args], {
        cwd: options.cwd,
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        env: {
          ...(options.env ?? process.env),
          GIT_TERMINAL_PROMPT: "0",
          GIT_PAGER: "cat",
          PAGER: "cat",
          LC_ALL: "C",
          LANG: "C",
          ...(options.optionalLocks ? { GIT_OPTIONAL_LOCKS: "0" } : {}),
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(
        new GitServiceError(
          "GIT_UNAVAILABLE",
          error instanceof Error ? error.message : "Unable to start Git",
        ),
      );
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const stop = () => terminateProcessTree(child);
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    timer.unref?.();

    const onAbort = () => {
      aborted = true;
      stop();
    };
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutBytes < options.maxStdoutBytes) {
        const remaining = options.maxStdoutBytes - stdoutBytes;
        stdout.push(chunk.subarray(0, remaining));
      }
      stdoutBytes += chunk.length;
      if (stdoutBytes > options.maxStdoutBytes && !stdoutTruncated) {
        stdoutTruncated = true;
        if (!options.truncateStdout) stop();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes < GIT_STDERR_LIMIT_BYTES) {
        const remaining = GIT_STDERR_LIMIT_BYTES - stderrBytes;
        stderr.push(chunk.subarray(0, remaining));
      }
      stderrBytes += chunk.length;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(
        new GitServiceError(
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? "GIT_UNAVAILABLE"
            : "GIT_OPERATION_FAILED",
          error.message,
        ),
      );
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (timedOut) {
        reject(new GitServiceError("GIT_OPERATION_FAILED", "Git command timed out", true));
        return;
      }
      if (aborted) {
        reject(new GitServiceError("GIT_OPERATION_FAILED", "Git command was cancelled", true));
        return;
      }
      if (stdoutTruncated && !options.truncateStdout) {
        reject(new GitServiceError("GIT_OUTPUT_LIMIT", "Git command output exceeded its limit"));
        return;
      }
      resolvePromise({
        exitCode,
        stdout: Buffer.concat(stdout),
        stderr: boundedText(stderr, GIT_STDERR_LIMIT_BYTES).trim(),
        stdoutTruncated,
      });
    });

    if (options.stdin !== undefined) child.stdin.end(options.stdin, "utf8");
    else child.stdin.end();
  });
}

function splitNullRecords(output: Buffer): Buffer[] {
  const records: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== 0) continue;
    records.push(output.subarray(start, index));
    start = index + 1;
  }
  if (start < output.length) records.push(output.subarray(start));
  return records.filter((record) => record.length > 0);
}

function decodeUtf8(buffer: Buffer): { text: string; supported: boolean } {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(buffer), supported: true };
  } catch {
    const text = [...buffer]
      .map((byte) =>
        byte >= 0x20 && byte <= 0x7e
          ? String.fromCharCode(byte)
          : `\\x${byte.toString(16).padStart(2, "0")}`,
      )
      .join("");
    return { text, supported: false };
  }
}

function mapStatusCode(code: string): GitChangeKind | null {
  switch (code) {
    case ".":
      return null;
    case "A":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "type_changed";
    case "U":
      return "conflicted";
    default:
      return null;
  }
}

type ParsedGitStatus = {
  branch: string | null;
  detached: boolean;
  unborn: boolean;
  headSha: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  indexGeneration: string;
  files: GitFileChange[];
  warnings: string[];
};

export function parseGitStatusPorcelain(output: Buffer): ParsedGitStatus {
  const records = splitNullRecords(output);
  const files: GitFileChange[] = [];
  const indexEntries: Array<readonly (string | boolean | null)[]> = [];
  const warnings: string[] = [];
  let branch: string | null = null;
  let detached = false;
  let unborn = false;
  let headSha: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;

  for (let index = 0; index < records.length; index += 1) {
    const decoded = decodeUtf8(records[index]!);
    const record = decoded.text;
    if (record.startsWith("# branch.oid ")) {
      const oid = record.slice("# branch.oid ".length);
      unborn = oid === "(initial)";
      headSha = unborn ? null : oid;
      continue;
    }
    if (record.startsWith("# branch.head ")) {
      const head = record.slice("# branch.head ".length);
      detached = head === "(detached)";
      branch = detached ? null : head;
      continue;
    }
    if (record.startsWith("# branch.upstream ")) {
      upstream = record.slice("# branch.upstream ".length);
      continue;
    }
    if (record.startsWith("# branch.ab ")) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record);
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
      continue;
    }
    if (record.startsWith("? ")) {
      const pathBytes = records[index]!.subarray(2);
      const path = decodeUtf8(pathBytes);
      if (!path.supported) warnings.push("A changed path is not valid UTF-8 and is read-only");
      files.push({
        path: path.text,
        staged: null,
        unstaged: "untracked",
        conflict: false,
        submodule: false,
        pathSupported: path.supported,
      });
      continue;
    }

    const parts = record.split(" ");
    if (parts[0] === "1" && parts.length >= 9) {
      const xy = parts[1]!;
      const path = parts.slice(8).join(" ");
      const staged = mapStatusCode(xy[0] ?? ".");
      if (!decoded.supported) warnings.push("A changed path is not valid UTF-8 and is read-only");
      files.push({
        path,
        staged,
        unstaged: mapStatusCode(xy[1] ?? "."),
        conflict: xy.includes("U"),
        submodule: parts[2] !== "N...",
        pathSupported: decoded.supported,
      });
      if (staged) indexEntries.push([path, null, staged, parts[7] ?? null, false]);
      continue;
    }
    if (parts[0] === "2" && parts.length >= 10) {
      const xy = parts[1]!;
      const path = parts.slice(9).join(" ");
      const originalRecord = records[index + 1];
      const original = originalRecord ? decodeUtf8(originalRecord) : { text: "", supported: false };
      if (originalRecord) index += 1;
      const supported = decoded.supported && original.supported;
      const staged = mapStatusCode(xy[0] ?? ".");
      if (!supported) warnings.push("A renamed path is not valid UTF-8 and is read-only");
      files.push({
        path,
        ...(original.text ? { originalPath: original.text } : {}),
        staged,
        unstaged: mapStatusCode(xy[1] ?? "."),
        conflict: xy.includes("U"),
        submodule: parts[2] !== "N...",
        pathSupported: supported,
      });
      if (staged) indexEntries.push([path, original.text || null, staged, parts[7] ?? null, false]);
      continue;
    }
    if (parts[0] === "u" && parts.length >= 11) {
      const path = parts.slice(10).join(" ");
      if (!decoded.supported)
        warnings.push("A conflicted path is not valid UTF-8 and is read-only");
      files.push({
        path,
        staged: "conflicted",
        unstaged: "conflicted",
        conflict: true,
        submodule: parts[2] !== "N...",
        pathSupported: decoded.supported,
      });
      indexEntries.push([path, null, "conflicted", parts.slice(7, 10).join(":"), true]);
    }
  }

  const uniqueWarnings = [...new Set(warnings)];
  const indexGeneration = createHash("sha256")
    .update(
      JSON.stringify({
        headSha,
        staged: indexEntries,
      }),
    )
    .digest("hex");

  return {
    branch,
    detached,
    unborn,
    headSha,
    upstream,
    ahead,
    behind,
    indexGeneration,
    files,
    warnings: uniqueWarnings,
  };
}

function snapshotFingerprint(snapshot: GitStatusCandidate): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === "win32"
    ? win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase()
    : left === right;
}

function safeGitMessage(message: string, fallback: string): string {
  const normalized = message.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  return normalized || fallback;
}

type ParsedGitDiffHunk = GitDiffHunk & { patch: string };

function countPatchChanges(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}

export function parseUnifiedGitDiffHunks(patch: string): ParsedGitDiffHunk[] {
  const lines = patch.split("\n");
  const hunkStarts: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.startsWith("@@ ")) hunkStarts.push(index);
  }
  if (hunkStarts.length === 0) return [];
  const headerLines = lines.slice(0, hunkStarts[0]);
  if (
    !headerLines.some((line) => line.startsWith("diff --git ")) ||
    !headerLines.some((line) => line.startsWith("--- ")) ||
    !headerLines.some((line) => line.startsWith("+++ "))
  ) {
    return [];
  }

  return hunkStarts.flatMap((start, ordinal) => {
    const header = lines[start] ?? "";
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
    if (!match) return [];
    const end = hunkStarts[ordinal + 1] ?? lines.length;
    const hunkLines = lines.slice(start, end);
    while (hunkLines.at(-1) === "") hunkLines.pop();
    const hunkPatch = [...headerLines, ...hunkLines].join("\n") + "\n";
    let additions = 0;
    let deletions = 0;
    for (const line of hunkLines.slice(1)) {
      if (line.startsWith("+")) additions += 1;
      else if (line.startsWith("-")) deletions += 1;
    }
    return [
      {
        id: createHash("sha256")
          .update(String(ordinal))
          .update("\0")
          .update(hunkPatch)
          .digest("hex"),
        header,
        oldStart: Number(match[1]),
        oldLines: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newLines: match[4] === undefined ? 1 : Number(match[4]),
        additions,
        deletions,
        patch: hunkPatch,
      },
    ];
  });
}

export class GitService {
  private cacheKey: string | null = null;
  private cachedSnapshot: GitStatusSnapshot | null = null;
  private cachedFingerprint: string | null = null;
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private watchPolling = false;
  private watchGeneration = 0;
  private watchAbortController: AbortController | null = null;

  constructor(
    private readonly executable = "git",
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  private runGit(options: GitCommandOptions): Promise<GitCommandResult> {
    return runGitCommand(this.executable, { ...options, env: this.env });
  }

  async getStatus(workspace: string, signal?: AbortSignal): Promise<GitStatusSnapshot> {
    const key = process.platform === "win32" ? win32.normalize(workspace).toLowerCase() : workspace;
    if (key !== this.cacheKey) this.resetCache(key);

    let candidate: GitStatusCandidate;
    try {
      const rootResult = await this.runGit({
        cwd: workspace,
        args: ["rev-parse", "--show-toplevel"],
        timeoutMs: GIT_READ_TIMEOUT_MS,
        maxStdoutBytes: 64 * 1024,
        optionalLocks: true,
        signal,
      });
      if (rootResult.exitCode !== 0) {
        const message = safeGitMessage(rootResult.stderr, "Unable to locate a Git repository");
        candidate = /not a git repository/i.test(message)
          ? { state: "not_repository" }
          : { state: "error", message };
      } else {
        const rootText = rootResult.stdout.toString("utf8").replace(/[\r\n]+$/, "");
        const repositoryRoot = await realpath(rootText);
        const statusResult = await this.runGit({
          cwd: repositoryRoot,
          args: [
            "-c",
            "color.ui=false",
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "--untracked-files=all",
          ],
          timeoutMs: GIT_READ_TIMEOUT_MS,
          maxStdoutBytes: MAX_GIT_STATUS_OUTPUT_BYTES,
          optionalLocks: true,
          signal,
        });
        if (statusResult.exitCode !== 0) {
          candidate = {
            state: "error",
            message: safeGitMessage(statusResult.stderr, "Unable to read Git status"),
          };
        } else {
          const parsed = parseGitStatusPorcelain(statusResult.stdout);
          if (parsed.files.length > MAX_GIT_STATUS_ENTRIES) {
            throw new GitServiceError(
              "GIT_OUTPUT_LIMIT",
              `Git status contains more than ${MAX_GIT_STATUS_ENTRIES} changed paths`,
            );
          }
          candidate = {
            state: "ready",
            repositoryRoot,
            workspaceIsRepositoryRoot: pathsEqual(repositoryRoot, workspace),
            ...parsed,
          };
        }
      }
    } catch (error) {
      if (error instanceof GitServiceError && error.code === "GIT_OUTPUT_LIMIT") {
        throw error;
      }
      if (error instanceof GitServiceError && error.code === "GIT_UNAVAILABLE") {
        candidate = {
          state: "unavailable",
          message: safeGitMessage(error.message, "Git is unavailable"),
        };
      } else {
        candidate = {
          state: "error",
          message: safeGitMessage(
            error instanceof Error ? error.message : String(error),
            "Unable to read Git status",
          ),
        };
      }
    }

    return this.commitSnapshot(candidate);
  }

  async getDiff(
    workspace: string,
    path: string,
    area: "staged" | "unstaged",
    expectedRevision: number,
    signal?: AbortSignal,
  ): Promise<GitDiffSnapshot> {
    const status = this.requireReady(await this.getStatus(workspace, signal));
    if (status.revision !== expectedRevision) {
      throw new GitServiceError(
        "STALE_REVISION",
        "Git status changed before diff was loaded",
        true,
      );
    }
    const change = this.requireChange(status, path, area);
    this.validatePath(status.repositoryRoot, change.path);

    const args =
      area === "staged"
        ? [
            "diff",
            "--cached",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--unified=3",
            "--",
            change.path,
          ]
        : change.unstaged === "untracked"
          ? [
              "diff",
              "--no-index",
              "--no-ext-diff",
              "--no-textconv",
              "--no-color",
              "--unified=3",
              "--",
              "/dev/null",
              change.path,
            ]
          : [
              "diff",
              "--no-ext-diff",
              "--no-textconv",
              "--no-color",
              "--unified=3",
              "--",
              change.path,
            ];
    const result = await this.runGit({
      cwd: status.repositoryRoot,
      args,
      timeoutMs: GIT_READ_TIMEOUT_MS,
      maxStdoutBytes: MAX_GIT_DIFF_OUTPUT_BYTES,
      optionalLocks: true,
      truncateStdout: true,
      signal,
    });
    const allowedNoIndexDifference = area === "unstaged" && change.unstaged === "untracked";
    if (result.exitCode !== 0 && !(allowedNoIndexDifference && result.exitCode === 1)) {
      throw new GitServiceError(
        "GIT_OPERATION_FAILED",
        safeGitMessage(result.stderr, "Unable to read Git diff"),
      );
    }

    let patch = result.stdout.toString("utf8");
    let truncated = result.stdoutTruncated;
    const lines = patch.split("\n");
    if (lines.length > MAX_GIT_DIFF_LINES) {
      patch = lines.slice(0, MAX_GIT_DIFF_LINES).join("\n");
      truncated = true;
    }
    const binary =
      /(^|\n)(Binary files .* differ|GIT binary patch)(\n|$)/.test(patch) ||
      patch.includes("\u0000");
    const hunkUnsafe =
      binary ||
      truncated ||
      change.conflict ||
      change.submodule ||
      change.staged === "renamed" ||
      change.staged === "copied" ||
      change.unstaged === "renamed" ||
      change.unstaged === "copied";
    const hunkOperations: GitHunkOperation[] = hunkUnsafe
      ? []
      : area === "staged"
        ? ["unstage"]
        : change.unstaged === "untracked"
          ? ["stage"]
          : ["stage", "discard"];
    const { additions, deletions } = countPatchChanges(patch);
    return {
      path,
      area,
      patch,
      additions,
      deletions,
      binary,
      truncated,
      contentGeneration: createHash("sha256").update(patch).digest("hex"),
      hunks:
        hunkOperations.length === 0
          ? []
          : parseUnifiedGitDiffHunks(patch).map(({ patch: _patch, ...hunk }) => hunk),
      hunkOperations,
    };
  }

  async mutateHunk(
    workspace: string,
    path: string,
    area: "staged" | "unstaged",
    hunkId: string,
    operation: GitHunkOperation,
    expectedRevision: number,
    expectedContentGeneration: string,
    signal?: AbortSignal,
  ): Promise<GitMutationResult> {
    if (
      (area === "unstaged" && operation === "unstage") ||
      (area === "staged" && operation !== "unstage")
    ) {
      throw new GitServiceError(
        "GIT_OPERATION_FAILED",
        "The hunk operation does not match its diff area",
      );
    }
    const status = this.requireReady(await this.getStatus(workspace, signal));
    if (status.revision !== expectedRevision) {
      throw new GitServiceError(
        "STALE_REVISION",
        "Git status changed before the hunk operation",
        true,
      );
    }
    const change = this.requireChange(status, path, area);
    if (
      change.conflict ||
      change.submodule ||
      change.staged === "renamed" ||
      change.staged === "copied" ||
      change.unstaged === "renamed" ||
      change.unstaged === "copied" ||
      (operation === "discard" && change.unstaged === "untracked")
    ) {
      throw new GitServiceError(
        "GIT_OPERATION_FAILED",
        "This change does not support safe hunk operations in PiDeck",
      );
    }
    const diff = await this.getDiff(workspace, path, area, expectedRevision, signal);
    if (diff.contentGeneration !== expectedContentGeneration) {
      throw new GitServiceError(
        "STALE_REVISION",
        "The selected diff changed before the hunk operation",
        true,
      );
    }
    if (diff.binary || diff.truncated) {
      throw new GitServiceError(
        "GIT_OPERATION_FAILED",
        "Binary or truncated diffs cannot be changed by hunk",
      );
    }
    const hunk = parseUnifiedGitDiffHunks(diff.patch).find((candidate) => candidate.id === hunkId);
    if (!hunk) {
      throw new GitServiceError("STALE_REVISION", "The selected diff hunk no longer exists", true);
    }
    const args =
      operation === "stage"
        ? ["apply", "--cached", "--recount", "--whitespace=nowarn", "-"]
        : operation === "unstage"
          ? ["apply", "--cached", "--reverse", "--recount", "--whitespace=nowarn", "-"]
          : ["apply", "--reverse", "--recount", "--whitespace=nowarn", "-"];
    const result = await this.runGit({
      cwd: status.repositoryRoot,
      args,
      timeoutMs: GIT_MUTATION_TIMEOUT_MS,
      maxStdoutBytes: GIT_MUTATION_OUTPUT_LIMIT_BYTES,
      truncateStdout: true,
      signal,
      stdin: hunk.patch,
    });
    if (result.exitCode !== 0) {
      throw new GitServiceError(
        "GIT_OPERATION_FAILED",
        safeGitMessage(
          result.stderr || result.stdout.toString("utf8"),
          "Git hunk operation failed",
        ),
      );
    }
    return { applied: true, ...(await this.refreshAfterMutation(workspace, signal)) };
  }

  stage(
    workspace: string,
    path: string,
    expectedRevision: number,
    signal?: AbortSignal,
  ): Promise<GitMutationResult> {
    return this.mutateFile("stage", workspace, path, expectedRevision, signal);
  }

  unstage(
    workspace: string,
    path: string,
    expectedRevision: number,
    signal?: AbortSignal,
  ): Promise<GitMutationResult> {
    return this.mutateFile("unstage", workspace, path, expectedRevision, signal);
  }

  stageAll(
    workspace: string,
    expectedRevision: number,
    signal?: AbortSignal,
  ): Promise<GitMutationResult> {
    return this.mutateAll("stage", workspace, expectedRevision, signal);
  }

  unstageAll(
    workspace: string,
    expectedRevision: number,
    signal?: AbortSignal,
  ): Promise<GitMutationResult> {
    return this.mutateAll("unstage", workspace, expectedRevision, signal);
  }

  async discard(
    workspace: string,
    path: string,
    expectedRevision: number,
    signal?: AbortSignal,
  ): Promise<GitMutationResult> {
    const status = this.requireReady(await this.getStatus(workspace, signal));
    if (status.revision !== expectedRevision) {
      throw new GitServiceError("STALE_REVISION", "Git status changed before discard", true);
    }
    const change = this.requireChange(status, path, "unstaged");
    if (
      change.conflict ||
      change.submodule ||
      change.unstaged === "untracked" ||
      change.unstaged === "conflicted" ||
      change.unstaged === "renamed" ||
      change.unstaged === "copied"
    ) {
      throw new GitServiceError(
        "GIT_OPERATION_FAILED",
        "This change cannot be safely discarded from PiDeck",
      );
    }
    this.validatePath(status.repositoryRoot, change.path);
    const result = await this.runGit({
      cwd: status.repositoryRoot,
      args: ["restore", "--worktree", "--", change.path],
      timeoutMs: GIT_MUTATION_TIMEOUT_MS,
      maxStdoutBytes: GIT_MUTATION_OUTPUT_LIMIT_BYTES,
      truncateStdout: true,
      signal,
    });
    if (result.exitCode !== 0) {
      throw new GitServiceError(
        "GIT_OPERATION_FAILED",
        safeGitMessage(result.stderr || result.stdout.toString("utf8"), "Git discard failed"),
      );
    }
    return { applied: true, ...(await this.refreshAfterMutation(workspace, signal)) };
  }

  async commit(
    workspace: string,
    message: string,
    expectedIndexGeneration: string,
    signal?: AbortSignal,
  ): Promise<GitCommitResult> {
    const status = this.requireReady(await this.getStatus(workspace, signal));
    if (status.indexGeneration !== expectedIndexGeneration) {
      throw new GitServiceError("STALE_REVISION", "Staged changes changed before commit", true);
    }
    if (status.files.some((file) => file.conflict)) {
      throw new GitServiceError(
        "GIT_OPERATION_FAILED",
        "Resolve merge conflicts before committing",
      );
    }
    if (!status.files.some((file) => file.staged !== null)) {
      throw new GitServiceError("GIT_OPERATION_FAILED", "There are no staged changes to commit");
    }
    const result = await this.runGit({
      cwd: status.repositoryRoot,
      args: ["commit", "--file=-"],
      timeoutMs: GIT_COMMIT_TIMEOUT_MS,
      maxStdoutBytes: GIT_MUTATION_OUTPUT_LIMIT_BYTES,
      truncateStdout: true,
      signal,
      stdin: message,
    });
    if (result.exitCode !== 0) {
      throw new GitServiceError(
        "GIT_OPERATION_FAILED",
        safeGitMessage(result.stderr || result.stdout.toString("utf8"), "Git commit failed"),
      );
    }
    let commitSha: string | null = null;
    try {
      const sha = await this.runGit({
        cwd: status.repositoryRoot,
        args: ["rev-parse", "HEAD"],
        timeoutMs: GIT_READ_TIMEOUT_MS,
        maxStdoutBytes: 1024,
        optionalLocks: true,
        signal,
      });
      if (sha.exitCode === 0) commitSha = sha.stdout.toString("utf8").trim() || null;
    } catch {
      // The commit already succeeded; the SHA is optional recovery metadata.
    }
    const refreshed = await this.refreshAfterMutation(workspace, signal);
    return { applied: true, commitSha, ...refreshed };
  }

  async listBranches(workspace: string, signal?: AbortSignal): Promise<GitBranchList> {
    const status = this.requireReady(await this.getStatus(workspace, signal));
    const result = await this.runGit({
      cwd: status.repositoryRoot,
      args: [
        "for-each-ref",
        "--sort=refname",
        `--count=${MAX_GIT_BRANCHES + 1}`,
        "--format=%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(upstream:track)",
        "refs/heads",
      ],
      timeoutMs: GIT_READ_TIMEOUT_MS,
      maxStdoutBytes: MAX_GIT_METADATA_OUTPUT_BYTES,
      optionalLocks: true,
      truncateStdout: true,
      signal,
    });
    if (result.exitCode !== 0) {
      throw new GitServiceError(
        "GIT_OPERATION_FAILED",
        safeGitMessage(result.stderr, "Unable to list Git branches"),
      );
    }
    const records = result.stdout.toString("utf8").split("\n").filter(Boolean);
    const truncated = result.stdoutTruncated || records.length > MAX_GIT_BRANCHES;
    const branches = records.slice(0, MAX_GIT_BRANCHES).flatMap((record) => {
      const [name, marker, upstreamText, tracking = ""] = record.replace(/\r$/, "").split("\0");
      if (!name) return [];
      const ahead = /ahead (\d+)/.exec(tracking)?.[1];
      const behind = /behind (\d+)/.exec(tracking)?.[1];
      return [
        {
          name,
          current: marker === "*",
          upstream: upstreamText || null,
          ahead: ahead ? Number(ahead) : 0,
          behind: behind ? Number(behind) : 0,
        },
      ];
    });
    return {
      statusRevision: status.revision,
      current: status.branch,
      detached: status.detached,
      branches,
      truncated,
    };
  }

  async createBranch(
    workspace: string,
    name: string,
    expectedRevision: number,
    signal?: AbortSignal,
  ): Promise<GitMutationResult> {
    const status = this.requireReady(await this.getStatus(workspace, signal));
    if (status.revision !== expectedRevision) {
      throw new GitServiceError(
        "STALE_REVISION",
        "Git status changed before branch creation",
        true,
      );
    }
    await this.validateBranchName(status.repositoryRoot, name, signal);
    const result = await this.runGit({
      cwd: status.repositoryRoot,
      args: ["switch", "--create", name],
      timeoutMs: GIT_MUTATION_TIMEOUT_MS,
      maxStdoutBytes: GIT_MUTATION_OUTPUT_LIMIT_BYTES,
      truncateStdout: true,
      signal,
    });
    if (result.exitCode !== 0) {
      throw new GitServiceError(
        "GIT_OPERATION_FAILED",
        safeGitMessage(
          result.stderr || result.stdout.toString("utf8"),
          "Unable to create Git branch",
        ),
      );
    }
    return { applied: true, ...(await this.refreshAfterMutation(workspace, signal)) };
  }

  async switchBranch(
    workspace: string,
    name: string,
    expectedRevision: number,
    signal?: AbortSignal,
  ): Promise<GitMutationResult> {
    const status = this.requireReady(await this.getStatus(workspace, signal));
    if (status.revision !== expectedRevision) {
      throw new GitServiceError(
        "STALE_REVISION",
        "Git status changed before branch switching",
        true,
      );
    }
    await this.validateBranchName(status.repositoryRoot, name, signal);
    const branchList = await this.listBranches(workspace, signal);
    if (!branchList.branches.some((branch) => branch.name === name)) {
      throw new GitServiceError(
        "GIT_OPERATION_FAILED",
        "The selected local branch no longer exists",
      );
    }
    if (status.branch === name && !status.detached) {
      throw new GitServiceError(
        "GIT_OPERATION_FAILED",
        "The selected branch is already checked out",
      );
    }
    const result = await this.runGit({
      cwd: status.repositoryRoot,
      args: ["switch", "--", name],
      timeoutMs: GIT_MUTATION_TIMEOUT_MS,
      maxStdoutBytes: GIT_MUTATION_OUTPUT_LIMIT_BYTES,
      truncateStdout: true,
      signal,
    });
    if (result.exitCode !== 0) {
      throw new GitServiceError(
        "GIT_OPERATION_FAILED",
        safeGitMessage(
          result.stderr || result.stdout.toString("utf8"),
          "Unable to switch Git branch",
        ),
      );
    }
    return { applied: true, ...(await this.refreshAfterMutation(workspace, signal)) };
  }

  async listHistory(
    workspace: string,
    limit: number,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<GitHistoryResult> {
    const status = this.requireReady(await this.getStatus(workspace, signal));
    if (status.unborn) return { commits: [], nextCursor: null };
    const revision = cursor
      ? await this.resolveCommit(status.repositoryRoot, cursor, signal)
      : "HEAD";
    const result = await this.runGit({
      cwd: status.repositoryRoot,
      args: [
        "log",
        "--first-parent",
        "--no-show-signature",
        "-z",
        `--max-count=${Math.min(limit, MAX_GIT_HISTORY_PAGE_SIZE) + 1}`,
        ...(cursor ? ["--skip=1"] : []),
        "--format=%H%x00%h%x00%P%x00%an%x00%aI%x00%s%x00%D",
        revision,
        "--",
      ],
      timeoutMs: GIT_READ_TIMEOUT_MS,
      maxStdoutBytes: MAX_GIT_METADATA_OUTPUT_BYTES,
      optionalLocks: true,
      signal,
    });
    if (result.exitCode !== 0) {
      throw new GitServiceError(
        "GIT_OPERATION_FAILED",
        safeGitMessage(result.stderr, "Unable to read Git history"),
      );
    }
    const fields = result.stdout.toString("utf8").split("\0");
    if (fields.at(-1) === "") fields.pop();
    const commits = [] as GitHistoryResult["commits"];
    for (let index = 0; index + 6 < fields.length; index += 7) {
      const sha = fields[index]!;
      if (!/^[0-9a-f]{40,64}$/.test(sha)) continue;
      commits.push({
        sha,
        shortSha: fields[index + 1]!,
        parents: fields[index + 2]!.split(" ").filter(Boolean),
        authorName: fields[index + 3]!,
        authoredAt: fields[index + 4]!,
        subject: fields[index + 5]!,
        refs: fields[index + 6]!.split(", ")
          .map((ref) => ref.trim())
          .filter(Boolean),
      });
    }
    const hasMore = commits.length > limit;
    const page = commits.slice(0, limit);
    return { commits: page, nextCursor: hasMore ? (page.at(-1)?.sha ?? null) : null };
  }

  async getCommitDiff(
    workspace: string,
    commitSha: string,
    signal?: AbortSignal,
  ): Promise<GitCommitDiffSnapshot> {
    const status = this.requireReady(await this.getStatus(workspace, signal));
    if (status.unborn) {
      throw new GitServiceError("GIT_OPERATION_FAILED", "The repository has no commits");
    }
    const resolved = await this.resolveCommit(status.repositoryRoot, commitSha, signal);
    const parentsResult = await this.runGit({
      cwd: status.repositoryRoot,
      args: ["rev-list", "--parents", "-n", "1", resolved],
      timeoutMs: GIT_READ_TIMEOUT_MS,
      maxStdoutBytes: 8 * 1024,
      optionalLocks: true,
      signal,
    });
    if (parentsResult.exitCode !== 0) {
      throw new GitServiceError("GIT_OPERATION_FAILED", "Unable to resolve the commit parent");
    }
    const parentSha = parentsResult.stdout.toString("utf8").trim().split(/\s+/)[1] ?? null;
    const args = parentSha
      ? [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          "--unified=3",
          parentSha,
          resolved,
          "--",
        ]
      : [
          "show",
          "--format=",
          "--root",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          "--unified=3",
          resolved,
          "--",
        ];
    const result = await this.runGit({
      cwd: status.repositoryRoot,
      args,
      timeoutMs: GIT_READ_TIMEOUT_MS,
      maxStdoutBytes: MAX_GIT_DIFF_OUTPUT_BYTES,
      optionalLocks: true,
      truncateStdout: true,
      signal,
    });
    if (result.exitCode !== 0) {
      throw new GitServiceError(
        "GIT_OPERATION_FAILED",
        safeGitMessage(result.stderr, "Unable to read the commit diff"),
      );
    }
    let patch = result.stdout.toString("utf8");
    let truncated = result.stdoutTruncated;
    const lines = patch.split("\n");
    if (lines.length > MAX_GIT_DIFF_LINES) {
      patch = lines.slice(0, MAX_GIT_DIFF_LINES).join("\n");
      truncated = true;
    }
    const binary =
      /(^|\n)(Binary files .* differ|GIT binary patch)(\n|$)/.test(patch) ||
      patch.includes("\u0000");
    return {
      commitSha: resolved,
      parentSha,
      patch,
      ...countPatchChanges(patch),
      binary,
      truncated,
    };
  }

  async setWatching(
    enabled: boolean,
    workspace: string,
    emit: (snapshot: GitStatusSnapshot) => void,
  ): Promise<{ watching: boolean; snapshot: GitStatusSnapshot | null }> {
    this.stopWatching();
    if (!enabled) return { watching: false, snapshot: null };
    const generation = this.watchGeneration;
    const controller = new AbortController();
    this.watchAbortController = controller;
    const snapshot = await this.getStatus(workspace, controller.signal);
    if (generation !== this.watchGeneration || controller.signal.aborted) {
      return { watching: false, snapshot: null };
    }
    let lastRevision = snapshot.revision;
    this.watchTimer = setInterval(() => {
      if (generation !== this.watchGeneration || this.watchPolling) return;
      this.watchPolling = true;
      void this.getStatus(workspace, controller.signal)
        .then((next) => {
          if (generation !== this.watchGeneration || next.revision === lastRevision) return;
          lastRevision = next.revision;
          emit(next);
        })
        .catch((error) => {
          if (generation !== this.watchGeneration || controller.signal.aborted) return;
          const next = this.commitSnapshot({
            state: "error",
            message: safeGitMessage(
              error instanceof Error ? error.message : String(error),
              "Unable to read Git status",
            ),
          });
          if (next.revision === lastRevision) return;
          lastRevision = next.revision;
          emit(next);
        })
        .finally(() => {
          this.watchPolling = false;
        });
    }, GIT_WATCH_INTERVAL_MS);
    this.watchTimer.unref?.();
    return { watching: true, snapshot };
  }

  stopWatching(): void {
    this.watchGeneration += 1;
    this.watchAbortController?.abort();
    this.watchAbortController = null;
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
    this.watchPolling = false;
  }

  dispose(): void {
    this.stopWatching();
    this.resetCache(null);
  }

  private async mutateFile(
    kind: "stage" | "unstage",
    workspace: string,
    path: string,
    expectedRevision: number,
    signal?: AbortSignal,
  ): Promise<GitMutationResult> {
    const status = this.requireReady(await this.getStatus(workspace, signal));
    if (status.revision !== expectedRevision) {
      throw new GitServiceError("STALE_REVISION", "Git status changed before the operation", true);
    }
    const change = this.requireChange(status, path, kind === "stage" ? "unstaged" : "staged");
    const paths = [change.originalPath, change.path].filter((item): item is string =>
      Boolean(item),
    );
    for (const candidate of paths) this.validatePath(status.repositoryRoot, candidate);
    const args =
      kind === "stage"
        ? ["add", "-A", "--", ...paths]
        : status.unborn
          ? ["rm", "--cached", "-r", "--ignore-unmatch", "--", ...paths]
          : ["restore", "--staged", "--", ...paths];
    const result = await this.runGit({
      cwd: status.repositoryRoot,
      args,
      timeoutMs: GIT_MUTATION_TIMEOUT_MS,
      maxStdoutBytes: GIT_MUTATION_OUTPUT_LIMIT_BYTES,
      truncateStdout: true,
      signal,
    });
    if (result.exitCode !== 0) {
      throw new GitServiceError(
        "GIT_OPERATION_FAILED",
        safeGitMessage(result.stderr || result.stdout.toString("utf8"), `Git ${kind} failed`),
      );
    }
    return { applied: true, ...(await this.refreshAfterMutation(workspace, signal)) };
  }

  private async mutateAll(
    kind: "stage" | "unstage",
    workspace: string,
    expectedRevision: number,
    signal?: AbortSignal,
  ): Promise<GitMutationResult> {
    const status = this.requireReady(await this.getStatus(workspace, signal));
    if (status.revision !== expectedRevision) {
      throw new GitServiceError("STALE_REVISION", "Git status changed before the operation", true);
    }
    const area = kind === "stage" ? "unstaged" : "staged";
    const changes = status.files.filter((file) => file[area] !== null);
    if (changes.length === 0) {
      throw new GitServiceError(
        "GIT_OPERATION_FAILED",
        kind === "stage" ? "There are no changes to stage" : "There are no changes to unstage",
      );
    }
    if (changes.some((change) => !change.pathSupported)) {
      throw new GitServiceError(
        "GIT_OPERATION_FAILED",
        "A changed path is not valid UTF-8 and must remain read-only",
      );
    }
    const args =
      kind === "stage"
        ? ["add", "-A", "--", "."]
        : status.unborn
          ? ["rm", "--cached", "-r", "--ignore-unmatch", "--", "."]
          : ["restore", "--staged", "--", "."];
    const result = await this.runGit({
      cwd: status.repositoryRoot,
      args,
      timeoutMs: GIT_MUTATION_TIMEOUT_MS,
      maxStdoutBytes: GIT_MUTATION_OUTPUT_LIMIT_BYTES,
      truncateStdout: true,
      signal,
    });
    if (result.exitCode !== 0) {
      throw new GitServiceError(
        "GIT_OPERATION_FAILED",
        safeGitMessage(result.stderr || result.stdout.toString("utf8"), `Git ${kind} all failed`),
      );
    }
    return { applied: true, ...(await this.refreshAfterMutation(workspace, signal)) };
  }

  private async refreshAfterMutation(
    workspace: string,
    signal?: AbortSignal,
  ): Promise<Pick<GitMutationResult, "snapshot" | "warning">> {
    const snapshot = await this.getStatus(workspace, signal);
    return snapshot.state === "ready"
      ? { snapshot }
      : { snapshot, warning: "Git operation succeeded, but status could not be refreshed" };
  }

  private requireReady(
    snapshot: GitStatusSnapshot,
  ): Extract<GitStatusSnapshot, { state: "ready" }> {
    if (snapshot.state === "ready") return snapshot;
    throw new GitServiceError(
      snapshot.state === "unavailable" ? "GIT_UNAVAILABLE" : "GIT_OPERATION_FAILED",
      snapshot.state === "not_repository"
        ? "The workspace is not in a Git repository"
        : snapshot.message,
    );
  }

  private requireChange(
    status: Extract<GitStatusSnapshot, { state: "ready" }>,
    path: string,
    area: "staged" | "unstaged",
  ): GitFileChange {
    const change = status.files.find((file) => file.path === path);
    if (!change || change[area] === null) {
      throw new GitServiceError("STALE_REVISION", "The selected Git change no longer exists", true);
    }
    if (!change.pathSupported) {
      throw new GitServiceError(
        "GIT_OPERATION_FAILED",
        "This path is not valid UTF-8 and is read-only",
      );
    }
    return change;
  }

  private validatePath(repositoryRoot: string, path: string): void {
    if (!path || path.includes("\u0000") || isAbsolute(path) || win32.isAbsolute(path)) {
      throw new GitServiceError("GIT_OPERATION_FAILED", "Invalid repository path");
    }
    const absolute = resolve(repositoryRoot, ...path.split("/"));
    const fromRoot = relative(repositoryRoot, absolute);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new GitServiceError("GIT_OPERATION_FAILED", "Repository path escapes its root");
    }
  }

  private async validateBranchName(
    repositoryRoot: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!name || name.includes("\u0000") || /[\u0000-\u001f\u007f]/.test(name)) {
      throw new GitServiceError("GIT_OPERATION_FAILED", "Invalid Git branch name");
    }
    const result = await this.runGit({
      cwd: repositoryRoot,
      args: ["check-ref-format", "--branch", name],
      timeoutMs: GIT_READ_TIMEOUT_MS,
      maxStdoutBytes: 8 * 1024,
      optionalLocks: true,
      signal,
    });
    if (result.exitCode !== 0) {
      throw new GitServiceError(
        "GIT_OPERATION_FAILED",
        safeGitMessage(result.stderr, "Invalid Git branch name"),
      );
    }
  }

  private async resolveCommit(
    repositoryRoot: string,
    commitSha: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (!/^[0-9a-f]{40,64}$/.test(commitSha)) {
      throw new GitServiceError("GIT_OPERATION_FAILED", "Invalid Git commit ID");
    }
    const result = await this.runGit({
      cwd: repositoryRoot,
      args: ["rev-parse", "--verify", `${commitSha}^{commit}`],
      timeoutMs: GIT_READ_TIMEOUT_MS,
      maxStdoutBytes: 8 * 1024,
      optionalLocks: true,
      signal,
    });
    const resolved = result.stdout.toString("utf8").trim();
    if (result.exitCode !== 0 || !/^[0-9a-f]{40,64}$/.test(resolved)) {
      throw new GitServiceError("GIT_OPERATION_FAILED", "The selected Git commit no longer exists");
    }
    return resolved;
  }

  private commitSnapshot(candidate: GitStatusCandidate): GitStatusSnapshot {
    const fingerprint = snapshotFingerprint(candidate);
    if (fingerprint === this.cachedFingerprint && this.cachedSnapshot) return this.cachedSnapshot;
    const revision = (this.cachedSnapshot?.revision ?? 0) + 1;
    const snapshot = { ...candidate, revision } as GitStatusSnapshot;
    this.cachedFingerprint = fingerprint;
    this.cachedSnapshot = snapshot;
    return snapshot;
  }

  private resetCache(key: string | null): void {
    this.cacheKey = key;
    this.cachedSnapshot = null;
    this.cachedFingerprint = null;
  }
}
