import { join } from "node:path";
import {
  createAgentSession,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  type ModelRuntime,
  type SessionManager,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { PIDECK_NO_MODEL } from "./no-model.js";
import {
  ENABLED_PROVIDERS_KEY,
  isObject,
  readModelsConfig,
  readProviderModelAllowLists,
  resolveEnabledProviders,
} from "./provider-models-config.js";

type HostAgentSessionOptions = Omit<
  CreateAgentSessionOptions,
  "agentDir" | "model" | "modelRuntime" | "sessionManager" | "settingsManager"
> & {
  agentDir: string;
  modelRuntime: ModelRuntime;
  sessionManager: SessionManager;
  settingsManager: SettingsManager;
};

type InitialModelOption = { model?: never } | { model: Model<Api> };

async function resolveInitialModelOption(
  options: HostAgentSessionOptions,
): Promise<InitialModelOption> {
  const config = await readModelsConfig(join(options.agentDir, "models.json"));
  const hasCustomProviders = Object.values(config.providers).some(isObject);
  const hasEnabledProviderFilter =
    hasCustomProviders || Array.isArray(config.root[ENABLED_PROVIDERS_KEY]);
  const modelAllowLists = readProviderModelAllowLists(config);
  if (!hasEnabledProviderFilter && Object.keys(modelAllowLists).length === 0) return {};

  const sessionModel = options.sessionManager.buildSessionContext().model;
  const defaultProvider = options.settingsManager.getDefaultProvider();
  const defaultModelId = options.settingsManager.getDefaultModel();
  const preferredProvider = sessionModel?.provider ?? defaultProvider;
  const enabledProviders = hasEnabledProviderFilter
    ? new Set(
        resolveEnabledProviders(
          config,
          preferredProvider,
          options.modelRuntime.getProviders().map((provider) => provider.id),
        ),
      )
    : undefined;
  const available = await options.modelRuntime.getAvailable();
  const eligible = available.filter((model) => {
    if (enabledProviders && !enabledProviders.has(model.provider)) return false;
    const allow = modelAllowLists[model.provider];
    return !allow || allow.includes(model.id);
  });
  const findEligible = (provider: string | undefined, modelId: string | undefined) =>
    provider && modelId
      ? eligible.find((model) => model.provider === provider && model.id === modelId)
      : undefined;

  return {
    model:
      findEligible(sessionModel?.provider, sessionModel?.modelId) ??
      findEligible(defaultProvider, defaultModelId) ??
      eligible[0] ??
      PIDECK_NO_MODEL,
  };
}

/**
 * Construct every Host AgentSession through the PiDeck Provider/model policy.
 * Omitting the model option preserves SDK-native selection for legacy configs;
 * the no-model sentinel prevents the SDK from resurrecting a disabled Provider.
 */
export async function createHostAgentSession(
  options: HostAgentSessionOptions,
): Promise<CreateAgentSessionResult> {
  const initialModel = await resolveInitialModelOption(options);
  return createAgentSession({ ...options, ...initialModel });
}
