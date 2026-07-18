/**
 * Prepare controlled Node runtime from release-runtime.lock.json.
 * Does NOT use process.execPath as the staged runtime (R1).
 *
 * Cache: .runtime-cache/node-vX-win-x64/
 * Stage: apps/desktop/src-tauri/resources/node/
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  cpSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = join(root, "scripts/release-runtime.lock.json");
const cacheRoot = join(root, ".runtime-cache");
const stageNode = join(root, "apps/desktop/src-tauri/resources/node");
const stageGit = join(root, "apps/desktop/src-tauri/resources/git");

function die(msg) {
  console.error("[prepare-runtime]", msg);
  process.exit(1);
}

function sha256File(file) {
  const h = createHash("sha256");
  h.update(readFileSync(file));
  return h.digest("hex");
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) die(`download failed ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
}

function extractZipWindows(zipPath, destDir) {
  mkdirSync(destDir, { recursive: true });
  // Prefer PowerShell Expand-Archive (available on Windows 11)
  const r = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    console.error(r.stdout, r.stderr);
    die("Expand-Archive failed");
  }
}

const lock = JSON.parse(readFileSync(lockPath, "utf8"));
if (lock.sdk !== "0.80.7") die(`lock sdk must be 0.80.7, got ${lock.sdk}`);
if (lock.node.os !== "win" || lock.node.arch !== "x64") {
  die("R1 lock is Windows x64 only for P0");
}
if (!lock.git?.portable?.url || !lock.git.portable.sha256) {
  die("release-runtime lock must pin Portable Git URL and SHA-256");
}

const ver = lock.node.version;
const archiveName = lock.node.archive;
const cacheDir = join(cacheRoot, `node-v${ver}-win-x64`);
const zipPath = join(cacheRoot, archiveName);
const extractedRoot = join(cacheDir, `node-v${ver}-win-x64`);

mkdirSync(cacheRoot, { recursive: true });

// Download + verify archive
if (!existsSync(zipPath) || sha256File(zipPath) !== lock.node.sha256) {
  console.log("[prepare-runtime] downloading", lock.node.url);
  await download(lock.node.url, zipPath);
}
const hash = sha256File(zipPath);
if (hash !== lock.node.sha256) {
  die(`SHA-256 mismatch: expected ${lock.node.sha256} got ${hash}`);
}
console.log("[prepare-runtime] archive sha256 OK", hash);

// Extract if needed
if (!existsSync(join(extractedRoot, "node.exe"))) {
  if (existsSync(cacheDir)) rmSync(cacheDir, { recursive: true, force: true });
  mkdirSync(cacheDir, { recursive: true });
  extractZipWindows(zipPath, cacheDir);
}
if (!existsSync(join(extractedRoot, "node.exe"))) {
  // some zips nest differently — find node.exe
  const found = findFile(cacheDir, "node.exe");
  if (!found) die("node.exe not found after extract");
  // if found is deeper, use its parent as extractedRoot
  const realRoot = dirname(found);
  if (!existsSync(join(stageNode, "node.exe"))) {
    // stage from realRoot
  }
  stageFrom(realRoot);
} else {
  stageFrom(extractedRoot);
}

await preparePortableGit();

function findFile(dir, name) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isFile() && ent.name === name) return p;
    if (ent.isDirectory()) {
      const f = findFile(p, name);
      if (f) return f;
    }
  }
  return null;
}

async function preparePortableGit() {
  const portable = lock.git.portable;
  const archivePath = join(cacheRoot, portable.archive);
  if (!existsSync(archivePath) || sha256File(archivePath) !== portable.sha256) {
    console.log("[prepare-runtime] downloading", portable.url);
    await download(portable.url, archivePath);
  }
  const archiveHash = sha256File(archivePath);
  if (archiveHash !== portable.sha256) {
    die(`Portable Git SHA-256 mismatch: expected ${portable.sha256} got ${archiveHash}`);
  }

  const extractDir = join(cacheRoot, `portable-git-${portable.version}`);
  if (!existsSync(join(extractDir, "cmd", "git.exe"))) {
    if (existsSync(extractDir)) rmSync(extractDir, { recursive: true, force: true });
    mkdirSync(extractDir, { recursive: true });
    const extracted = spawnSync(archivePath, ["-y", `-o${extractDir}`], {
      cwd: cacheRoot,
      encoding: "utf8",
      shell: false,
      timeout: 300_000,
    });
    if (extracted.status !== 0) {
      console.error(extracted.stdout, extracted.stderr);
      die(`Portable Git extraction failed exit=${extracted.status}`);
    }
  }

  for (const expected of portable.expectedFiles ?? []) {
    if (!existsSync(join(extractDir, expected))) {
      die(`Portable Git missing expected file after extraction: ${expected}`);
    }
  }
  if (existsSync(stageGit)) rmSync(stageGit, { recursive: true, force: true });
  cpSync(extractDir, stageGit, { recursive: true });
  const gitExe = join(stageGit, "cmd", "git.exe");
  const version = spawnSync(gitExe, ["--version"], {
    encoding: "utf8",
    shell: false,
    timeout: 30_000,
  });
  if (version.status !== 0 || !String(version.stdout).includes("git version")) {
    die(`staged Portable Git is not runnable: ${version.stderr || version.stdout}`);
  }
  const meta = {
    gitVersion: portable.version,
    tag: portable.tag,
    archive: portable.archive,
    archiveSha256: archiveHash,
    gitExe,
    versionOutput: String(version.stdout).trim(),
    preparedAt: new Date().toISOString(),
  };
  writeFileSync(join(stageGit, "RUNTIME.json"), JSON.stringify(meta, null, 2));
  console.log("[prepare-runtime] staged Portable Git to", stageGit);
}

function stageFrom(srcRoot) {
  if (existsSync(stageNode)) rmSync(stageNode, { recursive: true, force: true });
  mkdirSync(stageNode, { recursive: true });
  // Copy full distribution (node, npm, npx, etc.)
  cpSync(srcRoot, stageNode, { recursive: true });
  const nodeExe = join(stageNode, "node.exe");
  if (!existsSync(nodeExe)) die("staged node.exe missing");
  // Also need npm
  const npmCmd = join(stageNode, "npm.cmd");
  if (!existsSync(npmCmd)) {
    console.warn("[prepare-runtime] warning: npm.cmd not found in staged Node");
  }
  const stagingMeta = {
    nodeVersion: ver,
    archiveSha256: hash,
    stagedFrom: srcRoot,
    nodeExe,
    sdk: lock.sdk,
    preparedAt: new Date().toISOString(),
    usedProcessExecPath: false,
  };
  writeFileSync(join(stageNode, "RUNTIME.json"), JSON.stringify(stagingMeta, null, 2));
  console.log("[prepare-runtime] staged controlled Node to", stageNode);
  console.log(JSON.stringify(stagingMeta, null, 2));
}
