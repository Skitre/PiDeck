import { readFileSync } from "node:fs";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  DefaultPackageManager,
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  createInternalRuntime,
  resetInternalRuntimeForTests,
  setInternalRuntimeForTests,
} from "./internal-runtime.js";

let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
  resetInternalRuntimeForTests();
  delete process.env.PI_OFFLINE;
});

function writeShim(dir: string, name: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  if (process.platform === "win32") {
    writeFileSync(
      join(dir, `${name}.cmd`),
      `@echo off\r\n"${process.execPath}" -e ${JSON.stringify(body)} -- %*\r\n`,
    );
    return;
  }
  const file = join(dir, name);
  writeFileSync(file, `#!${process.execPath}\n${body}\n`);
  chmodSync(file, 0o755);
}

function createIsolatedRuntime(dumpFile: string) {
  root = mkdtempSync(join(tmpdir(), "pideck-internal-env-"));
  const bin = join(root, "bundled-bin");
  const dumpScript = `require("node:fs").writeFileSync(${JSON.stringify(dumpFile)}, JSON.stringify(process.env)); process.exit(0);`;
  writeShim(bin, "npm", dumpScript);
  writeShim(bin, "git", dumpScript);
  const userPath = join(root, "user-path-without-tools");
  mkdirSync(userPath, { recursive: true });
  const runtime = createInternalRuntime({
    nodeExecutable: process.execPath,
    gitExecutable: join(bin, process.platform === "win32" ? "git.cmd" : "git"),
    sourceEnv: {
      ...process.env,
      PATH: userPath,
      HTTP_PROXY: "http://internal-proxy.test:8080",
      SSL_CERT_FILE: join(root, "cert.pem"),
    },
  });
  runtime.env.PATH = [bin, runtime.env.PATH].join(delimiter);
  setInternalRuntimeForTests(runtime);
  return {
    cwd: join(root, "workspace"),
    agentDir: join(root, "agent"),
    env: runtime.env,
    userPath,
  };
}

type SpawnInternals = {
  runCommand: (command: string, args: string[], options?: { cwd?: string }) => Promise<void>;
  runCommandCapture: (
    command: string,
    args: string[],
    options?: { cwd?: string },
  ) => Promise<string>;
  runCommandSync: (command: string, args: string[]) => string;
};

describe("SDK package manager internal env", () => {
  it("uses internal env for async, capture, and sync spawn paths", async () => {
    const dumpFile = join(tmpdir(), `pideck-pm-env-${process.pid}-${Date.now()}.json`);
    const { cwd, agentDir, env, userPath } = createIsolatedRuntime(dumpFile);
    mkdirSync(cwd, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
    const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
    const internals = manager as unknown as SpawnInternals;

    await internals.runCommand("npm", ["install", "demo"]);
    const asyncEnv = JSON.parse(readFileSync(dumpFile, "utf8")) as NodeJS.ProcessEnv;
    expect(asyncEnv.HTTP_PROXY).toBe("http://internal-proxy.test:8080");
    expect(asyncEnv.PATH).not.toContain(userPath);
    expect(asyncEnv.PIDECK_BUNDLED_GIT).toBeUndefined();

    await internals.runCommandCapture("git", ["clone", "repo", "dest"]);
    const captureEnv = JSON.parse(readFileSync(dumpFile, "utf8")) as NodeJS.ProcessEnv;
    expect(captureEnv.SSL_CERT_FILE).toBe(env.SSL_CERT_FILE);
    expect(captureEnv.PATH).toBe(env.PATH);

    internals.runCommandSync("npm", ["root", "-g"]);
    const syncEnv = JSON.parse(readFileSync(dumpFile, "utf8")) as NodeJS.ProcessEnv;
    expect(syncEnv.PATH).toBe(env.PATH);
    expect(syncEnv.HTTP_PROXY).toBe("http://internal-proxy.test:8080");
  });

  it("threads internal env through ResourceLoader's private package manager", async () => {
    const dumpFile = join(tmpdir(), `pideck-rl-env-${process.pid}-${Date.now()}.json`);
    const { cwd, agentDir, env, userPath } = createIsolatedRuntime(dumpFile);
    mkdirSync(cwd, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: true }),
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    const packageManager = (loader as unknown as { packageManager: SpawnInternals }).packageManager;
    packageManager.runCommandSync("npm", ["list", "-g"]);
    const dumped = JSON.parse(readFileSync(dumpFile, "utf8")) as NodeJS.ProcessEnv;
    expect(dumped.PATH).toBe(env.PATH);
    expect(dumped.PATH).not.toContain(userPath);
    expect(dumped.HTTP_PROXY).toBe("http://internal-proxy.test:8080");
  });
});
