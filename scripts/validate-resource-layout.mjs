/**
 * Validate staged Tauri resources layout (C1 / B-LAYOUT-01).
 * Accepts either expanded node_modules or the compacted, cache-materialized Host payload.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  assertPiPackageTree,
  assertReleaseProductionManifest,
  assertReleaseSdkEvidence,
  loadReleaseSdkEvidence,
} from "./release-sdk-evidence.mjs";
import { resolveReleaseRuntimeTarget } from "./release-runtime-target.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const res = join(root, "apps/desktop/src-tauri/resources");
const errors = [];
const info = {};
const runtimeLock = JSON.parse(
  readFileSync(join(root, "scripts/release-runtime.lock.json"), "utf8"),
);
const runtimeTarget = resolveReleaseRuntimeTarget(runtimeLock);
const protocolVersion = JSON.parse(
  readFileSync(join(root, "packages/protocol/package.json"), "utf8"),
).version;
let expectedSdkEvidence = null;
try {
  expectedSdkEvidence = loadReleaseSdkEvidence(root, runtimeLock);
  info.sdkEvidence = expectedSdkEvidence;
} catch (error) {
  errors.push(error instanceof Error ? error.message : String(error));
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function need(p, msg) {
  if (!existsSync(p)) errors.push(msg ?? `missing ${p}`);
}

need(
  join(res, "node", runtimeTarget.stagedNodeExecutable),
  `node/${runtimeTarget.stagedNodeExecutable} missing`,
);
need(
  join(res, "node", runtimeTarget.stagedNpmExecutable),
  `node/${runtimeTarget.stagedNpmExecutable} missing — controlled npm required`,
);
need(join(res, "node/RUNTIME.json"), "node/RUNTIME.json missing");
need(join(res, "git/RUNTIME.json"), "git/RUNTIME.json missing");
if (runtimeTarget.git.strategy === "bundled-portable") {
  const portableGitFiles = runtimeTarget.git.portable?.expectedFiles ?? [];
  if (portableGitFiles.length === 0) {
    errors.push("release-runtime lock portable Git expectedFiles is empty");
  }
  for (const file of portableGitFiles) {
    need(
      join(res, "git", ...file.split("/")),
      `git/${file} missing — controlled Portable Git required`,
    );
  }
}
need(join(res, "pi-host/main.js"), "pi-host/main.js missing");
need(join(res, "pi-host/package.json"), "pi-host/package.json missing");
need(join(res, "pi-host/STAGING.json"), "pi-host/STAGING.json missing");

const expandedSdk = join(res, "pi-host/node_modules/@earendil-works/pi-coding-agent/package.json");
const zipPath = join(res, "pi-host/node_modules.zip");
const hostMain = join(res, "pi-host/host-main.js");
const nodeModulesLinks = join(res, "pi-host/NODE_MODULES_LINKS.json");
const nodeModulesGraph = join(res, "pi-host/NODE_MODULES_GRAPH.json");
const portableNodeModules = join(res, "pi-host/portable-node-modules.mjs");
const bootstrapRuntime = join(res, "pi-host/pi-host-bootstrap-runtime.mjs");
const compacted = existsSync(zipPath) && statSync(zipPath).size > 1_000_000;

if (compacted) {
  info.layout = "compacted-zip";
  info.zipBytes = statSync(zipPath).size;
  info.nodeModulesZipSha256 = sha256File(zipPath);
  need(hostMain, "host-main.js missing in compacted layout");
  need(nodeModulesLinks, "NODE_MODULES_LINKS.json missing in compacted layout");
  need(nodeModulesGraph, "NODE_MODULES_GRAPH.json missing in compacted layout");
  need(portableNodeModules, "portable-node-modules.mjs missing in compacted layout");
  need(bootstrapRuntime, "pi-host-bootstrap-runtime.mjs missing in compacted layout");
  // The signed resource bootstrap must delegate all writes to the app cache.
  const mainSrc = readFileSync(join(res, "pi-host/main.js"), "utf8");
  if (
    !mainSrc.includes("pi-host-bootstrap-runtime.mjs") ||
    !mainSrc.includes("PIDECK_HOST_CACHE_DIR")
  ) {
    errors.push("compacted main.js must delegate extraction to the writable Host cache runtime");
  }
} else {
  info.layout = "expanded-node_modules";
  need(expandedSdk, "SDK package missing under pi-host/node_modules");
  need(
    join(res, "pi-host/node_modules/@pideck/protocol/package.json"),
    "protocol package missing under pi-host/node_modules",
  );
}

const hostRoot = join(res, "pi-host");
for (const forbidden of [
  "src",
  "apps",
  ".staging-host-deploy",
  "tsconfig.json",
  "vitest.config.ts",
]) {
  if (existsSync(join(hostRoot, forbidden))) {
    errors.push(`pi-host contains forbidden deploy payload: ${forbidden}`);
  }
}
if (existsSync(hostRoot)) {
  for (const name of readdirSync(hostRoot)) {
    if (/\.(?:test|spec)\.[cm]?[jt]s$/i.test(name)) {
      errors.push(`pi-host contains test file: ${name}`);
    }
  }
}

if (existsSync(join(res, "pi-host/package.json"))) {
  const n = JSON.parse(readFileSync(join(res, "pi-host/package.json"), "utf8")).name;
  if (n === "@pideck/protocol") {
    errors.push("pi-host/package.json overwritten by protocol package (flatten collision)");
  }
  info.hostPackageName = n;
}

if (existsSync(expandedSdk) && expectedSdkEvidence) {
  try {
    info.piPackageVersions = assertPiPackageTree(
      hostRoot,
      expectedSdkEvidence,
      "expanded staged Host tree",
    );
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
}

if (existsSync(join(res, "pi-host/STAGING.json"))) {
  const s = JSON.parse(readFileSync(join(res, "pi-host/STAGING.json"), "utf8"));
  if (s.usedProcessExecPath === true) errors.push("STAGING usedProcessExecPath must be false");
  if (s.usedGlobalNpm === true) errors.push("STAGING usedGlobalNpm must be false");
  if (s.unlockedNpmInstall === true) errors.push("STAGING unlockedNpmInstall must be false");
  if (s.pnpmLockVerified !== true) errors.push("STAGING pnpmLockVerified must be true");
  if (expectedSdkEvidence) {
    try {
      assertReleaseSdkEvidence(s.sdkEvidence, expectedSdkEvidence, "STAGING SDK evidence");
      if (s.sdkVersion !== expectedSdkEvidence.sdkVersion) {
        errors.push(
          `STAGING sdkVersion ${s.sdkVersion ?? "missing"} !== ${expectedSdkEvidence.sdkVersion}`,
        );
      }
      if (s.pnpmLockSha256 !== expectedSdkEvidence.pnpmLock.sha256) {
        errors.push(
          `STAGING pnpmLockSha256 ${s.pnpmLockSha256 ?? "missing"} !== ${expectedSdkEvidence.pnpmLock.sha256}`,
        );
      }
      if (s.pnpmLockSha256Expected !== expectedSdkEvidence.pnpmLock.sha256) {
        errors.push(
          `STAGING pnpmLockSha256Expected ${s.pnpmLockSha256Expected ?? "missing"} !== ${expectedSdkEvidence.pnpmLock.sha256}`,
        );
      }
      const releaseManifest = JSON.parse(readFileSync(join(res, "pi-host/package.json"), "utf8"));
      assertReleaseProductionManifest(
        releaseManifest,
        expectedSdkEvidence,
        { "@pideck/protocol": protocolVersion },
        "staged release Host manifest",
      );
      assertReleaseProductionManifest(
        { dependencies: s.productionDependencies },
        expectedSdkEvidence,
        { "@pideck/protocol": protocolVersion },
        "STAGING production dependency evidence",
      );
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (compacted && s.nodeModulesZipSha256 !== info.nodeModulesZipSha256) {
    errors.push(
      `STAGING node_modules zip SHA-256 ${s.nodeModulesZipSha256 ?? "missing"} !== ${info.nodeModulesZipSha256}`,
    );
  }
  if (compacted && s.hostRuntimePackagedInZip !== true) {
    errors.push("STAGING hostRuntimePackagedInZip must be true");
  }
  if (compacted && s.hostCacheSchemaVersion !== 1) {
    errors.push(`STAGING hostCacheSchemaVersion ${s.hostCacheSchemaVersion ?? "missing"} !== 1`);
  }
  if (compacted && existsSync(nodeModulesLinks)) {
    const linksSha256 = sha256File(nodeModulesLinks);
    info.nodeModulesLinksSha256 = linksSha256;
    if (s.nodeModulesLinksSha256 !== linksSha256) {
      errors.push(
        `STAGING node_modules links SHA-256 ${s.nodeModulesLinksSha256 ?? "missing"} !== ${linksSha256}`,
      );
    }
  }
  if (compacted && existsSync(nodeModulesGraph)) {
    const graphSha256 = sha256File(nodeModulesGraph);
    info.nodeModulesGraphSha256 = graphSha256;
    if (s.nodeModulesGraphSha256 !== graphSha256) {
      errors.push(
        `STAGING node_modules graph SHA-256 ${s.nodeModulesGraphSha256 ?? "missing"} !== ${graphSha256}`,
      );
    }
  }
  info.staging = {
    sdkVersion: s.sdkVersion,
    sdkEvidence: s.sdkEvidence ?? null,
    productionDependencies: s.productionDependencies ?? null,
    usedProcessExecPath: s.usedProcessExecPath,
    usedGlobalNpm: s.usedGlobalNpm,
    unlockedNpmInstall: s.unlockedNpmInstall,
    stagingStrategy: s.stagingStrategy,
    nodeModulesPackagedAs: s.nodeModulesPackagedAs ?? null,
    nodeModulesZipSha256: s.nodeModulesZipSha256 ?? null,
    hostRuntimePackagedInZip: s.hostRuntimePackagedInZip ?? false,
    hostCacheSchemaVersion: s.hostCacheSchemaVersion ?? null,
    pnpmLockSha256: s.pnpmLockSha256 ?? null,
    pnpmLockVerified: s.pnpmLockVerified ?? false,
  };
}

if (existsSync(join(res, "node/RUNTIME.json"))) {
  const r = JSON.parse(readFileSync(join(res, "node/RUNTIME.json"), "utf8"));
  info.runtime = {
    target: r.target,
    platform: r.platform,
    arch: r.arch,
    nodeVersion: r.nodeVersion,
    archiveSha256: r.archiveSha256,
    usedProcessExecPath: r.usedProcessExecPath,
  };
  if (r.usedProcessExecPath === true) errors.push("RUNTIME usedProcessExecPath must be false");
  if (r.target !== runtimeTarget.key) {
    errors.push(`RUNTIME target ${r.target ?? "missing"} !== ${runtimeTarget.key}`);
  }
  if (r.archiveSha256 !== runtimeTarget.node.sha256) {
    errors.push(
      `Node runtime archive SHA-256 ${r.archiveSha256 ?? "missing"} !== ${runtimeTarget.node.sha256}`,
    );
  }
}
if (existsSync(join(res, "git/RUNTIME.json"))) {
  const r = JSON.parse(readFileSync(join(res, "git/RUNTIME.json"), "utf8"));
  info.gitRuntime = {
    strategy: r.strategy,
    target: r.target,
    gitVersion: r.gitVersion,
    archiveSha256: r.archiveSha256,
    versionOutput: r.versionOutput,
  };
  if (r.target !== runtimeTarget.key) {
    errors.push(`Git runtime target ${r.target ?? "missing"} !== ${runtimeTarget.key}`);
  }
  if (r.strategy !== runtimeTarget.git.strategy) {
    errors.push(
      `Git runtime strategy ${r.strategy ?? "missing"} !== ${runtimeTarget.git.strategy}`,
    );
  }
  if (!String(r.versionOutput ?? "").startsWith("git version ")) {
    errors.push("Git runtime version probe missing or invalid");
  }
  if (
    runtimeTarget.git.strategy === "bundled-portable" &&
    r.gitVersion !== runtimeTarget.git.portable?.version
  ) {
    errors.push(
      `Portable Git runtime version ${r.gitVersion ?? "missing"} !== ${runtimeTarget.git.portable?.version ?? "missing"}`,
    );
  }
}

// Emit machine-readable layout report when ARTIFACTS_DIR set
const report = {
  status: errors.length ? "failed" : "ok",
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  command: "pnpm validate:resources",
  exitCode: errors.length ? 1 : 0,
  errors,
  info,
};

const outDir = process.env.ARTIFACTS_DIR;
if (outDir) {
  try {
    const { mkdirSync, writeFileSync: wf } = await import("node:fs");
    mkdirSync(outDir, { recursive: true });
    wf(join(outDir, "resource-layout.json"), JSON.stringify(report, null, 2));
  } catch {
    /* ignore */
  }
}

console.log(`validate-resource-layout errors=${errors.length} layout=${info.layout}`);
if (errors.length) {
  for (const e of errors) console.error(e);
  process.exit(1);
}
console.log("validate-resource-layout OK");
console.log(JSON.stringify(info, null, 2));
