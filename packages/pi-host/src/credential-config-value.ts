/**
 * Config-value resolution for stored credentials.
 *
 * Why this exists: pi-ai resolves request auth by handing whatever
 * `CredentialStore.read()` returns straight to the provider —
 * `resolveProviderAuth()` uses `credential.key` verbatim and never expands
 * templates. Upstream's coding-agent `AuthStorage.read()` compensates by
 * calling its internal `resolveConfigValue()`, which is not part of the public
 * SDK surface. Any app-owned store must therefore reproduce that resolution or
 * users whose `auth.json` holds `"!op read ..."` / `"$ANTHROPIC_API_KEY"` will
 * send the literal template as their API key.
 *
 * Supported forms, matching upstream:
 * - `!<command>`  execute in a shell, use trimmed stdout, cached per process
 * - `$NAME` / `${NAME}`  substitute from credential env, then process env
 * - `$$` escapes a literal `$`; `$!` escapes a literal `!`
 * - anything else is a literal
 *
 * A template whose environment variable is unset resolves to `undefined`, so
 * callers can tell "not configured" from "configured but empty".
 */
import { execSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { ProviderEnv } from "@earendil-works/pi-ai";

const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VAR_NAME_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*/;
const COMMAND_TIMEOUT_MS = 10_000;

/** Command results persist for the process lifetime, as upstream does. */
const commandCache = new Map<string, string | undefined>();

type TemplatePart = { type: "literal"; value: string } | { type: "env"; name: string };

type ConfigReference =
  { type: "command"; config: string } | { type: "template"; parts: TemplatePart[] };

function appendLiteral(parts: TemplatePart[], value: string): void {
  if (!value) return;
  const previous = parts[parts.length - 1];
  if (previous?.type === "literal") {
    previous.value += value;
    return;
  }
  parts.push({ type: "literal", value });
}

function parseTemplate(config: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let index = 0;
  while (index < config.length) {
    const dollar = config.indexOf("$", index);
    if (dollar < 0) {
      appendLiteral(parts, config.slice(index));
      break;
    }
    appendLiteral(parts, config.slice(index, dollar));
    const next = config[dollar + 1];
    if (next === "$" || next === "!") {
      appendLiteral(parts, next);
      index = dollar + 2;
      continue;
    }
    if (next === "{") {
      const end = config.indexOf("}", dollar + 2);
      if (end < 0) {
        appendLiteral(parts, "$");
        index = dollar + 1;
        continue;
      }
      const name = config.slice(dollar + 2, end);
      if (ENV_VAR_NAME.test(name)) parts.push({ type: "env", name });
      else appendLiteral(parts, config.slice(dollar, end + 1));
      index = end + 1;
      continue;
    }
    const match = config.slice(dollar + 1).match(ENV_VAR_NAME_PREFIX);
    if (match) {
      parts.push({ type: "env", name: match[0] });
      index = dollar + 1 + match[0].length;
      continue;
    }
    appendLiteral(parts, "$");
    index = dollar + 1;
  }
  return parts;
}

function parseReference(config: string): ConfigReference {
  if (config.startsWith("!")) return { type: "command", config };
  return { type: "template", parts: parseTemplate(config) };
}

function lookupEnv(name: string, env: ProviderEnv | undefined): string | undefined {
  return env?.[name] || process.env[name] || undefined;
}

function resolveTemplate(parts: TemplatePart[], env: ProviderEnv | undefined): string | undefined {
  let resolved = "";
  for (const part of parts) {
    if (part.type === "literal") {
      resolved += part.value;
      continue;
    }
    const value = lookupEnv(part.name, env);
    if (value === undefined) return undefined;
    resolved += value;
  }
  return resolved;
}

function isLegacyWslBash(shell: string): boolean {
  const normalized = shell.replace(/\//g, "\\").toLowerCase();
  return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized);
}

type ShellConfig = { shell: string; args: string[]; commandViaStdin: boolean };

function bashShellConfig(shell: string): ShellConfig {
  return isLegacyWslBash(shell)
    ? { shell, args: ["-s"], commandViaStdin: true }
    : { shell, args: ["-c"], commandViaStdin: false };
}

/** Windows-only bash discovery, mirroring the SDK's resolution order. */
function findWindowsBash(): ShellConfig | undefined {
  const candidates: string[] = [];
  const programFiles = process.env.ProgramFiles;
  if (programFiles) candidates.push(`${programFiles}\\Git\\bin\\bash.exe`);
  const programFilesX86 = process.env["ProgramFiles(x86)"];
  if (programFilesX86) candidates.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return bashShellConfig(candidate);
  }
  try {
    const result = spawnSync("where", ["bash.exe"], {
      encoding: "utf-8",
      timeout: 5_000,
      windowsHide: true,
    });
    if (result.status === 0 && result.stdout) {
      const first = result.stdout.trim().split(/\r?\n/)[0];
      if (first && existsSync(first)) return bashShellConfig(first);
    }
  } catch {
    // Fall through to the bundled shell.
  }
  const bundled = process.env.PIDECK_BUNDLED_BASH;
  if (bundled && existsSync(bundled)) return bashShellConfig(bundled);
  return undefined;
}

/** `executed` distinguishes "shell ran and failed" from "no shell available". */
function executeWithBash(command: string): { executed: boolean; value: string | undefined } {
  const config = findWindowsBash();
  if (!config) return { executed: false, value: undefined };
  try {
    const result = spawnSync(
      config.shell,
      config.commandViaStdin ? config.args : [...config.args, command],
      {
        encoding: "utf-8",
        input: config.commandViaStdin ? command : undefined,
        timeout: COMMAND_TIMEOUT_MS,
        stdio: [config.commandViaStdin ? "pipe" : "ignore", "pipe", "ignore"],
        shell: false,
        windowsHide: true,
      },
    );
    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code;
      return { executed: code !== "ENOENT", value: undefined };
    }
    if (result.status !== 0) return { executed: true, value: undefined };
    const value = (result.stdout ?? "").trim();
    return { executed: true, value: value || undefined };
  } catch {
    return { executed: false, value: undefined };
  }
}

function executeWithDefaultShell(command: string): string | undefined {
  try {
    const output = execSync(command, {
      encoding: "utf-8",
      timeout: COMMAND_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output.trim() || undefined;
  } catch {
    return undefined;
  }
}

function executeCommandUncached(config: string): string | undefined {
  const command = config.slice(1);
  if (process.platform !== "win32") return executeWithDefaultShell(command);
  const viaBash = executeWithBash(command);
  return viaBash.executed ? viaBash.value : executeWithDefaultShell(command);
}

function executeCommand(config: string): string | undefined {
  const cached = commandCache.get(config);
  if (cached !== undefined || commandCache.has(config)) return cached;
  const result = executeCommandUncached(config);
  commandCache.set(config, result);
  return result;
}

/** True when the value runs a shell command rather than expanding a template. */
export function isCommandConfigValue(config: string): boolean {
  return parseReference(config).type === "command";
}

/**
 * Resolve a stored credential value. Returns `undefined` when a referenced
 * environment variable is unset or a command fails, so a broken reference
 * never reaches a provider as a literal.
 */
export function resolveCredentialConfigValue(
  config: string,
  env?: ProviderEnv,
): string | undefined {
  const reference = parseReference(config);
  if (reference.type === "command") return executeCommand(reference.config);
  return resolveTemplate(reference.parts, env);
}

/** Drop cached command results. Exported for tests. */
export function clearCredentialCommandCache(): void {
  commandCache.clear();
}
