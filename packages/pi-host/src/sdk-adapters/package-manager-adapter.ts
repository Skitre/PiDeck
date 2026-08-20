import { DefaultPackageManager, VERSION } from "@earendil-works/pi-coding-agent";
import { getInternalRuntime } from "../internal-runtime.js";
import { spawnProcess, spawnProcessSync } from "./spawn-process.js";
import { waitForChildProcess } from "./wait-for-child-process.js";

const SUPPORTED_SDK_VERSIONS = new Set(["0.84.2"]);
const REQUIRED_METHODS = [
  "spawnCommand",
  "spawnCaptureCommand",
  "runCommand",
  "runCommandCapture",
  "runCommandSync",
  "update",
] as const;

type UpdateTarget = { source: string; scope: "user" | "project" };

type PackageManagerInternals = {
  env?: NodeJS.ProcessEnv;
  settingsManager: {
    getGlobalSettings: () => { packages?: unknown[] };
    getProjectSettings: () => { packages?: unknown[] };
  };
  getPackageIdentity: (source: string, scope?: "user" | "project") => string;
  updateConfiguredSources: (sources: UpdateTarget[]) => Promise<void>;
  buildNoMatchingPackageMessage: (source: string, packages: unknown[]) => string;
};

type SpawnCommandOptions = { cwd?: string };
type SpawnCaptureOptions = { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number };

type PackageManagerPrototype = PackageManagerInternals & {
  setOperationSignal: (signal: AbortSignal | undefined) => void;
  spawnCommand: (
    command: string,
    args: string[],
    options?: SpawnCommandOptions,
  ) => ReturnType<typeof spawnProcess>;
  spawnCaptureCommand: (
    command: string,
    args: string[],
    options?: SpawnCaptureOptions,
  ) => ReturnType<typeof spawnProcess>;
  runCommand: (command: string, args: string[], options?: SpawnCommandOptions) => Promise<void>;
  runCommandCapture: (
    command: string,
    args: string[],
    options?: SpawnCaptureOptions,
  ) => Promise<string>;
  runCommandSync: (command: string, args: string[]) => string;
  update: (source?: string, options?: { local?: boolean }) => Promise<void>;
};

const operationSignals = new WeakMap<object, AbortSignal | undefined>();
let installed = false;

function assertSdkSurface(): void {
  if (!SUPPORTED_SDK_VERSIONS.has(VERSION)) {
    throw new Error(`PiDeck package-manager adapter refuses SDK ${VERSION}`);
  }
  const proto = DefaultPackageManager.prototype as unknown as Record<string, unknown>;
  for (const name of REQUIRED_METHODS) {
    if (typeof proto[name] !== "function") {
      throw new Error(`PiDeck package-manager adapter missing ${name} on DefaultPackageManager`);
    }
  }
}

function childEnv(manager: PackageManagerInternals, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const base = manager.env ?? getInternalRuntime().env;
  return extra ? { ...base, ...extra } : base;
}

function operationSignal(manager: object): AbortSignal | undefined {
  return operationSignals.get(manager);
}

function packageSourceString(pkg: unknown): string {
  return typeof pkg === "string" ? pkg : String((pkg as { source?: unknown }).source ?? "");
}

export function installPackageManagerAdapter(): void {
  if (installed) return;
  assertSdkSurface();

  const proto = DefaultPackageManager.prototype as unknown as PackageManagerPrototype;

  proto.setOperationSignal = function setOperationSignal(signal: AbortSignal | undefined) {
    operationSignals.set(this, signal);
  };

  proto.spawnCommand = function spawnCommand(
    command: string,
    args: string[],
    options?: SpawnCommandOptions,
  ) {
    return spawnProcess(command, args, {
      cwd: options?.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv(this),
      signal: operationSignal(this),
    });
  };

  proto.spawnCaptureCommand = function spawnCaptureCommand(
    command: string,
    args: string[],
    options?: SpawnCaptureOptions,
  ) {
    return spawnProcess(command, args, {
      cwd: options?.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv(this, options?.env),
      signal: operationSignal(this),
    });
  };

  proto.runCommandCapture = async function runCommandCapture(
    command: string,
    args: string[],
    options?: SpawnCaptureOptions,
  ) {
    const child = this.spawnCaptureCommand(command, args, options);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout =
      typeof options?.timeoutMs === "number"
        ? setTimeout(() => {
            timedOut = true;
            child.kill();
          }, options.timeoutMs)
        : undefined;
    child.stdout?.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });
    let code: number | null;
    try {
      code = await waitForChildProcess(child);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    if (timedOut) {
      throw new Error(`${command} ${args.join(" ")} timed out after ${options?.timeoutMs}ms`);
    }
    if (code === 0) return stdout.trim();
    const exitStatus = code === null ? `signal ${child.signalCode ?? "unknown"}` : `code ${code}`;
    throw new Error(`${command} ${args.join(" ")} failed with ${exitStatus}: ${stderr || stdout}`);
  };

  proto.runCommand = async function runCommand(
    command: string,
    args: string[],
    options?: SpawnCommandOptions,
  ) {
    const child = this.spawnCommand(command, args, options);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (data) => {
      stdout = `${stdout}${data.toString()}`.slice(-65536);
    });
    child.stderr?.on("data", (data) => {
      stderr = `${stderr}${data.toString()}`.slice(-65536);
    });
    const code = await waitForChildProcess(child);
    if (code === 0) return;
    const exitStatus = code === null ? `signal ${child.signalCode ?? "unknown"}` : `code ${code}`;
    const output = (stderr || stdout).trim();
    throw new Error(
      `${command} ${args.join(" ")} failed with ${exitStatus}${output ? `: ${output}` : ""}`,
    );
  };

  proto.runCommandSync = function runCommandSync(command: string, args: string[]) {
    operationSignal(this)?.throwIfAborted();
    const result = spawnProcessSync(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      env: childEnv(this),
    });
    if (result.error || result.status !== 0) {
      throw new Error(
        `Failed to run ${command} ${args.join(" ")}: ${result.error?.message || result.stderr || result.stdout}`,
      );
    }
    return String(result.stdout || result.stderr || "").trim();
  };

  proto.update = async function update(source?: string, options?: { local?: boolean }) {
    const globalSettings = this.settingsManager.getGlobalSettings();
    const projectSettings = this.settingsManager.getProjectSettings();
    const identity = source ? this.getPackageIdentity(source) : undefined;
    const requestedScope = source && options ? (options.local ? "project" : "user") : undefined;
    let matched = false;
    const updateSources: UpdateTarget[] = [];
    for (const pkg of globalSettings.packages ?? []) {
      if (requestedScope === "project") continue;
      const sourceStr = packageSourceString(pkg);
      if (identity && this.getPackageIdentity(sourceStr, "user") !== identity) continue;
      matched = true;
      updateSources.push({ source: sourceStr, scope: "user" });
    }
    for (const pkg of projectSettings.packages ?? []) {
      if (requestedScope === "user") continue;
      const sourceStr = packageSourceString(pkg);
      if (identity && this.getPackageIdentity(sourceStr, "project") !== identity) continue;
      matched = true;
      updateSources.push({ source: sourceStr, scope: "project" });
    }
    if (source && !matched) {
      throw new Error(
        this.buildNoMatchingPackageMessage(source, [
          ...(globalSettings.packages ?? []),
          ...(projectSettings.packages ?? []),
        ]),
      );
    }
    await this.updateConfiguredSources(updateSources);
  };

  installed = true;
}
