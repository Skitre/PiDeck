/**
 * Host hello smoke — run from repo root:
 *   pnpm --filter @pideck/pi-host exec node ../../scripts/smoke-host-hello.mjs
 * or: node --import tsx/esm after ensuring tsx resolves from packages/pi-host
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = mkdtempSync(join(tmpdir(), "host-hello-"));
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(agentDir, "auth.json"), "{}");
writeFileSync(join(agentDir, "models.json"), "{}");
writeFileSync(join(agentDir, "settings.json"), "{}");

const entry = join(root, "packages/pi-host/dist/main.js");
const useTs = !existsSyncSafe(entry);
const args = useTs
  ? ["--import", "tsx", join(root, "packages/pi-host/src/main.ts"), `--agent-dir=${agentDir}`]
  : [entry, `--agent-dir=${agentDir}`];

const helloRequestId = randomUUID();
const shutdownRequestId = randomUUID();

const p = spawn(process.execPath, args, {
  env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
  stdio: ["pipe", "pipe", "pipe"],
  cwd: join(root, "packages/pi-host"),
});

let buf = "";
p.stdout.on("data", (c) => {
  buf += c;
});
p.stderr.on("data", () => {});

await sleep(useTs ? 2000 : 800);
p.stdin.write(
  JSON.stringify({
    protocolVersion: 1,
    id: helloRequestId,
    method: "system.hello",
    context: {},
    params: { clientName: "smoke", clientVersion: "0", protocolVersion: 1 },
  }) + "\n",
);
await sleep(1500);

const lines = buf
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

const ready = lines.find((m) => m.event === "host.ready");
const hello = lines.find((m) => m.id === helloRequestId);
const sdk = hello?.result?.sdkVersion || ready?.payload?.sdkVersion;
const hostId = hello?.hostInstanceId || ready?.hostInstanceId;

console.log(JSON.stringify({ READY_FOUND: !!ready, HELLO_OK: hello?.ok, SDK: sdk, HOST_ID: hostId, PHASE: hello?.result?.phase || ready?.payload?.phase }, null, 2));

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
  await sleep(500);
}
p.kill();

if (!hello?.ok || sdk !== "0.80.7") process.exit(1);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function existsSyncSafe(p) {
  try {
    return require("node:fs").existsSync(p);
  } catch {
    return false;
  }
}
