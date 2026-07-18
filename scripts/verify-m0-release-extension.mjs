/**
 * R1 M0 hard gate: staged Node + staged Host + real Extension handler nonce.
 * PATH is scrubbed of global Node/npm/git. Harness never writes the success marker.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  cpSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nodeExe = join(root, "apps/desktop/src-tauri/resources/node/node.exe");
const hostEntry = join(root, "apps/desktop/src-tauri/resources/pi-host/main.js");
const fixtureExt = join(
  root,
  "test-fixtures/pi-packages/extension-only/extensions/spike-extension.ts",
);
const stagingPath = join(root, "apps/desktop/src-tauri/resources/pi-host/STAGING.json");
const runtimePath = join(root, "apps/desktop/src-tauri/resources/node/RUNTIME.json");

function die(msg) {
  console.error("[verify:m0]", msg);
  process.exit(1);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`process did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    const onExit = (code) => {
      cleanup();
      resolve(code ?? 1);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
    };
    child.on("exit", onExit);
  });
}

function parseLines(buf) {
  return buf
    .split(/\n/)
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// --- negative prechecks ---
if (!existsSync(nodeExe)) die("staged node.exe missing — run prepare-release-runtime + package:sidecar");
if (!existsSync(hostEntry)) die("staged host main.js missing — run package:sidecar");
if (!existsSync(join(dirname(hostEntry), "model-health.js"))) die("flat host layout broken");
const hostDir = dirname(hostEntry);
const expandedSdk = join(hostDir, "node_modules/@earendil-works/pi-coding-agent");
const zipPath = join(hostDir, "node_modules.zip");
const hostMain = join(hostDir, "host-main.js");
const compacted =
  existsSync(zipPath) &&
  existsSync(hostMain) &&
  (!existsSync(expandedSdk) || readFileSync(hostEntry, "utf8").includes("node_modules.zip"));
if (!existsSync(expandedSdk) && !compacted) {
  die("staged SDK missing (neither expanded node_modules nor compacted zip)");
}
if (compacted) {
  console.log("[verify:m0] layout=compacted-zip (bootstrap extracts on start)");
}
if (!existsSync(runtimePath)) die("RUNTIME.json missing — prepare-release-runtime required");
const runtime = JSON.parse(readFileSync(runtimePath, "utf8"));
if (runtime.usedProcessExecPath) die("runtime staged from process.execPath — forbidden for R1");
const staging = JSON.parse(readFileSync(stagingPath, "utf8"));
if (staging.sdk !== "0.80.7") die(`SDK ${staging.sdk} !== 0.80.7`);
if (!existsSync(fixtureExt)) die("fixture extension missing");

const nonce = randomBytes(16).toString("hex");
const work = mkdtempSync(join(tmpdir(), "m0-verify-"));
const agentDir = join(work, "agent");
const projectDir = join(work, "project");
const markerPath = join(work, "handler-marker.txt");
mkdirSync(agentDir, { recursive: true });
mkdirSync(join(projectDir, ".pi", "extensions"), { recursive: true });
writeFileSync(join(agentDir, "auth.json"), "{}");
writeFileSync(join(agentDir, "models.json"), "{}");
writeFileSync(join(agentDir, "settings.json"), "{}");
writeFileSync(join(agentDir, "trust.json"), "{}");
cpSync(fixtureExt, join(projectDir, ".pi", "extensions", "spike-extension.ts"));

// Scrub PATH of global node/npm/git directories
const scrubbedPath = (process.env.PATH || "")
  .split(";")
  .filter((p) => {
    const low = p.toLowerCase();
    if (low.includes("nvm") || low.includes("nodejs") || low.includes("\\git\\") || low.includes("program files\\git")) {
      return false;
    }
    // keep Windows system dirs
    return true;
  })
  .join(";");
const stagedNodeDir = dirname(nodeExe);
const childPath = [stagedNodeDir, scrubbedPath].filter(Boolean).join(";");

console.log("[verify:m0] node=", nodeExe);
console.log("[verify:m0] host=", hostEntry);
console.log("[verify:m0] nonce=", nonce);
console.log("[verify:m0] agentDir=", agentDir);

const env = {
  ...process.env,
  PATH: childPath,
  PI_CODING_AGENT_DIR: agentDir,
  PI_DESKTOP_SPIKE_NONCE: nonce,
  PI_DESKTOP_SPIKE_MARKER: markerPath,
};

const p = spawn(nodeExe, [hostEntry, `--agent-dir=${agentDir}`], {
  cwd: dirname(hostEntry),
  env,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

let stdout = "";
let stderr = "";
p.stdout.on("data", (c) => {
  stdout += c.toString();
});
p.stderr.on("data", (c) => {
  stderr += c.toString();
});

function send(obj) {
  p.stdin.write(JSON.stringify(obj) + "\n");
}

async function request(method, context, params, timeoutMs = 60_000) {
  const id = randomUUID();
  send({ protocolVersion: 1, id, method, context, params });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(50);
    const hit = parseLines(stdout).find((m) => m.id === id);
    if (hit) return hit;
  }
  throw new Error(`timeout ${method}`);
}

try {
  // Compacted zip bootstrap may take minutes on first extract
  const readyDeadline = Date.now() + 180_000;
  let ready = null;
  while (Date.now() < readyDeadline) {
    ready = parseLines(stdout).find((m) => m.event === "host.ready");
    if (ready) break;
    await sleep(250);
  }
  if (!ready) die(`no host.ready. stderr=${stderr.slice(-800)}`);

  // Harness must never write the success marker
  if (existsSync(markerPath)) {
    die("marker already exists before Host graph load — harness forgery");
  }

  const hello = await request(
    "system.hello",
    {},
    { clientName: "m0-verify", clientVersion: "0", protocolVersion: 1 },
  );
  if (!hello.ok) die("hello failed");
  if (hello.result?.sdkVersion !== "0.80.7") die(`sdk ${hello.result?.sdkVersion}`);
  const hostId = hello.hostInstanceId;

  // workspace with project extension (trust required)
  let set = await request(
    "workspace.setCurrent",
    {
      expectedHostInstanceId: hostId,
      expectedWorkspaceId: null,
      expectedWorkspaceRevision: 0,
    },
    { cwd: projectDir },
    90_000,
  );
  if (!set.ok) die(`setCurrent failed: ${JSON.stringify(set.error)}`);

  let ws = set.result?.workspace;
  if (ws?.trust?.decision === "pending") {
    // Still no marker until services create AgentSession
    if (existsSync(markerPath)) {
      die("marker written while trust still pending — unexpected");
    }
    const trust = await request(
      "workspace.setTrust",
      {
        expectedHostInstanceId: hostId,
        expectedWorkspaceId: ws.id,
        expectedWorkspaceRevision: ws.revision,
      },
      { decision: "trustOnce" },
      90_000,
    );
    if (!trust.ok) die(`setTrust failed: ${JSON.stringify(trust.error)}`);
    ws = trust.result?.workspace;
    set = trust;
  }

  if (!ws?.servicesReady) die(`services not ready: ${JSON.stringify(ws)}`);

  // Graph factory creates a real AgentSession on trust/servicesReady — session_start fires there.
  // Optionally open another session to re-fire if needed.
  let markDeadline = Date.now() + 15_000;
  while (Date.now() < markDeadline && !existsSync(markerPath)) {
    await sleep(100);
  }

  if (!existsSync(markerPath)) {
    const created = await request(
      "session.create",
      {
        expectedHostInstanceId: hostId,
        expectedWorkspaceId: ws.id,
        expectedWorkspaceRevision: ws.revision,
        expectedSessionId: set.sessionId ?? null,
        expectedSessionRevision: set.sessionRevision ?? 0,
      },
      {},
      90_000,
    );
    if (!created.ok) die(`session.create failed: ${JSON.stringify(created.error)}`);
    markDeadline = Date.now() + 15_000;
    while (Date.now() < markDeadline && !existsSync(markerPath)) {
      await sleep(100);
    }
  }

  if (!existsSync(markerPath)) {
    die(
      `Extension handler did not write marker. stderr=${stderr.slice(-1200)} stdout_tail=${stdout.slice(-400)}`,
    );
  }
  const marker = readFileSync(markerPath, "utf8");
  if (!marker.includes(`nonce=${nonce}`)) die("marker nonce mismatch");
  if (!marker.includes("sdk=0.80.7")) die("marker sdk mismatch");
  if (!marker.includes("handler=session_start")) die("marker missing handler=session_start");
  if (!marker.includes("source=")) die("marker missing source path");

  const shutdown = await request(
    "system.shutdown",
    { expectedHostInstanceId: hostId },
    null,
    10_000,
  );
  if (!shutdown.ok) die(`Host shutdown failed: ${shutdown.error?.message ?? "unknown"}`);
  const hostExitCode = await waitForExit(p, 15_000);
  if (hostExitCode !== 0) die(`Host exited with code ${hostExitCode}`);

  const releaseManifestPath = join(
    root,
    "apps/desktop/src-tauri/target/release-staging/PACKAGE_RELEASE.json",
  );
  if (!existsSync(releaseManifestPath)) {
    die("release manifest missing; run package:release before the M0 production-path gate");
  }
  const releaseManifest = JSON.parse(readFileSync(releaseManifestPath, "utf8"));
  if (
    releaseManifest.status !== "ok" ||
    releaseManifest.exitCode !== 0 ||
    !releaseManifest.desktopExecutable ||
    !existsSync(releaseManifest.desktopExecutable) ||
    typeof releaseManifest.desktopExecutableSha256 !== "string"
  ) {
    die("release manifest does not contain a valid hash-bound desktop candidate");
  }
  const productionE2e = spawnSync(
    process.execPath,
    [join(root, "scripts", "run-e2e.mjs")],
    {
      cwd: root,
      shell: false,
      encoding: "utf8",
      timeout: 900_000,
      env: {
        ...process.env,
        PI_DESKTOP_E2E_MODE: "m0",
        PI_DESKTOP_E2E_EXE: releaseManifest.desktopExecutable,
        PI_DESKTOP_E2E_EXPECTED_SHA256: releaseManifest.desktopExecutableSha256,
      },
    },
  );
  if (productionE2e.status !== 0 || productionE2e.error) {
    die(
      `Tauri production-path Extension proof failed: ${productionE2e.error?.message ?? productionE2e.stderr?.slice(-2000) ?? `exit ${productionE2e.status}`}`,
    );
  }
  const e2eResultPath = join(root, "artifacts", "p0", "e2e-latest", "e2e-results.json");
  const e2eResult = JSON.parse(readFileSync(e2eResultPath, "utf8"));
  const extensionStep = e2eResult.steps?.find(
    (step) => step.step === "extension-ui.release-path",
  );
  if (
    e2eResult.ok !== true ||
    e2eResult.workflowMode !== "m0" ||
    e2eResult.desktopExitCode !== 0 ||
    e2eResult.cleanupAudit?.clear !== true ||
    extensionStep?.invocationCount !== 1 ||
    typeof extensionStep?.nonce !== "string"
  ) {
    die("Tauri production-path Extension result is incomplete");
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        gate: "verify:m0-release-extension",
        sdk: "0.80.7",
        controlledNode: nodeExe,
        hostEntry,
        nonce,
        markerPath,
        markerPreview: marker.trim().split("\n"),
        runtime,
        staging,
        directHostExitCode: hostExitCode,
        productionPath: {
          executable: releaseManifest.desktopExecutable,
          executableSha256: releaseManifest.desktopExecutableSha256,
          e2eResultPath,
          extensionStep,
          cleanupAudit: e2eResult.cleanupAudit,
        },
      },
      null,
      2,
    ),
  );
  console.log("[verify:m0] SUCCESS");
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.exit(0);
} catch (err) {
  try {
    p.kill();
  } catch {
    /* ignore */
  }
  die(err instanceof Error ? err.message : String(err));
}
