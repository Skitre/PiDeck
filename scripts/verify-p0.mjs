/**
 * Full release gate (invoked as `pnpm verify:release`).
 * Production-grade aggregate: any subgate failure fails the whole run.
 * Writes artifacts/p0/<run-id>/verify-p0.json.
 * Day-to-day development uses the lightweight `pnpm verify:p0` instead;
 * run this before any release — see docs/operations/release-checklist.md.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import {
  createRunDir,
  runCaptured,
  writeJson,
  finishRun,
  tryGitSha,
  tryGitDirty,
  platformInfo,
  trySdkVersion,
  baseRecord,
  sha256File,
} from "./p0-evidence.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { dir, runId } = createRunDir("verify-p0");

const gates = [
  ["docs", "pnpm", ["verify:docs"]],
  ["typecheck", "pnpm", ["typecheck"]],
  ["build", "pnpm", ["build"]],
  ["test", "pnpm", ["test"]],
  ["rust", "pnpm", ["test:rust"]],
  ["package:release", "pnpm", ["package:release"]],
  ["m0", "pnpm", ["verify:m0-release-extension"]],
  ["e2e", "pnpm", ["test:e2e"]],
  ["smoke:release", "pnpm", ["smoke:release"]],
];

const results = [];
let failed = false;
let candidate = null;
const packageManifestPath = join(
  root,
  "apps/desktop/src-tauri/target/release-staging/PACKAGE_RELEASE.json",
);
const e2eResultPath = join(root, "artifacts/p0/e2e-latest/e2e-results.json");
const smokeResultPath = join(root, "artifacts/p0/release-latest/installed-smoke.json");

for (const [name, cmd, args] of gates) {
  console.log(`\n=== ${name}: ${cmd} ${args.join(" ")} ===`);
  const rec = baseRecord(`${cmd} ${args.join(" ")}`, { name });
  const candidateEnv =
    candidate && (name === "m0" || name === "e2e")
      ? {
          PIDECK_E2E_EXE: candidate.desktopExecutable,
          PIDECK_E2E_EXPECTED_SHA256: candidate.desktopExecutableSha256,
        }
      : {};
  const r = runCaptured(
    dir,
    `verify-${name.replace(/:/g, "-")}.log`,
    cmd,
    args,
    { env: candidateEnv },
  );
  rec.exitCode = r.exitCode;
  rec.finishedAt = r.finishedAt;
  rec.log = r.logPath;
  rec.status = r.exitCode === 0 ? "passed" : "failed";
  if (r.exitCode !== 0) failed = true;

  if (name === "package:release" && r.exitCode === 0) {
    try {
      const packaged = JSON.parse(readFileSync(packageManifestPath, "utf8"));
      const actualDesktopSha = sha256File(packaged.desktopExecutable);
      if (
        packaged.status !== "ok" ||
        packaged.exitCode !== 0 ||
        !existsSync(packaged.desktopExecutable) ||
        actualDesktopSha !== packaged.desktopExecutableSha256 ||
        !existsSync(packaged.primaryInstaller) ||
        sha256File(packaged.primaryInstaller) !== packaged.primaryInstallerSha256
      ) {
        throw new Error("package manifest is not bound to stable candidate files");
      }
      candidate = packaged;
      rec.artifact = packaged;
    } catch (error) {
      failed = true;
      rec.status = "failed";
      rec.exitCode = 1;
      rec.artifactError = error instanceof Error ? error.message : String(error);
    }
  }
  if ((name === "m0" || name === "e2e") && existsSync(e2eResultPath)) {
    rec.artifact = JSON.parse(readFileSync(e2eResultPath, "utf8"));
  }
  if (name === "smoke:release" && existsSync(smokeResultPath)) {
    rec.artifact = JSON.parse(readFileSync(smokeResultPath, "utf8"));
  }

  results.push(rec);
  console.log(`${name} exit=${rec.exitCode}`);
}

const commit = tryGitSha();
const dirty = tryGitDirty();
if (!commit || dirty !== false) {
  failed = true;
  results.push({
    ...baseRecord("git metadata preflight", { name: "git-metadata" }),
    finishedAt: new Date().toISOString(),
    exitCode: 1,
    status: "failed",
    commit,
    dirty,
  });
}

const m0Artifact = results.find((result) => result.name === "m0")?.artifact ?? null;
const e2eArtifact = results.find((result) => result.name === "e2e")?.artifact ?? null;
const smokeArtifact = results.find((result) => result.name === "smoke:release")?.artifact ?? null;
const e2eCandidateStep = e2eArtifact?.steps?.find(
  (step) => step.step === "desktop.candidate.verified",
);
const candidateBound = Boolean(
  candidate &&
    m0Artifact?.ok === true &&
    m0Artifact?.workflowMode === "m0" &&
    e2eArtifact?.ok === true &&
    e2eArtifact?.workflowMode === "full" &&
    resolve(e2eArtifact.executable) === resolve(candidate.desktopExecutable) &&
    e2eCandidateStep?.executableSha256 === candidate.desktopExecutableSha256 &&
    smokeArtifact?.status === "passed" &&
    smokeArtifact?.installerSha256 === candidate.primaryInstallerSha256 &&
    smokeArtifact?.installedExeSha256 === candidate.desktopExecutableSha256 &&
    smokeArtifact?.resourceManifestHashOk === true &&
    smokeArtifact?.resourceManifestFilesOk === true &&
    smokeArtifact?.p0InstalledSmokeComplete === true,
);
if (!candidateBound) {
  failed = true;
  results.push({
    ...baseRecord("candidate and provenance binding", { name: "candidate-binding" }),
    finishedAt: new Date().toISOString(),
    exitCode: 1,
    status: "failed",
    candidate: candidate
      ? {
          desktopExecutable: candidate.desktopExecutable,
          desktopExecutableSha256: candidate.desktopExecutableSha256,
          primaryInstaller: candidate.primaryInstaller,
          primaryInstallerSha256: candidate.primaryInstallerSha256,
          resourceManifestSha256: candidate.resourceManifestSha256,
        }
      : null,
    m0Artifact,
    e2eArtifact,
    smokeArtifact,
  });
}

const finalRelease =
  !failed && candidate
    ? {
        schemaVersion: 1,
        status: "passed",
        runId,
        commit,
        dirty,
        generatedAt: new Date().toISOString(),
        platform: platformInfo(),
        sdkVersion: trySdkVersion(),
        candidate: {
          desktopExecutable: candidate.desktopExecutable,
          desktopExecutableSha256: candidate.desktopExecutableSha256,
          desktopExecutableSize: candidate.desktopExecutableSize,
          primaryInstaller: candidate.primaryInstaller,
          primaryInstallerSha256: candidate.primaryInstallerSha256,
          primaryInstallerSize: candidate.primaryInstallerSize,
          acceptedInstallerIntegrity: candidate.acceptedInstallerIntegrity,
          resourceManifestSha256: candidate.resourceManifestSha256,
          resourceManifest: candidate.resourceManifest,
        },
        m0: m0Artifact,
        e2e: e2eArtifact,
        installedSmoke: smokeArtifact,
        gates: results.map(({ name, status, exitCode, log }) => ({
          name,
          status,
          exitCode,
          log,
        })),
      }
    : null;
if (finalRelease) {
  writeJson(dir, "FINAL_RELEASE.json", finalRelease);
  writeJson(
    join(root, "artifacts", "p0", "release-latest"),
    "FINAL_RELEASE.json",
    finalRelease,
  );
}

const verify = {
  status: failed ? "failed" : "passed",
  startedAt: results[0]?.startedAt ?? new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  commit,
  dirty,
  ...platformInfo(),
  sdkVersion: trySdkVersion(),
  command: "pnpm verify:release",
  exitCode: failed ? 1 : 0,
  runId,
  p0Complete: !failed,
  candidateBound,
  finalReleaseManifest: finalRelease ? join(dir, "FINAL_RELEASE.json") : null,
  results,
};

writeJson(dir, "verify-p0.json", verify);
finishRun(dir, failed ? "failed" : "passed", { p0Complete: !failed });

if (failed) {
  console.error(`\nverify:release FAIL run=${runId} dir=${dir}`);
  process.exit(1);
}
console.log(`\nverify:release OK run=${runId}`);
