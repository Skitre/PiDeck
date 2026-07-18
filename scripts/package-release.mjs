/**
 * package:release — C8 primary installer pipeline.
 * Primary format: NSIS setup exe under target/release/bundle/nsis/.
 * Never accepts target/release/deps/*.exe as installer.
 */
import { spawnSync } from "node:child_process";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
  readFileSync,
  rmSync,
  copyFileSync,
  chmodSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { inspectWindowsInstaller } from "./windows-installer-integrity.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "apps/desktop/src-tauri/target/release-staging");
mkdirSync(outDir, { recursive: true });

function run(cmd, args) {
  console.log(`\n=== ${cmd} ${args.join(" ")} ===`);
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", shell: true, env: process.env });
  if (r.status !== 0) {
    writeManifest({
      status: "failed",
      primaryInstaller: null,
      exitCode: r.status ?? 1,
      failedStep: `${cmd} ${args.join(" ")}`,
    });
    process.exit(r.status ?? 1);
  }
}

function sha256File(p) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForStableFile(path, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let previous = null;
  let matchingSamples = 0;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const stat = statSync(path);
      const hash = sha256File(path);
      const current = `${stat.size}:${stat.mtimeMs}:${hash}`;
      if (current === previous) {
        matchingSamples += 1;
        if (matchingSamples >= 2) return { stat, hash };
      } else {
        previous = current;
        matchingSamples = 0;
      }
    }
    sleepSync(1_000);
  }
  throw new Error(`file did not become stable within ${timeoutMs}ms: ${path}`);
}

function writeManifest(obj) {
  const body = {
    status: obj.status ?? "unknown",
    startedAt: obj.startedAt ?? new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    command: "pnpm package:release",
    exitCode: obj.exitCode ?? null,
    primaryInstaller: obj.primaryInstaller ?? null,
    primaryInstallerSha256: obj.primaryInstallerSha256 ?? null,
    residualRisk: obj.residualRisk ?? null,
    ...obj,
  };
  writeFileSync(join(outDir, "PACKAGE_RELEASE.json"), JSON.stringify(body, null, 2));
  const art = join(root, "artifacts", "p0", "release-latest");
  mkdirSync(art, { recursive: true });
  writeFileSync(join(art, "installer-manifest.json"), JSON.stringify(body, null, 2));
  return body;
}

/** Only accept real NSIS setup installers — never cargo deps intermediates. */
function findPrimaryInstaller(dir) {
  if (!existsSync(dir)) return null;
  const hits = [];
  function walk(d) {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (name === "deps" || name === ".fingerprint" || name === "incremental") continue;
        walk(p);
      } else if (/setup\.exe$/i.test(name) || /_x64-setup\.exe$/i.test(name)) {
        hits.push(p);
      } else if (/\.msi$/i.test(name) && /pi/i.test(name)) {
        hits.push(p);
      }
    }
  }
  walk(dir);
  // Prefer nsis folder
  hits.sort((a, b) => {
    const an = a.includes(`${join("bundle", "nsis")}`) ? 0 : 1;
    const bn = b.includes(`${join("bundle", "nsis")}`) ? 0 : 1;
    if (an !== bn) return an - bn;
    return statSync(b).mtimeMs - statSync(a).mtimeMs;
  });
  return hits[0] ?? null;
}

const criticalResourcePaths = [
  "node/node.exe",
  "node/npm.cmd",
  "node/node_modules/npm/package.json",
  "node/RUNTIME.json",
  "git/cmd/git.exe",
  "git/bin/git.exe",
  "git/RUNTIME.json",
  "pi-host/main.js",
  "pi-host/host-main.js",
  "pi-host/package.json",
  "pi-host/STAGING.json",
  "pi-host/node_modules.zip",
];

function writeResourceManifest(resourceDir) {
  const runtimeLockPath = join(root, "scripts", "release-runtime.lock.json");
  const runtimeLock = JSON.parse(readFileSync(runtimeLockPath, "utf8"));
  const files = criticalResourcePaths.map((relativePath) => {
    const path = join(resourceDir, ...relativePath.split("/"));
    if (!existsSync(path)) throw new Error(`critical release resource missing: ${relativePath}`);
    const stat = statSync(path);
    return { path: relativePath, sha256: sha256File(path), size: stat.size };
  });
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sdkVersion: runtimeLock.sdk,
    nodeVersion: runtimeLock.node.version,
    nodeArchiveSha256: runtimeLock.node.sha256,
    gitVersion: runtimeLock.git.portable.version,
    gitArchiveSha256: runtimeLock.git.portable.sha256,
    pnpmLockSha256: runtimeLock.pnpmLock.sha256,
    files,
  };
  const path = join(resourceDir, "pi-host", "RELEASE_RESOURCES.json");
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  return { path, manifest, sha256: sha256File(path) };
}

function validatePackagedRuntime(releaseDir, expectedResourceManifest) {
  const errors = [];
  const resourceDir = join(releaseDir, "resources");
  const hostDir = join(resourceDir, "pi-host");
  const mainPath = join(hostDir, "main.js");
  const hostMainPath = join(hostDir, "host-main.js");
  const hostPackagePath = join(hostDir, "package.json");
  const zipPath = join(hostDir, "node_modules.zip");
  for (const [path, label] of [
    [mainPath, "pi-host/main.js"],
    [hostMainPath, "pi-host/host-main.js"],
    [hostPackagePath, "pi-host/package.json"],
    [zipPath, "pi-host/node_modules.zip"],
    [join(resourceDir, "node", "node.exe"), "node/node.exe"],
    [join(resourceDir, "node", "npm.cmd"), "node/npm.cmd"],
    [join(resourceDir, "git", "cmd", "git.exe"), "git/cmd/git.exe"],
  ]) {
    if (!existsSync(path)) errors.push(`packaged runtime missing ${label}`);
  }
  const packagedManifestPath = join(hostDir, "RELEASE_RESOURCES.json");
  if (!existsSync(packagedManifestPath)) {
    errors.push("packaged runtime missing pi-host/RELEASE_RESOURCES.json");
  } else {
    try {
      const packagedManifest = JSON.parse(readFileSync(packagedManifestPath, "utf8"));
      if (JSON.stringify(packagedManifest) !== JSON.stringify(expectedResourceManifest)) {
        errors.push("packaged resource manifest differs from the staged manifest");
      }
      for (const entry of packagedManifest.files ?? []) {
        const path = join(resourceDir, ...String(entry.path).split("/"));
        if (!existsSync(path)) {
          errors.push(`packaged resource manifest file missing: ${entry.path}`);
          continue;
        }
        if (statSync(path).size !== entry.size || sha256File(path) !== entry.sha256) {
          errors.push(`packaged resource hash mismatch: ${entry.path}`);
        }
      }
    } catch (error) {
      errors.push(`invalid packaged resource manifest: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (existsSync(mainPath)) {
    const main = readFileSync(mainPath, "utf8");
    if (!main.includes("node_modules.zip") || !main.includes("host-main.js")) {
      errors.push("packaged pi-host/main.js is not the compacted bootstrap");
    }
  }
  if (existsSync(hostPackagePath)) {
    const name = JSON.parse(readFileSync(hostPackagePath, "utf8")).name;
    if (name !== "pi-desktop-host-release") {
      errors.push(`packaged pi-host/package.json identity is ${name ?? "missing"}`);
    }
  }
  if (existsSync(zipPath) && statSync(zipPath).size < 1_000_000) {
    errors.push("packaged pi-host/node_modules.zip is unexpectedly small");
  }
  if (existsSync(join(hostDir, "node_modules"))) {
    errors.push("packaged pi-host unexpectedly contains expanded node_modules");
  }
  for (const forbidden of ["src", "apps", ".staging-host-deploy", "tsconfig.json", "vitest.config.ts"]) {
    if (existsSync(join(hostDir, forbidden))) {
      errors.push(`packaged pi-host contains forbidden deploy payload: ${forbidden}`);
    }
  }
  for (const name of existsSync(hostDir) ? readdirSync(hostDir) : []) {
    if (/\.(?:test|spec)\.[cm]?[jt]s$/i.test(name)) {
      errors.push(`packaged pi-host contains test file: ${name}`);
    }
  }
  return errors;
}

const startedAt = new Date().toISOString();
run("pnpm", ["build"]);
run("pnpm", ["package:sidecar:with-node"]);
run("pnpm", ["validate:resources"]);

// Compact pi-host node_modules into a zip to avoid NSIS MAX_PATH failures (C1/C8)
const compact = spawnSync(
  process.execPath,
  [join(root, "scripts/compact-pi-host-resources.mjs")],
  { cwd: root, stdio: "inherit", shell: false },
);
if (compact.status !== 0) {
  writeManifest({
    status: "failed",
    startedAt,
    exitCode: 1,
    residualRisk: "compact-pi-host-resources failed",
  });
  process.exit(1);
}

const stagedResourceDir = join(root, "apps", "desktop", "src-tauri", "resources");
let resourceManifestProof;
try {
  resourceManifestProof = writeResourceManifest(stagedResourceDir);
} catch (error) {
  writeManifest({
    status: "failed",
    startedAt,
    exitCode: 1,
    residualRisk: "critical release resource manifest generation failed",
    resourceManifestError: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
}

const bundleRoot = join(root, "apps/desktop/src-tauri/target/release");
for (const stalePath of [
  join(bundleRoot, "resources", "pi-host"),
  join(bundleRoot, "resources", "node"),
  join(bundleRoot, "resources", "git"),
  join(bundleRoot, "pi-desktop.exe"),
  join(bundleRoot, "bundle", "nsis"),
]) {
  rmSync(stalePath, { recursive: true, force: true });
}

const tauriCli = join(
  root,
  "apps/desktop/node_modules/@tauri-apps/cli/tauri.js",
);
const tauriArgs = existsSync(tauriCli)
  ? [tauriCli, "build", "--bundles", "nsis"]
  : null;

let tauriStatus = 1;
if (tauriArgs) {
  console.log("\n=== node tauri build --bundles nsis ===");
  const r = spawnSync(process.execPath, tauriArgs, {
    cwd: join(root, "apps/desktop"),
    stdio: "inherit",
    shell: false,
    env: process.env,
  });
  tauriStatus = r.status ?? 1;
} else {
  const r = spawnSync(
    "pnpm",
    ["--filter", "@pi-desktop/desktop", "exec", "tauri", "build", "--bundles", "nsis"],
    { cwd: root, stdio: "inherit", shell: true, env: process.env },
  );
  tauriStatus = r.status ?? 1;
}

const desktopExecutable = join(bundleRoot, "pi-desktop.exe");
const installer = findPrimaryInstaller(bundleRoot);
const packagedRuntimeErrors = validatePackagedRuntime(
  bundleRoot,
  resourceManifestProof.manifest,
);
let installerProof = null;
let installerStabilityError = null;
let sourceInstallerIntegrity = null;
if (installer && existsSync(installer)) {
  try {
    installerProof = waitForStableFile(installer);
    sourceInstallerIntegrity = inspectWindowsInstaller(installer);
  } catch (error) {
    installerStabilityError = error instanceof Error ? error.message : String(error);
  }
}
const startedAtMs = Date.parse(startedAt);
const installerFresh =
  Boolean(installerProof) && installerProof.stat.mtimeMs >= startedAtMs - 2_000;
const desktopFresh =
  existsSync(desktopExecutable) && statSync(desktopExecutable).mtimeMs >= startedAtMs - 2_000;

if (
  tauriStatus !== 0 ||
  !installer ||
  !existsSync(installer) ||
  !installerProof ||
  !sourceInstallerIntegrity?.ok ||
  !installerFresh ||
  !desktopFresh ||
  packagedRuntimeErrors.length > 0
) {
  writeManifest({
    status: "failed",
    startedAt,
    exitCode: 1,
    primaryInstaller: null,
    tauriExitCode: tauriStatus,
    residualRisk:
      packagedRuntimeErrors.length > 0
        ? "Packaged runtime validation failed."
        : sourceInstallerIntegrity && !sourceInstallerIntegrity.ok
          ? "Primary installer failed outer PE/NSIS integrity validation."
          : "Fresh primary NSIS setup.exe and desktop executable were not produced in this run.",
    installerFresh,
    installerStable: Boolean(installerProof),
    installerStabilityError,
    sourceInstaller: installer,
    sourceInstallerIntegrity,
    desktopFresh,
    packagedRuntimeErrors,
  });
  console.error(
    "package:release FAIL",
    packagedRuntimeErrors.length > 0
      ? packagedRuntimeErrors.join("; ")
      : sourceInstallerIntegrity && !sourceInstallerIntegrity.ok
        ? sourceInstallerIntegrity.errors.join("; ")
        : "no fresh primary NSIS installer",
  );
  process.exit(1);
}

// Refuse cargo intermediate binaries
if (installer.includes(`${join("target", "release", "deps")}`)) {
  writeManifest({
    status: "failed",
    startedAt,
    exitCode: 1,
    residualRisk: "Refusing deps intermediate exe as installer",
  });
  process.exit(1);
}

const acceptedDir = join(outDir, "accepted");
rmSync(acceptedDir, { recursive: true, force: true });
mkdirSync(acceptedDir, { recursive: true });
const acceptedInstaller = join(acceptedDir, basename(installer));
copyFileSync(installer, acceptedInstaller);
try {
  chmodSync(acceptedInstaller, 0o444);
} catch {
  /* hash and repeated validation remain authoritative on Windows */
}

let acceptedProof = null;
let acceptedInstallerIntegrity = null;
let acceptedInstallerError = null;
try {
  acceptedProof = waitForStableFile(acceptedInstaller, 10_000);
  acceptedInstallerIntegrity = inspectWindowsInstaller(acceptedInstaller);
} catch (error) {
  acceptedInstallerError = error instanceof Error ? error.message : String(error);
}
const sourceHashAfterCopy = sha256File(installer);
const acceptedMatchesSource =
  Boolean(acceptedProof) &&
  sourceHashAfterCopy === installerProof.hash &&
  acceptedProof.hash === installerProof.hash;
if (!acceptedProof || !acceptedInstallerIntegrity?.ok || !acceptedMatchesSource) {
  writeManifest({
    status: "failed",
    startedAt,
    exitCode: 1,
    primaryInstaller: null,
    sourceInstaller: installer,
    sourceInstallerSha256: installerProof.hash,
    sourceHashAfterCopy,
    sourceInstallerIntegrity,
    acceptedInstaller,
    acceptedInstallerIntegrity,
    acceptedInstallerError,
    acceptedMatchesSource,
    residualRisk: "Accepted installer staging failed integrity or source-hash binding.",
  });
  console.error(
    "package:release FAIL",
    acceptedInstallerError || acceptedInstallerIntegrity?.errors?.join("; ") || "accepted installer hash mismatch",
  );
  process.exit(1);
}

const installerStat = acceptedProof.stat;
const desktopStat = statSync(desktopExecutable);
const manifest = writeManifest({
  status: "ok",
  startedAt,
  exitCode: 0,
  primaryInstaller: acceptedInstaller,
  primaryInstallerSha256: acceptedProof.hash,
  primaryInstallerSize: installerStat.size,
  primaryInstallerMtimeMs: installerStat.mtimeMs,
  primaryFormat: "nsis",
  primaryInstallerName: basename(acceptedInstaller),
  sourceInstaller: installer,
  sourceInstallerSha256: installerProof.hash,
  sourceInstallerIntegrity,
  acceptedInstallerIntegrity,
  acceptedMatchesSource,
  desktopExecutable,
  desktopExecutableSha256: sha256File(desktopExecutable),
  desktopExecutableSize: desktopStat.size,
  desktopExecutableMtimeMs: desktopStat.mtimeMs,
  installerFresh,
  installerStable: true,
  desktopFresh,
  packagedRuntimeValidated: true,
  packagedRuntimeErrors,
  resourceManifestPath: resourceManifestProof.path,
  resourceManifestSha256: resourceManifestProof.sha256,
  resourceManifest: resourceManifestProof.manifest,
  residualRisk: null,
});
console.log("package:release OK", JSON.stringify(manifest, null, 2));
process.exit(0);
