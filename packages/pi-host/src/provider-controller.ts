import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  createHostError,
  detectModelThinking,
  type DiscoveredProviderModel,
  type HostError,
  type ProviderApi,
  type ProviderDraft,
  type ProviderModelConfig,
  type ProviderSnapshot,
  type ThinkingLevel,
  type ThinkingLevelMap,
} from "@pideck/protocol";
import type { MethodHandler } from "./server.js";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";
import { rebindCurrentSessionModel } from "./model-thinking.js";

type JsonObject = Record<string, unknown>;
type ModelsConfig = { root: JsonObject; providers: JsonObject; original: string | null };
const ENABLED_PROVIDERS_KEY = "pideckEnabledProviders";
const LEGACY_ACTIVE_PROVIDER_KEY = "pideckActiveProvider";

const PROVIDER_APIS = new Set<ProviderApi>([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
]);

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
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
      typeof value.contextWindow === "number" && Number.isSafeInteger(value.contextWindow) && value.contextWindow > 0
        ? value.contextWindow
        : 128_000,
    maxTokens:
      typeof value.maxTokens === "number" && Number.isSafeInteger(value.maxTokens) && value.maxTokens > 0
        ? value.maxTokens
        : 16_384,
  };
}

function normalizeDraft(input: ProviderDraft): ProviderDraft {
  const models = new Map<string, ProviderModelConfig>();
  for (const item of input.models) {
    const model = normalizeModel(item);
    if (model) models.set(model.id, model);
  }
  return {
    id: input.id.trim(),
    name: input.name.trim(),
    baseUrl: input.baseUrl.trim().replace(/\/+$/, ""),
    api: input.api,
    authHeader: input.authHeader,
    headers: Object.fromEntries(
      Object.entries(input.headers)
        .map(([key, value]) => [key.trim(), value.trim()] as const)
        .filter(([key]) => key.length > 0),
    ),
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
  return null;
}

async function readModelsConfig(path: string): Promise<ModelsConfig> {
  let original: string | null = null;
  try {
    original = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (original === null || !original.trim()) {
    const providers: JsonObject = {};
    return { root: { providers }, providers, original };
  }
  const parsed = JSON.parse(original) as unknown;
  if (!isObject(parsed)) throw new Error("models.json root must be an object");
  const providers = parsed.providers;
  if (providers === undefined) {
    const next: JsonObject = {};
    parsed.providers = next;
    return { root: parsed, providers: next, original };
  }
  if (!isObject(providers)) throw new Error("models.json providers must be an object");
  return { root: parsed, providers, original };
}

function resolveEnabledProviders(config: ModelsConfig, preferredProvider?: string): string[] {
  const providerIds = Object.entries(config.providers)
    .filter((entry): entry is [string, JsonObject] => isObject(entry[1]))
    .map(([id]) => id);
  if (providerIds.length === 0) return [];
  const configured = config.root[ENABLED_PROVIDERS_KEY];
  if (Array.isArray(configured)) {
    return [...new Set(configured.filter((id): id is string => typeof id === "string" && providerIds.includes(id)))];
  }
  const legacyActive = config.root[LEGACY_ACTIVE_PROVIDER_KEY];
  if (typeof legacyActive === "string" && providerIds.includes(legacyActive)) return [legacyActive];
  if (preferredProvider && providerIds.includes(preferredProvider)) return [preferredProvider];
  const fallback = providerIds.find((id) => {
    const provider = config.providers[id];
    return isObject(provider) && Array.isArray(provider.models) && provider.models.length > 0;
  }) ?? providerIds[0];
  return fallback ? [fallback] : [];
}

export async function getEnabledProviderIds(
  agentDir: string,
  preferredProvider?: string,
): Promise<string[] | undefined> {
  try {
    const config = await readModelsConfig(join(agentDir, "models.json"));
    if (!Object.values(config.providers).some(isObject)) return undefined;
    return resolveEnabledProviders(config, preferredProvider);
  } catch {
    return undefined;
  }
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
  return {
    id,
    enabled,
    name:
      typeof raw.name === "string" && raw.name.trim()
        ? raw.name.trim()
        : factory.deps.modelRegistry.getProviderDisplayName(id),
    baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : "",
    api,
    authHeader: raw.authHeader === true,
    headers: stringRecord(raw.headers),
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
  return {
    ...existing,
    name: draft.name,
    baseUrl: draft.baseUrl,
    api: draft.api,
    authHeader: draft.authHeader,
    headers: draft.headers,
    models,
  };
}

async function commitModelsConfig(
  path: string,
  root: JsonObject,
  factory: WorkspaceGraphFactory,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const candidate = JSON.stringify(root, null, 2) + "\n";
  const tempPath = join(dirname(path), `.models-${randomUUID()}.tmp`);
  const backupPath = join(dirname(path), `models-${Date.now()}-${randomUUID().slice(0, 8)}.bak`);
  await writeFile(tempPath, candidate, { encoding: "utf8", mode: 0o600 });
  try {
    const candidateRegistry = ModelRegistry.create(factory.deps.authStorage, tempPath);
    const validationError = candidateRegistry.getError();
    if (validationError) throw new Error(validationError);
    try {
      await copyFile(path, backupPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await rename(tempPath, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const displacedPath = join(dirname(path), `.models-${randomUUID()}.old`);
      await rename(path, displacedPath);
      try {
        await rename(tempPath, path);
        await unlink(displacedPath).catch(() => undefined);
      } catch (replaceError) {
        await rename(displacedPath, path).catch(() => undefined);
        throw replaceError;
      }
    }
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

function currentModelConflict(
  factory: WorkspaceGraphFactory,
  originalId: string,
  draft?: ProviderDraft,
  managesModelList = true,
): HostError | null {
  const current = factory.getGraph()?.agentSession?.model;
  if (!current || current.provider !== originalId) return null;
  if (
    !draft ||
    draft.id !== originalId ||
    (managesModelList && !draft.models.some((model) => model.id === current.id))
  ) {
    return createHostError(
      "AGENT_BUSY",
      `The current session uses ${current.provider}/${current.id}. Select another model before changing its Provider entry.`,
      { retryable: true },
    );
  }
  return null;
}

async function refreshRegistry(factory: WorkspaceGraphFactory, rebindCurrentModel = false): Promise<void> {
  await Promise.resolve(factory.deps.refreshModelHealth());
  factory.onModelHealthChanged?.();
  if (!rebindCurrentModel) return;
  const graph = factory.getGraph();
  if (!graph?.agentSession || !graph.agentSession.isIdle) return;
  rebindCurrentSessionModel(graph.agentSession, factory.deps.modelRegistry);
}

async function alignCurrentSessionModel(
  factory: WorkspaceGraphFactory,
  targetProvider: string | undefined,
  preferredModelIds: string[] = [],
): Promise<void> {
  if (!targetProvider) return;
  const session = factory.getGraph()?.agentSession;
  if (!session?.isIdle || session.model?.provider === targetProvider) return;
  const registry = factory.deps.modelRegistry;
  const model = preferredModelIds
    .map((id) => registry.find(targetProvider, id))
    .find((item) => item !== undefined)
    ?? registry.getAll().find((item) => item.provider === targetProvider);
  if (model) await session.setModel(model);
}

async function discoverModels(
  provider: ProviderSnapshot,
  apiKey: string | undefined,
): Promise<DiscoveredProviderModel[]> {
  const url = new URL(`${provider.baseUrl.replace(/\/+$/, "")}/models`);
  const headers = new Headers(provider.headers);
  headers.set("Accept", "application/json");
  if (apiKey) {
    if (provider.api === "anthropic-messages") {
      headers.set("x-api-key", apiKey);
      if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
    } else if (provider.api === "google-generative-ai") {
      url.searchParams.set("key", apiKey);
    } else {
      headers.set("Authorization", `Bearer ${apiKey}`);
    }
  }
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) {
    throw new Error(`Provider returned ${response.status} ${response.statusText}`);
  }
  const payload = (await response.json()) as unknown;
  if (!isObject(payload)) throw new Error("Provider returned an invalid model catalog");
  const items = Array.isArray(payload.data)
    ? payload.data
    : Array.isArray(payload.models)
      ? payload.models
      : [];
  const enabled = new Map(provider.models.map((model) => [model.id, model]));
  const discovered = new Map<string, DiscoveredProviderModel>();
  for (const item of items) {
    if (!isObject(item)) continue;
    const rawId = typeof item.id === "string" ? item.id : typeof item.name === "string" ? item.name : "";
    const id = rawId.replace(/^models\//, "").trim();
    if (!id) continue;
    const existing = enabled.get(id);
    const detected = detectModelThinking(id, item);
    const useDetectedMap =
      existing?.thinkingLevelMap === undefined && existing?.reasoning === true && detected.reasoning;
    const thinkingLevelMap = existing?.thinkingLevelMap ??
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
      contextWindow: existing?.contextWindow ?? 128_000,
      maxTokens: existing?.maxTokens ?? 16_384,
      enabled: enabled.has(id),
      thinkingSource,
    });
  }
  for (const model of provider.models) {
    if (!discovered.has(model.id)) {
      const detected = detectModelThinking(model.id);
      const thinkingLevelMap = model.thinkingLevelMap ??
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

export function createProviderHandlers(
  factory: WorkspaceGraphFactory,
): Partial<Record<"provider.list" | "provider.setEnabled" | "provider.save" | "provider.remove" | "provider.fetchModels", MethodHandler>> {
  const modelsPath = join(factory.deps.agentDir, "models.json");

  return {
    "provider.list": async () => {
      try {
        await refreshRegistry(factory);
        const config = await readModelsConfig(modelsPath);
        const enabledProviders = new Set(resolveEnabledProviders(
          config,
          factory.getGraph()?.agentSession?.model?.provider,
        ));
        const providers = Object.entries(config.providers)
          .filter((entry): entry is [string, JsonObject] => isObject(entry[1]))
          .map(([id, raw]) => providerSnapshot(id, raw, factory, enabledProviders.has(id)))
          .sort((left, right) => left.name.localeCompare(right.name));
        return { result: { providers } };
      } catch (error) {
        return {
          error: createHostError(
            "SETTINGS_READ_FAILED",
            error instanceof Error ? error.message : "Could not read Provider configuration",
          ),
        };
      }
    },

    "provider.setEnabled": async (ctx) => {
      const { providerId, enabled } = ctx.params as { providerId: string; enabled: boolean };
      if (factory.hasBusySessions()) {
        return {
          error: createHostError("AGENT_BUSY", "Stop running sessions before changing enabled Providers", {
            retryable: true,
          }),
        };
      }
      const server = factory.getServer();
      if (!server) return { error: createHostError("HOST_NOT_READY", "Server not bound") };
      if (!server.serviceGraphLock.tryAcquire({ operationKind: "provider.mutation", requestId: ctx.id })) {
        return { error: createHostError("SERVICE_GRAPH_BUSY", "Service graph busy", { retryable: true }) };
      }
      try {
        const config = await readModelsConfig(modelsPath);
        const raw = config.providers[providerId];
        if (!isObject(raw)) {
          return { error: createHostError("MODEL_NOT_FOUND", `Provider not found: ${providerId}`) };
        }
        const nextEnabled = new Set(resolveEnabledProviders(
          config,
          factory.getGraph()?.agentSession?.model?.provider,
        ));
        if (enabled) nextEnabled.add(providerId);
        else nextEnabled.delete(providerId);
        config.root[ENABLED_PROVIDERS_KEY] = [...nextEnabled];
        delete config.root[LEGACY_ACTIVE_PROVIDER_KEY];
        await commitModelsConfig(modelsPath, config.root, factory);
        try {
          await refreshRegistry(factory, true);
          const currentProvider = factory.getGraph()?.agentSession?.model?.provider;
          if (!currentProvider || !nextEnabled.has(currentProvider)) {
            const targetProvider = enabled ? providerId : [...nextEnabled][0];
            const targetRaw = targetProvider ? config.providers[targetProvider] : undefined;
            const modelIds = isObject(targetRaw) && Array.isArray(targetRaw.models)
              ? targetRaw.models
                  .filter((model): model is JsonObject => isObject(model))
                  .map((model) => model.id)
                  .filter((id): id is string => typeof id === "string")
              : [];
            await alignCurrentSessionModel(factory, targetProvider, modelIds);
          }
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
      } finally {
        server.serviceGraphLock.release(ctx.id);
      }
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
      if (factory.hasBusySessions()) {
        return {
          error: createHostError("AGENT_BUSY", "Stop running sessions before changing Provider configuration", {
            retryable: true,
          }),
        };
      }
      const server = factory.getServer();
      if (!server) return { error: createHostError("HOST_NOT_READY", "Server not bound") };
      if (!server.serviceGraphLock.tryAcquire({ operationKind: "provider.mutation", requestId: ctx.id })) {
        return { error: createHostError("SERVICE_GRAPH_BUSY", "Service graph busy", { retryable: true }) };
      }
      try {
        const config = await readModelsConfig(modelsPath);
        const enabledBefore = resolveEnabledProviders(
          config,
          factory.getGraph()?.agentSession?.model?.provider,
        );
        const wasFirstProvider = Object.keys(config.providers).length === 0;
        if (draft.id !== originalId && config.providers[draft.id] !== undefined) {
          return { error: createHostError("INVALID_REQUEST", `Provider already exists: ${draft.id}`) };
        }
        const existing = isObject(config.providers[originalId]) ? config.providers[originalId] : {};
        const modelConflict = currentModelConflict(
          factory,
          originalId,
          draft,
          Array.isArray(existing.models),
        );
        if (modelConflict) return { error: modelConflict };
        const merged = mergeProvider(existing, draft);
        if (params.apiKey !== undefined || params.clearApiKey === true) delete merged.apiKey;
        if (draft.id !== originalId) delete config.providers[originalId];
        config.providers[draft.id] = merged;
        const enabledAfter = enabledBefore.map((id) => id === originalId ? draft.id : id);
        if (wasFirstProvider && !enabledAfter.includes(draft.id)) enabledAfter.push(draft.id);
        config.root[ENABLED_PROVIDERS_KEY] = [...new Set(enabledAfter)];
        delete config.root[LEGACY_ACTIVE_PROVIDER_KEY];

        const oldSourceCredential = factory.deps.authStorage.get(originalId);
        const oldTargetCredential = factory.deps.authStorage.get(draft.id);
        await commitModelsConfig(modelsPath, config.root, factory);
        try {
          if (params.clearApiKey) {
            factory.deps.authStorage.remove(draft.id);
          } else if (params.apiKey !== undefined) {
            factory.deps.authStorage.set(draft.id, { type: "api_key", key: params.apiKey });
          } else if (draft.id !== originalId && oldSourceCredential) {
            factory.deps.authStorage.set(draft.id, oldSourceCredential);
          }
          if (draft.id !== originalId) factory.deps.authStorage.remove(originalId);
          await refreshRegistry(factory, true);
          const currentProvider = factory.getGraph()?.agentSession?.model?.provider;
          const targetProvider = currentProvider && enabledAfter.includes(currentProvider)
            ? undefined
            : enabledAfter[0];
          await alignCurrentSessionModel(factory, targetProvider, targetProvider === draft.id
            ? draft.models.map((model) => model.id)
            : []);
        } catch (error) {
          await restoreModelsConfig(modelsPath, config.original);
          if (oldTargetCredential) factory.deps.authStorage.set(draft.id, oldTargetCredential);
          else factory.deps.authStorage.remove(draft.id);
          if (draft.id !== originalId && oldSourceCredential) {
            factory.deps.authStorage.set(originalId, oldSourceCredential);
          }
          await refreshRegistry(factory, true);
          throw error;
        }
        const enabledProviders = new Set(resolveEnabledProviders(config));
        return {
          result: {
            provider: providerSnapshot(draft.id, merged, factory, enabledProviders.has(draft.id)),
          },
        };
      } catch (error) {
        return {
          error: createHostError(
            "SETTINGS_WRITE_FAILED",
            error instanceof Error ? error.message : "Could not save Provider configuration",
          ),
        };
      } finally {
        server.serviceGraphLock.release(ctx.id);
      }
    },

    "provider.remove": async (ctx) => {
      const { providerId } = ctx.params as { providerId: string };
      const conflict = currentModelConflict(factory, providerId);
      if (conflict) return { error: conflict };
      if (factory.hasBusySessions()) {
        return { error: createHostError("AGENT_BUSY", "Stop running sessions before deleting a Provider", { retryable: true }) };
      }
      const server = factory.getServer();
      if (!server) return { error: createHostError("HOST_NOT_READY", "Server not bound") };
      if (!server.serviceGraphLock.tryAcquire({ operationKind: "provider.mutation", requestId: ctx.id })) {
        return { error: createHostError("SERVICE_GRAPH_BUSY", "Service graph busy", { retryable: true }) };
      }
      try {
        const config = await readModelsConfig(modelsPath);
        if (config.providers[providerId] === undefined) {
          return { error: createHostError("MODEL_NOT_FOUND", `Provider not found: ${providerId}`) };
        }
        const enabledBefore = resolveEnabledProviders(
          config,
          factory.getGraph()?.agentSession?.model?.provider,
        );
        delete config.providers[providerId];
        config.root[ENABLED_PROVIDERS_KEY] = enabledBefore.filter((id) => id !== providerId);
        delete config.root[LEGACY_ACTIVE_PROVIDER_KEY];
        const oldCredential = factory.deps.authStorage.get(providerId);
        await commitModelsConfig(modelsPath, config.root, factory);
        try {
          factory.deps.authStorage.remove(providerId);
          await refreshRegistry(factory, true);
        } catch (error) {
          await restoreModelsConfig(modelsPath, config.original);
          if (oldCredential) factory.deps.authStorage.set(providerId, oldCredential);
          await refreshRegistry(factory, true);
          throw error;
        }
        return { result: { providerId, removed: true as const } };
      } catch (error) {
        return {
          error: createHostError(
            "SETTINGS_WRITE_FAILED",
            error instanceof Error ? error.message : "Could not delete Provider",
          ),
        };
      } finally {
        server.serviceGraphLock.release(ctx.id);
      }
    },

    "provider.fetchModels": async (ctx) => {
      const { providerId } = ctx.params as { providerId: string };
      try {
        const config = await readModelsConfig(modelsPath);
        const raw = config.providers[providerId];
        if (!isObject(raw)) {
          return { error: createHostError("MODEL_NOT_FOUND", `Provider not found: ${providerId}`) };
        }
        const provider = providerSnapshot(
          providerId,
          raw,
          factory,
          resolveEnabledProviders(
            config,
            factory.getGraph()?.agentSession?.model?.provider,
          ).includes(providerId),
        );
        if (!provider.baseUrl) {
          return { error: createHostError("INVALID_REQUEST", "Provider Base URL is required") };
        }
        const apiKey = await factory.deps.modelRegistry.getApiKeyForProvider(providerId);
        const models = await discoverModels(provider, apiKey);
        return { result: { providerId, models } };
      } catch (error) {
        return {
          error: createHostError(
            "INTERNAL_ERROR",
            error instanceof Error ? error.message : "Could not fetch Provider models",
            { retryable: true },
          ),
        };
      }
    },
  };
}
