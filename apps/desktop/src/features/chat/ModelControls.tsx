import { Brain, Check, ChevronDown } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ModelSummary } from "@pideck/protocol";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import {
  activeSessionContext,
  captureRequestGeneration,
  isCurrentRequestGeneration,
} from "../../lib/bridge/host-context";
import { formatTokenCount } from "../../lib/format-token-count";

const MODEL_MENU_MIN_WIDTH = 120;
const MODEL_MENU_MAX_WIDTH = 280;
const MODEL_MENU_ROW_CONTROLS_WIDTH = 48;

export function includeCurrentModel(
  models: ModelSummary[],
  current: ModelSummary | undefined,
  enabledProviders?: string[],
): ModelSummary[] {
  if (!current) return models;
  if (enabledProviders && !enabledProviders.includes(current.provider)) return models;
  const currentKey = `${current.provider}/${current.modelId}`;
  return models.some((model) => `${model.provider}/${model.modelId}` === currentKey)
    ? models
    : [current, ...models];
}

export function thinkingLevelsForModel(
  models: ModelSummary[],
  current: ModelSummary | undefined,
  fallback: string[],
): string[] {
  if (!current) return fallback;
  const selected = models.find(
    (model) => model.provider === current.provider && model.modelId === current.modelId,
  );
  return selected?.thinkingLevels ?? fallback;
}

export function modelOptionLabel(model: ModelSummary): string {
  return `${model.provider}/${model.name || model.modelId}`;
}

function ContextUsageRing() {
  const contextUsage = useAppStore((s) => s.session?.contextUsage);
  const breakdown = contextUsage?.breakdown;
  const percent =
    contextUsage?.tokens === null || !contextUsage
      ? null
      : Math.min(100, Math.max(0, (contextUsage.tokens / contextUsage.contextWindow) * 100));
  const roundedPercent = percent === null ? null : Math.round(percent);
  const title = contextUsage
    ? contextUsage.tokens === null
      ? `Context usage unknown / ${formatTokenCount(contextUsage.contextWindow)} tokens`
      : `${formatTokenCount(contextUsage.tokens)} / ${formatTokenCount(contextUsage.contextWindow)} context tokens`
    : "No model context available";

  return (
    <span
      className="group/context relative flex size-7 shrink-0 items-center justify-center rounded-full"
      style={{
        background: `conic-gradient(var(--color-accent) ${
          percent === null ? 0 : percent * 3.6
        }deg, var(--color-border) 0deg)`,
      }}
      aria-label={title}
      role="img"
      tabIndex={0}
    >
      <span className="absolute inset-[3px] rounded-full bg-surface-raised" />
      <span className="relative text-[8px] tabular-nums text-muted">
        {roundedPercent === null ? "--" : `${roundedPercent}%`}
      </span>
      <span className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 hidden w-64 -translate-x-1/2 flex-col rounded-md border border-border bg-surface-raised p-3 text-left text-[11px] leading-4 text-foreground shadow-lg group-hover/context:flex group-focus/context:flex">
        <span className="font-medium">Context usage</span>
        <span className="mt-0.5 tabular-nums text-muted">{title}</span>
        {breakdown && (
          <>
            <span className="my-2 h-px bg-border" />
            <span className="mb-1 text-[10px] font-medium uppercase text-muted">
              Estimated composition
            </span>
            <span className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
              <span className="text-muted">System prompt</span>
              <span className="tabular-nums">~{formatTokenCount(breakdown.systemPrompt)}</span>
              <span className="text-muted">Tool definitions</span>
              <span className="tabular-nums">~{formatTokenCount(breakdown.toolDefinitions)}</span>
              <span className="text-muted">User prompts</span>
              <span className="tabular-nums">~{formatTokenCount(breakdown.userPrompts)}</span>
              <span className="text-muted">Assistant</span>
              <span className="tabular-nums">~{formatTokenCount(breakdown.assistantMessages)}</span>
              <span className="text-muted">Tool results</span>
              <span className="tabular-nums">~{formatTokenCount(breakdown.toolResults)}</span>
              <span className="text-muted">Summaries</span>
              <span className="tabular-nums">~{formatTokenCount(breakdown.summaries)}</span>
              <span className="text-muted">Other / framing</span>
              <span className="tabular-nums">~{formatTokenCount(breakdown.other)}</span>
            </span>
            <span className="mt-2 text-[10px] text-muted">Estimated; total from provider.</span>
          </>
        )}
      </span>
    </span>
  );
}

/** Model menu and context indicator for the composer's bottom bar. */
export function ModelControls() {
  const host = useAppStore((s) => s.host);
  const workspace = useAppStore((s) => s.workspace);
  const session = useAppStore((s) => s.session);
  const setSession = useAppStore((s) => s.applySessionSnapshot);
  const thinkingLevels = useAppStore((s) => s.thinkingLevels);
  const providerConfigRevision = useAppStore((s) => s.providerConfigRevision);
  const setThinkingLevels = useAppStore((s) => s.setThinkingLevels);
  const pushNotification = useAppStore((s) => s.pushNotification);
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [enabledProviders, setEnabledProviders] = useState<string[] | undefined>();
  const [menuOpen, setMenuOpen] = useState(false);
  const [modelMenuWidth, setModelMenuWidth] = useState(MODEL_MENU_MIN_WIDTH);
  const [thinkingModelKey, setThinkingModelKey] = useState<string | null>(null);
  const [thinkingMenuTop, setThinkingMenuTop] = useState(0);
  const listRequest = useRef(0);
  const menuRef = useRef<HTMLDivElement>(null);
  const modelMenuMeasureRef = useRef<HTMLSpanElement>(null);
  const modelMenuPanelRef = useRef<HTMLDivElement>(null);
  const hostInstanceId = host?.hostInstanceId;
  const workspaceId = workspace?.id;
  const workspaceRevision = workspace?.revision;
  const sessionId = session?.sessionId;
  const sessionRevision = session?.revision;

  useEffect(() => {
    if (!host || !workspace || !session) {
      listRequest.current += 1;
      setModels([]);
      setEnabledProviders(undefined);
      return;
    }
    const request = ++listRequest.current;
    const expectedHostId = host.hostInstanceId;
    const expectedWorkspaceId = workspace.id;
    const expectedWorkspaceRevision = workspace.revision;
    const expectedSessionId = session.sessionId;
    const expectedSessionRevision = session.revision;
    void (async () => {
      const res = await hostClient.request(
        "model.list",
        activeSessionContext(host, workspace, session),
        null,
      );
      const current = useAppStore.getState();
      if (
        request !== listRequest.current ||
        current.host?.hostInstanceId !== expectedHostId ||
        current.workspace?.id !== expectedWorkspaceId ||
        current.workspace?.revision !== expectedWorkspaceRevision ||
        current.session?.sessionId !== expectedSessionId ||
        current.session?.revision !== expectedSessionRevision
      ) {
        return;
      }
      if (res.ok) {
        setModels(res.result.models);
        setEnabledProviders(res.result.enabledProviders);
        setThinkingLevels(res.result.thinkingLevels);
        if (res.result.current) {
          const latestSession = current.session;
          const selected = latestSession?.model;
          if (
            latestSession &&
            (selected?.provider !== res.result.current.provider ||
              selected.modelId !== res.result.current.modelId)
          ) {
            current.applySessionSnapshot({
              ...latestSession,
              model: res.result.current,
            });
          }
        }
      }
    })();
  }, [
    hostInstanceId,
    workspaceId,
    workspaceRevision,
    sessionId,
    sessionRevision,
    providerConfigRevision,
    setThinkingLevels,
  ]);

  const modelOptions = includeCurrentModel(models, session?.model, enabledProviders);
  const availableThinkingLevels = thinkingLevelsForModel(
    modelOptions,
    session?.model,
    thinkingLevels,
  );
  const thinkingModel = thinkingModelKey
    ? modelOptions.find((model) => `${model.provider}/${model.modelId}` === thinkingModelKey)
    : undefined;
  const thinkingModelSelected = thinkingModel !== undefined &&
    session?.model?.provider === thinkingModel.provider &&
    session.model.modelId === thinkingModel.modelId;
  const thinkingMenuLevels = thinkingModel?.thinkingLevels ??
    (thinkingModelSelected ? availableThinkingLevels : ["off"]);
  const modelMenuLabels = modelOptions.length > 0
    ? modelOptions.map(modelOptionLabel)
    : ["No enabled models"];
  const modelMenuMeasureKey = modelMenuLabels.join("\n");

  useLayoutEffect(() => {
    const contentWidth = modelMenuMeasureRef.current?.scrollWidth;
    if (contentWidth === undefined) return;
    const nextWidth = Math.min(
      MODEL_MENU_MAX_WIDTH,
      Math.max(
        MODEL_MENU_MIN_WIDTH,
        Math.ceil(contentWidth) + MODEL_MENU_ROW_CONTROLS_WIDTH,
      ),
    );
    setModelMenuWidth((current) => current === nextWidth ? current : nextWidth);
  }, [modelMenuMeasureKey]);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
        setThinkingModelKey(null);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        setThinkingModelKey(null);
      }
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);

  async function setModel(provider: string, modelId: string): Promise<boolean> {
    if (!host || !workspace || !session) return false;
    const res = await hostClient.request(
      "model.setCurrent",
      activeSessionContext(host, workspace, session),
      { provider, modelId },
    );
    const current = useAppStore.getState();
    if (
      current.host?.hostInstanceId !== host.hostInstanceId ||
      current.workspace?.id !== workspace.id ||
      current.workspace?.revision !== workspace.revision ||
      current.session?.sessionId !== session.sessionId ||
      current.session?.revision !== session.revision
    ) {
      return false;
    }
    if (res.ok) {
      setSession(res.result.session);
      setThinkingLevels(res.result.thinkingLevels);
      return true;
    }
    pushNotification(res.error?.message ?? "Could not switch model", "error");
    return false;
  }

  async function setThinkingForModel(model: ModelSummary, level: string) {
    const selected = useAppStore.getState().session?.model;
    if (selected?.provider !== model.provider || selected.modelId !== model.modelId) {
      if (!(await setModel(model.provider, model.modelId))) return;
    }
    const current = useAppStore.getState();
    if (!current.host || !current.workspace || !current.session) return;
    const generation = captureRequestGeneration(current.host);
    const res = await hostClient.request(
      "model.setThinkingLevel",
      activeSessionContext(current.host, current.workspace, current.session),
      { level },
    );
    if (
      !isCurrentRequestGeneration(useAppStore.getState().host, generation, {
        session: true,
      })
    ) {
      return;
    }
    if (res.ok) {
      setSession(res.result);
      setMenuOpen(false);
      setThinkingModelKey(null);
      return;
    }
    pushNotification(res.error?.message ?? "Could not set thinking level", "error");
  }

  return (
    <div className="flex min-w-0 items-center">
      <div ref={menuRef} className="relative flex h-7 min-w-0 max-w-[280px] items-center">
        <span
          ref={modelMenuMeasureRef}
          aria-hidden="true"
          className="pointer-events-none invisible absolute flex w-max flex-col whitespace-nowrap text-xs"
        >
          {modelMenuLabels.map((label, index) => <span key={`${index}:${label}`}>{label}</span>)}
        </span>
        <button
          type="button"
          className="flex h-7 min-w-0 max-w-full cursor-pointer items-center gap-1 text-xs text-muted hover:text-foreground disabled:cursor-default disabled:opacity-40"
          disabled={!session}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title={session?.model ? modelOptionLabel(session.model) : "Select model"}
          onClick={() => {
            setMenuOpen((open) => !open);
            setThinkingModelKey(null);
          }}
        >
          <span className="truncate">
            {session?.model ? modelOptionLabel(session.model) : "No model"}
          </span>
          <ChevronDown
            className={`shrink-0 transition-transform ${menuOpen ? "rotate-180" : ""}`}
            size={13}
          />
        </button>
        {menuOpen && (
          <div
            className="absolute bottom-full left-0 z-50 mb-2 min-w-[120px] max-w-[280px]"
            style={{ width: modelMenuWidth }}
          >
            <div
              ref={modelMenuPanelRef}
              className="max-h-80 w-full overflow-y-auto rounded-md border border-border bg-surface-raised py-0.5 shadow-lg"
              role="menu"
              aria-label="Models"
            >
              {modelOptions.length === 0 ? (
                <p className="px-2 py-1.5 text-xs text-muted">No enabled models</p>
              ) : modelOptions.map((model) => {
                const key = `${model.provider}/${model.modelId}`;
                const selected = session?.model?.provider === model.provider &&
                  session.model.modelId === model.modelId;
                const levels = model.thinkingLevels ?? (selected ? availableThinkingLevels : ["off"]);
                return (
                  <div key={key} className="flex h-8 items-center gap-0.5 px-1">
                    <button
                      type="button"
                      className={`min-w-0 flex-1 truncate px-1.5 py-1 text-left text-xs ${
                        selected ? "font-medium text-accent" : "text-foreground hover:text-accent"
                      }`}
                      role="menuitemradio"
                      aria-checked={selected}
                      title={modelOptionLabel(model)}
                      onClick={() => {
                        if (selected) {
                          setMenuOpen(false);
                          return;
                        }
                        void setModel(model.provider, model.modelId).then((changed) => {
                          if (changed) setMenuOpen(false);
                        });
                      }}
                    >
                      {modelOptionLabel(model)}
                    </button>
                    <button
                      type="button"
                      className={`flex size-7 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-overlay hover:text-foreground ${
                        thinkingModelKey === key ? "bg-surface-overlay text-foreground" : ""
                      }`}
                      title={`Thinking level for ${modelOptionLabel(model)}`}
                      aria-label={`Thinking level for ${modelOptionLabel(model)}`}
                      aria-expanded={thinkingModelKey === key}
                      onClick={(event) => {
                        if (thinkingModelKey === key) {
                          setThinkingModelKey(null);
                          return;
                        }
                        const panel = modelMenuPanelRef.current?.getBoundingClientRect();
                        const button = event.currentTarget.getBoundingClientRect();
                        const estimatedHeight = Math.min(220, Math.max(36, levels.length * 28 + 8));
                        const rowTop = panel ? button.top - panel.top : 0;
                        setThinkingMenuTop(panel
                          ? Math.max(0, Math.min(rowTop, panel.height - estimatedHeight))
                          : 0);
                        setThinkingModelKey(key);
                      }}
                    >
                      <Brain size={14} />
                    </button>
                  </div>
                );
              })}
            </div>
            {thinkingModel && (
              <div
                className="absolute left-full ml-1 min-w-[112px] overflow-hidden rounded-md border border-border bg-surface-raised py-1 shadow-lg"
                style={{ top: thinkingMenuTop }}
                role="menu"
                aria-label={`Thinking level for ${modelOptionLabel(thinkingModel)}`}
              >
                {thinkingMenuLevels.length === 0 ? (
                  <span className="block px-2 py-1.5 text-[11px] text-muted">No levels</span>
                ) : thinkingMenuLevels.map((level) => {
                  const active = thinkingModelSelected && session?.thinkingLevel === level;
                  return (
                    <button
                      key={level}
                      type="button"
                      className={`flex h-7 w-full items-center gap-1.5 px-2 text-left text-[11px] capitalize ${
                        active
                          ? "bg-accent/15 text-accent"
                          : "text-muted hover:bg-surface-overlay hover:text-foreground"
                      }`}
                      role="menuitemradio"
                      aria-checked={active}
                      onClick={() => void setThinkingForModel(thinkingModel, level)}
                    >
                      <span className="flex size-3 shrink-0 items-center justify-center">
                        {active && <Check size={11} />}
                      </span>
                      {level}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
      <ContextUsageRing />
    </div>
  );
}
