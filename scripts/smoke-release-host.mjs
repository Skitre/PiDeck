/**
 * Smoke-test the *staged* release host with controlled Node.
 * Must succeed for M6 release packaging DoD.
 *
 *   node scripts/smoke-release-host.mjs
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nodeExe = join(
  root,
  "apps/desktop/src-tauri/resources/node",
  process.platform === "win32" ? "node.exe" : "node",
);
const hostEntry = join(root, "apps/desktop/src-tauri/resources/pi-host/main.js");
const stagingPath = join(root, "apps/desktop/src-tauri/resources/pi-host/STAGING.json");

function die(msg) {
  console.error("[release-smoke] FAIL:", msg);
  process.exit(1);
}

if (!existsSync(nodeExe)) die(`controlled Node missing: ${nodeExe}`);
if (!existsSync(hostEntry)) die(`host entry missing: ${hostEntry}`);
if (!existsSync(join(dirname(hostEntry), "model-health.js"))) {
  die("model-health.js not beside main.js — packaging layout broken");
}
const hostDir = dirname(hostEntry);
const expandedSdk = join(
  hostDir,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
);
const zipPath = join(hostDir, "node_modules.zip");
const hostMain = join(hostDir, "host-main.js");
const compacted =
  existsSync(zipPath) &&
  existsSync(hostMain) &&
  (!existsSync(expandedSdk) ||
    readFileSync(hostEntry, "utf8").includes("node_modules.zip"));
if (!existsSync(expandedSdk) && !compacted) {
  die("SDK node_modules missing in staged host (neither expanded nor compacted zip)");
}
if (compacted) {
  console.log("[release-smoke] layout=compacted-zip bootstrap will extract node_modules.zip");
}

const agentDir = mkdtempSync(join(tmpdir(), "release-host-smoke-"));
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(agentDir, "auth.json"), "{}");
writeFileSync(join(agentDir, "models.json"), "{}");
writeFileSync(join(agentDir, "settings.json"), "{}");

console.log("[release-smoke] node=", nodeExe);
console.log("[release-smoke] entry=", hostEntry);
console.log("[release-smoke] agentDir=", agentDir);

const helloRequestId = randomUUID();
const shutdownRequestId = randomUUID();

const p = spawn(nodeExe, [hostEntry, `--agent-dir=${agentDir}`], {
  env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
  stdio: ["pipe", "pipe", "pipe"],
  cwd: dirname(hostEntry),
});

let buf = "";
let err = "";
p.stdout.on("data", (c) => {
  buf += c.toString();
});
p.stderr.on("data", (c) => {
  err += c.toString();
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseLines(s) {
  return s
    .trim()
    .split(/\n/)
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// Compacted layout may extract ~200MB node_modules.zip on first start
const extractBudgetMs = compacted ? 180_000 : 5_000;
console.log(`[release-smoke] waiting up to ${extractBudgetMs}ms for host.ready (bootstrap extract)`);
const readyDeadline = Date.now() + extractBudgetMs;
while (Date.now() < readyDeadline) {
  if (parseLines(buf).some((m) => m.event === "host.ready")) break;
  await sleep(500);
}

p.stdin.write(
  JSON.stringify({
    protocolVersion: 1,
    id: helloRequestId,
    method: "system.hello",
    context: {},
    params: { clientName: "release-smoke", clientVersion: "0", protocolVersion: 1 },
  }) + "\n",
);
await sleep(compacted ? 5_000 : 1_500);

const lines = parseLines(buf);
const ready = lines.find((m) => m.event === "host.ready");
const hello = lines.find((m) => m.id === helloRequestId);

const report = {
  READY_FOUND: !!ready,
  HELLO_OK: !!(hello && hello.ok),
  SDK: hello?.result?.sdkVersion || ready?.payload?.sdkVersion || null,
  PHASE: hello?.result?.phase || ready?.payload?.phase || null,
  AGENT_DIR: hello?.result?.agentDir || ready?.payload?.agentDir || null,
  HOST_ID: hello?.hostInstanceId || ready?.hostInstanceId || null,
  controlledNode: nodeExe,
  hostEntry,
  staging: existsSync(stagingPath) ? JSON.parse(readFileSync(stagingPath, "utf8")) : null,
  stderrTail: err.slice(-800),
};

console.log(JSON.stringify(report, null, 2));

const hostId = report.HOST_ID;
if (hostId) {
  p.stdin.write(
    JSON.stringify({
      protocolVersion: 1,
      id: shutdownRequestId,
      method: "system.shutdown",
      context: { expectedHostInstanceId: hostId },
      params: null,
    }) + "\n",
  );
  await sleep(400);
}
try {
  p.kill();
} catch {
  /* ignore */
}

if (!report.HELLO_OK || report.SDK !== "0.80.7") {
  die("hello failed or wrong SDK — staged host is not runnable");
}
if (!report.AGENT_DIR || !String(report.AGENT_DIR).includes("release-host-smoke")) {
  die("agentDir not temp smoke dir — wrong agent path");
}

console.log("[release-smoke] SUCCESS");
process.exit(0);
