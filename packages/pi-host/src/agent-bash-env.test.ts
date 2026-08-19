import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BUNDLED_BASH_ENV, createInternalRuntime } from "./internal-runtime.js";

const shellModuleUrl = pathToFileURL(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../node_modules/@earendil-works/pi-coding-agent/dist/utils/shell.js",
  ),
).href;

let agentDir: string | undefined;
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousPath = process.env.PATH;
const previousBundledBash = process.env[BUNDLED_BASH_ENV];
const previousProgramFiles = process.env.ProgramFiles;
const previousProgramFilesX86 = process.env["ProgramFiles(x86)"];

afterEach(() => {
  if (agentDir) rmSync(agentDir, { recursive: true, force: true });
  agentDir = undefined;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  process.env.PATH = previousPath;
  if (previousBundledBash === undefined) delete process.env[BUNDLED_BASH_ENV];
  else process.env[BUNDLED_BASH_ENV] = previousBundledBash;
  if (previousProgramFiles === undefined) delete process.env.ProgramFiles;
  else process.env.ProgramFiles = previousProgramFiles;
  if (previousProgramFilesX86 === undefined) delete process.env["ProgramFiles(x86)"];
  else process.env["ProgramFiles(x86)"] = previousProgramFilesX86;
});

describe("Agent Bash environment", () => {
  it("inherits the Host user PATH and still prepends SDK agentDir/bin", async () => {
    agentDir = mkdtempSync(join(tmpdir(), "pideck-bash-env-"));
    mkdirSync(join(agentDir, "bin"), { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const marker = join(agentDir, "user-mise-marker");
    process.env.PATH = [marker, previousPath ?? ""].filter(Boolean).join(delimiter);

    const { getShellEnv } = await import(shellModuleUrl);
    const env = getShellEnv() as NodeJS.ProcessEnv;
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
    const pathValue = env[pathKey] ?? "";
    expect(pathValue).toContain(marker);
    expect(pathValue.split(delimiter)[0]).toBe(join(agentDir, "bin"));
    expect(env.PI_SESSION_ID).toBe(process.env.PI_SESSION_ID);
    expect(env.PI_CODING_AGENT_DIR).toBe(agentDir);
  });

  it("does not put bundled Git or npm on the Bash PATH", async () => {
    agentDir = mkdtempSync(join(tmpdir(), "pideck-bash-bundled-"));
    mkdirSync(join(agentDir, "bin"), { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const userMarker = join(agentDir, "user-path-marker");
    process.env.PATH = [userMarker, previousPath ?? ""].filter(Boolean).join(delimiter);

    const bundledGit = join("C:", "pideck-bundled-git-not-on-user-path", "cmd", "git.exe");
    const runtime = createInternalRuntime({
      nodeExecutable: join("C:", "pideck-bundled-node-not-on-user-path", "node.exe"),
      gitExecutable: bundledGit,
      sourceEnv: { ...process.env, PIDECK_BUNDLED_GIT: bundledGit },
    });
    const { getShellEnv } = await import(shellModuleUrl);
    const env = getShellEnv() as NodeJS.ProcessEnv;
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
    expect(env[pathKey]).toContain(userMarker);
    expect(env[pathKey]).not.toContain("pideck-bundled-git-not-on-user-path");
    expect(env[pathKey]).not.toContain("pideck-bundled-node-not-on-user-path");
    expect(runtime.env.PATH).toContain("pideck-bundled-git-not-on-user-path");
    expect(runtime.env.PATH).not.toContain(userMarker);
  });

  it("uses bundled bash.exe as an absolute fallback when no system Git Bash exists", async () => {
    if (process.platform !== "win32") return;
    agentDir = mkdtempSync(join(tmpdir(), "pideck-bash-fallback-"));
    mkdirSync(join(agentDir, "bin"), { recursive: true });
    const bundledBash = join(agentDir, "git", "bin", "bash.exe");
    mkdirSync(dirname(bundledBash), { recursive: true });
    writeFileSync(bundledBash, "");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env[BUNDLED_BASH_ENV] = bundledBash;
    delete process.env.ProgramFiles;
    delete process.env["ProgramFiles(x86)"];
    process.env.PATH = [join(agentDir, "user-mise-marker"), join(agentDir, "no-bash")].join(
      delimiter,
    );

    const { getShellConfig, getShellEnv } = await import(
      `${shellModuleUrl}?fallback=${Date.now()}`
    );
    const config = getShellConfig() as { shell: string; args: string[] };
    expect(config.shell).toBe(bundledBash);
    const env = getShellEnv() as NodeJS.ProcessEnv;
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
    expect(env[pathKey]).toContain(join(agentDir, "user-mise-marker"));
    expect(env[pathKey]).not.toContain(join(agentDir, "git"));
  });

  it("still honors an explicit user shellPath over bundled bash", async () => {
    agentDir = mkdtempSync(join(tmpdir(), "pideck-bash-user-shell-"));
    const bundledBash = join(agentDir, "bundled-bash.exe");
    const userShell = join(agentDir, "user-bash.exe");
    writeFileSync(bundledBash, "");
    writeFileSync(userShell, "");
    process.env[BUNDLED_BASH_ENV] = bundledBash;
    const { getShellConfig } = await import(`${shellModuleUrl}?user-shell=${Date.now()}`);
    const config = getShellConfig(userShell) as { shell: string };
    expect(config.shell).toBe(userShell);
  });

  it("can start bundled bash without Git on PATH when the real binary is present", async () => {
    const stagedBash = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../apps/desktop/src-tauri/resources/git/bin/bash.exe",
    );
    if (process.platform !== "win32" || !existsSync(stagedBash)) return;
    agentDir = mkdtempSync(join(tmpdir(), "pideck-bash-spawn-"));
    mkdirSync(join(agentDir, "bin"), { recursive: true });
    const marker = join(agentDir, "user-mise-marker");
    mkdirSync(marker, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env[BUNDLED_BASH_ENV] = stagedBash;
    delete process.env.ProgramFiles;
    delete process.env["ProgramFiles(x86)"];
    process.env.PATH = [marker, join(agentDir, "no-bash")].join(delimiter);

    const { getShellConfig, getShellEnv } = await import(`${shellModuleUrl}?spawn=${Date.now()}`);
    const config = getShellConfig() as {
      shell: string;
      args: string[];
      commandTransport?: string;
    };
    expect(config.shell).toBe(stagedBash);
    const result = spawnSync(
      config.shell,
      config.commandTransport === "stdin"
        ? config.args
        : [...config.args, "printf '%s' PIDECK_BUNDLED_BASH_OK"],
      {
        encoding: "utf8",
        env: getShellEnv() as NodeJS.ProcessEnv,
        timeout: 15_000,
        windowsHide: true,
        input:
          config.commandTransport === "stdin" ? "printf '%s' PIDECK_BUNDLED_BASH_OK" : undefined,
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PIDECK_BUNDLED_BASH_OK");
  });
});
