import {
  Check,
  Eye,
  EyeOff,
  Plus,
  RefreshCw,
  Save,
  Search,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  DiscoveredProviderModel,
  ProviderDraft,
  ProviderModelConfig,
  ProviderSnapshot,
  ThinkingLevel,
  ThinkingLevelMap,
} from "@pideck/protocol";
import { detectModelThinking, THINKING_LEVELS } from "@pideck/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { hostContext } from "../../lib/bridge/host-context";
import { useAppStore } from "../../lib/stores/app-store";

type DraftState = ProviderDraft & { originalId?: string };

const API_OPTIONS: Array<{ value: ProviderDraft["api"]; label: string }> = [
  { value: "openai-completions", label: "OpenAI Chat Completions" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "anthropic-messages", label: "Anthropic Messages" },
  { value: "google-generative-ai", label: "Google Generative AI" },
];

function snapshotToDraft(provider: ProviderSnapshot): DraftState {
  return {
    id: provider.id,
    originalId: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    api: provider.api,
    authHeader: provider.authHeader,
    headers: { ...provider.headers },
    models: provider.models.map((model) => {
      const detected = detectModelThinking(model.id);
      const useProfile =
        model.reasoning && model.thinkingLevelMap === undefined && detected.source === "profile";
      return {
        ...model,
        ...(model.thinkingLevelMap
          ? { thinkingLevelMap: { ...model.thinkingLevelMap } }
          : useProfile && detected.thinkingLevelMap
            ? { thinkingLevelMap: { ...detected.thinkingLevelMap } }
            : {}),
        input: [...model.input],
      };
    }),
  };
}

function emptyDraft(): DraftState {
  return {
    id: "",
    name: "New Provider",
    baseUrl: "",
    api: "openai-completions",
    authHeader: true,
    headers: {},
    models: [],
  };
}

function enabledCatalog(models: ProviderModelConfig[]): DiscoveredProviderModel[] {
  return models.map((model) => {
    const detected = detectModelThinking(model.id);
    return {
      ...model,
      ...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}),
      input: [...model.input],
      enabled: true,
      thinkingSource:
        model.reasoning && detected.source === "profile" ? "profile" : "configured",
    };
  });
}

function stripEnabled(model: DiscoveredProviderModel): ProviderModelConfig {
  const { enabled: _enabled, thinkingSource: _thinkingSource, ...config } = model;
  return config;
}

function customThinkingMap(model: DiscoveredProviderModel): ThinkingLevelMap {
  return Object.fromEntries(
    THINKING_LEVELS.map((level) => {
      const configured = model.thinkingLevelMap?.[level];
      if (configured !== undefined) return [level, configured];
      return [level, ["off", "minimal", "low", "medium", "high"].includes(level) ? level : null];
    }),
  ) as ThinkingLevelMap;
}

export function automaticThinkingConfig(
  modelId: string,
): Pick<DiscoveredProviderModel, "reasoning" | "thinkingLevelMap" | "thinkingSource"> {
  const detected = detectModelThinking(modelId);
  return {
    reasoning: true,
    thinkingLevelMap: detected.thinkingLevelMap,
    thinkingSource: detected.reasoning ? detected.source : "default",
  };
}

function thinkingMode(model: DiscoveredProviderModel): "auto" | "custom" | "disabled" {
  if (!model.reasoning) return "disabled";
  return model.thinkingSource === "manual" ||
    (model.thinkingSource === "configured" && model.thinkingLevelMap !== undefined)
    ? "custom"
    : "auto";
}

function thinkingSourceLabel(model: DiscoveredProviderModel): string {
  switch (model.thinkingSource) {
    case "provider":
      return "Provider metadata";
    case "profile":
      return "Known model profile";
    case "inferred":
      return "Inferred from model ID";
    case "manual":
      return "Manual override";
    case "configured":
      return "Existing configuration";
    default:
      return model.reasoning ? "Automatic defaults" : "No reasoning detected";
  }
}

function authLabel(provider: ProviderSnapshot | undefined): string {
  if (!provider?.auth.configured) {
    return provider?.auth.label ? `Available via ${provider.auth.label}` : "No stored API key";
  }
  return provider.auth.source === "stored" ? "API key stored" : "Authentication configured";
}

export function ProvidersSettings() {
  const host = useAppStore((state) => state.host);
  const pushNotification = useAppStore((state) => state.pushNotification);
  const refreshProviderConfig = useAppStore((state) => state.refreshProviderConfig);
  const [providers, setProviders] = useState<ProviderSnapshot[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [catalog, setCatalog] = useState<DiscoveredProviderModel[]>([]);
  const [providerSearch, setProviderSearch] = useState("");
  const [modelSearch, setModelSearch] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [clearApiKey, setClearApiKey] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [updatingProviderId, setUpdatingProviderId] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualId, setManualId] = useState("");
  const [editingModelId, setEditingModelId] = useState<string | null>(null);

  const selectedProvider = providers.find((provider) => provider.id === selectedId);

  useEffect(() => {
    if (!host) {
      setProviders([]);
      setDraft(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void hostClient
      .request("provider.list", hostContext(host), null)
      .then((response) => {
        if (cancelled) return;
        if (!response.ok) {
          pushNotification(response.error?.message ?? "Could not load Providers", "error");
          return;
        }
        setProviders(response.result.providers);
        const preferred =
          response.result.providers.find((provider) => provider.id === selectedId) ??
          response.result.providers[0];
        if (preferred) {
          const nextDraft = snapshotToDraft(preferred);
          setSelectedId(preferred.id);
          setDraft(nextDraft);
          setCatalog(enabledCatalog(nextDraft.models));
        } else {
          setSelectedId(null);
          setDraft(null);
          setCatalog([]);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          pushNotification(error instanceof Error ? error.message : "Could not load Providers", "error");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [host?.hostInstanceId, pushNotification]);

  const filteredProviders = useMemo(() => {
    const query = providerSearch.trim().toLowerCase();
    if (!query) return providers;
    return providers.filter((provider) =>
      `${provider.name} ${provider.id} ${provider.baseUrl}`.toLowerCase().includes(query),
    );
  }, [providerSearch, providers]);

  const filteredModels = useMemo(() => {
    const query = modelSearch.trim().toLowerCase();
    if (!query) return catalog;
    return catalog.filter((model) => `${model.name} ${model.id}`.toLowerCase().includes(query));
  }, [catalog, modelSearch]);

  function selectProvider(provider: ProviderSnapshot) {
    const nextDraft = snapshotToDraft(provider);
    setSelectedId(provider.id);
    setDraft(nextDraft);
    setCatalog(enabledCatalog(nextDraft.models));
    setApiKey("");
    setClearApiKey(false);
    setEditingModelId(null);
    setManualOpen(false);
  }

  function startNewProvider() {
    setSelectedId(null);
    setDraft(emptyDraft());
    setCatalog([]);
    setApiKey("");
    setClearApiKey(false);
    setEditingModelId(null);
    setManualOpen(false);
  }

  function updateDraft(patch: Partial<ProviderDraft>) {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  }

  function syncModels(nextCatalog: DiscoveredProviderModel[]) {
    setCatalog(nextCatalog);
    updateDraft({ models: nextCatalog.filter((model) => model.enabled).map(stripEnabled) });
  }

  async function persistDraft(notify = true): Promise<ProviderSnapshot | null> {
    if (!host || !draft || saving) return null;
    if (!draft.id.trim() || !draft.name.trim() || !draft.baseUrl.trim()) {
      pushNotification("Provider ID, name, and Base URL are required", "error");
      return null;
    }
    setSaving(true);
    try {
      const response = await hostClient.request(
        "provider.save",
        hostContext(host),
        {
          ...(draft.originalId ? { originalId: draft.originalId } : {}),
          provider: {
            id: draft.id,
            name: draft.name,
            baseUrl: draft.baseUrl,
            api: draft.api,
            authHeader: draft.authHeader,
            headers: draft.headers,
            models: draft.models,
          },
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          ...(clearApiKey ? { clearApiKey: true } : {}),
        },
      );
      if (!response.ok) {
        pushNotification(response.error?.message ?? "Could not save Provider", "error");
        return null;
      }
      const saved = response.result.provider;
      setProviders((current) =>
        [...current
          .filter((provider) => provider.id !== draft.originalId && provider.id !== saved.id), saved].sort(
          (left, right) => left.name.localeCompare(right.name),
        ),
      );
      setSelectedId(saved.id);
      setDraft(snapshotToDraft(saved));
      setCatalog((current) => {
        const savedIds = new Set(saved.models.map((model) => model.id));
        const savedById = new Map(saved.models.map((model) => [model.id, model]));
        if (current.length === 0) return enabledCatalog(saved.models);
        return current.map((model) => ({
          ...model,
          ...(savedById.get(model.id) ?? {}),
          enabled: savedIds.has(model.id),
        }));
      });
      setApiKey("");
      setClearApiKey(false);
      refreshProviderConfig();
      if (notify) pushNotification("Provider saved");
      return saved;
    } catch (error) {
      pushNotification(error instanceof Error ? error.message : "Could not save Provider", "error");
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function fetchModels() {
    if (!host || !draft || fetching) return;
    const saved = await persistDraft(false);
    if (!saved) return;
    setFetching(true);
    try {
      const response = await hostClient.request(
        "provider.fetchModels",
        hostContext(host),
        { providerId: saved.id },
        20_000,
      );
      if (!response.ok) {
        pushNotification(response.error?.message ?? "Could not fetch models", "error");
        return;
      }
      setCatalog(response.result.models);
      setDraft((current) =>
        current
          ? {
              ...current,
              models: response.result.models.filter((model) => model.enabled).map(stripEnabled),
            }
          : current,
      );
      pushNotification(`Found ${response.result.models.length} models`);
    } catch (error) {
      pushNotification(error instanceof Error ? error.message : "Could not fetch models", "error");
    } finally {
      setFetching(false);
    }
  }

  async function setProviderEnabled(provider: ProviderSnapshot, enabled: boolean) {
    if (!host || updatingProviderId) return;
    setUpdatingProviderId(provider.id);
    try {
      const response = await hostClient.request(
        "provider.setEnabled",
        hostContext(host),
        { providerId: provider.id, enabled },
      );
      if (!response.ok) {
        pushNotification(response.error?.message ?? "Could not update Provider", "error");
        return;
      }
      setProviders((current) =>
        current.map((item) => item.id === response.result.providerId
          ? { ...item, enabled: response.result.enabled }
          : item),
      );
      refreshProviderConfig();
      pushNotification(`${provider.name} ${enabled ? "enabled" : "disabled"}`);
    } catch (error) {
      pushNotification(error instanceof Error ? error.message : "Could not update Provider", "error");
    } finally {
      setUpdatingProviderId(null);
    }
  }

  async function removeProvider() {
    if (!host || !draft?.originalId || saving) return;
    if (!window.confirm(`Delete ${draft.name}?`)) return;
    setSaving(true);
    try {
      const response = await hostClient.request(
        "provider.remove",
        hostContext(host),
        { providerId: draft.originalId },
      );
      if (!response.ok) {
        pushNotification(response.error?.message ?? "Could not delete Provider", "error");
        return;
      }
      const listResponse = await hostClient.request("provider.list", hostContext(host), null);
      const remaining = listResponse.ok
        ? listResponse.result.providers
        : providers.filter((provider) => provider.id !== draft.originalId);
      setProviders(remaining);
      const nextProvider = remaining.find((provider) => provider.enabled) ?? remaining[0];
      if (nextProvider) selectProvider(nextProvider);
      else {
        setSelectedId(null);
        setDraft(null);
        setCatalog([]);
      }
      refreshProviderConfig();
      pushNotification("Provider deleted");
    } catch (error) {
      pushNotification(error instanceof Error ? error.message : "Could not delete Provider", "error");
    } finally {
      setSaving(false);
    }
  }

  function addManualModel() {
    const id = manualId.trim();
    if (!id) return;
    const existing = catalog.find((model) => model.id === id);
    const detected = detectModelThinking(id);
    const model: DiscoveredProviderModel = existing ?? {
      id,
      name: id,
      reasoning: detected.reasoning,
      ...(detected.thinkingLevelMap ? { thinkingLevelMap: detected.thinkingLevelMap } : {}),
      thinkingSource: detected.source,
      input: ["text"],
      contextWindow: 128_000,
      maxTokens: 16_384,
      enabled: true,
    };
    const next = [...catalog.filter((item) => item.id !== id), { ...model, enabled: true }].sort(
      (left, right) => left.id.localeCompare(right.id),
    );
    syncModels(next);
    setManualId("");
    setManualOpen(false);
    setEditingModelId(id);
  }

  function updateModel(id: string, patch: Partial<DiscoveredProviderModel>) {
    syncModels(catalog.map((model) => (model.id === id ? { ...model, ...patch } : model)));
  }

  function updateHeader(oldKey: string, nextKey: string, value: string) {
    if (!draft) return;
    const headers = { ...draft.headers };
    delete headers[oldKey];
    if (nextKey) headers[nextKey] = value;
    updateDraft({ headers });
  }

  const editingModel = catalog.find((model) => model.id === editingModelId);

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-surface-raised/40">
        <div className="flex items-center gap-2 border-b border-border p-3">
          <div className="relative min-w-0 flex-1">
            <Search className="absolute left-2 top-2 text-muted" size={14} />
            <input
              className="h-8 w-full rounded border border-border bg-surface pl-7 pr-2 text-xs outline-none focus:border-accent"
              placeholder="Search Providers"
              value={providerSearch}
              onChange={(event) => setProviderSearch(event.target.value)}
            />
          </div>
          <button
            type="button"
            className="flex size-8 shrink-0 items-center justify-center rounded border border-border hover:bg-surface-overlay"
            title="Add Provider"
            onClick={startNewProvider}
          >
            <Plus size={15} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {loading ? (
            <p className="p-3 text-xs text-muted">Loading Providers...</p>
          ) : filteredProviders.length === 0 ? (
            <p className="p-3 text-xs text-muted">No configured Providers</p>
          ) : (
            filteredProviders.map((provider) => (
              <div
                key={provider.id}
                className={`mb-1 flex w-full items-center rounded-md ${
                  selectedId === provider.id
                    ? "bg-accent/15 text-foreground"
                    : "text-muted hover:bg-surface-overlay hover:text-foreground"
                }`}
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-start gap-2 px-3 py-2 text-left"
                  onClick={() => selectProvider(provider)}
                >
                  <span
                    className={`mt-1.5 size-2 shrink-0 rounded-full ${
                      provider.auth.configured ? "bg-success" : "bg-muted"
                    }`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{provider.name}</span>
                    <span className="block truncate text-[11px]">
                      {provider.models.length} models{provider.enabled ? " - Enabled" : ""}
                    </span>
                  </span>
                </button>
                <span className="mr-2 flex size-8 shrink-0 items-center justify-center">
                  {updatingProviderId === provider.id ? (
                    <RefreshCw className="animate-spin text-muted" size={15} />
                  ) : (
                    <input
                      type="checkbox"
                      checked={provider.enabled}
                      aria-label={`${provider.enabled ? "Disable" : "Enable"} ${provider.name}`}
                      disabled={updatingProviderId !== null}
                      onChange={(event) => void setProviderEnabled(provider, event.target.checked)}
                    />
                  )}
                </span>
              </div>
            ))
          )}
        </div>
      </aside>

      {!draft ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted">
          Select or add a Provider
        </div>
      ) : (
        <div className="min-w-0 flex-1 overflow-auto">
          <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
            <header className="flex items-start justify-between gap-4">
              <div>
                <h1 className="text-lg font-semibold">{draft.originalId ? "Edit Provider" : "Add Provider"}</h1>
                <p className="mt-1 text-xs text-muted">{draft.originalId ?? "Custom Provider"}</p>
              </div>
              <div className="flex gap-2">
                {draft.originalId && (
                  <button
                    type="button"
                    className="flex h-8 items-center gap-1.5 rounded border border-danger/40 px-2.5 text-xs text-danger hover:bg-danger/10 disabled:opacity-50"
                    disabled={saving}
                    onClick={() => void removeProvider()}
                  >
                    <Trash2 size={14} /> Delete
                  </button>
                )}
                <button
                  type="button"
                  className="flex h-8 items-center gap-1.5 rounded bg-accent px-3 text-xs text-white hover:bg-accent-hover disabled:opacity-50"
                  disabled={saving || fetching}
                  onClick={() => void persistDraft()}
                >
                  {saving ? <RefreshCw className="animate-spin" size={14} /> : <Save size={14} />}
                  Save
                </button>
              </div>
            </header>

            <section className="grid grid-cols-2 gap-4">
              <label className="flex flex-col gap-1.5 text-xs text-muted">
                Display name
                <input
                  className="h-9 rounded border border-border bg-surface px-3 text-sm text-foreground outline-none focus:border-accent"
                  value={draft.name}
                  onChange={(event) => updateDraft({ name: event.target.value })}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-xs text-muted">
                Provider ID
                <input
                  className="h-9 rounded border border-border bg-surface px-3 font-mono text-sm text-foreground outline-none focus:border-accent"
                  value={draft.id}
                  onChange={(event) => updateDraft({ id: event.target.value })}
                />
              </label>
              <label className="col-span-2 flex flex-col gap-1.5 text-xs text-muted">
                Base URL
                <input
                  className="h-9 rounded border border-border bg-surface px-3 font-mono text-sm text-foreground outline-none focus:border-accent"
                  placeholder="https://api.example.com/v1"
                  value={draft.baseUrl}
                  onChange={(event) => updateDraft({ baseUrl: event.target.value })}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-xs text-muted">
                API protocol
                <select
                  className="h-9 rounded border border-border bg-surface px-3 text-sm text-foreground outline-none focus:border-accent"
                  value={draft.api}
                  onChange={(event) => updateDraft({ api: event.target.value as ProviderDraft["api"] })}
                >
                  {API_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
              <label className="flex items-end gap-2 pb-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.authHeader}
                  onChange={(event) => updateDraft({ authHeader: event.target.checked })}
                />
                Authorization Bearer header
              </label>
            </section>

            <section>
              <div className="mb-2 flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-medium">API key</h2>
                  <p className="text-[11px] text-muted">{clearApiKey ? "Stored key will be removed" : authLabel(selectedProvider)}</p>
                </div>
                {selectedProvider?.auth.configured && (
                  <button
                    type="button"
                    className="text-xs text-danger hover:underline"
                    onClick={() => {
                      setClearApiKey((current) => !current);
                      setApiKey("");
                    }}
                  >
                    {clearApiKey ? "Keep stored key" : "Remove stored key"}
                  </button>
                )}
              </div>
              <div className="relative">
                <input
                  type={showApiKey ? "text" : "password"}
                  className="h-9 w-full rounded border border-border bg-surface px-3 pr-10 font-mono text-sm outline-none focus:border-accent"
                  placeholder={selectedProvider?.auth.configured ? "Leave blank to keep current key" : "Enter API key"}
                  value={apiKey}
                  onChange={(event) => {
                    setApiKey(event.target.value);
                    if (event.target.value) setClearApiKey(false);
                  }}
                  autoComplete="off"
                />
                <button
                  type="button"
                  className="absolute right-1 top-1 flex size-7 items-center justify-center text-muted hover:text-foreground"
                  title={showApiKey ? "Hide API key" : "Show API key"}
                  onClick={() => setShowApiKey((current) => !current)}
                >
                  {showApiKey ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </section>

            <section>
              <div className="mb-2 flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-medium">Models</h2>
                  <p className="text-[11px] text-muted">{draft.models.length} enabled in the chat model selector</p>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    className="h-8 px-2 text-xs text-muted hover:text-foreground"
                    disabled={catalog.length === 0}
                    onClick={() => {
                      const enable = catalog.some((model) => !model.enabled);
                      syncModels(catalog.map((model) => ({ ...model, enabled: enable })));
                    }}
                  >
                    {catalog.length > 0 && catalog.every((model) => model.enabled) ? "Select none" : "Select all"}
                  </button>
                  <button
                    type="button"
                    className="flex size-8 items-center justify-center rounded hover:bg-surface-overlay disabled:opacity-50"
                    title="Fetch models"
                    disabled={fetching || saving}
                    onClick={() => void fetchModels()}
                  >
                    <RefreshCw className={fetching ? "animate-spin" : ""} size={15} />
                  </button>
                  <button
                    type="button"
                    className="flex size-8 items-center justify-center rounded hover:bg-surface-overlay"
                    title="Add model manually"
                    onClick={() => setManualOpen((current) => !current)}
                  >
                    <Plus size={15} />
                  </button>
                </div>
              </div>
              <div className="relative mb-2">
                <Search className="absolute left-2.5 top-2.5 text-muted" size={14} />
                <input
                  className="h-9 w-full rounded border border-border bg-surface pl-8 pr-3 text-xs outline-none focus:border-accent"
                  placeholder="Search models"
                  value={modelSearch}
                  onChange={(event) => setModelSearch(event.target.value)}
                />
              </div>
              {manualOpen && (
                <div className="mb-2 flex gap-2">
                  <input
                    className="h-8 min-w-0 flex-1 rounded border border-border bg-surface px-3 font-mono text-xs outline-none focus:border-accent"
                    placeholder="Model ID"
                    value={manualId}
                    onChange={(event) => setManualId(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") addManualModel();
                    }}
                  />
                  <button
                    type="button"
                    className="flex size-8 items-center justify-center rounded bg-accent text-white"
                    title="Add model"
                    onClick={addManualModel}
                  >
                    <Check size={14} />
                  </button>
                </div>
              )}
              <div className="max-h-72 overflow-auto rounded border border-border">
                {filteredModels.length === 0 ? (
                  <p className="p-4 text-center text-xs text-muted">Fetch or add models to configure visibility</p>
                ) : (
                  filteredModels.map((model) => (
                    <div key={model.id} className="flex h-10 items-center gap-3 border-b border-border px-3 last:border-b-0">
                      <input
                        type="checkbox"
                        checked={model.enabled}
                        aria-label={`Show ${model.name} in chat`}
                        onChange={(event) => updateModel(model.id, { enabled: event.target.checked })}
                      />
                      <span className="min-w-0 flex-1 truncate text-sm" title={model.id}>{model.name}</span>
                      {model.reasoning && (
                        <span className="text-[10px] text-muted" title={thinkingSourceLabel(model)}>
                          reasoning
                        </span>
                      )}
                      <button
                        type="button"
                        className="flex size-7 items-center justify-center text-muted hover:text-foreground"
                        title="Model settings"
                        onClick={() => setEditingModelId((current) => (current === model.id ? null : model.id))}
                      >
                        <SlidersHorizontal size={14} />
                      </button>
                    </div>
                  ))
                )}
              </div>
              {editingModel && (
                <div className="mt-2 grid grid-cols-2 gap-3 border-l-2 border-accent pl-3">
                  <div className="col-span-2 flex items-center justify-between">
                    <span className="font-mono text-xs">{editingModel.id}</span>
                    <button type="button" className="text-muted hover:text-foreground" onClick={() => setEditingModelId(null)}>
                      <X size={14} />
                    </button>
                  </div>
                  <label className="flex flex-col gap-1 text-[11px] text-muted">
                    Display name
                    <input
                      className="h-8 rounded border border-border bg-surface px-2 text-xs text-foreground"
                      value={editingModel.name}
                      onChange={(event) => updateModel(editingModel.id, { name: event.target.value })}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-[11px] text-muted">
                    Context window
                    <input
                      type="number"
                      min={1}
                      className="h-8 rounded border border-border bg-surface px-2 text-xs text-foreground"
                      value={editingModel.contextWindow}
                      onChange={(event) => updateModel(editingModel.id, { contextWindow: Number(event.target.value) || 1 })}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-[11px] text-muted">
                    Max output tokens
                    <input
                      type="number"
                      min={1}
                      className="h-8 rounded border border-border bg-surface px-2 text-xs text-foreground"
                      value={editingModel.maxTokens}
                      onChange={(event) => updateModel(editingModel.id, { maxTokens: Number(event.target.value) || 1 })}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-[11px] text-muted">
                    Thinking support
                    <select
                      className="h-8 rounded border border-border bg-surface px-2 text-xs text-foreground"
                      value={thinkingMode(editingModel)}
                      onChange={(event) => {
                        const mode = event.target.value;
                        if (mode === "disabled") {
                          updateModel(editingModel.id, {
                            reasoning: false,
                            thinkingLevelMap: undefined,
                            thinkingSource: "manual",
                          });
                          return;
                        }
                        if (mode === "custom") {
                          updateModel(editingModel.id, {
                            reasoning: true,
                            thinkingLevelMap: customThinkingMap(editingModel),
                            thinkingSource: "manual",
                          });
                          return;
                        }
                        updateModel(editingModel.id, automaticThinkingConfig(editingModel.id));
                      }}
                    >
                      <option value="auto">Auto</option>
                      <option value="custom">Custom</option>
                      <option value="disabled">Disabled</option>
                    </select>
                  </label>
                  <div className="flex items-end gap-4 pb-1 text-xs">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={editingModel.input.includes("image")}
                        onChange={(event) =>
                          updateModel(editingModel.id, { input: event.target.checked ? ["text", "image"] : ["text"] })
                        }
                      /> Images
                    </label>
                  </div>
                  <p className="col-span-2 text-[11px] text-muted">
                    {thinkingSourceLabel(editingModel)}
                  </p>
                  {thinkingMode(editingModel) === "custom" && (
                    <div className="col-span-2 grid grid-cols-4 gap-2 border-t border-border pt-2">
                      {THINKING_LEVELS.map((level) => {
                        const enabled = editingModel.thinkingLevelMap?.[level] !== null;
                        const enabledCount = THINKING_LEVELS.filter(
                          (item) => editingModel.thinkingLevelMap?.[item] !== null,
                        ).length;
                        return (
                          <label key={level} className="flex items-center gap-2 text-xs">
                            <input
                              type="checkbox"
                              checked={enabled}
                              onChange={(event) => {
                                if (!event.target.checked && enabledCount <= 1) return;
                                updateModel(editingModel.id, {
                                  reasoning: true,
                                  thinkingLevelMap: {
                                    ...customThinkingMap(editingModel),
                                    [level]: event.target.checked ? level : null,
                                  },
                                  thinkingSource: "manual",
                                });
                              }}
                            />
                            {level}
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </section>

            <details className="border-t border-border pt-4">
              <summary className="cursor-pointer text-sm font-medium">Custom headers</summary>
              <div className="mt-3 flex flex-col gap-2">
                {Object.entries(draft.headers).map(([key, value]) => (
                  <div key={key} className="grid grid-cols-[1fr_1.5fr_32px] gap-2">
                    <input
                      className="h-8 rounded border border-border bg-surface px-2 font-mono text-xs"
                      value={key}
                      onChange={(event) => updateHeader(key, event.target.value, value)}
                    />
                    <input
                      className="h-8 rounded border border-border bg-surface px-2 font-mono text-xs"
                      value={value}
                      onChange={(event) => updateHeader(key, key, event.target.value)}
                    />
                    <button
                      type="button"
                      className="flex size-8 items-center justify-center text-muted hover:text-danger"
                      title="Remove header"
                      onClick={() => updateHeader(key, "", "")}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="flex h-8 w-fit items-center gap-1.5 rounded border border-border px-2.5 text-xs hover:bg-surface-overlay"
                  onClick={() => {
                    let key = "X-Custom-Header";
                    let index = 2;
                    while (draft.headers[key] !== undefined) key = `X-Custom-Header-${index++}`;
                    updateDraft({ headers: { ...draft.headers, [key]: "" } });
                  }}
                >
                  <Plus size={13} /> Add header
                </button>
              </div>
            </details>
          </div>
        </div>
      )}
    </div>
  );
}
