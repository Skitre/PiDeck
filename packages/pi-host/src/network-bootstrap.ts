/**
 * Network bootstrap — applies the global Pi network settings to the Host
 * process. The SDK applies `httpProxy`/`httpIdleTimeoutMs` only in its CLI
 * entrypoint (dist/main.js:377/601); the Host embeds the SDK as a library and
 * never runs that path, so without this module a hand-written `httpProxy` in
 * settings.json silently does nothing (SDK functions are not root-exported
 * and deep imports are blocked by its exports map — mirrored here instead).
 */
import { EventEmitter } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import * as undici from "undici";
import { logger } from "./logger.js";

const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;

// Captured at module load, mirroring the SDK: a fetch replaced before this
// module loaded is a deliberate override and must be preserved.
const originalGlobalFetch = globalThis.fetch;
let installedGlobalFetch: typeof globalThis.fetch | undefined;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ensureJsonFile(path: string, contents: string, label: string): void {
  if (existsSync(path)) return;
  try {
    writeFileSync(path, contents, "utf-8");
  } catch (error) {
    logger.warn(`Could not create ${label}`, {
      path,
      error: errorMessage(error),
    });
  }
}

/**
 * Create an empty global settings file when none exists so the desktop
 * "Open settings.json" reveal (which rejects non-existent paths) works on
 * fresh installs. Never throws: a read-only agent dir must not kill the Host.
 */
export function ensureGlobalSettingsFile(agentDir: string): void {
  ensureJsonFile(join(agentDir, "settings.json"), "{}\n", "global settings file");
}

/**
 * Create a schema-valid empty models.json when none exists so the desktop
 * "Open models.json" reveal works on fresh installs. `{}` is invalid for the
 * SDK schema (providers is required); a missing file is treated as empty, so
 * the stub must keep that meaning. Never throws.
 */
export function ensureModelsJsonFile(agentDir: string): void {
  ensureJsonFile(
    join(agentDir, "models.json"),
    `${JSON.stringify({ providers: {} })}\n`,
    "models.json",
  );
}

/** Origin only — a proxy URL may embed credentials that must never be logged. */
function redactProxyForLog(proxy: string): string {
  try {
    return new URL(proxy).origin;
  } catch {
    return "(unparseable proxy URL)";
  }
}

function applyHttpProxySettings(httpProxy: string | undefined): void {
  const proxy = httpProxy?.trim();
  if (!proxy) return;
  const hadHttp = process.env.HTTP_PROXY !== undefined;
  const hadHttps = process.env.HTTPS_PROXY !== undefined;
  // Explicit environment wins over the settings value, matching the CLI.
  process.env.HTTP_PROXY ??= proxy;
  process.env.HTTPS_PROXY ??= proxy;
  logger.info("Applied httpProxy from global settings", {
    proxyOrigin: redactProxyForLog(proxy),
    ...(hadHttp && hadHttps
      ? { note: "HTTP_PROXY/HTTPS_PROXY already set; settings value ignored" }
      : {}),
  });
}

function normalizeIdleTimeoutMs(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return DEFAULT_HTTP_IDLE_TIMEOUT_MS;
  }
  return Math.floor(value);
}

const ignoreUndiciDispatcherError = (_error: unknown) => {};

// Undici can emit an internal Client "error" while terminating a mid-stream
// fetch body. The body stream still rejects through reader.read(); this
// listener only prevents EventEmitter's unhandled "error" special case from
// crashing the Host. (Mirrored from the SDK — dropping it is a crash risk.)
function withUndiciErrorListener<T>(dispatcher: T): T {
  if (dispatcher instanceof EventEmitter) {
    EventEmitter.prototype.on.call(dispatcher, "error", ignoreUndiciDispatcherError);
  }
  return dispatcher;
}

function createUndiciClient(origin: string | URL, options?: undici.Client.Options): undici.Client {
  return withUndiciErrorListener(new undici.Client(origin, options));
}

function createUndiciOriginDispatcher(
  origin: string | URL,
  options: undici.Pool.Options,
): undici.Dispatcher {
  if (options.connections === 1) {
    return createUndiciClient(origin, options);
  }
  return withUndiciErrorListener(
    new undici.Pool(origin, { ...options, factory: createUndiciClient }),
  );
}

function configureHttpDispatcher(timeoutMs: number): void {
  const dispatcher = withUndiciErrorListener(
    // clientFactory/factory are honored by undici at runtime but absent from
    // its public option types, hence the cast (same shape the SDK passes).
    new undici.EnvHttpProxyAgent({
      allowH2: false,
      bodyTimeout: timeoutMs,
      headersTimeout: timeoutMs,
      clientFactory: createUndiciClient,
      factory: createUndiciOriginDispatcher,
    } as undici.EnvHttpProxyAgent.Options),
  );
  undici.setGlobalDispatcher(dispatcher);
  // Keep fetch and the dispatcher on the same undici implementation. Node 26.0's
  // bundled fetch can otherwise consume compressed responses through npm undici's
  // dispatcher without decompressing them, causing response.json() failures.
  // If a caller replaced fetch after module load, preserve that deliberate override.
  const shouldInstallGlobals =
    installedGlobalFetch === undefined
      ? globalThis.fetch === originalGlobalFetch
      : globalThis.fetch === installedGlobalFetch;
  if (shouldInstallGlobals) {
    undici.install?.();
    installedGlobalFetch = globalThis.fetch;
  }
}

/**
 * Read the global Pi settings and apply the network-relevant ones process-wide.
 * Every stage is independently fault-tolerant: a hand-edited settings value
 * must never prevent the Host from starting.
 */
export function applyHostNetworkSettings(agentDir: string): void {
  let settingsManager: SettingsManager;
  try {
    settingsManager = SettingsManager.create(process.cwd(), agentDir, {
      projectTrusted: false,
    });
  } catch (error) {
    logger.warn("Could not read global settings for network bootstrap", {
      error: errorMessage(error),
    });
    return;
  }

  // The only feedback a hand-editing user gets when the JSON is malformed:
  // the SDK records the load error and falls back to defaults.
  for (const settingsError of settingsManager.drainErrors()) {
    logger.warn("Global settings file not fully applied", {
      scope: settingsError.scope,
      error: errorMessage(settingsError.error),
    });
  }

  try {
    applyHttpProxySettings(settingsManager.getGlobalSettings().httpProxy);
  } catch (error) {
    logger.warn("Could not apply httpProxy setting", { error: errorMessage(error) });
  }

  try {
    // The CLI applies the default timeout at bootstrap and the tuned value
    // later (SDK main.js:378 vs :602); the Host has only this call site, so
    // the tuned value is applied here directly.
    configureHttpDispatcher(normalizeIdleTimeoutMs(settingsManager.getHttpIdleTimeoutMs()));
  } catch (error) {
    logger.warn("Could not configure HTTP dispatcher", { error: errorMessage(error) });
  }
}
