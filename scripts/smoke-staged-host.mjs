import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertPiPackageTree,
  assertReleaseProductionManifest,
  assertReleaseSdkEvidence,
  loadReleaseSdkEvidence,
} from "./release-sdk-evidence.mjs";
import { resolveReleaseRuntimeTarget } from "./release-runtime-target.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const resources = join(root, "apps", "desktop", "src-tauri", "resources");
const lock = JSON.parse(readFileSync(join(root, "scripts", "release-runtime.lock.json"), "utf8"));
const runtimeTarget = resolveReleaseRuntimeTarget(lock);
const sdkEvidence = loadReleaseSdkEvidence(root, lock);
const stagedHostRoot = join(resources, "pi-host");
const staging = JSON.parse(readFileSync(join(stagedHostRoot, "STAGING.json"), "utf8"));
const stagedManifest = JSON.parse(readFileSync(join(stagedHostRoot, "package.json"), "utf8"));
const protocolVersion = JSON.parse(
  readFileSync(join(root, "packages/protocol/package.json"), "utf8"),
).version;
assertReleaseSdkEvidence(staging.sdkEvidence, sdkEvidence, "STAGING SDK evidence");
assertReleaseProductionManifest(
  stagedManifest,
  sdkEvidence,
  { "@pideck/protocol": protocolVersion },
  "staged release Host manifest",
);
const nodePath =
  process.env.PIDECK_STAGED_NODE ?? join(resources, "node", runtimeTarget.stagedNodeExecutable);
const hostEntry = process.env.PIDECK_STAGED_HOST_ENTRY ?? join(resources, "pi-host", "main.js");
const portableGit = join(resources, "git", "cmd", "git.exe");
const portableBash = join(resources, "git", "bin", "bash.exe");
const gitExecutable =
  process.env.PIDECK_STAGED_GIT ??
  (process.platform === "win32" && existsSync(portableGit) ? portableGit : "git");
const expectedNodeVersion = process.env.PIDECK_EXPECT_NODE_VERSION ?? runtimeTarget.node.version;
const timeoutMs = parseTimeout(process.env.PIDECK_STAGED_SMOKE_TIMEOUT_MS, 180_000);

function parseTimeout(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid PIDECK_STAGED_SMOKE_TIMEOUT_MS: ${value}`);
  }
  return parsed;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function withStderr(message, stderr) {
  const tail = stderr.trim();
  return tail ? `${message}\nstderr tail:\n${tail}` : message;
}

assert(existsSync(nodePath), `Staged Node is missing: ${nodePath}`);
assert(existsSync(hostEntry), `Staged Host entry is missing: ${hostEntry}`);

const tempRoot = mkdtempSync(join(tmpdir(), "pideck-staged-smoke-"));
const agentDir = join(tempRoot, "agent");
const workspaceDir = join(tempRoot, "workspace");
const hostCacheDir = join(tempRoot, "host-cache");
mkdirSync(agentDir, { recursive: true, mode: 0o700 });
mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });
for (const name of ["auth.json", "models.json", "settings.json"]) {
  writeFileSync(join(agentDir, name), "{}\n", { encoding: "utf8", mode: 0o600 });
}
if (process.platform === "win32") {
  assert(existsSync(portableGit), `Staged Portable Git is missing: ${portableGit}`);
  assert(existsSync(portableBash), `Staged Portable Bash is missing: ${portableBash}`);
}
execFileSync(gitExecutable, ["init", workspaceDir], { stdio: "pipe" });
writeFileSync(join(workspaceDir, "smoke.txt"), "staged host Git smoke\n", "utf8");

function snapshotFiles(directory, relativeDirectory = "", snapshot = {}) {
  for (const name of readdirSync(join(directory, relativeDirectory)).sort()) {
    const relativePath = join(relativeDirectory, name);
    const path = join(directory, relativePath);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      snapshotFiles(directory, relativePath, snapshot);
    } else if (stats.isFile()) {
      snapshot[relativePath] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  }
  return snapshot;
}

const stagedHostSnapshot = snapshotFiles(stagedHostRoot);

function assertStagedHostUnchanged() {
  assert(
    JSON.stringify(snapshotFiles(stagedHostRoot)) === JSON.stringify(stagedHostSnapshot),
    "staged Host resources changed while bootstrapping the writable cache",
  );
}

const pathMarker = join(tempRoot, "user-mise-marker");
mkdirSync(pathMarker, { recursive: true });
const hostPath = [pathMarker];
if (process.platform === "win32") {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  hostPath.push(join(systemRoot, "System32"));
} else {
  for (const systemDir of ["/usr/bin", "/bin"]) {
    if (existsSync(systemDir)) hostPath.push(systemDir);
  }
}

const hostEnv = {
  ...process.env,
  PI_CODING_AGENT_DIR: agentDir,
  PIDECK_HOST_CACHE_DIR: hostCacheDir,
  PATH: hostPath.join(delimiter),
  PIDECK_SMOKE_PATH_MARKER: pathMarker,
};
if (process.platform === "win32") {
  hostEnv.PIDECK_BUNDLED_GIT = gitExecutable;
  hostEnv.PIDECK_BUNDLED_BASH = portableBash;
}

const child = spawn(nodePath, [hostEntry], {
  cwd: dirname(hostEntry),
  env: hostEnv,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");

let stdoutBuffer = "";
let stderrTail = "";
let streamClosedError = null;
const messages = [];
const messageWaiters = [];
const exitPromise = new Promise((resolve) => {
  child.once("exit", (code, signal) => resolve({ code, signal }));
});

function rejectMessageWaiters(error) {
  streamClosedError = error;
  for (const waiter of messageWaiters.splice(0)) {
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
}

function enqueueMessage(message) {
  const waiter = messageWaiters.shift();
  if (!waiter) {
    messages.push(message);
    return;
  }
  clearTimeout(waiter.timer);
  waiter.resolve(message);
}

child.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk;
  let newline;
  while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
    const line = stdoutBuffer.slice(0, newline).trim();
    stdoutBuffer = stdoutBuffer.slice(newline + 1);
    if (!line) continue;
    try {
      enqueueMessage(JSON.parse(line));
    } catch (error) {
      rejectMessageWaiters(
        new Error(`Staged Host emitted invalid JSONL: ${line}`, { cause: error }),
      );
    }
  }
});

child.stderr.on("data", (chunk) => {
  stderrTail = (stderrTail + chunk).slice(-32_768);
});
child.once("error", (error) => rejectMessageWaiters(error));
child.once("close", (code, signal) => {
  rejectMessageWaiters(
    new Error(withStderr(`Staged Host closed with code=${code} signal=${signal}`, stderrTail)),
  );
});

function nextMessage(deadline) {
  if (messages.length > 0) return Promise.resolve(messages.shift());
  if (streamClosedError) return Promise.reject(streamClosedError);
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new Error("Timed out waiting for staged Host output"));
  return new Promise((resolve, reject) => {
    const waiter = {
      resolve,
      reject,
      timer: setTimeout(() => {
        const index = messageWaiters.indexOf(waiter);
        if (index >= 0) messageWaiters.splice(index, 1);
        reject(new Error(withStderr("Timed out waiting for staged Host output", stderrTail)));
      }, remaining),
    };
    messageWaiters.push(waiter);
  });
}

function probeAgentBash(cachedHostRoot) {
  const shellModule = join(
    cachedHostRoot,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "utils",
    "shell.js",
  );
  assert(existsSync(shellModule), `cached SDK shell module is missing: ${shellModule}`);
  const gitRoot = dirname(dirname(portableGit));
  const forbidden = [
    dirname(nodePath),
    dirname(portableGit),
    join(gitRoot, "bin"),
    join(gitRoot, "mingw64", "bin"),
  ];
  const script = `
import { spawnSync } from "node:child_process";
const { getShellConfig, getShellEnv } = await import(${JSON.stringify(pathToFileURL(shellModule).href)});
const env = getShellEnv();
const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
const pathValue = env[pathKey] ?? "";
const marker = process.env.PIDECK_SMOKE_PATH_MARKER;
if (!marker || !pathValue.includes(marker)) {
  throw new Error("Agent Bash env missing user PATH marker");
}
const forbidden = ${JSON.stringify(forbidden)};
for (const entry of forbidden) {
  if (entry && pathValue.toLowerCase().includes(String(entry).toLowerCase())) {
    throw new Error("Agent Bash env includes bundled runtime PATH: " + entry);
  }
}
if (process.platform === "win32") {
  delete process.env.ProgramFiles;
  delete process.env["ProgramFiles(x86)"];
  process.env.PATH = marker;
  const cfg = getShellConfig();
  if (cfg.shell !== process.env.PIDECK_BUNDLED_BASH) {
    throw new Error("expected bundled bash fallback, got " + cfg.shell);
  }
  const command = "printf '%s' PIDECK_BUNDLED_BASH_OK";
  const result = spawnSync(
    cfg.shell,
    cfg.commandTransport === "stdin" ? cfg.args : [...cfg.args, command],
    {
      encoding: "utf8",
      env,
      timeout: 15_000,
      windowsHide: true,
      input: cfg.commandTransport === "stdin" ? command : undefined,
    },
  );
  if (result.status !== 0 || !(result.stdout ?? "").includes("PIDECK_BUNDLED_BASH_OK")) {
    throw new Error(
      "bundled bash spawn failed: " + (result.stderr || String(result.error ?? "") || "no output"),
    );
  }
} else {
  const cfg = getShellConfig();
  const command = "printf '%s' PIDECK_BUNDLED_BASH_OK";
  const result = spawnSync(cfg.shell, [...cfg.args, command], {
    encoding: "utf8",
    env,
    timeout: 15_000,
  });
  if (result.status !== 0 || !(result.stdout ?? "").includes("PIDECK_BUNDLED_BASH_OK")) {
    throw new Error(
      "bash spawn failed: " + (result.stderr || String(result.error ?? "") || "no output"),
    );
  }
}
`;
  execFileSync(nodePath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: hostEnv,
    timeout: 30_000,
    windowsHide: true,
  });
}

async function waitForEvent(event, deadline) {
  while (Date.now() < deadline) {
    const message = await nextMessage(deadline);
    if (message.event === event) return message;
  }
  throw new Error(`Timed out waiting for event ${event}`);
}

async function request(method, context, params, deadline) {
  const id = randomUUID();
  child.stdin.write(`${JSON.stringify({ protocolVersion: 1, id, method, context, params })}\n`);
  while (Date.now() < deadline) {
    const message = await nextMessage(deadline);
    if (message.id === id) return message;
  }
  throw new Error(`Timed out waiting for response ${method}`);
}

async function waitForExit(deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Timed out waiting for staged Host exit");
  let timer;
  try {
    return await Promise.race([
      exitPromise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(withStderr("Timed out waiting for staged Host exit", stderrTail))),
          remaining,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

let cleanExit = false;
try {
  const deadline = Date.now() + timeoutMs;
  const ready = await waitForEvent("host.ready", deadline);
  const readyStatus = ready.payload;
  const hostInstanceId = ready.hostInstanceId ?? readyStatus?.hostInstanceId;
  assert(typeof hostInstanceId === "string", "host.ready did not include hostInstanceId");
  assert(
    readyStatus?.sdkVersion === sdkEvidence.sdkVersion,
    `Expected SDK ${sdkEvidence.sdkVersion}, got ${readyStatus?.sdkVersion}`,
  );
  const cachedHostRoot = join(hostCacheDir, staging.nodeModulesZipSha256);
  assert(existsSync(join(cachedHostRoot, "READY.json")), "Host cache readiness marker is missing");
  assert(
    existsSync(join(cachedHostRoot, "host-runtime", "host-main.js")),
    "cached Host runtime entry is missing",
  );
  assertPiPackageTree(cachedHostRoot, sdkEvidence, "smoke cached Host tree");
  assert(!existsSync(join(stagedHostRoot, "node_modules")), "staged Host was extracted in place");
  assertStagedHostUnchanged();
  assert(
    readyStatus?.nodeVersion === `v${expectedNodeVersion}`,
    `Expected Node v${expectedNodeVersion}, got ${readyStatus?.nodeVersion}`,
  );

  const context = { expectedHostInstanceId: hostInstanceId };
  const status = await request("system.getStatus", context, null, deadline);
  assert(status.ok === true, `system.getStatus failed: ${JSON.stringify(status.error)}`);
  assert(status.result?.hostInstanceId === hostInstanceId, "system.getStatus identity mismatch");

  const rehydrate = await request("system.rehydrate", context, null, deadline);
  assert(rehydrate.ok === true, `system.rehydrate failed: ${JSON.stringify(rehydrate.error)}`);
  assert(Number.isSafeInteger(rehydrate.result?.watermark), "rehydrate watermark is missing");
  assert(rehydrate.result?.host?.hostInstanceId === hostInstanceId, "rehydrate identity mismatch");

  const selected = await request(
    "workspace.setCurrent",
    {
      expectedHostInstanceId: hostInstanceId,
      expectedWorkspaceId: status.result.workspaceId,
      expectedWorkspaceRevision: status.result.workspaceRevision,
    },
    { cwd: workspaceDir },
    deadline,
  );
  assert(selected.ok === true, `workspace.setCurrent failed: ${JSON.stringify(selected.error)}`);
  const selectedWorkspace = selected.result?.workspace;
  assert(typeof selectedWorkspace?.id === "string", "workspace.setCurrent did not return an id");
  assert(Number.isSafeInteger(selectedWorkspace?.revision), "workspace revision is missing");
  const gitContext = {
    expectedHostInstanceId: hostInstanceId,
    expectedWorkspaceId: selectedWorkspace.id,
    expectedWorkspaceRevision: selectedWorkspace.revision,
  };
  const gitStatus = await request("git.getStatus", gitContext, null, deadline);
  assert(gitStatus.ok === true, `git.getStatus failed: ${JSON.stringify(gitStatus.error)}`);
  assert(
    gitStatus.result?.state === "ready",
    `git.getStatus was not ready: ${JSON.stringify(gitStatus.result)}`,
  );
  assert(
    gitStatus.result.files?.some(
      (file) => file.path === "smoke.txt" && file.unstaged === "untracked",
    ),
    "git.getStatus did not report the smoke file",
  );
  probeAgentBash(cachedHostRoot);

  const shutdown = await request("system.shutdown", context, null, deadline);
  assert(shutdown.ok === true, `system.shutdown failed: ${JSON.stringify(shutdown.error)}`);
  assert(shutdown.result?.accepted === true, "system.shutdown was not accepted");

  const exited = await waitForExit(deadline);
  assert(exited.code === 0, withStderr(`Staged Host exited with code=${exited.code}`, stderrTail));
  assertStagedHostUnchanged();
  cleanExit = true;
  console.log(
    JSON.stringify({
      status: "ok",
      sdkVersion: readyStatus.sdkVersion,
      nodeVersion: readyStatus.nodeVersion,
      gitStatus: gitStatus.result.state,
      bashProbe: "ok",
      rehydrateWatermark: rehydrate.result.watermark,
      exitCode: exited.code,
    }),
  );
} finally {
  if (!cleanExit) {
    child.kill();
    await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }
  rmSync(tempRoot, { recursive: true, force: true });
}
