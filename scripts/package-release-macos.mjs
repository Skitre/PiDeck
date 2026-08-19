/** Build and accept a native macOS DMG plus its Tauri updater bundle. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeReleaseResourceManifest } from "./release-resource-manifest.mjs";
import { updaterPlatformKey } from "./release-runtime-target.mjs";
import { currentSourceCommit, verifiedSourceBuildCommit } from "./verified-source-build.mjs";

if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)) {
  throw new Error(
    `macOS release packaging requires darwin arm64/x64, got ${process.platform}-${process.arch}`,
  );
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tauriRoot = join(root, "apps/desktop/src-tauri");
const bundleRoot = join(tauriRoot, "target/release/bundle");
const stagingRoot = join(tauriRoot, "target/release-staging");
const stageTimingsMs = {};
const startedAt = new Date().toISOString();
mkdirSync(stagingRoot, { recursive: true });

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeManifest(fields) {
  const manifest = {
    status: fields.status ?? "unknown",
    startedAt,
    finishedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    updaterPlatform: updaterPlatformKey(),
    command: "pnpm package:release",
    stageTimingsMs,
    exitCode: fields.exitCode ?? null,
    primaryInstaller: fields.primaryInstaller ?? null,
    primaryInstallerSha256: fields.primaryInstallerSha256 ?? null,
    updaterBundle: fields.updaterBundle ?? null,
    updaterBundleSha256: fields.updaterBundleSha256 ?? null,
    residualRisk: fields.residualRisk ?? null,
    ...fields,
    sourceCommit: fields.sourceCommit ?? currentSourceCommit(),
  };
  writeFileSync(
    join(stagingRoot, "PACKAGE_RELEASE.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  const evidenceDir = join(root, "artifacts/p0/release-latest");
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(
    join(evidenceDir, `installer-manifest-${manifest.updaterPlatform}.json`),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

function fail(message, fields = {}) {
  writeManifest({ status: "failed", exitCode: 1, residualRisk: message, ...fields });
  console.error("package:release FAIL", message);
  process.exit(1);
}

function timed(label, operation) {
  const started = Date.now();
  console.log(`[package:release:macos] ${label} started`);
  try {
    return operation();
  } finally {
    stageTimingsMs[label] = Date.now() - started;
    console.log(`[package:release:macos] ${label} finished in ${stageTimingsMs[label]}ms`);
  }
}

function run(command, args, options = {}) {
  console.log(`\n=== ${command} ${args.join(" ")} ===`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: false,
    env: process.env,
    ...options,
  });
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} failed`, {
      failedStep: `${command} ${args.join(" ")}`,
      failedExitCode: result.status ?? 1,
    });
  }
  return result;
}

function capture(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    shell: false,
    env: process.env,
    ...options,
  });
}

function newestFile(directory, accepts) {
  if (!existsSync(directory)) return null;
  return (
    readdirSync(directory)
      .map((name) => join(directory, name))
      .filter((path) => statSync(path).isFile() && accepts(basename(path)))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null
  );
}

function newestDirectory(directory, accepts) {
  if (!existsSync(directory)) return null;
  return (
    readdirSync(directory)
      .map((name) => join(directory, name))
      .filter((path) => statSync(path).isDirectory() && accepts(basename(path)))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null
  );
}

function validatePackagedResources(appBundle, expectedManifest) {
  const errors = [];
  const resourceDir = join(appBundle, "Contents/Resources/resources");
  const packagedManifestPath = join(resourceDir, "pi-host/RELEASE_RESOURCES.json");
  if (!existsSync(packagedManifestPath)) {
    return { errors: ["packaged app is missing pi-host/RELEASE_RESOURCES.json"], resourceDir };
  }
  let packagedManifest;
  try {
    packagedManifest = JSON.parse(readFileSync(packagedManifestPath, "utf8"));
  } catch (error) {
    return { errors: [`invalid packaged resource manifest: ${error.message}`], resourceDir };
  }
  if (JSON.stringify(packagedManifest) !== JSON.stringify(expectedManifest)) {
    errors.push("packaged resource manifest differs from staged manifest");
  }
  for (const entry of packagedManifest.files ?? []) {
    const path = join(resourceDir, ...String(entry.path).split("/"));
    if (!existsSync(path)) {
      errors.push(`packaged resource missing: ${entry.path}`);
      continue;
    }
    if (statSync(path).size !== entry.size || sha256File(path) !== entry.sha256) {
      errors.push(`packaged resource hash mismatch: ${entry.path}`);
    }
  }
  const node = join(resourceDir, "node/node");
  if (existsSync(node)) {
    const probe = capture(node, ["--version"]);
    if (probe.status !== 0 || probe.stdout.trim() !== `v${expectedManifest.nodeVersion}`) {
      errors.push(`packaged Node probe failed: ${probe.stderr || probe.stdout}`);
    }
  }
  return { errors, resourceDir };
}

let reusedSourceBuildCommit = null;
try {
  reusedSourceBuildCommit = verifiedSourceBuildCommit();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error), {
    failedStep: "verify reused source build",
  });
}
if (reusedSourceBuildCommit) {
  console.log(
    `[package:release:macos] reusing verify:p0 JavaScript build for ${reusedSourceBuildCommit}`,
  );
} else {
  timed("build JavaScript packages", () => run("pnpm", ["build"]));
}
timed("stage controlled sidecar runtime", () => run("pnpm", ["package:sidecar:with-node"]));
timed("validate staged resources", () => run("pnpm", ["validate:resources"]));
timed("smoke staged Host", () => run("pnpm", ["smoke:staged-host"]));

const stagedResources = join(tauriRoot, "resources");
let resourceProof;
try {
  resourceProof = timed("write release resource manifest", () =>
    writeReleaseResourceManifest(root, stagedResources),
  );
} catch (error) {
  fail(`release resource manifest failed: ${error.message}`);
}

for (const stalePath of [
  join(bundleRoot, "macos"),
  join(bundleRoot, "dmg"),
  join(tauriRoot, "target/release/pideck"),
]) {
  rmSync(stalePath, { recursive: true, force: true });
}

const tauriCli = join(root, "apps/desktop/node_modules/@tauri-apps/cli/tauri.js");
if (!existsSync(tauriCli)) fail("local Tauri CLI is missing; run pnpm install --frozen-lockfile");
const signingIdentity = process.env.APPLE_SIGNING_IDENTITY?.trim() || "-";
const tauriEnv = {
  ...process.env,
  APPLE_SIGNING_IDENTITY: signingIdentity,
  TAURI_BUNDLER_DMG_IGNORE_CI: "true",
};
timed("build signed Tauri app and DMG", () =>
  run(process.execPath, [tauriCli, "build", "--bundles", "app,dmg"], {
    cwd: join(root, "apps/desktop"),
    env: tauriEnv,
  }),
);

const appBundle = newestDirectory(join(bundleRoot, "macos"), (name) => name.endsWith(".app"));
const updaterBundle = newestFile(join(bundleRoot, "macos"), (name) => name.endsWith(".app.tar.gz"));
const dmg = newestFile(join(bundleRoot, "dmg"), (name) => name.endsWith(".dmg"));
const updaterSignature = updaterBundle ? `${updaterBundle}.sig` : null;
if (!appBundle || !updaterBundle || !dmg || !updaterSignature || !existsSync(updaterSignature)) {
  fail("fresh app, DMG, updater tarball, and updater signature were not all produced", {
    sourceAppBundle: appBundle,
    sourceInstaller: dmg,
    sourceUpdaterBundle: updaterBundle,
    sourceUpdaterSignature: updaterSignature,
  });
}

const startedAtMs = Date.parse(startedAt);
for (const [path, label] of [
  [appBundle, "app bundle"],
  [dmg, "DMG"],
  [updaterBundle, "updater bundle"],
  [updaterSignature, "updater signature"],
]) {
  if (statSync(path).mtimeMs < startedAtMs - 2_000) fail(`${label} is stale: ${path}`);
}

const packagedResources = timed("validate packaged resources", () =>
  validatePackagedResources(appBundle, resourceProof.manifest),
);
if (packagedResources.errors.length > 0) {
  fail(`packaged runtime validation failed: ${packagedResources.errors.join("; ")}`, {
    packagedRuntimeErrors: packagedResources.errors,
  });
}

timed("smoke packaged Host", () =>
  run(process.execPath, [join(root, "scripts/smoke-staged-host.mjs")], {
    env: {
      ...process.env,
      PIDECK_STAGED_NODE: join(packagedResources.resourceDir, "node/node"),
      PIDECK_STAGED_HOST_ENTRY: join(packagedResources.resourceDir, "pi-host/main.js"),
    },
  }),
);

const codeSign = timed("verify app code signature", () =>
  capture("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appBundle]),
);
if (codeSign.status !== 0) {
  fail(`codesign verification failed: ${codeSign.stderr || codeSign.stdout}`);
}
const codeSignDetails = capture("codesign", ["--display", "--verbose=4", appBundle]);
const codeSignOutput = `${codeSignDetails.stdout ?? ""}${codeSignDetails.stderr ?? ""}`.trim();
const codeSigningMode = /Signature=adhoc/u.test(codeSignOutput) ? "ad-hoc" : "developer-id";

const dmgVerify = timed("verify DMG", () => capture("hdiutil", ["verify", dmg]));
if (dmgVerify.status !== 0) fail(`hdiutil verify failed: ${dmgVerify.stderr || dmgVerify.stdout}`);
const gatekeeper = capture("spctl", ["--assess", "--type", "execute", "--verbose=2", appBundle]);

const acceptedDir = join(stagingRoot, "accepted");
rmSync(acceptedDir, { recursive: true, force: true });
mkdirSync(acceptedDir, { recursive: true });
const acceptedDmg = join(acceptedDir, basename(dmg));
const acceptedUpdater = join(acceptedDir, basename(updaterBundle));
const acceptedSignature = `${acceptedUpdater}.sig`;
copyFileSync(dmg, acceptedDmg);
copyFileSync(updaterBundle, acceptedUpdater);
copyFileSync(updaterSignature, acceptedSignature);
for (const path of [acceptedDmg, acceptedUpdater, acceptedSignature]) {
  try {
    chmodSync(path, 0o444);
  } catch {
    // Hash binding below remains authoritative.
  }
}

const dmgHash = sha256File(dmg);
const updaterHash = sha256File(updaterBundle);
if (sha256File(acceptedDmg) !== dmgHash || sha256File(acceptedUpdater) !== updaterHash) {
  fail("accepted macOS artifact hash does not match its source");
}

const manifest = writeManifest({
  status: "ok",
  exitCode: 0,
  primaryInstaller: acceptedDmg,
  primaryInstallerName: basename(acceptedDmg),
  primaryInstallerSha256: dmgHash,
  primaryInstallerSize: statSync(acceptedDmg).size,
  primaryFormat: "dmg",
  sourceInstaller: dmg,
  sourceAppBundle: appBundle,
  updaterBundle: acceptedUpdater,
  updaterBundleName: basename(acceptedUpdater),
  updaterBundleSha256: updaterHash,
  updaterBundleSize: statSync(acceptedUpdater).size,
  updaterSignatureFile: acceptedSignature,
  updaterSignature: readFileSync(acceptedSignature, "utf8").trim(),
  packagedRuntimeValidated: true,
  packagedRuntimeErrors: [],
  resourceManifestPath: resourceProof.path,
  resourceManifestSha256: resourceProof.sha256,
  resourceManifest: resourceProof.manifest,
  macosCodeSigningMode: codeSigningMode,
  macosCodeSignatureVerified: true,
  macosCodeSignatureDetails: codeSignOutput,
  macosGatekeeperAccepted: gatekeeper.status === 0,
  macosGatekeeperDetails: `${gatekeeper.stdout ?? ""}${gatekeeper.stderr ?? ""}`.trim(),
  reusedSourceBuildCommit,
  residualRisk:
    gatekeeper.status === 0
      ? null
      : "The app is ad-hoc signed or not notarized; macOS may require manual approval in Privacy & Security.",
});
console.log("package:release OK", JSON.stringify(manifest, null, 2));
