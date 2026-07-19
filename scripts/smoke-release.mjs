/**
 * smoke:release — install primary NSIS installer, locate app, launch with scrubbed PATH,
 * verify resources, uninstall, orphan audit. Fail closed without valid installer-manifest / setup.exe.
 */
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { inspectWindowsInstaller } from "./windows-installer-integrity.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const art = join(root, "artifacts", "p0", "release-latest");
mkdirSync(art, { recursive: true });

function writeSmoke(obj) {
  const body = {
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    command: "pnpm smoke:release",
    ...obj,
  };
  writeFileSync(join(art, "installed-smoke.json"), JSON.stringify(body, null, 2));
  console.log(JSON.stringify(body, null, 2));
  return body;
}

function findExe(name, roots) {
  for (const r of roots) {
    if (!r || !existsSync(r)) continue;
    const direct = join(r, name);
    if (existsSync(direct)) return direct;
    try {
      for (const ent of readdirSync(r, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const p = join(r, ent.name, name);
        if (existsSync(p)) return p;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

function installRoots() {
  const local = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  const pf = process.env.ProgramFiles || "C:\\Program Files";
  return [
    join(local, "PiDeck"),
    join(local, "Programs", "PiDeck"),
    join(pf, "PiDeck"),
  ];
}

function killRunningApp() {
  // Best-effort: avoid NSIS failure when app holds files open
  spawnSync("taskkill", ["/F", "/IM", "pideck.exe", "/T"], {
    shell: true,
    encoding: "utf8",
    timeout: 15_000,
  });
  spawnSync("taskkill", ["/F", "/IM", "node.exe", "/FI", "WINDOWTITLE eq pi-host*"], {
    shell: true,
    encoding: "utf8",
    timeout: 10_000,
  });
}

function runSilentNsis(executable, timeout) {
  return spawnSync(executable, ["/S"], {
    cwd: dirname(executable),
    shell: false,
    windowsHide: true,
    encoding: "utf8",
    timeout,
  });
}

function fileSha256(p) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

const releaseStagingDir = join(root, "apps/desktop/src-tauri/target/release-staging");
const acceptedInstallerRoot = join(releaseStagingDir, "accepted");
const manifestPaths = [
  join(releaseStagingDir, "PACKAGE_RELEASE.json"),
  join(art, "installer-manifest.json"),
];

function isUnder(path, rootPath) {
  const rel = relative(resolve(rootPath), resolve(path));
  return rel.length > 0 && rel !== ".." && !rel.startsWith("..\\") && !rel.startsWith("../") && !isAbsolute(rel);
}

let manifest = null;
let manifestPath = null;
let installerIntegrity = null;
for (const p of manifestPaths) {
  if (!existsSync(p)) continue;
  try {
    const candidate = JSON.parse(readFileSync(p, "utf8"));
    const candidateIntegrity =
      candidate.primaryInstaller && existsSync(candidate.primaryInstaller)
        ? inspectWindowsInstaller(candidate.primaryInstaller)
        : null;
    if (
      candidate.status === "ok" &&
      candidate.exitCode === 0 &&
      candidate.primaryInstaller &&
      isUnder(candidate.primaryInstaller, acceptedInstallerRoot) &&
      existsSync(candidate.primaryInstaller) &&
      typeof candidate.primaryInstallerSha256 === "string" &&
      fileSha256(candidate.primaryInstaller) === candidate.primaryInstallerSha256.toLowerCase() &&
      candidate.acceptedInstallerIntegrity?.ok === true &&
      candidateIntegrity?.ok === true
    ) {
      manifest = candidate;
      manifestPath = p;
      installerIntegrity = candidateIntegrity;
      break;
    }
  } catch {
    /* invalid or stale manifest is not accepted */
  }
}

if (!manifest?.primaryInstaller || !existsSync(manifest.primaryInstaller)) {
  writeSmoke({
    status: "failed",
    exitCode: 1,
    p0InstalledSmokeComplete: false,
    note: "No primary installer — run package:release first",
  });
  process.exit(1);
}

const installer = manifest.primaryInstaller;
const installerSha = manifest.primaryInstallerSha256.toLowerCase();

// Pre-uninstall previous install so silent reinstall is clean
killRunningApp();
const knownInstallRoots = installRoots();
const preExe = findExe("pideck.exe", knownInstallRoots);
let preUninstallExit = null;
if (preExe) {
  const preUninst =
    findExe("uninstall.exe", [dirname(preExe)]) ||
    findExe("Uninstall PiDeck.exe", [dirname(preExe)]);
  if (preUninst && existsSync(preUninst)) {
    console.log("[smoke:release] pre-uninstall", preUninst);
    const previous = runSilentNsis(preUninst, 120_000);
    preUninstallExit = previous.status;
    spawnSync(process.execPath, ["-e", "setTimeout(()=>{},1500)"], { timeout: 5_000 });
  }
  const remainingPreExe = findExe("pideck.exe", knownInstallRoots);
  if (preUninstallExit !== 0 || remainingPreExe) {
    writeSmoke({
      status: "pre_uninstall_failed",
      exitCode: 1,
      manifestPath,
      installer,
      preExe,
      preUninstallExit,
      remainingPreExe,
      p0InstalledSmokeComplete: false,
      note: "A clean pre-install state is required",
    });
    process.exit(1);
  }
} else {
  for (const installRoot of knownInstallRoots) {
    if (existsSync(installRoot)) {
      rmSync(installRoot, { recursive: true, force: true });
    }
  }
  const remainingInstallRoots = knownInstallRoots.filter(existsSync);
  if (remainingInstallRoots.length > 0) {
    writeSmoke({
      status: "pre_install_cleanup_failed",
      exitCode: 1,
      manifestPath,
      installer,
      remainingInstallRoots,
      p0InstalledSmokeComplete: false,
      note: "Orphaned install files must be removed before setup",
    });
    process.exit(1);
  }
}

const preExecutionSha256 = fileSha256(installer);
const preExecutionIntegrity = inspectWindowsInstaller(installer);
if (preExecutionSha256 !== installerSha || !preExecutionIntegrity.ok) {
  writeSmoke({
    status: "installer_integrity_failed",
    exitCode: 1,
    manifestPath,
    installer,
    installerSha256: installerSha,
    preExecutionSha256,
    preExecutionIntegrity,
    p0InstalledSmokeComplete: false,
    note: "Accepted installer changed or failed integrity validation before execution",
  });
  process.exit(1);
}

console.log("[smoke:release] installing", installer);
const inst = runSilentNsis(installer, 300_000);

const exe = findExe("pideck.exe", installRoots()) || null;
const installAccepted = inst.status === 0 && !inst.error && Boolean(exe);

if (!installAccepted) {
  writeSmoke({
    status: "install_failed",
    exitCode: inst.status ?? 1,
    installer,
    installerSha256: installerSha,
    installedExe: exe,
    installerStdout: (inst.stdout || "").slice(0, 2000),
    installerStderr: (inst.stderr || "").slice(0, 2000),
    installerSignal: inst.signal ?? null,
    installerErrorCode: inst.error?.code ?? null,
    installerErrorMessage: inst.error?.message ?? null,
    installerIntegrity,
    probedInstallRoots: installRoots(),
    p0InstalledSmokeComplete: false,
    note: "Silent install failed or exe not found",
  });
  process.exit(1);
}

// Resource layout checks under installed tree
const installDir = dirname(exe);
const resourcesDir = join(installDir, "resources");
const nodeDir = join(resourcesDir, "node");
const nodeExe = join(nodeDir, "node.exe");
const npmCmd = join(nodeDir, "npm.cmd");
const npmPackage = join(nodeDir, "node_modules", "npm", "package.json");
const hostDir = join(resourcesDir, "pi-host");
const hostMain = join(hostDir, "main.js");
const hostPkg = join(hostDir, "package.json");
const hostStagingPath = join(hostDir, "STAGING.json");
const resourceManifestPath = join(hostDir, "RELEASE_RESOURCES.json");
const nodeRuntimePath = join(nodeDir, "RUNTIME.json");
const gitDir = join(resourcesDir, "git");
const gitExe = join(gitDir, "cmd", "git.exe");
const gitBinExe = join(gitDir, "bin", "git.exe");
const gitRuntimePath = join(gitDir, "RUNTIME.json");
const archivePath = join(hostDir, "node_modules.zip");
const requiredResourceFiles = [
  nodeExe,
  npmCmd,
  npmPackage,
  hostMain,
  hostPkg,
  hostStagingPath,
  resourceManifestPath,
  nodeRuntimePath,
  gitExe,
  gitBinExe,
  gitRuntimePath,
  archivePath,
];
const controlledNodePresent = existsSync(nodeExe);
const hostMainPresent = existsSync(hostMain);
const resourcesPresent = requiredResourceFiles.every(existsSync);
const scrubbedPath = [nodeDir, join(gitDir, "cmd"), process.env.SystemRoot + "\\System32"].join(";");
const runtimeEnv = { ...process.env, PATH: scrubbedPath, NODE_OPTIONS: "" };
const nodeProbe = spawnSync(nodeExe, ["--version"], {
  shell: false,
  encoding: "utf8",
  timeout: 15_000,
  env: runtimeEnv,
});
// npm.cmd is a batch file: Node rejects spawning .cmd with shell:false
// (EINVAL, DEP0190 hardening) — invoke through cmd.exe explicitly.
const npmProbe = spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", npmCmd, "--version"], {
  shell: false,
  encoding: "utf8",
  timeout: 30_000,
  env: runtimeEnv,
});
const gitProbe = spawnSync(gitExe, ["--version"], {
  shell: false,
  encoding: "utf8",
  timeout: 30_000,
  env: runtimeEnv,
});
let runtimeMetadataOk = false;
let runtimeMetadata = null;
let resourceManifestFilesOk = false;
let resourceManifestHashOk = false;
let resourceManifestChecks = [];
if (resourcesPresent) {
  try {
    const runtimeLock = JSON.parse(
      readFileSync(join(root, "scripts", "release-runtime.lock.json"), "utf8"),
    );
    const nodeRuntime = JSON.parse(readFileSync(nodeRuntimePath, "utf8"));
    const gitRuntime = JSON.parse(readFileSync(gitRuntimePath, "utf8"));
    const hostStaging = JSON.parse(readFileSync(hostStagingPath, "utf8"));
    const npmMetadata = JSON.parse(readFileSync(npmPackage, "utf8"));
    const resourceManifest = JSON.parse(readFileSync(resourceManifestPath, "utf8"));
    resourceManifestChecks = (resourceManifest.files ?? []).map((entry) => {
      const path = join(resourcesDir, ...String(entry.path).split("/"));
      const present = existsSync(path);
      const size = present ? statSync(path).size : null;
      const sha256 = present ? fileSha256(path) : null;
      return {
        path: entry.path,
        present,
        expectedSize: entry.size,
        size,
        expectedSha256: entry.sha256,
        sha256,
        ok: present && size === entry.size && sha256 === entry.sha256,
      };
    });
    resourceManifestFilesOk =
      resourceManifestChecks.length > 0 && resourceManifestChecks.every((entry) => entry.ok);
    resourceManifestHashOk =
      typeof manifest.resourceManifestSha256 === "string" &&
      fileSha256(resourceManifestPath) === manifest.resourceManifestSha256.toLowerCase();
    runtimeMetadata = {
      runtimeLock,
      nodeRuntime,
      gitRuntime,
      hostStaging,
      resourceManifest,
      npmVersion: npmMetadata.version,
    };
    runtimeMetadataOk =
      resourceManifest.schemaVersion === 1 &&
      resourceManifest.sdkVersion === runtimeLock.sdk &&
      resourceManifest.nodeVersion === runtimeLock.node.version &&
      resourceManifest.nodeArchiveSha256 === runtimeLock.node.sha256 &&
      resourceManifest.gitVersion === runtimeLock.git.portable.version &&
      resourceManifest.gitArchiveSha256 === runtimeLock.git.portable.sha256 &&
      resourceManifest.pnpmLockSha256 === runtimeLock.pnpmLock.sha256 &&
      nodeRuntime.nodeVersion === runtimeLock.node.version &&
      nodeRuntime.archiveSha256 === runtimeLock.node.sha256 &&
      gitRuntime.gitVersion === runtimeLock.git.portable.version &&
      gitRuntime.archiveSha256 === runtimeLock.git.portable.sha256 &&
      hostStaging.sdk === runtimeLock.sdk &&
      hostStaging.pnpmLockSha256 === runtimeLock.pnpmLock.sha256 &&
      hostStaging.pnpmLockVerified === true &&
      npmProbe.stdout.trim() === npmMetadata.version &&
      gitProbe.stdout.trim() === gitRuntime.versionOutput &&
      resourceManifestFilesOk &&
      resourceManifestHashOk;
  } catch {
    runtimeMetadataOk = false;
  }
}
const installedExeSha256 = fileSha256(exe);
const executableMatchesManifest =
  typeof manifest.desktopExecutableSha256 === "string" &&
  installedExeSha256 === manifest.desktopExecutableSha256.toLowerCase();
const resourcesOk =
  resourcesPresent &&
  runtimeMetadataOk &&
  executableMatchesManifest &&
  nodeProbe.status === 0 &&
  npmProbe.status === 0 &&
  gitProbe.status === 0;

// Drive the installed Tauri window through the real desktop E2E workflow.
console.log("[smoke:release] running installed desktop E2E", exe);
const installedE2e = spawnSync(
  process.execPath,
  [join(root, "scripts", "run-e2e.mjs")],
  {
    cwd: root,
    shell: false,
    encoding: "utf8",
    timeout: 900_000,
    env: {
      ...process.env,
      PATH: scrubbedPath,
      NODE_OPTIONS: "",
      PIDECK_E2E_EXE: exe,
      PIDECK_E2E_EXPECTED_SHA256: installedExeSha256,
    },
  },
);
const launchOk = installedE2e.status === 0;

// Kill app before uninstall
killRunningApp();
spawnSync(process.execPath, ["-e", "setTimeout(()=>{},1000)"], { timeout: 3_000 });

// Uninstall
const uninst =
  findExe("uninstall.exe", [installDir]) ||
  findExe("Uninstall PiDeck.exe", [installDir]);
let uninstallExit = null;
let uninstallOk = false;
if (uninst && existsSync(uninst)) {
  console.log("[smoke:release] uninstalling", uninst);
  const u = runSilentNsis(uninst, 120_000);
  uninstallExit = u.status;
  uninstallOk = u.status === 0 && !u.error && !existsSync(exe);
} else {
  uninstallOk = false;
}

// Orphan audit: pideck.exe should not remain running
const tasklist = spawnSync("tasklist", ["/FI", "IMAGENAME eq pideck.exe", "/NH"], {
  shell: true,
  encoding: "utf8",
  timeout: 10_000,
});
const tasklistAuditOk = tasklist.status === 0 && !tasklist.error;
const orphanDesktop =
  (tasklist.stdout || "").toLowerCase().includes("pideck.exe") &&
  !(tasklist.stdout || "").toLowerCase().includes("no tasks");
const escapedInstallDir = installDir.replace(/'/g, "''");
const runtimeAudit = spawnSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-Command",
    `$p = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${escapedInstallDir}*' -and $_.Name -in @('node.exe','npm.exe','git.exe','pideck.exe') }; $p | Select-Object Name,ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress`,
  ],
  { shell: false, encoding: "utf8", timeout: 15_000 },
);
const runtimeAuditOk = runtimeAudit.status === 0 && !runtimeAudit.error;
const orphanRuntimeOutput = (runtimeAudit.stdout || "").trim();
const orphanRuntime = orphanRuntimeOutput.length > 0 && orphanRuntimeOutput !== "null";

// All of: clean install, controlled resources, installed E2E, uninstall, successful orphan audits.
const ok =
  installAccepted &&
  resourcesOk &&
  launchOk &&
  uninstallOk &&
  tasklistAuditOk &&
  runtimeAuditOk &&
  !orphanDesktop &&
  !orphanRuntime;
writeSmoke({
  status: ok ? "passed" : "failed",
  exitCode: ok ? 0 : 1,
  manifestPath,
  installer,
  installerSha256: installerSha,
  installerExitCode: inst.status,
  preUninstallExitCode: preUninstallExit,
  installedExe: exe,
  installedExeSha256,
  executableMatchesManifest,
  installDir,
  resourcesOk,
  requiredResourceFiles,
  controlledNodePresent,
  hostMainPresent,
  runtimeMetadataOk,
  runtimeMetadata,
  resourceManifestFilesOk,
  resourceManifestHashOk,
  resourceManifestChecks,
  nodeProbe: { status: nodeProbe.status, stdout: (nodeProbe.stdout ?? "").trim(), error: nodeProbe.error?.message ?? null },
  npmProbe: { status: npmProbe.status, stdout: (npmProbe.stdout ?? "").trim(), error: npmProbe.error?.message ?? null },
  gitProbe: { status: gitProbe.status, stdout: (gitProbe.stdout ?? "").trim(), error: gitProbe.error?.message ?? null },
  installedE2eExitCode: installedE2e.status,
  installedE2eError: installedE2e.error?.code ?? null,
  installedE2eStdoutTail: (installedE2e.stdout || "").slice(-4000),
  installedE2eStderrTail: (installedE2e.stderr || "").slice(-4000),
  pathScrubbed: true,
  uninstallExitCode: uninstallExit,
  uninstallOk,
  tasklistAuditOk,
  tasklistAuditStatus: tasklist.status,
  runtimeAuditOk,
  runtimeAuditStatus: runtimeAudit.status,
  orphanDesktop,
  orphanRuntime,
  orphanRuntimeOutput,
  p0InstalledSmokeComplete: ok,
  note: "Silent install + resource check + installed Tauri E2E + silent uninstall + desktop/runtime orphan audit",
});
process.exit(ok ? 0 : 1);
