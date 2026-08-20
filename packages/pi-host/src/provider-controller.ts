import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ModelRuntime,
  type AgentSession,
  type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import {
  InMemoryCredentialStore,
  type AuthEvent,
  type AuthInteraction,
  type AuthPrompt,
} from "@earendil-works/pi-ai";
import {
  completeSimple,
  type Api,
  type Context,
  type Model,
  type ProviderHeaders,
} from "@earendil-works/pi-ai/compat";
import {
  createHostError,
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_MODEL_MAX_TOKENS,
  detectModelThinking,
  type BuiltinProviderAuthStatus,
  type DiscoveredProviderModel,
  type HostError,
  type HostIdentity,
  type ProviderApi,
  type ProviderConnectionCategory,
  type ProviderConnectionResult,
  type ProviderCompatibility,
  type ProviderCompatibilityDraft,
  type ProviderDraft,
  type ProviderLoginFlowEvent,
  type ProviderModelConfig,
  type ProviderSnapshot,
  type ThinkingLevel,
  type ThinkingLevelMap,
} from "@pideck/protocol";
import { logger } from "./logger.js";
import type { MethodHandler, PiHostServer } from "./server.js";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";
import { rebindCurrentSessionModel } from "./model-thinking.js";
import { clearSessionModel, publishIdleActiveSessionSnapshot } from "./no-model.js";
import { withRegisteredGraphMutation } from "./registered-graph-mutation.js";
import { withStableGraphRead } from "./stable-graph-read.js";
import { ProviderMutationJournal } from "./provider-journal.js";
import { modelBackupDir, PIDECK_MODEL_BACKUP_PATTERN } from "./pideck-data.js";
import {
  ENABLED_PROVIDERS_KEY,
  isObject,
  LEGACY_ACTIVE_PROVIDER_KEY,
  PROVIDER_MODELS_KEY,
  readModelsConfig,
  readProviderModelAllowLists,
  resolveEnabledProviders,
  type JsonObject,
} from "./provider-models-config.js";

type ProviderFetchCapture =
  | {
      snapshot: {
        original: string | null;
        provider: ProviderSnapshot;
        apiKey: string | undefined;
      };
    }
  | { error: HostError };
type ProviderConnectionCapture =
  | {
      snapshot: {
        original: string | null;
        provider: ProviderSnapshot;
        model: Model<Api>;
        auth: Awaited<ReturnType<ModelRegistry["getApiKeyAndHeaders"]>>;
      };
    }
  | { error: HostError };
const MODELS_BACKUP_RETENTION = 5;

const PROVIDER_APIS = new Set<ProviderApi>([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
]);

function defaultAuthHeader(api: ProviderApi): boolean {
  return api === "openai-completions" || api === "openai-responses";
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function providerHasEligibleModel(
  config: Awaited<ReturnType<typeof readModelsConfig>>,
  factory: WorkspaceGraphFactory,
  providerId: string,
): boolean {
  const custom = config.providers[providerId];
  if (isObject(custom)) {
    return (
      Array.isArray(custom.models) &&
      custom.models.some(
        (model) => isObject(model) && typeof model.id === "string" && model.id.trim().length > 0,
      )
    );
  }
  const allow = readProviderModelAllowLists(config)[providerId];
  return factory.deps.modelRuntime
    .getModels(providerId)
    .some((model) => allow === undefined || allow.includes(model.id));
}

function normalizeModel(value: unknown): ProviderModelConfig | null {
  if (!isObject(value) || typeof value.id !== "string" || !value.id.trim()) return null;
  const id = value.id.trim();
  const input = Array.isArray(value.input)
    ? value.input.filter((item): item is "text" | "image" => item === "text" || item === "image")
    : [];
  const thinkingLevelMap = isObject(value.thinkingLevelMap)
    ? (Object.fromEntries(
        Object.entries(value.thinkingLevelMap).filter(
          (entry): entry is [ThinkingLevel, string | null] =>
            ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(entry[0]) &&
            (entry[1] === null || typeof entry[1] === "string"),
        ),
      ) as ThinkingLevelMap)
    : undefined;
  return {
    id,
    name: typeof value.name === "string" && value.name.trim() ? value.name.trim() : id,
    reasoning: value.reasoning === true,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    input: input.length > 0 ? [...new Set(input)] : ["text"],
    contextWindow:
      typeof value.contextWindow === "number" &&
      Number.isSafeInteger(value.contextWindow) &&
      value.contextWindow > 0
        ? value.contextWindow
        : DEFAULT_MODEL_CONTEXT_WINDOW,
    maxTokens:
      typeof value.maxTokens === "number" &&
      Number.isSafeInteger(value.maxTokens) &&
      value.maxTokens > 0
        ? value.maxTokens
        : DEFAULT_MODEL_MAX_TOKENS,
  };
}

const MANAGED_COMPAT_KEYS = ["supportsDeveloperRole", "supportsReasoningEffort"] as const;

function normalizeCompatibilityDraft(value: unknown): ProviderCompatibilityDraft | undefined {
  if (!isObject(value)) return undefined;
  const compat: ProviderCompatibilityDraft = {};
  for (const key of MANAGED_COMPAT_KEYS) {
    const item = value[key];
    if (typeof item === "boolean" || item === null) compat[key] = item;
  }
  return Object.keys(compat).length > 0 ? compat : undefined;
}

function compatibilitySnapshot(value: unknown): ProviderCompatibility | undefined {
  if (!isObject(value)) return undefined;
  const compat: ProviderCompatibility = {};
  for (const key of MANAGED_COMPAT_KEYS) {
    if (typeof value[key] === "boolean") compat[key] = value[key];
  }
  return Object.keys(compat).length > 0 ? compat : undefined;
}

function normalizeDraft(input: ProviderDraft): ProviderDraft {
  const models = new Map<string, ProviderModelConfig>();
  for (const item of input.models) {
    const model = normalizeModel(item);
    if (model) models.set(model.id, model);
  }
  const compat = normalizeCompatibilityDraft(input.compat);
  return {
    id: input.id.trim(),
    name: input.name.trim(),
    baseUrl: input.baseUrl.trim().replace(/\/+$/, ""),
    ...(input.modelsUrl?.trim() ? { modelsUrl: input.modelsUrl.trim() } : {}),
    api: input.api,
    headers: Object.fromEntries(
      Object.entries(input.headers)
        .map(([key, value]) => [key.trim(), value.trim()] as const)
        .filter(([key]) => key.length > 0),
    ),
    ...(compat ? { compat } : {}),
    models: [...models.values()],
  };
}

function validateDraft(input: ProviderDraft): HostError | null {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(input.id)) {
    return createHostError(
      "INVALID_REQUEST",
      "Provider ID may only contain letters, numbers, dots, underscores, and hyphens",
    );
  }
  if (!input.name) return createHostError("INVALID_REQUEST", "Provider name is required");
  if (!PROVIDER_APIS.has(input.api)) {
    return createHostError("INVALID_REQUEST", `Unsupported Provider API: ${input.api}`);
  }
  let url: URL;
  try {
    url = new URL(input.baseUrl);
  } catch {
    return createHostError("INVALID_REQUEST", "Base URL must be a valid HTTP or HTTPS URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return createHostError("INVALID_REQUEST", "Base URL must use HTTP or HTTPS");
  }
  if (input.modelsUrl) {
    try {
      const modelsUrl = new URL(input.modelsUrl);
      if (modelsUrl.protocol !== "http:" && modelsUrl.protocol !== "https:") throw new Error();
    } catch {
      return createHostError("INVALID_REQUEST", "Models URL must be a valid HTTP or HTTPS URL");
    }
  }
  return null;
}

function runtimeProviderIds(factory: WorkspaceGraphFactory): string[] {
  return factory.deps.modelRuntime.getProviders().map((provider) => provider.id);
}

function providerSnapshot(
  id: string,
  raw: JsonObject,
  factory: WorkspaceGraphFactory,
  enabled: boolean,
): ProviderSnapshot {
  const api =
    typeof raw.api === "string" && PROVIDER_APIS.has(raw.api as ProviderApi)
      ? (raw.api as ProviderApi)
      : "openai-completions";
  const models = Array.isArray(raw.models)
    ? raw.models.map(normalizeModel).filter((model): model is ProviderModelConfig => model !== null)
    : [];
  const compat = compatibilitySnapshot(raw.compat);
  return {
    id,
    enabled,
    name:
      typeof raw.name === "string" && raw.name.trim()
        ? raw.name.trim()
        : factory.deps.modelRegistry.getProviderDisplayName(id),
    baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : "",
    ...(typeof raw.modelsUrl === "string" && raw.modelsUrl.trim()
      ? { modelsUrl: raw.modelsUrl.trim() }
      : {}),
    api,
    authHeader: raw.authHeader === true,
    headers: stringRecord(raw.headers),
    ...(compat ? { compat } : {}),
    models,
    auth: factory.deps.modelRegistry.getProviderAuthStatus(id),
  };
}

function mergeProvider(existing: JsonObject, draft: ProviderDraft): JsonObject {
  const existingModels = new Map<string, JsonObject>();
  if (Array.isArray(existing.models)) {
    for (const item of existing.models) {
      if (isObject(item) && typeof item.id === "string") existingModels.set(item.id, item);
    }
  }
  const models = draft.models.map((model) => {
    const next = {
      ...(existingModels.get(model.id) ?? {}),
      ...model,
    };
    if (model.thinkingLevelMap === undefined) delete next.thinkingLevelMap;
    return next;
  });
  const merged: JsonObject = {
    ...existing,
    name: draft.name,
    baseUrl: draft.baseUrl,
    ...(draft.modelsUrl ? { modelsUrl: draft.modelsUrl } : {}),
    api: draft.api,
    authHeader:
      existing.api === draft.api && typeof existing.authHeader === "boolean"
        ? existing.authHeader
        : defaultAuthHeader(draft.api),
    headers: draft.headers,
    models,
  };
  if (!draft.modelsUrl) delete merged.modelsUrl;
  if (draft.compat) {
    const compat: JsonObject = isObject(existing.compat) ? { ...existing.compat } : {};
    for (const key of MANAGED_COMPAT_KEYS) {
      const value = draft.compat[key];
      if (value === null) delete compat[key];
      else if (typeof value === "boolean") compat[key] = value;
    }
    if (Object.keys(compat).length > 0) merged.compat = compat;
    else delete merged.compat;
  }
  // PiDeck defaults OpenAI Chat Completions Providers to the system role:
  // pi-ai auto-detection sends the developer role to any unrecognized relay,
  // which most OpenAI-compatible endpoints reject.
  if (draft.api === "openai-completions") {
    const compat: JsonObject = isObject(merged.compat) ? { ...merged.compat } : {};
    if (typeof compat.supportsDeveloperRole !== "boolean") {
      compat.supportsDeveloperRole = false;
      merged.compat = compat;
    }
  }
  return merged;
}

/**
 * Validate a candidate models.json in complete isolation.
 *
 * The runtime gets the candidate file, a throwaway models store, an empty
 * in-memory credential store, and no network. It must not observe the real
 * auth.json or models-store.json, and must not disturb the production runtime
 * or the current session's model.
 */
async function validateCandidateModelsConfig(tempPath: string): Promise<void> {
  const storePath = join(dirname(tempPath), `.models-store-${randomUUID()}.tmp`);
  try {
    const candidateRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: tempPath,
      modelsStorePath: storePath,
      allowModelNetwork: false,
    });
    const validationError = candidateRuntime.getError();
    if (validationError) throw new Error(validationError);
  } finally {
    await unlink(storePath).catch(() => undefined);
  }
}

async function pruneModelsBackups(directory: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  const backups = entries.flatMap((entry) => {
    if (!entry.isFile()) return [];
    const match = PIDECK_MODEL_BACKUP_PATTERN.exec(entry.name);
    if (!match) return [];
    return [{ name: entry.name, timestamp: Number(match[1]) }];
  });
  backups.sort(
    (left, right) => left.timestamp - right.timestamp || left.name.localeCompare(right.name),
  );
  const stale = backups.slice(0, Math.max(0, backups.length - MODELS_BACKUP_RETENTION));
  await Promise.all(stale.map(({ name }) => unlink(join(directory, name)).catch(() => undefined)));
}

async function commitModelsConfig(
  path: string,
  root: JsonObject,
  factory: WorkspaceGraphFactory,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const backupDirectory = modelBackupDir(factory.deps.agentDir);
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  const candidate = JSON.stringify(root, null, 2) + "\n";
  const tempPath = join(backupDirectory, `.models-${randomUUID()}.tmp`);
  const backupPath = join(backupDirectory, `models-${Date.now()}-${randomUUID().slice(0, 8)}.bak`);
  await writeFile(tempPath, candidate, { encoding: "utf8", mode: 0o600 });
  try {
    await validateCandidateModelsConfig(tempPath);
    try {
      await copyFile(path, backupPath);
      await chmod(backupPath, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await rename(tempPath, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const displacedPath = join(backupDirectory, `.models-${randomUUID()}.old`);
      await rename(path, displacedPath);
      try {
        await rename(tempPath, path);
        await unlink(displacedPath).catch(() => undefined);
      } catch (replaceError) {
        await rename(displacedPath, path).catch(() => undefined);
        throw replaceError;
      }
    }
    await pruneModelsBackups(backupDirectory);
  } finally {
    await unlink(tempPath).catch(() => undefined);
  }
}

async function restoreModelsConfig(path: string, original: string | null): Promise<void> {
  if (original === null) {
    await unlink(path).catch(() => undefined);
    return;
  }
  await writeFile(path, original, { encoding: "utf8", mode: 0o600 });
}

function providerMutationConflict(
  factory: WorkspaceGraphFactory,
  providerIds: Iterable<string>,
  message: string,
): HostError | null {
  const graph = factory.getGraph();
  if (!graph) return null;
  const affected = new Set(providerIds);
  const sessions: AgentSession[] = [
    ...(graph.agentSession ? [graph.agentSession] : []),
    ...[...graph.backgroundSessions.values()].map((runtime) => runtime.agentSession),
  ];
  const conflict = sessions.find((session) => {
    const providerId = session.model?.provider;
    return providerId !== undefined && affected.has(providerId) && factory.isSessionBusy(session);
  });
  if (!conflict) return null;
  return createHostError("AGENT_BUSY", message, {
    retryable: true,
    details: {
      providerId: conflict.model?.provider ?? null,
      modelId: conflict.model?.id ?? null,
    },
  });
}

async function refreshRegistry(
  factory: WorkspaceGraphFactory,
  rebindCurrentModel = false,
): Promise<void> {
  await Promise.resolve(factory.deps.refreshModelHealth());
  factory.onModelHealthChanged?.();
  if (!rebindCurrentModel) return;
  const graph = factory.getGraph();
  if (!graph?.agentSession || !graph.agentSession.isIdle) return;
  rebindCurrentSessionModel(graph.agentSession, factory.deps.modelRegistry);
}

async function invalidateRetainedRuntimes(
  factory: WorkspaceGraphFactory,
): Promise<HostError | null> {
  if (factory.hasBusyRetainedSessions?.()) {
    return createHostError(
      "AGENT_BUSY",
      "Stop running sessions in other workspaces before changing Providers",
      { retryable: true },
    );
  }
  await factory.invalidateRetainedRuntimeCaches?.();
  return null;
}

async function reconcileIdleActiveSessionModel(
  factory: WorkspaceGraphFactory,
  enabledProviderIds: Iterable<string>,
  options: {
    remapProvider?: { from: string; to: string };
    preferredModelIds?: ReadonlyMap<string, readonly string[]>;
    allowedModelIds?: ReadonlyMap<string, ReadonlySet<string>>;
    allowNoModel?: boolean;
  } = {},
): Promise<void> {
  const session = factory.getGraph()?.agentSession;
  const current = session?.model;
  if (!session?.isIdle || !current) return;
  const registry = factory.deps.modelRegistry;
  const enabled = [...new Set(enabledProviderIds)];
  const enabledSet = new Set(enabled);
  const currentProvider =
    options.remapProvider?.from === current.provider ? options.remapProvider.to : current.provider;
  const candidates: Model<Api>[] = [];
  const add = (model: Model<Api> | undefined) => {
    if (!model || !enabledSet.has(model.provider)) return;
    const allowed = options.allowedModelIds?.get(model.provider);
    if (allowed && !allowed.has(model.id)) return;
    if (
      candidates.some(
        (candidate) => candidate.provider === model.provider && candidate.id === model.id,
      )
    ) {
      return;
    }
    candidates.push(model);
  };

  add(registry.find(currentProvider, current.id));
  for (const providerId of enabled) {
    for (const modelId of options.preferredModelIds?.get(providerId) ?? []) {
      add(registry.find(providerId, modelId));
    }
  }
  for (const providerId of enabled) {
    for (const model of registry.getAll()) {
      if (model.provider !== providerId) continue;
      const before = candidates.length;
      add(model);
      if (candidates.length > before) break;
    }
  }

  const model = candidates[0];
  if (!model) {
    if (options.allowNoModel) {
      await clearSessionModel(session);
      publishIdleActiveSessionSnapshot(factory);
      return;
    }
    throw new Error("Enable at least one Provider model before changing the current Provider");
  }
  if (model.provider === current.provider && model.id === current.id) {
    rebindCurrentSessionModel(session, registry);
    return;
  }
  await session.setModel(model);
}

const ANTHROPIC_COMPAT_PATH_SUFFIXES = [
  "/api/claudecode",
  "/api/anthropic",
  "/apps/anthropic",
  "/api/coding",
  "/claudecode",
  "/anthropic",
  "/step_plan",
  "/coding",
  "/claude",
] as const;

function modelCatalogUrls(baseUrl: string, modelsUrl?: string): URL[] {
  if (modelsUrl) return [new URL(modelsUrl)];
  const base = new URL(baseUrl);
  const pathname = base.pathname.replace(/\/+$/, "");
  const paths: string[] = [];
  const add = (path: string) => {
    const normalized = path.replace(/\/{2,}/g, "/") || "/";
    if (!paths.includes(normalized)) paths.push(normalized);
  };
  const versionMatch = pathname.match(/^(.*)\/v(\d+)$/i);
  const compatSuffix = ANTHROPIC_COMPAT_PATH_SUFFIXES.find((suffix) =>
    pathname.toLowerCase().endsWith(suffix),
  );
  if (!pathname) {
    add("/v1/models");
    add("/models");
  } else if (versionMatch) {
    const prefix = versionMatch[1];
    add(`${pathname}/models`);
    if (versionMatch[2] !== "1") add(`${prefix}/v1/models`);
    add(`${prefix}/models`);
  } else if (compatSuffix) {
    const prefix = pathname.slice(0, -compatSuffix.length);
    add(`${prefix}/v1/models`);
    add(`${prefix}/models`);
  } else {
    add(`${pathname}/models`);
    add(`${pathname}/v1/models`);
  }
  return paths.map((path) => {
    const url = new URL(base);
    url.pathname = path;
    url.search = "";
    url.hash = "";
    return url;
  });
}

function catalogEndpointLabel(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

function redactedProviderMessage(payload: unknown, sensitiveValues: string[]): string | undefined {
  if (!isObject(payload)) return undefined;
  const nestedError = isObject(payload.error) ? payload.error.message : payload.error;
  const raw = [nestedError, payload.message, payload.detail].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  if (!raw) return undefined;
  let message = raw.replace(/\s+/g, " ").trim();
  for (const value of sensitiveValues) {
    if (value) message = message.replaceAll(value, "[redacted]");
  }
  return message.length > 240 ? `${message.slice(0, 237)}...` : message;
}

function redactedProviderText(raw: string, sensitiveValues: string[]): string {
  let message = raw.replace(/\s+/g, " ").trim();
  for (const value of sensitiveValues) {
    if (value) message = message.replaceAll(value, "[redacted]");
  }
  return message.length > 320 ? `${message.slice(0, 317)}...` : message;
}

function providerSensitiveValues(
  apiKey: string | undefined,
  headers: ProviderHeaders | Record<string, string>,
): string[] {
  const headerValues = Object.entries(stringRecord(headers))
    .filter(
      ([name, value]) =>
        value.length >= 6 || /authorization|api.?key|token|secret|cookie/i.test(name),
    )
    .map(([, value]) => value);
  return [
    ...new Set(
      [apiKey, ...headerValues].filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      ),
    ),
  ];
}

type CatalogResponse = {
  items?: unknown[];
  error?: string;
  retryAlternatePath: boolean;
};

async function fetchModelCatalog(
  url: URL,
  headers: Headers,
  sensitiveValues: string[],
  signal: AbortSignal,
): Promise<CatalogResponse> {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
  });
  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    const kind =
      response.headers.get("content-type")?.includes("text/html") || /^\s*</.test(text)
        ? "HTML instead of JSON"
        : "invalid JSON";
    return {
      error: `Provider model endpoint ${catalogEndpointLabel(url)} returned ${kind}`,
      retryAlternatePath: response.ok || response.status === 404 || response.status === 405,
    };
  }

  const detail = redactedProviderMessage(payload, sensitiveValues);
  if (!response.ok) {
    return {
      error: `Provider model endpoint ${catalogEndpointLabel(url)} returned ${response.status} ${response.statusText}${
        detail ? `: ${detail}` : ""
      }`,
      retryAlternatePath: response.status === 404 || response.status === 405,
    };
  }

  const items = Array.isArray(payload)
    ? payload
    : isObject(payload) && Array.isArray(payload.data)
      ? payload.data
      : isObject(payload) && Array.isArray(payload.models)
        ? payload.models
        : undefined;
  if (!items) {
    return {
      error: `Provider model endpoint ${catalogEndpointLabel(url)} returned JSON without a model list${
        detail ? `: ${detail}` : ""
      }`,
      retryAlternatePath: true,
    };
  }
  return { items, retryAlternatePath: false };
}

async function discoverModels(
  provider: ProviderSnapshot,
  apiKey: string | undefined,
  signal: AbortSignal,
): Promise<DiscoveredProviderModel[]> {
  const headers = new Headers(provider.headers);
  headers.set("Accept", "application/json");
  if (apiKey) {
    if (provider.authHeader) headers.set("Authorization", `Bearer ${apiKey}`);
    if (provider.api === "anthropic-messages") {
      headers.set("x-api-key", apiKey);
      if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
    } else if (provider.api !== "google-generative-ai" && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${apiKey}`);
    }
  }
  const urls = modelCatalogUrls(provider.baseUrl, provider.modelsUrl);
  const sensitiveValues = providerSensitiveValues(apiKey, provider.headers);
  const attempted: string[] = [];
  let lastError = "Provider returned an invalid model catalog";
  let items: unknown[] | undefined;
  for (const url of urls) {
    if (apiKey && provider.api === "google-generative-ai") url.searchParams.set("key", apiKey);
    attempted.push(catalogEndpointLabel(url));
    let result: CatalogResponse;
    try {
      result = await fetchModelCatalog(url, headers, sensitiveValues, signal);
    } catch (error) {
      signal.throwIfAborted();
      const raw = error instanceof Error ? error.message : String(error);
      const timeout =
        error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      result = {
        error: `Could not reach Provider model endpoint ${catalogEndpointLabel(url)}: ${
          timeout ? "request timed out" : redactedProviderText(raw, sensitiveValues)
        }`,
        retryAlternatePath: true,
      };
    }
    if (result.items) {
      items = result.items;
      break;
    }
    if (result.error) lastError = result.error;
    if (!result.retryAlternatePath) break;
  }
  if (!items) {
    throw new Error(`${lastError}. Check the Base URL; tried ${attempted.join(" or ")}`);
  }
  const enabled = new Map(provider.models.map((model) => [model.id, model]));
  const discovered = new Map<string, DiscoveredProviderModel>();
  for (const item of items) {
    if (!isObject(item)) continue;
    const rawId =
      typeof item.id === "string" ? item.id : typeof item.name === "string" ? item.name : "";
    const id = rawId.replace(/^models\//, "").trim();
    if (!id) continue;
    const existing = enabled.get(id);
    const detected = detectModelThinking(id, item);
    const useDetectedMap =
      existing?.thinkingLevelMap === undefined &&
      existing?.reasoning === true &&
      detected.reasoning;
    const thinkingLevelMap =
      existing?.thinkingLevelMap ??
      (existing === undefined || useDetectedMap ? detected.thinkingLevelMap : undefined);
    const reasoning = existing?.reasoning ?? detected.reasoning;
    const thinkingSource = existing?.thinkingLevelMap
      ? "configured"
      : useDetectedMap || existing === undefined
        ? detected.source
        : "configured";
    discovered.set(id, {
      id,
      name: existing?.name ?? (typeof item.displayName === "string" ? item.displayName : id),
      reasoning,
      ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
      input: existing?.input ?? ["text"],
      contextWindow: existing?.contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW,
      maxTokens: existing?.maxTokens ?? DEFAULT_MODEL_MAX_TOKENS,
      enabled: enabled.has(id),
      thinkingSource,
    });
  }
  for (const model of provider.models) {
    if (!discovered.has(model.id)) {
      const detected = detectModelThinking(model.id);
      const thinkingLevelMap =
        model.thinkingLevelMap ??
        (model.reasoning && detected.reasoning ? detected.thinkingLevelMap : undefined);
      discovered.set(model.id, {
        ...model,
        ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
        enabled: true,
        thinkingSource: model.thinkingLevelMap
          ? "configured"
          : model.reasoning && detected.reasoning
            ? detected.source
            : "configured",
      });
    }
  }
  return [...discovered.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
}

function headersForAuthMode(
  provider: ProviderSnapshot,
  resolvedHeaders: ProviderHeaders | undefined,
  apiKey: string | undefined,
  authHeader: boolean,
): Record<string, string> {
  const headers = Object.fromEntries(
    Object.entries(stringRecord(resolvedHeaders)).filter(
      ([key]) => key.toLowerCase() !== "authorization",
    ),
  );
  const explicitAuthorization = Object.entries(provider.headers).find(
    ([key]) => key.toLowerCase() === "authorization",
  );
  if (explicitAuthorization) headers[explicitAuthorization[0]] = explicitAuthorization[1];
  else if (authHeader && apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

function classifyConnectionFailure(
  raw: string,
  provider: ProviderSnapshot,
  sensitiveValues: string[],
): Pick<ProviderConnectionResult, "category" | "message" | "suggestion"> {
  const message = redactedProviderText(raw || "Provider request failed", sensitiveValues);
  const lower = message.toLowerCase();
  let category: ProviderConnectionCategory = "provider";
  let suggestion: string | undefined;

  if (
    /\b401\b|unauthorized|(?:invalid|missing|no) api.?key|api.?key.*(?:not found|required)|authentication|authentication_error/.test(
      lower,
    )
  ) {
    category = "authentication";
    suggestion = "Check the API key and the Provider's authentication header settings.";
  } else if (/\b403\b|forbidden|blocked|cloudflare|\bwaf\b|access denied/.test(lower)) {
    category = "blocked";
    suggestion =
      provider.api === "anthropic-messages" && !hasHeader(provider.headers, "user-agent")
        ? "This relay may block the Anthropic SDK fingerprint. Set User-Agent to PiDeck/0.1 and retry."
        : "The relay or its WAF rejected the request. Check IP policy, headers, and User-Agent rules.";
  } else if (/\b429\b|rate.?limit|too many requests|quota/.test(lower)) {
    category = "rate_limit";
    suggestion =
      "The endpoint is reachable but rate-limited. Retry later or check the account quota.";
  } else if (/\b404\b|not found|unknown endpoint|no route/.test(lower)) {
    category = "not_found";
    suggestion = `Check that the Base URL and ${provider.api} protocol point to the same API.`;
  } else if (/timeout|timed out|aborted|deadline exceeded/.test(lower)) {
    category = "timeout";
    suggestion =
      "The generation request did not complete within 15 seconds. Check relay latency and routing.";
  } else if (
    /fetch failed|enotfound|econnrefused|eai_again|socket|network|connection reset/.test(lower)
  ) {
    category = "network";
    suggestion =
      "Check DNS, proxy settings, TLS, and whether the endpoint is reachable from this machine.";
  } else if (
    /unexpected token|<!doctype|<html|invalid json|parse|stream ended|protocol/.test(lower)
  ) {
    category = "protocol";
    suggestion = `The response did not match ${provider.api}. Check the protocol selection and Base URL.`;
  } else if (
    /\b400\b|\b422\b|bad request|invalid_request|model.*required|unknown model/.test(lower)
  ) {
    category = "configuration";
    suggestion =
      provider.api === "openai-completions"
        ? "The relay rejected the Coding Agent request shape. Try System role and omit reasoning_effort in OpenAI compatibility."
        : "Check the model ID, protocol selection, and provider-specific request requirements.";
  }
  return { category, message, ...(suggestion ? { suggestion } : {}) };
}

async function checkProviderConnection(
  provider: ProviderSnapshot,
  model: Model<Api>,
  auth: Awaited<ReturnType<ModelRegistry["getApiKeyAndHeaders"]>>,
  signal: AbortSignal,
  authHeaderOverride?: boolean,
): Promise<ProviderConnectionResult> {
  const startedAt = Date.now();
  signal.throwIfAborted();
  if (!auth.ok) {
    const failure = classifyConnectionFailure(auth.error, provider, []);
    return {
      providerId: provider.id,
      modelId: model.id,
      api: provider.api,
      ok: false,
      latencyMs: Date.now() - startedAt,
      ...failure,
    };
  }
  const headers =
    authHeaderOverride === undefined
      ? auth.headers
      : headersForAuthMode(provider, auth.headers, auth.apiKey, authHeaderOverride);
  const sensitiveValues = providerSensitiveValues(auth.apiKey, headers ?? {});
  const context: Context = {
    systemPrompt: "You are validating a coding assistant Provider.",
    messages: [{ role: "user", content: "Reply with OK.", timestamp: Date.now() }],
    tools: [
      {
        name: "pideck_connection_test",
        description: "Return a diagnostic label for the Provider connection test.",
        parameters: {
          type: "object",
          properties: { label: { type: "string" } },
          required: ["label"],
          additionalProperties: false,
        } as never,
      },
    ],
  };
  try {
    const response = await completeSimple(model, context, {
      apiKey: auth.apiKey,
      headers,
      env: auth.env,
      maxTokens: 4,
      ...(model.reasoning ? { reasoning: "minimal" as const } : {}),
      signal,
      timeoutMs: 15_000,
      maxRetries: 0,
      maxRetryDelayMs: 0,
    });
    signal.throwIfAborted();
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      const failure = classifyConnectionFailure(
        response.errorMessage ?? `Generation ${response.stopReason}`,
        provider,
        sensitiveValues,
      );
      return {
        providerId: provider.id,
        modelId: model.id,
        api: provider.api,
        ok: false,
        latencyMs: Date.now() - startedAt,
        ...failure,
      };
    }
    return {
      providerId: provider.id,
      modelId: model.id,
      api: provider.api,
      ok: true,
      latencyMs: Date.now() - startedAt,
      category: "ok",
      message: `Generation succeeded with ${provider.api}.`,
    };
  } catch (error) {
    signal.throwIfAborted();
    const failure = classifyConnectionFailure(
      error instanceof Error ? error.message : String(error),
      provider,
      sensitiveValues,
    );
    return {
      providerId: provider.id,
      modelId: model.id,
      api: provider.api,
      ok: false,
      latencyMs: Date.now() - startedAt,
      ...failure,
    };
  }
}

async function persistDetectedAuthHeader(
  modelsPath: string,
  providerId: string,
  authHeader: boolean,
  expectedOriginal: string | null,
  expectedIdentity: HostIdentity,
  requestId: string,
  factory: WorkspaceGraphFactory,
): Promise<{ error: HostError } | { identity: HostIdentity }> {
  const conflict = providerMutationConflict(
    factory,
    [providerId],
    "Stop sessions using this Provider before applying detected authentication",
  );
  if (conflict) return { error: conflict };
  const server = factory.getServer();
  if (!server) throw new Error("Server not bound");
  return withRegisteredGraphMutation({
    server,
    operationKind: "provider.mutation",
    requestId,
    run: async ({ signal }) => {
      const conflictUnderLock = providerMutationConflict(
        factory,
        [providerId],
        "Stop sessions using this Provider before applying detected authentication",
      );
      if (conflictUnderLock) return { error: conflictUnderLock };
      const config = await readModelsConfig(modelsPath);
      const identity = server.getIdentity();
      if (
        config.original !== expectedOriginal ||
        !hostIdentitiesEqual(identity, expectedIdentity)
      ) {
        return {
          error: createHostError(
            "STALE_REVISION",
            "Provider configuration changed during connection testing",
            { retryable: true },
          ),
        };
      }
      const raw = config.providers[providerId];
      if (!isObject(raw)) throw new Error(`Provider not found: ${providerId}`);
      if (raw.authHeader === authHeader) return { identity };
      const retainedBusy = await invalidateRetainedRuntimes(factory);
      if (retainedBusy) return { error: retainedBusy };
      signal.throwIfAborted();
      raw.authHeader = authHeader;
      await commitModelsConfig(modelsPath, config.root, factory);
      try {
        await refreshRegistry(factory, true);
      } catch (error) {
        await restoreModelsConfig(modelsPath, config.original);
        await refreshRegistry(factory, true);
        throw error;
      }
      return { identity };
    },
  });
}

async function readModelsOriginalUnderLock(
  server: PiHostServer,
  modelsPath: string,
  requestId: string,
) {
  return withStableGraphRead({
    requestId,
    identity: server.identity,
    serviceGraphLock: server.serviceGraphLock,
    run: async () => (await readModelsConfig(modelsPath)).original,
  });
}

function hostShuttingDownError(): HostError {
  return createHostError("HOST_SHUTTING_DOWN", "Host is shutting down", {
    retryable: true,
  });
}

function hostIdentitiesEqual(left: HostIdentity, right: HostIdentity): boolean {
  return (
    left.hostInstanceId === right.hostInstanceId &&
    left.workspaceId === right.workspaceId &&
    left.workspaceRevision === right.workspaceRevision &&
    left.sessionId === right.sessionId &&
    left.sessionRevision === right.sessionRevision &&
    left.packageRevision === right.packageRevision
  );
}

function providerReadStaleError(args: {
  capturedIdentity: HostIdentity;
  validatedIdentity: HostIdentity;
  capturedOriginal: string | null;
  validatedOriginal: string | null;
  message: string;
}): HostError | null {
  if (
    hostIdentitiesEqual(args.capturedIdentity, args.validatedIdentity) &&
    args.capturedOriginal === args.validatedOriginal
  ) {
    return null;
  }
  return createHostError("STALE_REVISION", args.message, { retryable: true });
}

/** Toggle a custom or builtin provider in the enabled list; shared by the
 * setEnabled RPC and the login/logout flows. */
async function applyProviderEnabledMutation(
  factory: WorkspaceGraphFactory,
  modelsPath: string,
  requestId: string,
  providerId: string,
  enabled: boolean,
): Promise<
  | { result: { providerId: string; enabled: boolean }; identity?: HostIdentity }
  | { error: HostError; identity?: HostIdentity }
> {
  const conflict = providerMutationConflict(
    factory,
    [providerId],
    "Stop sessions using this Provider before changing whether it is enabled",
  );
  if (conflict) return { error: conflict };
  const server = factory.getServer();
  if (!server) return { error: createHostError("HOST_NOT_READY", "Server not bound") };
  return withRegisteredGraphMutation({
    server,
    operationKind: "provider.mutation",
    requestId,
    run: async ({ signal }) => {
      try {
        const conflictUnderLock = providerMutationConflict(
          factory,
          [providerId],
          "Stop sessions using this Provider before changing whether it is enabled",
        );
        if (conflictUnderLock) return { error: conflictUnderLock };
        const config = await readModelsConfig(modelsPath);
        const raw = config.providers[providerId];
        if (!isObject(raw) && !runtimeProviderIds(factory).includes(providerId)) {
          return { error: createHostError("MODEL_NOT_FOUND", `Provider not found: ${providerId}`) };
        }
        const retainedBusy = await invalidateRetainedRuntimes(factory);
        if (retainedBusy) return { error: retainedBusy };
        signal.throwIfAborted();
        const nextEnabled = new Set(
          resolveEnabledProviders(
            config,
            factory.getGraph()?.agentSession?.model?.provider,
            runtimeProviderIds(factory),
          ),
        );
        if (enabled && !providerHasEligibleModel(config, factory, providerId)) {
          return {
            error: createHostError(
              "INVALID_REQUEST",
              `Enable at least one model for Provider ${providerId} before enabling it`,
            ),
          };
        }
        if (enabled) nextEnabled.add(providerId);
        else nextEnabled.delete(providerId);
        config.root[ENABLED_PROVIDERS_KEY] = [...nextEnabled];
        delete config.root[LEGACY_ACTIVE_PROVIDER_KEY];
        await commitModelsConfig(modelsPath, config.root, factory);
        try {
          await refreshRegistry(factory, true);
          const preferredModelIds = new Map<string, string[]>();
          for (const targetProvider of nextEnabled) {
            const targetRaw = config.providers[targetProvider];
            const modelIds =
              isObject(targetRaw) && Array.isArray(targetRaw.models)
                ? targetRaw.models
                    .filter((model): model is JsonObject => isObject(model))
                    .map((model) => model.id)
                    .filter((id): id is string => typeof id === "string")
                : [];
            preferredModelIds.set(targetProvider, modelIds);
          }
          await reconcileIdleActiveSessionModel(factory, nextEnabled, {
            preferredModelIds,
            allowNoModel: !enabled && nextEnabled.size === 0,
          });
        } catch (error) {
          await restoreModelsConfig(modelsPath, config.original);
          await refreshRegistry(factory, true);
          throw error;
        }
        return { result: { providerId, enabled } };
      } catch (error) {
        return {
          error: createHostError(
            "SETTINGS_WRITE_FAILED",
            error instanceof Error ? error.message : "Could not update enabled Providers",
          ),
        };
      }
    },
  });
}

const LOGIN_FLOW_TIMEOUT_MS = 10 * 60_000;

type PendingLoginPrompt = {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
};

type ActiveLoginFlow = {
  loginId: string;
  providerId: string;
  controller: AbortController;
  pending: Map<string, PendingLoginPrompt>;
  timeout: NodeJS.Timeout;
  settled: boolean;
};

function asText(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  return value === undefined || value === null ? fallback : String(value);
}

export function createProviderHandlers(
  factory: WorkspaceGraphFactory,
): Partial<
  Record<
    | "provider.list"
    | "provider.setEnabled"
    | "provider.save"
    | "provider.remove"
    | "provider.fetchModels"
    | "provider.checkConnection"
    | "provider.authStatus"
    | "provider.loginStart"
    | "provider.loginRespond"
    | "provider.loginCancel"
    | "provider.logout"
    | "provider.builtinModels"
    | "provider.setBuiltinModels",
    MethodHandler
  >
> {
  const modelsPath = join(factory.deps.agentDir, "models.json");

  let activeLogin: ActiveLoginFlow | null = null;

  const loginInProgressError = (): HostError | null =>
    activeLogin
      ? createHostError(
          "AGENT_BUSY",
          "Wait for the active Provider login to finish before changing Provider credentials",
          { retryable: true },
        )
      : null;

  const unresolvedJournalLoginError = (): HostError | null => {
    const health = factory.deps.getModelConfigHealth();
    if (health.state !== "degraded" || health.source !== "provider.journal") return null;
    return createHostError(
      "SETTINGS_WRITE_FAILED",
      "Resolve the incomplete Provider mutation before signing in",
      {
        retryable: false,
        details: health.recovery ? { recovery: health.recovery } : undefined,
      },
    );
  };

  const emitLoginEvent = (flow: ActiveLoginFlow, event: ProviderLoginFlowEvent): void => {
    const server = factory.getServer();
    if (!server) return;
    try {
      server.emit("provider.loginEvent", {
        loginId: flow.loginId,
        providerId: flow.providerId,
        event,
      });
    } catch (error) {
      logger.warn("Could not publish Provider login event", {
        providerId: flow.providerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const notifyLoginEvent = (flow: ActiveLoginFlow, event: AuthEvent): void => {
    switch (event.type) {
      case "info": {
        const links = Array.isArray(event.links)
          ? event.links
              .filter((link) => typeof link?.url === "string")
              .map((link) => ({
                url: link.url,
                ...(typeof link.label === "string" ? { label: link.label } : {}),
              }))
          : [];
        emitLoginEvent(flow, {
          kind: "info",
          message: asText(event.message),
          ...(links.length > 0 ? { links } : {}),
        });
        return;
      }
      case "auth_url":
        emitLoginEvent(flow, {
          kind: "auth_url",
          url: asText(event.url),
          ...(typeof event.instructions === "string" ? { instructions: event.instructions } : {}),
        });
        return;
      case "device_code":
        emitLoginEvent(flow, {
          kind: "device_code",
          userCode: asText(event.userCode),
          verificationUri: asText(event.verificationUri),
          ...(typeof event.expiresInSeconds === "number" &&
          Number.isSafeInteger(event.expiresInSeconds) &&
          event.expiresInSeconds >= 0
            ? { expiresInSeconds: event.expiresInSeconds }
            : {}),
        });
        return;
      case "progress":
        emitLoginEvent(flow, { kind: "progress", message: asText(event.message) });
        return;
      default:
        return;
    }
  };

  const bridgeLoginPrompt = (flow: ActiveLoginFlow, prompt: AuthPrompt): Promise<string> => {
    const promptId = randomUUID();
    return new Promise<string>((resolve, reject) => {
      flow.pending.set(promptId, { resolve, reject });
      prompt.signal?.addEventListener("abort", () => {
        if (flow.pending.delete(promptId)) {
          emitLoginEvent(flow, { kind: "prompt_cancel", promptId });
          reject(new Error("Login prompt superseded"));
        }
      });
      const options =
        prompt.type === "select"
          ? prompt.options.map((option) => ({
              id: asText(option.id),
              label: asText(option.label, asText(option.id)),
              ...(typeof option.description === "string"
                ? { description: option.description }
                : {}),
            }))
          : undefined;
      emitLoginEvent(flow, {
        kind: "prompt",
        prompt: {
          promptId,
          kind: prompt.type,
          message: asText(prompt.message),
          ...("placeholder" in prompt && typeof prompt.placeholder === "string"
            ? { placeholder: prompt.placeholder }
            : {}),
          ...(options ? { options } : {}),
        },
      });
    });
  };

  const cancelLoginFlow = (flow: ActiveLoginFlow, reason: string): void => {
    if (flow.settled) return;
    flow.controller.abort(new Error(reason));
    for (const [promptId, pending] of [...flow.pending]) {
      flow.pending.delete(promptId);
      pending.reject(new Error(reason));
    }
  };

  const finishLoginFlow = (flow: ActiveLoginFlow): void => {
    flow.settled = true;
    clearTimeout(flow.timeout);
    for (const [promptId, pending] of [...flow.pending]) {
      flow.pending.delete(promptId);
      pending.reject(new Error("Login finished"));
    }
    if (activeLogin === flow) activeLogin = null;
  };

  const runLoginFlow = async (
    flow: ActiveLoginFlow,
    authType: "oauth" | "api_key",
  ): Promise<void> => {
    const interaction: AuthInteraction = {
      signal: flow.controller.signal,
      prompt: (prompt) => bridgeLoginPrompt(flow, prompt),
      notify: (event) => notifyLoginEvent(flow, event),
    };
    try {
      await factory.deps.modelRuntime.login(flow.providerId, authType, interaction);
      let note: string | undefined;
      const enabled = await applyProviderEnabledMutation(
        factory,
        modelsPath,
        flow.loginId,
        flow.providerId,
        true,
      );
      if ("error" in enabled) {
        note = `Signed in, but the Provider could not be enabled automatically: ${enabled.error.message}`;
        logger.warn("Provider auto-enable after login failed", {
          providerId: flow.providerId,
          error: enabled.error.message,
        });
      }
      emitLoginEvent(flow, { kind: "done", ok: true, ...(note ? { message: note } : {}) });
    } catch (error) {
      const cancelled = flow.controller.signal.aborted;
      emitLoginEvent(flow, {
        kind: "done",
        ok: false,
        message: cancelled
          ? "Login cancelled"
          : error instanceof Error && error.message
            ? error.message
            : "Login failed",
      });
    } finally {
      finishLoginFlow(flow);
    }
  };

  return {
    "provider.list": async (ctx) => {
      const server = factory.getServer();
      if (!server) return { error: createHostError("HOST_NOT_READY", "Server not bound") };
      const out = await withStableGraphRead({
        requestId: ctx.id,
        identity: server.identity,
        serviceGraphLock: server.serviceGraphLock,
        run: async () => {
          await refreshRegistry(factory);
          const config = await readModelsConfig(modelsPath);
          const enabledProviders = new Set(
            resolveEnabledProviders(
              config,
              factory.getGraph()?.agentSession?.model?.provider,
              runtimeProviderIds(factory),
            ),
          );
          const providers = Object.entries(config.providers)
            .filter((entry): entry is [string, JsonObject] => isObject(entry[1]))
            .map(([id, raw]) => providerSnapshot(id, raw, factory, enabledProviders.has(id)))
            .sort((left, right) => left.name.localeCompare(right.name));
          // Proves the migrated runtime can still compose the user's providers.
          await factory.deps.recordMigrationMilestone?.("providerSnapshot");
          return { providers };
        },
      });
      if (!out.ok) {
        if (out.error.code === "INTERNAL_ERROR") {
          return {
            error: createHostError("SETTINGS_READ_FAILED", out.error.message),
            identity: out.identity,
          };
        }
        return { error: out.error, identity: out.identity };
      }
      return { result: out.result, identity: out.identity };
    },

    "provider.setEnabled": async (ctx) => {
      const { providerId, enabled } = ctx.params as { providerId: string; enabled: boolean };
      return applyProviderEnabledMutation(factory, modelsPath, ctx.id, providerId, enabled);
    },

    "provider.save": async (ctx) => {
      const params = ctx.params as {
        originalId?: string;
        provider: ProviderDraft;
        apiKey?: string;
        clearApiKey?: boolean;
      };
      const draft = normalizeDraft(params.provider);
      const originalId = params.originalId?.trim() || draft.id;
      const invalid = validateDraft(draft);
      if (invalid) return { error: invalid };
      const conflict = providerMutationConflict(
        factory,
        [originalId, draft.id],
        "Stop sessions using this Provider before changing its configuration",
      );
      if (conflict) return { error: conflict };
      const server = factory.getServer();
      if (!server) return { error: createHostError("HOST_NOT_READY", "Server not bound") };
      return withRegisteredGraphMutation({
        server,
        operationKind: "provider.mutation",
        requestId: ctx.id,
        run: async ({ signal }) => {
          try {
            const loginConflict = loginInProgressError();
            if (loginConflict) return { error: loginConflict };
            const conflictUnderLock = providerMutationConflict(
              factory,
              [originalId, draft.id],
              "Stop sessions using this Provider before changing its configuration",
            );
            if (conflictUnderLock) return { error: conflictUnderLock };
            const config = await readModelsConfig(modelsPath);
            const currentProvider = factory.getGraph()?.agentSession?.model?.provider;
            const enabledBefore = resolveEnabledProviders(
              config,
              currentProvider,
              runtimeProviderIds(factory),
            );
            const wasFirstProvider = Object.keys(config.providers).length === 0;
            if (draft.id !== originalId && config.providers[draft.id] !== undefined) {
              return {
                error: createHostError("INVALID_REQUEST", `Provider already exists: ${draft.id}`),
              };
            }
            const existing = isObject(config.providers[originalId])
              ? config.providers[originalId]
              : {};
            const retainedBusy = await invalidateRetainedRuntimes(factory);
            if (retainedBusy) return { error: retainedBusy };
            signal.throwIfAborted();
            const merged = mergeProvider(existing, draft);
            if (params.apiKey !== undefined || params.clearApiKey === true) delete merged.apiKey;
            if (draft.id !== originalId) delete config.providers[originalId];
            config.providers[draft.id] = merged;
            const enabledAfter = enabledBefore.map((id) => (id === originalId ? draft.id : id));
            if (wasFirstProvider && draft.models.length > 0 && !enabledAfter.includes(draft.id)) {
              enabledAfter.push(draft.id);
            }
            if (enabledAfter.includes(draft.id) && draft.models.length === 0) {
              return {
                error: createHostError(
                  "INVALID_REQUEST",
                  `Enable at least one model for Provider ${draft.id} before saving it as enabled`,
                ),
              };
            }
            const enabledProvidersChanged =
              enabledAfter.length !== enabledBefore.length ||
              enabledAfter.some((providerId) => !enabledBefore.includes(providerId));
            const currentProviderChanged =
              currentProvider === originalId || currentProvider === draft.id;
            config.root[ENABLED_PROVIDERS_KEY] = [...new Set(enabledAfter)];
            delete config.root[LEGACY_ACTIVE_PROVIDER_KEY];

            const credentialStore = factory.deps.credentialStore;
            // Raw, not resolved: a renamed provider must carry its stored form.
            const oldSourceCredential = await credentialStore.readRaw(originalId);
            // Durable pre-mutation copies. models.json and auth.json cannot be
            // written atomically together, so a crash between them is only
            // detectable if the original bytes survive on disk.
            const journal = await ProviderMutationJournal.begin({
              agentDir: factory.deps.agentDir,
              operation: "provider.save",
              providerId: draft.id,
              modelsPath,
              modelsBytes: config.original,
              credentialStore,
            });
            await commitModelsConfig(modelsPath, config.root, factory);
            try {
              const newApiKey = params.apiKey;
              if (params.clearApiKey) {
                await credentialStore.delete(draft.id);
              } else if (newApiKey !== undefined) {
                await credentialStore.modify(draft.id, async () => ({
                  type: "api_key",
                  key: newApiKey,
                }));
              } else if (draft.id !== originalId && oldSourceCredential) {
                await credentialStore.modify(draft.id, async () => oldSourceCredential);
              }
              if (draft.id !== originalId) await credentialStore.delete(originalId);
              // Both durable writes landed; only reconciliation is left.
              await journal.markCommitted();
              await refreshRegistry(factory, true);
              if (enabledProvidersChanged || currentProviderChanged) {
                await reconcileIdleActiveSessionModel(factory, enabledAfter, {
                  ...(draft.id !== originalId
                    ? { remapProvider: { from: originalId, to: draft.id } }
                    : {}),
                  preferredModelIds: new Map([[draft.id, draft.models.map((model) => model.id)]]),
                });
              }
            } catch (error) {
              // Restores both files from the journal copies. A journal that
              // survives this means recovery failed and startup will report
              // degraded configuration health.
              await journal.rollback();
              await refreshRegistry(factory, true);
              throw error;
            }
            await journal.finish();
            const enabledProviders = new Set(
              resolveEnabledProviders(config, undefined, runtimeProviderIds(factory)),
            );
            return {
              result: {
                provider: providerSnapshot(
                  draft.id,
                  merged,
                  factory,
                  enabledProviders.has(draft.id),
                ),
              },
            };
          } catch (error) {
            return {
              error: createHostError(
                "SETTINGS_WRITE_FAILED",
                error instanceof Error ? error.message : "Could not save Provider configuration",
              ),
            };
          }
        },
      });
    },

    "provider.remove": async (ctx) => {
      const { providerId } = ctx.params as { providerId: string };
      const conflict = providerMutationConflict(
        factory,
        [providerId],
        "Stop sessions using this Provider before deleting it",
      );
      if (conflict) return { error: conflict };
      const server = factory.getServer();
      if (!server) return { error: createHostError("HOST_NOT_READY", "Server not bound") };
      return withRegisteredGraphMutation({
        server,
        operationKind: "provider.mutation",
        requestId: ctx.id,
        run: async ({ signal }) => {
          try {
            const loginConflict = loginInProgressError();
            if (loginConflict) return { error: loginConflict };
            const conflictUnderLock = providerMutationConflict(
              factory,
              [providerId],
              "Stop sessions using this Provider before deleting it",
            );
            if (conflictUnderLock) return { error: conflictUnderLock };
            const config = await readModelsConfig(modelsPath);
            if (config.providers[providerId] === undefined) {
              return {
                error: createHostError("MODEL_NOT_FOUND", `Provider not found: ${providerId}`),
              };
            }
            const retainedBusy = await invalidateRetainedRuntimes(factory);
            if (retainedBusy) return { error: retainedBusy };
            signal.throwIfAborted();
            const enabledBefore = resolveEnabledProviders(
              config,
              factory.getGraph()?.agentSession?.model?.provider,
              runtimeProviderIds(factory),
            );
            delete config.providers[providerId];
            const enabledAfter = enabledBefore.filter((id) => id !== providerId);
            config.root[ENABLED_PROVIDERS_KEY] = enabledAfter;
            delete config.root[LEGACY_ACTIVE_PROVIDER_KEY];
            const journal = await ProviderMutationJournal.begin({
              agentDir: factory.deps.agentDir,
              operation: "provider.remove",
              providerId,
              modelsPath,
              modelsBytes: config.original,
              credentialStore: factory.deps.credentialStore,
            });
            await commitModelsConfig(modelsPath, config.root, factory);
            try {
              await factory.deps.credentialStore.delete(providerId);
              await journal.markCommitted();
              await refreshRegistry(factory, true);
              await reconcileIdleActiveSessionModel(factory, enabledAfter, {
                allowNoModel: enabledAfter.length === 0,
              });
            } catch (error) {
              await journal.rollback();
              await refreshRegistry(factory, true);
              throw error;
            }
            await journal.finish();
            return { result: { providerId, removed: true as const } };
          } catch (error) {
            return {
              error: createHostError(
                "SETTINGS_WRITE_FAILED",
                error instanceof Error ? error.message : "Could not delete Provider",
              ),
            };
          }
        },
      });
    },

    "provider.fetchModels": async (ctx) => {
      const { providerId } = ctx.params as { providerId: string };
      const server = factory.getServer();
      if (!server) return { error: createHostError("HOST_NOT_READY", "Server not bound") };
      const shutdownSignal = server.getShutdownSignal();
      try {
        shutdownSignal.throwIfAborted();
        const captured = await withStableGraphRead({
          requestId: ctx.id,
          identity: server.identity,
          serviceGraphLock: server.serviceGraphLock,
          run: async (): Promise<ProviderFetchCapture> => {
            const config = await readModelsConfig(modelsPath);
            const raw = config.providers[providerId];
            if (!isObject(raw)) {
              return {
                error: createHostError("MODEL_NOT_FOUND", `Provider not found: ${providerId}`),
              };
            }
            const provider = providerSnapshot(
              providerId,
              raw,
              factory,
              resolveEnabledProviders(
                config,
                factory.getGraph()?.agentSession?.model?.provider,
                runtimeProviderIds(factory),
              ).includes(providerId),
            );
            if (!provider.baseUrl) {
              return { error: createHostError("INVALID_REQUEST", "Provider Base URL is required") };
            }
            const apiKey = await factory.deps.modelRegistry.getApiKeyForProvider(providerId);
            return { snapshot: { original: config.original, provider, apiKey } };
          },
        });
        if (!captured.ok) return { error: captured.error, identity: captured.identity };
        if (!("snapshot" in captured.result)) {
          return { error: captured.result.error, identity: captured.identity };
        }

        const { original, provider, apiKey } = captured.result.snapshot;
        const models = await discoverModels(provider, apiKey, shutdownSignal);
        const validated = await readModelsOriginalUnderLock(server, modelsPath, ctx.id);
        if (!validated.ok) return { error: validated.error, identity: validated.identity };
        const stale = providerReadStaleError({
          capturedIdentity: captured.identity,
          validatedIdentity: validated.identity,
          capturedOriginal: original,
          validatedOriginal: validated.result,
          message: "Provider configuration changed while fetching models",
        });
        if (stale) {
          return {
            error: stale,
            identity: validated.identity,
          };
        }
        return { result: { providerId, models }, identity: validated.identity };
      } catch (error) {
        if (shutdownSignal.aborted) return { error: hostShuttingDownError() };
        return {
          error: createHostError(
            "INTERNAL_ERROR",
            error instanceof Error ? error.message : "Could not fetch Provider models",
            { retryable: true },
          ),
        };
      }
    },

    "provider.checkConnection": async (ctx) => {
      const { providerId, modelId } = ctx.params as { providerId: string; modelId?: string };
      const server = factory.getServer();
      if (!server) return { error: createHostError("HOST_NOT_READY", "Server not bound") };
      const shutdownSignal = server.getShutdownSignal();
      try {
        shutdownSignal.throwIfAborted();
        const captured = await withStableGraphRead({
          requestId: ctx.id,
          identity: server.identity,
          serviceGraphLock: server.serviceGraphLock,
          run: async (): Promise<ProviderConnectionCapture> => {
            await refreshRegistry(factory);
            const config = await readModelsConfig(modelsPath);
            const raw = config.providers[providerId];
            if (!isObject(raw)) {
              return {
                error: createHostError("MODEL_NOT_FOUND", `Provider not found: ${providerId}`),
              };
            }
            const provider = providerSnapshot(
              providerId,
              raw,
              factory,
              resolveEnabledProviders(
                config,
                factory.getGraph()?.agentSession?.model?.provider,
                runtimeProviderIds(factory),
              ).includes(providerId),
            );
            const targetModelId = modelId?.trim() || provider.models[0]?.id;
            if (!targetModelId) {
              return {
                error: createHostError(
                  "INVALID_REQUEST",
                  "Add and enable at least one model before testing the Provider",
                ),
              };
            }
            const model = factory.deps.modelRegistry.find(providerId, targetModelId);
            if (!model) {
              return {
                error: createHostError(
                  "MODEL_NOT_FOUND",
                  `Model not found in Provider ${providerId}: ${targetModelId}`,
                ),
              };
            }
            const auth = await factory.deps.modelRegistry.getApiKeyAndHeaders(model);
            return { snapshot: { original: config.original, provider, model, auth } };
          },
        });
        if (!captured.ok) return { error: captured.error, identity: captured.identity };
        if (!("snapshot" in captured.result)) {
          return { error: captured.result.error, identity: captured.identity };
        }

        const { original, provider, model, auth } = captured.result.snapshot;
        const result = await checkProviderConnection(provider, model, auth, shutdownSignal);
        if (result.category !== "authentication" || hasHeader(provider.headers, "authorization")) {
          const validated = await readModelsOriginalUnderLock(server, modelsPath, ctx.id);
          if (!validated.ok) return { error: validated.error, identity: validated.identity };
          const stale = providerReadStaleError({
            capturedIdentity: captured.identity,
            validatedIdentity: validated.identity,
            capturedOriginal: original,
            validatedOriginal: validated.result,
            message: "Provider configuration changed during connection testing",
          });
          if (stale) {
            return {
              error: stale,
              identity: validated.identity,
            };
          }
          return { result, identity: validated.identity };
        }
        const detectedAuthHeader = !provider.authHeader;
        const retry = await checkProviderConnection(
          provider,
          model,
          auth,
          shutdownSignal,
          detectedAuthHeader,
        );
        if (!retry.ok) {
          const validated = await readModelsOriginalUnderLock(server, modelsPath, ctx.id);
          if (!validated.ok) return { error: validated.error, identity: validated.identity };
          const stale = providerReadStaleError({
            capturedIdentity: captured.identity,
            validatedIdentity: validated.identity,
            capturedOriginal: original,
            validatedOriginal: validated.result,
            message: "Provider configuration changed during connection testing",
          });
          if (stale) {
            return {
              error: stale,
              identity: validated.identity,
            };
          }
          return { result, identity: validated.identity };
        }
        shutdownSignal.throwIfAborted();
        const persistence = await persistDetectedAuthHeader(
          modelsPath,
          providerId,
          detectedAuthHeader,
          original,
          captured.identity,
          ctx.id,
          factory,
        );
        if ("error" in persistence) return persistence;
        return {
          result: {
            ...retry,
            message: `${retry.message} Authentication mode was detected automatically.`,
          },
          identity: persistence.identity,
        };
      } catch (error) {
        if (shutdownSignal.aborted) return { error: hostShuttingDownError() };
        return {
          error: createHostError(
            "INTERNAL_ERROR",
            error instanceof Error ? error.message : "Could not test Provider connection",
            { retryable: true },
          ),
        };
      }
    },

    "provider.authStatus": async () => {
      try {
        const config = await readModelsConfig(modelsPath);
        const customIds = new Set(
          Object.entries(config.providers)
            .filter((entry): entry is [string, JsonObject] => isObject(entry[1]))
            .map(([id]) => id),
        );
        const runtime = factory.deps.modelRuntime;
        const stored = new Set(
          (await runtime.listCredentials()).map((credential) => credential.providerId),
        );
        const enabled = new Set(
          resolveEnabledProviders(
            config,
            factory.getGraph()?.agentSession?.model?.provider,
            runtimeProviderIds(factory),
          ),
        );
        const providers: BuiltinProviderAuthStatus[] = runtime
          .getProviders()
          .filter((provider) => !customIds.has(provider.id))
          .filter(
            (provider) =>
              provider.auth?.oauth !== undefined ||
              typeof provider.auth?.apiKey?.login === "function",
          )
          .map((provider) => {
            const status = factory.deps.modelRegistry.getProviderAuthStatus(provider.id);
            const oauth = provider.auth?.oauth;
            return {
              providerId: provider.id,
              name: asText(provider.name, provider.id),
              supportsOauth: oauth !== undefined,
              ...(typeof oauth?.name === "string" ? { oauthLabel: oauth.name } : {}),
              supportsApiKeyLogin: typeof provider.auth?.apiKey?.login === "function",
              configured: status.configured,
              ...(typeof status.label === "string" ? { authLabel: status.label } : {}),
              hasStoredCredential: stored.has(provider.id),
              enabled: enabled.has(provider.id),
            };
          })
          .sort((left, right) => left.name.localeCompare(right.name));
        return { result: { providers } };
      } catch (error) {
        return {
          error: createHostError(
            "SETTINGS_READ_FAILED",
            error instanceof Error ? error.message : "Could not read Provider login status",
          ),
        };
      }
    },

    "provider.loginStart": async (ctx) => {
      const { providerId, authType } = ctx.params as {
        providerId: string;
        authType: "oauth" | "api_key";
      };
      const server = factory.getServer();
      if (!server) return { error: createHostError("HOST_NOT_READY", "Server not bound") };
      let admittedFlow: ActiveLoginFlow | null = null;
      const admission = await withStableGraphRead({
        requestId: ctx.id,
        identity: server.identity,
        serviceGraphLock: server.serviceGraphLock,
        run: async (): Promise<{ flow: ActiveLoginFlow } | { error: HostError }> => {
          const loginConflict = loginInProgressError();
          if (loginConflict) return { error: loginConflict };
          const recoveryConflict = unresolvedJournalLoginError();
          if (recoveryConflict) return { error: recoveryConflict };

          const provider = factory.deps.modelRuntime
            .getProviders()
            .find((candidate) => candidate.id === providerId);
          if (!provider) {
            return {
              error: createHostError("MODEL_NOT_FOUND", `Provider not found: ${providerId}`),
            };
          }
          const supported =
            authType === "oauth"
              ? provider.auth?.oauth !== undefined
              : typeof provider.auth?.apiKey?.login === "function";
          if (!supported) {
            return {
              error: createHostError(
                "INVALID_REQUEST",
                `Provider ${providerId} does not support ${authType === "oauth" ? "OAuth" : "API key"} login`,
              ),
            };
          }
          const flow: ActiveLoginFlow = {
            loginId: randomUUID(),
            providerId,
            controller: new AbortController(),
            pending: new Map(),
            timeout: setTimeout(() => {
              if (activeLogin) cancelLoginFlow(activeLogin, "Login timed out");
            }, LOGIN_FLOW_TIMEOUT_MS),
            settled: false,
          };
          flow.timeout.unref?.();
          activeLogin = flow;
          admittedFlow = flow;
          return { flow };
        },
      });
      if (!admission.ok) {
        if (admittedFlow && activeLogin === admittedFlow) finishLoginFlow(admittedFlow);
        return { error: admission.error, identity: admission.identity };
      }
      if ("error" in admission.result) {
        return { error: admission.result.error, identity: admission.identity };
      }
      const { flow } = admission.result;
      void runLoginFlow(flow, authType);
      return {
        result: { loginId: flow.loginId, providerId },
        identity: admission.identity,
      };
    },

    "provider.loginRespond": async (ctx) => {
      const { loginId, promptId, value } = ctx.params as {
        loginId: string;
        promptId: string;
        value: string;
      };
      const flow = activeLogin;
      if (!flow || flow.loginId !== loginId) {
        return { error: createHostError("INVALID_REQUEST", "Login flow is no longer active") };
      }
      const pending = flow.pending.get(promptId);
      if (!pending) {
        return {
          error: createHostError("INVALID_REQUEST", "Login prompt is no longer waiting for input"),
        };
      }
      flow.pending.delete(promptId);
      pending.resolve(value);
      return { result: { accepted: true as const } };
    },

    "provider.loginCancel": async (ctx) => {
      const { loginId } = ctx.params as { loginId: string };
      const flow = activeLogin;
      if (flow && flow.loginId === loginId) cancelLoginFlow(flow, "Login cancelled");
      return { result: { accepted: true as const } };
    },

    "provider.logout": async (ctx) => {
      const { providerId } = ctx.params as { providerId: string };
      const conflict = providerMutationConflict(
        factory,
        [providerId],
        "Stop sessions using this Provider before logging out",
      );
      if (conflict) return { error: conflict };
      const server = factory.getServer();
      if (!server) return { error: createHostError("HOST_NOT_READY", "Server not bound") };
      return withRegisteredGraphMutation({
        server,
        operationKind: "provider.mutation",
        requestId: ctx.id,
        run: async ({ signal }) => {
          try {
            const loginConflict = loginInProgressError();
            if (loginConflict) return { error: loginConflict };
            const conflictUnderLock = providerMutationConflict(
              factory,
              [providerId],
              "Stop sessions using this Provider before logging out",
            );
            if (conflictUnderLock) return { error: conflictUnderLock };
            const stored = await factory.deps.credentialStore.readRaw(providerId);
            if (!stored) {
              return {
                error: createHostError(
                  "INVALID_REQUEST",
                  `No stored credential to log out for Provider: ${providerId}`,
                ),
              };
            }
            const config = await readModelsConfig(modelsPath);
            const retainedBusy = await invalidateRetainedRuntimes(factory);
            if (retainedBusy) return { error: retainedBusy };
            signal.throwIfAborted();
            const nextEnabled = new Set(
              resolveEnabledProviders(
                config,
                factory.getGraph()?.agentSession?.model?.provider,
                runtimeProviderIds(factory),
              ),
            );
            nextEnabled.delete(providerId);
            config.root[ENABLED_PROVIDERS_KEY] = [...nextEnabled];
            delete config.root[LEGACY_ACTIVE_PROVIDER_KEY];
            const journal = await ProviderMutationJournal.begin({
              agentDir: factory.deps.agentDir,
              operation: "provider.logout",
              providerId,
              modelsPath,
              modelsBytes: config.original,
              credentialStore: factory.deps.credentialStore,
            });
            await commitModelsConfig(modelsPath, config.root, factory);
            try {
              await factory.deps.credentialStore.delete(providerId);
              await journal.markCommitted();
              await refreshRegistry(factory, true);
              await reconcileIdleActiveSessionModel(factory, nextEnabled, {
                allowNoModel: nextEnabled.size === 0,
              });
            } catch (error) {
              await journal.rollback();
              await refreshRegistry(factory, true);
              throw error;
            }
            await journal.finish();
            return { result: { providerId, loggedOut: true as const } };
          } catch (error) {
            return {
              error: createHostError(
                "SETTINGS_WRITE_FAILED",
                error instanceof Error ? error.message : "Could not log out of the Provider",
              ),
            };
          }
        },
      });
    },

    "provider.builtinModels": async (ctx) => {
      const { providerId } = ctx.params as { providerId: string };
      try {
        const runtime = factory.deps.modelRuntime;
        if (!runtime.getProviders().some((candidate) => candidate.id === providerId)) {
          return { error: createHostError("MODEL_NOT_FOUND", `Provider not found: ${providerId}`) };
        }
        const config = await readModelsConfig(modelsPath);
        if (isObject(config.providers[providerId])) {
          return {
            error: createHostError(
              "INVALID_REQUEST",
              `Provider ${providerId} is a custom Provider; edit its model list instead`,
            ),
          };
        }
        const allow = readProviderModelAllowLists(config)[providerId];
        const allowSet = allow ? new Set(allow) : undefined;
        const models = runtime
          .getModels(providerId)
          .map((model) => ({
            id: model.id,
            name: asText(model.name, model.id),
            enabled: !allowSet || allowSet.has(model.id),
          }))
          .sort((left, right) => left.id.localeCompare(right.id));
        return { result: { providerId, models } };
      } catch (error) {
        return {
          error: createHostError(
            "SETTINGS_READ_FAILED",
            error instanceof Error ? error.message : "Could not read the Provider model list",
          ),
        };
      }
    },

    "provider.setBuiltinModels": async (ctx) => {
      const { providerId, modelIds } = ctx.params as { providerId: string; modelIds: string[] };
      const server = factory.getServer();
      if (!server) return { error: createHostError("HOST_NOT_READY", "Server not bound") };
      return withRegisteredGraphMutation({
        server,
        operationKind: "provider.mutation",
        requestId: ctx.id,
        run: async ({ signal }) => {
          try {
            const conflict = providerMutationConflict(
              factory,
              [providerId],
              "Stop sessions using this Provider before changing its model list",
            );
            if (conflict) return { error: conflict };
            const runtime = factory.deps.modelRuntime;
            if (!runtime.getProviders().some((candidate) => candidate.id === providerId)) {
              return {
                error: createHostError("MODEL_NOT_FOUND", `Provider not found: ${providerId}`),
              };
            }
            const config = await readModelsConfig(modelsPath);
            if (isObject(config.providers[providerId])) {
              return {
                error: createHostError(
                  "INVALID_REQUEST",
                  `Provider ${providerId} is a custom Provider; edit its model list instead`,
                ),
              };
            }
            signal.throwIfAborted();
            const catalog = runtime.getModels(providerId);
            const catalogIds = new Set(catalog.map((model) => model.id));
            const selected = new Set(modelIds.filter((id) => catalogIds.has(id)));
            const lists = readProviderModelAllowLists(config);
            const enabledProviders = resolveEnabledProviders(
              config,
              factory.getGraph()?.agentSession?.model?.provider,
              runtimeProviderIds(factory),
            );
            if (enabledProviders.includes(providerId) && selected.size === 0) {
              return {
                error: createHostError(
                  "INVALID_REQUEST",
                  `Enable at least one model for Provider ${providerId} while it is enabled`,
                ),
              };
            }
            // A full selection means "no filter": drop the entry so models the
            // provider adds later stay visible without another save.
            if (selected.size === catalogIds.size) delete lists[providerId];
            else lists[providerId] = [...selected];
            if (Object.keys(lists).length === 0) delete config.root[PROVIDER_MODELS_KEY];
            else config.root[PROVIDER_MODELS_KEY] = lists;
            await commitModelsConfig(modelsPath, config.root, factory);
            try {
              const preferredModelIds = new Map<string, string[]>(Object.entries(lists));
              preferredModelIds.set(providerId, [...selected]);
              const currentProvider = factory.getGraph()?.agentSession?.model?.provider;
              if (enabledProviders.includes(providerId) || currentProvider === providerId) {
                await reconcileIdleActiveSessionModel(factory, enabledProviders, {
                  preferredModelIds,
                  allowedModelIds: new Map(
                    Object.entries(lists).map(([id, ids]) => [id, new Set(ids)]),
                  ),
                });
              }
            } catch (error) {
              await restoreModelsConfig(modelsPath, config.original);
              throw error;
            }
            const models = catalog
              .map((model) => ({
                id: model.id,
                name: asText(model.name, model.id),
                enabled: selected.size === catalogIds.size || selected.has(model.id),
              }))
              .sort((left, right) => left.id.localeCompare(right.id));
            return { result: { providerId, models } };
          } catch (error) {
            return {
              error: createHostError(
                "SETTINGS_WRITE_FAILED",
                error instanceof Error ? error.message : "Could not update the Provider model list",
              ),
            };
          }
        },
      });
    },
  };
}
