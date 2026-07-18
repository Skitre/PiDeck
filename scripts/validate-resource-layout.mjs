/**
 * Validate staged Tauri resources layout (C1 / B-LAYOUT-01).
 * Accepts either expanded node_modules OR compacted node_modules.zip + host-main.js.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const res = join(root, "apps/desktop/src-tauri/resources");
const errors = [];
const info = {};

function need(p, msg) {
  if (!existsSync(p)) errors.push(msg ?? `missing ${p}`);
}

need(join(res, "node/node.exe"), "node/node.exe missing");
need(join(res, "node/npm.cmd"), "node/npm.cmd missing — controlled npm required");
need(join(res, "node/RUNTIME.json"), "node/RUNTIME.json missing");
need(join(res, "git/cmd/git.exe"), "git/cmd/git.exe missing — controlled Portable Git required");
need(join(res, "git/RUNTIME.json"), "git/RUNTIME.json missing");
need(join(res, "pi-host/main.js"), "pi-host/main.js missing");
need(join(res, "pi-host/package.json"), "pi-host/package.json missing");
need(join(res, "pi-host/STAGING.json"), "pi-host/STAGING.json missing");

const expandedSdk = join(
  res,
  "pi-host/node_modules/@earendil-works/pi-coding-agent/package.json",
);
const zipPath = join(res, "pi-host/node_modules.zip");
const hostMain = join(res, "pi-host/host-main.js");
const compacted = existsSync(zipPath) && statSync(zipPath).size > 1_000_000;

if (compacted) {
  info.layout = "compacted-zip";
  info.zipBytes = statSync(zipPath).size;
  need(hostMain, "host-main.js missing in compacted layout");
  // Bootstrap main.js must reference zip
  const mainSrc = readFileSync(join(res, "pi-host/main.js"), "utf8");
  if (!mainSrc.includes("node_modules.zip")) {
    errors.push("compacted main.js bootstrap must reference node_modules.zip");
  }
} else {
  info.layout = "expanded-node_modules";
  need(expandedSdk, "SDK package missing under pi-host/node_modules");
  need(
    join(res, "pi-host/node_modules/@pi-desktop/protocol/package.json"),
    "protocol package missing under pi-host/node_modules",
  );
}

const hostRoot = join(res, "pi-host");
for (const forbidden of ["src", "apps", ".staging-host-deploy", "tsconfig.json", "vitest.config.ts"]) {
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
  if (n === "@pi-desktop/protocol") {
    errors.push("pi-host/package.json overwritten by protocol package (flatten collision)");
  }
  info.hostPackageName = n;
}

if (existsSync(expandedSdk)) {
  const v = JSON.parse(readFileSync(expandedSdk, "utf8")).version;
  if (v !== "0.80.7") errors.push(`SDK version ${v} !== 0.80.7`);
  info.sdkVersion = v;
}

if (existsSync(join(res, "pi-host/STAGING.json"))) {
  const s = JSON.parse(readFileSync(join(res, "pi-host/STAGING.json"), "utf8"));
  if (s.usedProcessExecPath === true) errors.push("STAGING usedProcessExecPath must be false");
  if (s.usedGlobalNpm === true) errors.push("STAGING usedGlobalNpm must be false");
  if (s.unlockedNpmInstall === true) errors.push("STAGING unlockedNpmInstall must be false");
  if (s.pnpmLockVerified !== true && s.pnpmLockSha256) {
    // optional
  }
  info.staging = {
    sdk: s.sdk,
    usedProcessExecPath: s.usedProcessExecPath,
    usedGlobalNpm: s.usedGlobalNpm,
    unlockedNpmInstall: s.unlockedNpmInstall,
    stagingStrategy: s.stagingStrategy,
    nodeModulesPackagedAs: s.nodeModulesPackagedAs ?? null,
  };
}

if (existsSync(join(res, "node/RUNTIME.json"))) {
  const r = JSON.parse(readFileSync(join(res, "node/RUNTIME.json"), "utf8"));
  info.runtime = {
    nodeVersion: r.nodeVersion,
    archiveSha256: r.archiveSha256,
    usedProcessExecPath: r.usedProcessExecPath,
  };
  if (r.usedProcessExecPath === true) errors.push("RUNTIME usedProcessExecPath must be false");
}
if (existsSync(join(res, "git/RUNTIME.json"))) {
  const r = JSON.parse(readFileSync(join(res, "git/RUNTIME.json"), "utf8"));
  info.gitRuntime = {
    gitVersion: r.gitVersion,
    archiveSha256: r.archiveSha256,
    versionOutput: r.versionOutput,
  };
  if (!String(r.versionOutput ?? "").startsWith("git version ")) {
    errors.push("Portable Git runtime version probe missing or invalid");
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
