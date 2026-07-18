/**
 * Stage runnable Pi Host + controlled Node from runtime lock (C1).
 *
 * - NO global npm fallback
 * - NO unlocked online npm install
 * - Production deps via `pnpm deploy --prod` from frozen workspace lock
 * - Verifies pnpm-lock.yaml hash against release-runtime.lock.json
 *
 * Layout:
 *   resources/node/     — full Node distro + RUNTIME.json
 *   resources/pi-host/  — main.js + STAGING.json + production node_modules
 */
import {
  cpSync,
  mkdirSync,
  existsSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  rmSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const hostDist = join(root, "packages/pi-host/dist");
const protocolDist = join(root, "packages/protocol/dist");
const protocolPkgJson = join(root, "packages/protocol/package.json");
const dest = join(root, "apps/desktop/src-tauri/resources/pi-host");
const nodeDir = join(root, "apps/desktop/src-tauri/resources/node");
const gitDir = join(root, "apps/desktop/src-tauri/resources/git");
const lockPath = join(root, "scripts/release-runtime.lock.json");
const pnpmLock = join(root, "pnpm-lock.yaml");

function die(msg) {
  console.error("[package-sidecar]", msg);
  process.exit(1);
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

if (!existsSync(hostDist)) die("packages/pi-host/dist missing — run pnpm build first");
if (!existsSync(protocolDist)) die("packages/protocol/dist missing — run pnpm build first");
if (!existsSync(lockPath)) die("scripts/release-runtime.lock.json missing");
if (!existsSync(pnpmLock)) die("pnpm-lock.yaml missing");

const lock = JSON.parse(readFileSync(lockPath, "utf8"));
if (lock.sdk !== "0.80.7") die(`lock.sdk must be 0.80.7, got ${lock.sdk}`);
if (lock.hostProductionDeps?.forbidUnlockedNpmInstall !== true) {
  die("lock must set hostProductionDeps.forbidUnlockedNpmInstall=true");
}

// Verify frozen lock hash
const lockSha = sha256File(pnpmLock);
const expectedSha = lock.pnpmLock?.sha256;
if (!expectedSha) die("release-runtime.lock.json missing pnpmLock.sha256");
if (lockSha !== expectedSha) {
  die(
    `pnpm-lock.yaml SHA-256 mismatch\n  expected ${expectedSha}\n  got      ${lockSha}\n  Update scripts/release-runtime.lock.json after intentional lock changes.`,
  );
}
console.log("[package-sidecar] pnpm-lock.yaml sha256 OK");

// Optionally prepare controlled Node from lock
if (process.argv.includes("--prepare-runtime") || process.argv.includes("--copy-system-node")) {
  if (process.argv.includes("--copy-system-node") && !process.argv.includes("--allow-execpath-fallback")) {
    console.warn(
      "[package-sidecar] --copy-system-node is not allowed for release; running prepare-release-runtime.mjs",
    );
  }
  const prep = spawnSync(process.execPath, [join(root, "scripts/prepare-release-runtime.mjs")], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
  if (prep.status !== 0) die("prepare-release-runtime failed");
}

if (!existsSync(join(nodeDir, "node.exe"))) {
  die("controlled Node missing — run: pnpm prepare:runtime");
}
if (!existsSync(join(nodeDir, "RUNTIME.json"))) {
  die("resources/node/RUNTIME.json missing — runtime not prepared via lock");
}
if (!existsSync(join(nodeDir, "npm.cmd"))) {
  die("controlled npm.cmd missing in staged Node — refuse global npm fallback");
}
if (!existsSync(join(gitDir, "cmd", "git.exe"))) {
  die("controlled Portable Git missing — run: pnpm prepare:runtime");
}
if (!existsSync(join(gitDir, "RUNTIME.json"))) {
  die("resources/git/RUNTIME.json missing — Portable Git not prepared via lock");
}

const runtimeMeta = JSON.parse(readFileSync(join(nodeDir, "RUNTIME.json"), "utf8"));
if (runtimeMeta.usedProcessExecPath === true) {
  die("RUNTIME.json usedProcessExecPath must be false");
}
if (runtimeMeta.archiveSha256 !== lock.node.sha256) {
  die(
    `staged Node archive hash mismatch: RUNTIME ${runtimeMeta.archiveSha256} vs lock ${lock.node.sha256}`,
  );
}
const gitRuntimeMeta = JSON.parse(readFileSync(join(gitDir, "RUNTIME.json"), "utf8"));
if (gitRuntimeMeta.archiveSha256 !== lock.git.portable.sha256) {
  die(
    `staged Git archive hash mismatch: RUNTIME ${gitRuntimeMeta.archiveSha256} vs lock ${lock.git.portable.sha256}`,
  );
}
const gitProbe = spawnSync(join(gitDir, "cmd", "git.exe"), ["--version"], {
  encoding: "utf8",
  shell: false,
  timeout: 30_000,
});
if (gitProbe.status !== 0 || !String(gitProbe.stdout).includes("git version")) {
  die(`controlled Portable Git probe failed: ${gitProbe.stderr || gitProbe.stdout}`);
}

function proveSdkImport(hostDir) {
  const nodeExe = join(nodeDir, process.platform === "win32" ? "node.exe" : "node");
  const prove = spawnSync(
    nodeExe,
    [
      "-e",
      "import('@earendil-works/pi-coding-agent').then(()=>console.log('SDK_OK')).catch(e=>{console.error(e);process.exit(1)})",
    ],
    { cwd: hostDir, encoding: "utf8", shell: false },
  );
  return prove.status === 0 && (prove.stdout || "").includes("SDK_OK")
    ? null
    : prove.stderr || prove.stdout || "SDK import failed";
}

/**
 * Stage production dependencies in an external temporary directory, then copy only
 * node_modules into a freshly-created release root. Deploying into the final resource
 * directory can recursively package the destination itself when pnpm walks the workspace.
 */
function stageHostWithDeploy() {
  const deployedFrom = join(tmpdir(), `pi-host-deploy-${process.pid}-${Date.now()}`);
  try {
    rmSync(deployedFrom, { recursive: true, force: true });
    console.log("[package-sidecar] pnpm deploy --prod ->", deployedFrom);
    const deploy = spawnSync(
      "pnpm",
      ["--filter", "@pideck/pi-host", "deploy", "--prod", deployedFrom],
      { cwd: root, encoding: "utf8", shell: true, env: process.env },
    );
    if (
      deploy.status !== 0 ||
      !existsSync(join(deployedFrom, "node_modules", "@earendil-works", "pi-coding-agent"))
    ) {
      die(
        `pnpm deploy failed — cannot stage production Host without unlocked install: ${
          deploy.stderr || deploy.stdout || `exit=${deploy.status}`
        }`,
      );
    }

    const deployImportError = proveSdkImport(deployedFrom);
    if (deployImportError) die(`deploy SDK import failed: ${deployImportError}`);

    console.log("[package-sidecar] hoisting pnpm store packages to top-level (real files)...");
    hoistPnpmPackages(join(deployedFrom, "node_modules"));
    const hoistedImportError = proveSdkImport(deployedFrom);
    if (hoistedImportError) die(`SDK import failed after hoist: ${hoistedImportError}`);

    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    cpSync(join(deployedFrom, "node_modules"), join(dest, "node_modules"), {
      recursive: true,
      dereference: true,
    });

    const stagedImportError = proveSdkImport(dest);
    if (stagedImportError) die(`SDK import failed after clean dependency copy: ${stagedImportError}`);
    return "pnpm-deploy-temp-node-modules-only-hoisted";
  } finally {
    try {
      rmSync(deployedFrom, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  }
}

/**
 * Copy every package from the pnpm virtual store into top-level node_modules
 * as real directories so resolution works after zip extract.
 */
function hoistPnpmPackages(nmDir) {
  const pnpmDir = join(nmDir, ".pnpm");
  if (!existsSync(pnpmDir)) {
    console.warn("[package-sidecar] no .pnpm dir to hoist");
    return;
  }
  let count = 0;
  for (const entry of readdirSync(pnpmDir)) {
    const storeNm = join(pnpmDir, entry, "node_modules");
    if (!existsSync(storeNm)) continue;
    for (const name of readdirSync(storeNm)) {
      if (name === ".bin") continue;
      const src = join(storeNm, name);
      if (name.startsWith("@")) {
        let scoped;
        try {
          scoped = readdirSync(src);
        } catch {
          continue;
        }
        for (const sub of scoped) {
          const srcPkg = join(src, sub);
          const dstPkg = join(nmDir, name, sub);
          try {
            // Prefer realpath content
            let real = srcPkg;
            try {
              real = realpathSync(srcPkg);
            } catch {
              /* keep */
            }
            mkdirSync(join(nmDir, name), { recursive: true });
            if (existsSync(dstPkg)) {
              // If existing is a junction, replace with real copy
              try {
                spawnSync("cmd.exe", ["/c", `rmdir "${dstPkg}"`], { encoding: "utf8" });
              } catch {
                /* ignore */
              }
              if (existsSync(dstPkg)) rmSync(dstPkg, { recursive: true, force: true });
            }
            cpSync(real, dstPkg, { recursive: true, dereference: true });
            count += 1;
          } catch (e) {
            console.warn("[package-sidecar] hoist skip", `${name}/${sub}`, e.message);
          }
        }
      } else {
        const dstPkg = join(nmDir, name);
        try {
          let real = src;
          try {
            real = realpathSync(src);
          } catch {
            /* keep */
          }
          if (existsSync(dstPkg)) {
            try {
              spawnSync("cmd.exe", ["/c", `rmdir "${dstPkg}"`], { encoding: "utf8" });
            } catch {
              /* ignore */
            }
            if (existsSync(dstPkg)) rmSync(dstPkg, { recursive: true, force: true });
          }
          cpSync(real, dstPkg, { recursive: true, dereference: true });
          count += 1;
        } catch (e) {
          console.warn("[package-sidecar] hoist skip", name, e.message);
        }
      }
    }
  }
  console.log("[package-sidecar] hoisted packages:", count);
}

// Stage: deploy first (creates dest + node_modules), then overlay Host dist
const depStrategy = stageHostWithDeploy();

// Overlay Host dist JS (deploy may have left package source stubs)
for (const name of readdirSync(hostDist)) {
  const src = join(hostDist, name);
  if (name.includes(".test.")) continue;
  if (name.endsWith(".d.ts") || name.endsWith(".d.ts.map")) continue;
  if (statSync(src).isDirectory()) {
    if (name === "spike" || name === "test-helpers") continue;
    cpSync(src, join(dest, name), { recursive: true });
  } else if (name.endsWith(".js") || name.endsWith(".js.map")) {
    cpSync(src, join(dest, name));
  }
}
if (!existsSync(join(dest, "main.js"))) die("main.js missing after stage");
if (!existsSync(join(dest, "model-health.js"))) die("model-health.js missing — flat layout broken");

// Re-prove after overlay (node_modules untouched)
{
  const err = proveSdkImport(dest);
  if (err) die(`SDK import failed after host overlay: ${err}`);
}

for (const forbidden of ["src", "apps", ".staging-host-deploy", "tsconfig.json", "vitest.config.ts"]) {
  if (existsSync(join(dest, forbidden))) {
    die(`clean Host stage contains forbidden deploy payload: ${forbidden}`);
  }
}
for (const name of readdirSync(dest)) {
  if (/\.(?:test|spec)\.[cm]?[jt]s$/i.test(name)) {
    die(`clean Host stage contains test file: ${name}`);
  }
}

// Ensure protocol is the workspace build (deploy may link workspace protocol)
const protocolVendor = join(dest, "vendor", "protocol");
mkdirSync(protocolVendor, { recursive: true });
cpSync(protocolDist, join(protocolVendor, "dist"), { recursive: true });
const protoMeta = JSON.parse(readFileSync(protocolPkgJson, "utf8"));
writeFileSync(
  join(protocolVendor, "package.json"),
  JSON.stringify(
    {
      name: "@pideck/protocol",
      version: protoMeta.version || "0.1.0",
      type: "module",
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
    },
    null,
    2,
  ),
);
// Force node_modules/@pideck/protocol → vendor
const protoLink = join(dest, "node_modules", "@pideck", "protocol");
mkdirSync(dirname(protoLink), { recursive: true });
if (existsSync(protoLink)) rmSync(protoLink, { recursive: true, force: true });
cpSync(protocolVendor, protoLink, { recursive: true });

const releasePkg = {
  name: "pideck-host-release",
  version: "0.1.0",
  private: true,
  type: "module",
  main: "./main.js",
  dependencies: {
    "@earendil-works/pi-coding-agent": "0.80.7",
    "@pideck/protocol": "0.1.0",
  },
};
writeFileSync(join(dest, "package.json"), JSON.stringify(releasePkg, null, 2));

const sdkPkgPath = join(dest, "node_modules/@earendil-works/pi-coding-agent/package.json");
if (!existsSync(sdkPkgPath)) die("SDK missing after pnpm deploy stage");
const sdkVer = JSON.parse(readFileSync(sdkPkgPath, "utf8")).version;
if (sdkVer !== "0.80.7") die(`SDK version ${sdkVer} !== 0.80.7`);

// Layout validation — refuse flatten collision of package.json identities
const hostPkgName = JSON.parse(readFileSync(join(dest, "package.json"), "utf8")).name;
if (hostPkgName !== "pideck-host-release") die("pi-host package.json name overwritten");
const protocolName = JSON.parse(
  readFileSync(join(dest, "node_modules/@pideck/protocol/package.json"), "utf8"),
).name;
if (protocolName !== "@pideck/protocol") die("protocol package identity broken");

const staging = {
  status: "ok",
  sdk: sdkVer,
  entry: "main.js",
  layout: "flat-dist-with-pnpm-deploy-node_modules",
  stagedAt: new Date().toISOString(),
  controlledNodePresent: true,
  usedProcessExecPath: false,
  usedGlobalNpm: false,
  unlockedNpmInstall: false,
  nodeVersion: runtimeMeta.nodeVersion,
  nodeArchiveSha256: runtimeMeta.archiveSha256,
  portableGitVersion: gitRuntimeMeta.gitVersion,
  portableGitArchiveSha256: gitRuntimeMeta.archiveSha256,
  portableGitProbe: String(gitProbe.stdout).trim(),
  pnpmLockSha256: lockSha,
  pnpmLockSha256Expected: expectedSha,
  pnpmLockVerified: true,
  sdkInstalled: true,
  runtimeLockSdk: lock.sdk,
  hostPackageName: hostPkgName,
  protocolPackageName: protocolName,
  stagingStrategy: depStrategy,
};
writeFileSync(join(dest, "STAGING.json"), JSON.stringify(staging, null, 2));

// Always compact node_modules → zip for NSIS MAX_PATH (C1/C8)
console.log("[package-sidecar] compacting node_modules for NSIS...");
const compact = spawnSync(process.execPath, [join(root, "scripts/compact-pi-host-resources.mjs")], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});
if (compact.status !== 0) {
  die("compact-pi-host-resources failed");
}

console.log("[package-sidecar] OK", JSON.stringify(staging, null, 2));
