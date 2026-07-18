import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tauriDir = join(root, "apps", "desktop", "src-tauri");
const desktopExe = join(tauriDir, "target", "debug", "pi-desktop.exe");
const devUrl = "http://localhost:1420/";
const hostSrc = join(root, "packages", "pi-host", "src");
const hostDist = join(root, "packages", "pi-host", "dist");
const hostEntry = join(hostDist, "main.js");
const protocolSrc = join(root, "packages", "protocol", "src");
const protocolDist = join(root, "packages", "protocol", "dist");
const protocolEntry = join(protocolDist, "index.js");
const protocolPackage = join(root, "packages", "protocol", "package.json");
const tauriHostResources = join(tauriDir, "resources", "pi-host");
const debugHostResources = join(tauriDir, "target", "debug", "resources", "pi-host");

let vite = null;
let desktop = null;
let ownsVite = false;
let stopping = false;
let viteStartError = null;

function spawnPnpm(args) {
  const npmExecPath = process.env.npm_execpath;
  const options = {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
  };

  if (npmExecPath && /\.(?:c?js|mjs)$/i.test(npmExecPath)) {
    return spawn(process.execPath, [npmExecPath, ...args], options);
  }

  return spawn(process.platform === "win32" ? "pnpm.cmd" : "pnpm", args, options);
}

function runPnpmSync(args) {
  const npmExecPath = process.env.npm_execpath;
  const command =
    npmExecPath && /\.(?:c?js|mjs)$/i.test(npmExecPath)
      ? { executable: process.execPath, args: [npmExecPath, ...args] }
      : { executable: process.platform === "win32" ? "pnpm.cmd" : "pnpm", args };
  return spawnSync(command.executable, command.args, {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
  });
}

function latestMtimeMs(directory, accept) {
  if (!existsSync(directory)) return 0;
  let latest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      latest = Math.max(latest, latestMtimeMs(path, accept));
    } else if (accept(path)) {
      latest = Math.max(latest, statSync(path).mtimeMs);
    }
  }
  return latest;
}

function ensurePackageBuild({ label, packageName, sourceDirectory, entry, dependencyMtime = 0 }) {
  const sourceMtime = Math.max(
    latestMtimeMs(sourceDirectory, (path) => path.endsWith(".ts")),
    dependencyMtime,
  );
  const builtMtime = existsSync(entry) ? statSync(entry).mtimeMs : 0;
  if (builtMtime >= sourceMtime) return builtMtime;

  console.log(`[dev:fast] Building changed ${label} sources...`);
  const result = runPnpmSync(["--filter", packageName, "run", "build"]);
  if (result.status !== 0) {
    throw new Error(`${label} build failed (code ${result.status ?? "unknown"})`);
  }
  return statSync(entry).mtimeMs;
}

function copyDirectoryContents(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const name of readdirSync(source)) {
    cpSync(join(source, name), join(destination, name), {
      recursive: true,
      force: true,
    });
  }
}

function syncHostResources(destination) {
  if (!existsSync(destination)) return;

  for (const entry of readdirSync(hostDist, { withFileTypes: true })) {
    const name = entry.name;
    if (name.includes(".test.") || name.endsWith(".d.ts") || name.endsWith(".d.ts.map")) {
      continue;
    }
    if (entry.isDirectory() && (name === "spike" || name === "test-helpers")) continue;
    if (!entry.isDirectory() && !name.endsWith(".js") && !name.endsWith(".js.map")) continue;

    const targetName = name === "main.js" ? "host-main.js" : name;
    cpSync(join(hostDist, name), join(destination, targetName), {
      recursive: entry.isDirectory(),
      force: true,
    });
  }

  for (const protocolRoot of [
    join(destination, "vendor", "protocol"),
    join(destination, "node_modules", "@pi-desktop", "protocol"),
  ]) {
    copyDirectoryContents(protocolDist, join(protocolRoot, "dist"));
    cpSync(protocolPackage, join(protocolRoot, "package.json"), { force: true });
  }
}

function prepareDevHostResources() {
  const protocolMtime = ensurePackageBuild({
    label: "protocol",
    packageName: "@pi-desktop/protocol",
    sourceDirectory: protocolSrc,
    entry: protocolEntry,
  });
  ensurePackageBuild({
    label: "Pi Host",
    packageName: "@pi-desktop/pi-host",
    sourceDirectory: hostSrc,
    entry: hostEntry,
    dependencyMtime: protocolMtime,
  });
  syncHostResources(tauriHostResources);
  syncHostResources(debugHostResources);
  console.log("[dev:fast] Pi Host resources are up to date");
}

async function isDesktopViteReady() {
  try {
    const response = await fetch(devUrl);
    if (!response.ok) return false;
    return (await response.text()).includes("<title>Pi Desktop Manager</title>");
  } catch {
    return false;
  }
}

async function waitForVite(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isDesktopViteReady()) return;
    if (viteStartError) throw viteStartError;
    if (vite?.exitCode !== null) {
      throw new Error(`Vite exited before becoming ready (code ${vite?.exitCode})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${devUrl}`);
}

function stopTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 15_000,
    });
  } else {
    child.kill("SIGTERM");
  }
}

function cleanup() {
  if (stopping) return;
  stopping = true;
  stopTree(desktop);
  if (ownsVite) stopTree(vite);
}

async function main() {
  if (process.platform !== "win32") {
    throw new Error("dev:fast currently supports Windows only");
  }
  if (!existsSync(desktopExe)) {
    throw new Error(
      `Debug executable not found: ${desktopExe}\nRun "pnpm --filter @pi-desktop/desktop run tauri:dev" once to compile it.`,
    );
  }

  prepareDevHostResources();

  if (await isDesktopViteReady()) {
    console.log(`[dev:fast] Reusing Vite at ${devUrl}`);
  } else {
    console.log("[dev:fast] Starting Vite...");
    ownsVite = true;
    vite = spawnPnpm(["--filter", "@pi-desktop/desktop", "run", "dev"]);
    vite.once("error", (error) => {
      viteStartError = error;
    });
    await waitForVite();
  }

  console.log(`[dev:fast] Launching ${desktopExe}`);
  desktop = spawn(desktopExe, [], {
    cwd: tauriDir,
    stdio: "inherit",
    windowsHide: false,
    env: process.env,
  });

  const exitCode = await new Promise((resolve, reject) => {
    desktop.once("error", reject);
    desktop.once("exit", (code, signal) => {
      resolve(code ?? (signal ? 1 : 0));
    });
    if (ownsVite) {
      vite.once("exit", (code) => {
        if (!stopping && desktop?.exitCode === null) {
          stopTree(desktop);
          reject(new Error(`Vite exited while the desktop app was running (code ${code})`));
        }
      });
    }
  });
  process.exitCode = exitCode;
}

process.once("SIGINT", () => {
  cleanup();
  process.exit(130);
});
process.once("SIGTERM", () => {
  cleanup();
  process.exit(143);
});
process.once("exit", cleanup);

try {
  await main();
} catch (error) {
  console.error(`[dev:fast] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (ownsVite) stopTree(vite);
}
