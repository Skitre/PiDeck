/**
 * Evidence framework for P0 completion plan (C0).
 * Writes machine-readable JSON under artifacts/p0/<run-id>/ without hand-forging success.
 */
import {
  createHash,
  randomBytes,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

export function platformInfo() {
  return {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
  };
}

export function trySdkVersion() {
  try {
    const pkg = require(join(
      root,
      "packages/pi-host/node_modules/@earendil-works/pi-coding-agent/package.json",
    ));
    return pkg.version ?? null;
  } catch {
    try {
      const pkg = require("@earendil-works/pi-coding-agent/package.json");
      return pkg.version ?? null;
    } catch {
      return null;
    }
  }
}

export function createRunDir(label = "run") {
  const utc = new Date().toISOString().replace(/[:.]/g, "-");
  const sha = tryGitSha() ?? "nogit";
  const runId = `${utc}_${sha.slice(0, 8)}_${label}`;
  const dir = join(root, "artifacts", "p0", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "run.json"),
    JSON.stringify(
      {
        status: "running",
        runId,
        startedAt: new Date().toISOString(),
        commit: sha,
        ...platformInfo(),
        sdkVersion: trySdkVersion(),
      },
      null,
      2,
    ),
  );
  return { runId, dir };
}

export function tryGitSha() {
  const r = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    shell: true,
  });
  if (r.status === 0 && r.stdout?.trim()) return r.stdout.trim();
  return null;
}

export function tryGitDirty() {
  const r = spawnSync("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
    shell: true,
  });
  if (r.status !== 0) return null;
  return Boolean(r.stdout?.trim());
}

export function baseRecord(command, extra = {}) {
  return {
    status: "unknown",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    commit: tryGitSha(),
    ...platformInfo(),
    command,
    exitCode: null,
    ...extra,
  };
}

export function writeJson(dir, name, obj) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(obj, null, 2));
  return path;
}

/**
 * Run a command, capture stdout/stderr to log file, return exit code.
 * Never converts non-zero to success.
 */
export function runCaptured(dir, logName, cmd, args, opts = {}) {
  const startedAt = new Date().toISOString();
  const logPath = join(dir, logName);
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? root,
    encoding: "utf8",
    shell: true,
    env: { ...process.env, ...(opts.env ?? {}) },
    maxBuffer: 20 * 1024 * 1024,
  });
  const body = [
    `command: ${cmd} ${args.join(" ")}`,
    `startedAt: ${startedAt}`,
    `exitCode: ${r.status ?? 1}`,
    "--- stdout ---",
    r.stdout ?? "",
    "--- stderr ---",
    r.stderr ?? "",
  ].join("\n");
  writeFileSync(logPath, body);
  return {
    exitCode: r.status ?? 1,
    logPath,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

export function sha256File(filePath) {
  const h = createHash("sha256");
  h.update(readFileSync(filePath));
  return h.digest("hex");
}

export function finishRun(dir, status, extra = {}) {
  const runPath = join(dir, "run.json");
  let run = {};
  if (existsSync(runPath)) {
    try {
      run = JSON.parse(readFileSync(runPath, "utf8"));
    } catch {
      run = {};
    }
  }
  const next = {
    ...run,
    status,
    finishedAt: new Date().toISOString(),
    ...extra,
  };
  writeFileSync(runPath, JSON.stringify(next, null, 2));
  return next;
}

// CLI: node scripts/p0-evidence.mjs baseline
if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("p0-evidence.mjs")) {
  const mode = process.argv[2] ?? "baseline";
  if (mode === "baseline") {
    const { dir, runId } = createRunDir("baseline");
    const commands = [
      ["verify:docs", "pnpm", ["verify:docs"]],
      ["typecheck", "pnpm", ["typecheck"]],
      ["build", "pnpm", ["build"]],
      ["test", "pnpm", ["test"]],
      ["test:rust", "pnpm", ["test:rust"]],
      ["test:e2e", "pnpm", ["test:e2e"]],
      ["package:release", "pnpm", ["package:release"]],
    ];
    const results = [];
    for (const [name, cmd, args] of commands) {
      const rec = baseRecord(`${cmd} ${args.join(" ")}`, { name });
      console.log(`\n=== baseline ${name} ===`);
      const r = runCaptured(dir, `${name.replace(/:/g, "-")}.log`, cmd, args);
      rec.exitCode = r.exitCode;
      rec.finishedAt = r.finishedAt;
      rec.log = r.logPath;
      // Expected fail-closed until C8 for e2e/package:release
      const expectedFail = name === "test:e2e" || name === "package:release";
      if (r.exitCode === 0) {
        rec.status = "passed";
      } else if (expectedFail) {
        rec.status = "expected_fail_closed";
        rec.note = "C0 allows fail-closed; must not be reported as green gate";
      } else {
        rec.status = "failed";
      }
      // Count tests from log if present
      const m = r.stdout.match(/Tests\s+(\d+)\s+passed/g);
      if (m) rec.testPassHints = m;
      results.push(rec);
      writeJson(dir, "baseline.json", {
        status: results.every((x) => x.status === "passed" || x.status === "expected_fail_closed")
          ? "baseline_recorded"
          : "baseline_partial",
        startedAt: results[0]?.startedAt,
        finishedAt: new Date().toISOString(),
        commit: tryGitSha(),
        ...platformInfo(),
        sdkVersion: trySdkVersion(),
        command: "node scripts/p0-evidence.mjs baseline",
        exitCode: results.some((x) => x.status === "failed") ? 1 : 0,
        results,
        p0Complete: false,
        stages: {
          R0: "Partial",
          R1: "Partial",
          R2: "Partial",
          R3: "Partial",
          R4: "Partial",
          R5: "Partial",
          R6: "Partial",
          R7: "Partial",
          R8: "NotImplemented",
          P0: "NotComplete",
        },
        blockers: [
          "B-DOC-01",
          "B-STAGE-01",
          "B-LOCK-01",
          "B-LAYOUT-01",
          "B-M0-01",
          "B-SHUTDOWN-01",
          "B-RESTART-01",
          "B-PROCESS-01",
          "B-SCHEMA-01",
          "B-BOUNDARY-01",
          "B-SESSION-TXN-01",
          "B-WORKSPACE-TXN-01",
          "B-GRAPH-RACE-01",
          "B-EXT-01",
          "B-EXT-RUNTIME-01",
          "B-EXT-OWNER-01",
          "B-PKG-DISK-01",
          "B-PKG-ATOMIC-01",
          "B-EPOCH-01",
          "B-REHYDRATE-01",
          "B-GENERATION-01",
          "B-E2E-01",
          "B-INSTALLER-01",
          "B-INSTALLED-SMOKE-01",
        ],
      });
    }
    const anyHardFail = results.some((x) => x.status === "failed");
    finishRun(dir, anyHardFail ? "failed" : "baseline_recorded", {
      runId,
      p0Complete: false,
    });
    console.log(`\nbaseline written to ${dir}`);
    // Exit 0 for baseline recording when only expected fail-closed remain
    process.exit(anyHardFail ? 1 : 0);
  } else {
    console.error(`Unknown mode: ${mode}`);
    process.exit(2);
  }
}
