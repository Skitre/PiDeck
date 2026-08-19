import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

export const BUNDLED_GIT_ENV = "PIDECK_BUNDLED_GIT";
export const BUNDLED_BASH_ENV = "PIDECK_BUNDLED_BASH";

/**
 * Host process.env stays the inherited desktop environment, including the
 * user's PATH. This object is only passed to internal Git/npm/Node children.
 * `bashExecutable` is the Agent Bash fallback descriptor, not an internal PATH entry.
 */
export type InternalRuntime = {
  nodeExecutable: string;
  gitExecutable?: string;
  bashExecutable?: string;
  env: NodeJS.ProcessEnv;
};

export type CreateInternalRuntimeOptions = {
  nodeExecutable?: string;
  gitExecutable?: string | null;
  bashExecutable?: string | null;
  sourceEnv?: NodeJS.ProcessEnv;
};

function pathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
}

function readPath(env: NodeJS.ProcessEnv): string {
  return env[pathKey(env)] ?? "";
}

function copyUserEnvWithoutRuntimePath(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (upper === "PATH" || upper === BUNDLED_GIT_ENV || upper === BUNDLED_BASH_ENV) continue;
    env[key] = value;
  }
  return env;
}

function systemPathEntries(source: NodeJS.ProcessEnv): string[] {
  if (process.platform === "win32") {
    const systemRoot = source.SystemRoot ?? source.SYSTEMROOT ?? "C:\\Windows";
    return [join(systemRoot, "System32")];
  }
  return ["/usr/bin", "/bin"].filter((dir) => existsSync(dir));
}

function gitRuntimeDirectories(gitExecutable: string): string[] {
  const containingDir = dirname(gitExecutable);
  const dirs = [containingDir];
  const parent = dirname(containingDir);
  const dirName = containingDir.split(/[\\/]/).pop()?.toLowerCase();
  if (dirName === "cmd") {
    dirs.push(join(parent, "bin"));
    dirs.push(join(parent, "mingw64", "bin"));
  }
  return dirs;
}

function findGitOnPath(source: NodeJS.ProcessEnv): string | undefined {
  const executable = process.platform === "win32" ? "git.exe" : "git";
  for (const dir of readPath(source).split(delimiter).filter(Boolean)) {
    const candidate = join(dir, executable);
    if (existsSync(candidate)) return candidate;
  }
  try {
    const result =
      process.platform === "win32"
        ? spawnSync("where", ["git.exe"], {
            encoding: "utf-8",
            env: source,
            timeout: 5_000,
            windowsHide: true,
          })
        : spawnSync("which", ["git"], {
            encoding: "utf-8",
            env: source,
            timeout: 5_000,
          });
    const first = result.stdout?.trim().split(/\r?\n/)[0];
    if (first && existsSync(first)) return first;
  } catch {
    /* ignore lookup failures */
  }
  return undefined;
}

function resolveGitExecutable(
  source: NodeJS.ProcessEnv,
  explicit?: string | null,
): string | undefined {
  if (explicit === null) return undefined;
  if (typeof explicit === "string") return explicit;
  const bundled = source[BUNDLED_GIT_ENV];
  if (bundled) return bundled;
  return findGitOnPath(source);
}

export function bundledBashFromGit(gitExecutable: string): string | undefined {
  const containingDir = dirname(gitExecutable);
  if (containingDir.split(/[\\/]/).pop()?.toLowerCase() !== "cmd") return undefined;
  return join(dirname(containingDir), "bin", "bash.exe");
}

export function resolveBundledBashExecutable(
  source: NodeJS.ProcessEnv = process.env,
  gitExecutable?: string,
): string | undefined {
  const bundled = source[BUNDLED_BASH_ENV];
  if (bundled) return bundled;
  const git = gitExecutable ?? source[BUNDLED_GIT_ENV];
  return git ? bundledBashFromGit(git) : undefined;
}

function resolveBashExecutable(
  source: NodeJS.ProcessEnv,
  explicit: string | null | undefined,
  gitExecutable?: string,
): string | undefined {
  if (explicit === null) return undefined;
  if (typeof explicit === "string") return explicit;
  return resolveBundledBashExecutable(source, gitExecutable);
}

function uniquePathEntries(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    if (!path) continue;
    const key = process.platform === "win32" ? path.toLowerCase() : path;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(path);
  }
  return result;
}

export function createInternalRuntime(options: CreateInternalRuntimeOptions = {}): InternalRuntime {
  const source = options.sourceEnv ?? process.env;
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const gitExecutable = resolveGitExecutable(source, options.gitExecutable);
  const bashExecutable = resolveBashExecutable(source, options.bashExecutable, gitExecutable);
  const env = copyUserEnvWithoutRuntimePath(source);
  env.PATH = uniquePathEntries([
    dirname(nodeExecutable),
    ...(gitExecutable ? gitRuntimeDirectories(gitExecutable) : []),
    ...systemPathEntries(source),
  ]).join(delimiter);
  return {
    nodeExecutable,
    ...(gitExecutable ? { gitExecutable } : {}),
    ...(bashExecutable ? { bashExecutable } : {}),
    env,
  };
}

let cached: InternalRuntime | undefined;

export function getInternalRuntime(): InternalRuntime {
  return (cached ??= createInternalRuntime());
}

export function resetInternalRuntimeForTests(): void {
  cached = undefined;
}
