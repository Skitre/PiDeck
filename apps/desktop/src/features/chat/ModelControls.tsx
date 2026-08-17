import { Brain, Check, ChevronDown } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ModelSummary, SessionContextBreakdown } from "@pideck/protocol";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import {
  activeSessionContext,
  captureRequestGeneration,
  isCurrentRequestGeneration,
} from "../../lib/bridge/host-context";
import { formatTokenCount } from "../../lib/format-token-count";
import { requestWithRetry } from "../../lib/bridge/request-retry";
import { requestCompact, setAutoCompaction } from "./compaction-actions";
import { Switch } from "../../components/Switch";
import { useT } from "../../lib/i18n/use-t";

const MODEL_MENU_MIN_WIDTH = 120;
const MODEL_MENU_DEFAULT_MAX_WIDTH = 280;
const MODEL_MENU_RESIZE_MAX_WIDTH = 640;
const MODEL_MENU_ROW_CONTROLS_WIDTH = 48;
const MODEL_MENU_RESIZE_STEP = 20;
const MODEL_MENU_VIEWPORT_GUTTER = 12;
const MODEL_MENU_THINKING_RESERVE_WIDTH = 120;
const CONTEXT_BREAKDOWN_KEYS = [
  "systemPrompt",
  "toolDefinitions",
  "userPrompts",
  "assistantMessages",
  "toolResults",
  "summaries",
  "other",
] as const satisfies readonly (keyof SessionContextBreakdown)[];

function estimatedContextTokens(breakdown: SessionContextBreakdown | undefined): number | null {
  if (!breakdown) return null;
  return CONTEXT_BREAKDOWN_KEYS.reduce((sum, key) => sum + breakdown[key], 0);
}

export function modelMenuMaxWidth(menuLeft: number, viewportWidth: number): number {
  const viewportLimit =
    viewportWidth -
    Math.max(0, menuLeft) -
    MODEL_MENU_VIEWPORT_GUTTER -
    MODEL_MENU_THINKING_RESERVE_WIDTH;
  return Math.max(MODEL_MENU_MIN_WIDTH, Math.min(MODEL_MENU_RESIZE_MAX_WIDTH, viewportLimit));
}

export function clampModelMenuWidth(
  width: number,
  menuLeft: number,
  viewportWidth: number,
): number {
  return Math.min(
    modelMenuMaxWidth(menuLeft, viewportWidth),
    Math.max(MODEL_MENU_MIN_WIDTH, Math.round(width)),
  );
}

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

export function thinkingLevelLabel(level: string): string {
  const labels = {
    off: "Off",
    minimal: "Minimal",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra high",
  } as const;
  return level in labels ? labels[level as keyof typeof labels] : level;
}

export function canRequestModelList(args: {
  hasHost: boolean;
  hasWorkspace: boolean;
  hasSession: boolean;
  connecting: boolean;
  rehydrating: boolean;
  desynchronized: boolean;
}): boolean {
  return (
    args.hasHost &&
    args.hasWorkspace &&
    args.hasSession &&
    !args.connecting &&
    !args.rehydrating &&
    !args.desynchronized
  );
}

export function ContextUsageRing() {
  const t = useT();
  const session = useAppStore((s) => s.session);
  const contextUsage = session?.contextUsage;
  const breakdown = contextUsage?.breakdown;
  const estimatedTokens = contextUsage?.tokens === null ? estimatedContextTokens(breakdown) : null;
  const displayTokens = contextUsage?.tokens ?? estimatedTokens;
  const isEstimated = contextUsage?.tokens === null && estimatedTokens !== null;
  const [open, setOpen] = useState(false);
  const [compactPending, setCompactPending] = useState(false);
  const containerRef = useRef<HTMLSpanElement>(null);
  const percent =
    displayTokens === null || !contextUsage
      ? null
      : Math.min(100, Math.max(0, (displayTokens / contextUsage.contextWindow) * 100));
  const roundedPercent = percent === null ? null : Math.round(percent);
  const title = contextUsage
    ? displayTokens === null
      ? t("contextUsageUnknown", { window: formatTokenCount(contextUsage.contextWindow) })
      : t(isEstimated ? "contextUsageEstimated" : "contextUsageValue", {
          used: formatTokenCount(displayTokens),
          window: formatTokenCount(contextUsage.contextWindow),
        })
    : t("contextUnavailable");
  const autoCompactionEnabled = session?.autoCompactionEnabled ?? false;

  useEffect(() => {
    if (!open) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  async function compactNow() {
    setCompactPending(true);
    try {
      await requestCompact();
    } finally {
      setCompactPending(false);
    }
  }

  return (
    <span ref={containerRef} className="relative flex shrink-0 items-center">
      <button
        type="button"
        className="relative flex size-6 shrink-0 items-center justify-center rounded-full"
        style={{
          background: `conic-gradient(var(--color-accent) ${
            percent === null ? 0 : percent * 3.6
          }deg, var(--color-border) 0deg)`,
        }}
        aria-label={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={title}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="absolute inset-[2px] rounded-full bg-surface-raised" />
        <span className="relative text-[7px] tabular-nums text-muted">
          {roundedPercent === null ? "--" : `${isEstimated ? "~" : ""}${roundedPercent}%`}
        </span>
      </button>
      {open && (
        <div className="theme-floating-surface absolute bottom-full right-0 z-50 mb-2 flex w-64 flex-col rounded-md border border-border bg-surface-raised p-3 text-left text-[11px] leading-4 text-foreground shadow-lg">
          <span className="font-medium">{t("contextUsageTitle")}</span>
          <span className="mt-0.5 tabular-nums text-muted">{title}</span>
          {breakdown && (
            <>
              <span className="my-2 h-px bg-border" />
              <span className="mb-1 text-[10px] font-medium uppercase text-muted">
                {t("contextEstimatedComposition")}
              </span>
              <span className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
                <span className="text-muted">{t("contextSystemPrompt")}</span>
                <span className="tabular-nums">~{formatTokenCount(breakdown.systemPrompt)}</span>
                <span className="text-muted">{t("contextToolDefinitions")}</span>
                <span className="tabular-nums">~{formatTokenCount(breakdown.toolDefinitions)}</span>
                <span className="text-muted">{t("contextUserPrompts")}</span>
                <span className="tabular-nums">~{formatTokenCount(breakdown.userPrompts)}</span>
                <span className="text-muted">{t("contextAssistant")}</span>
                <span className="tabular-nums">
                  ~{formatTokenCount(breakdown.assistantMessages)}
                </span>
                <span className="text-muted">{t("contextToolResults")}</span>
                <span className="tabular-nums">~{formatTokenCount(breakdown.toolResults)}</span>
                <span className="text-muted">{t("contextSummaries")}</span>
                <span className="tabular-nums">~{formatTokenCount(breakdown.summaries)}</span>
                <span className="text-muted">{t("contextOtherFraming")}</span>
                <span className="tabular-nums">~{formatTokenCount(breakdown.other)}</span>
              </span>
              <span className="mt-2 text-[10px] text-muted">
                {t(isEstimated ? "contextEstimatePendingNote" : "contextEstimateNote")}
              </span>
            </>
          )}
          <span className="my-2 h-px bg-border" />
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted">{t("contextAutoCompaction")}</span>
            <Switch
              checked={autoCompactionEnabled}
              label={t("contextToggleAutoCompaction")}
              disabled={!session}
              onChange={() => session && void setAutoCompaction(!session.autoCompactionEnabled)}
            />
          </div>
          <button
            type="button"
            className="mt-2 flex h-7 items-center justify-center rounded-md border border-border bg-surface px-2 font-medium transition-colors hover:bg-surface-overlay disabled:cursor-not-allowed disabled:opacity-40"
            disabled={compactPending || !session?.isIdle}
            onClick={() => void compactNow()}
          >
            {session?.isCompacting ? t("contextCompacting") : t("contextCompactNow")}
          </button>
        </div>
      )}
    </span>
  );
}

/** Model menu and context indicator for the composer's bottom bar. */
export function ModelControls() {
  const t = useT();
  const host = useAppStore((s) => s.host);
  const workspace = useAppStore((s) => s.workspace);
  const session = useAppStore((s) => s.session);
  const setSession = useAppStore((s) => s.applySessionSnapshot);
  const thinkingLevels = useAppStore((s) => s.thinkingLevels);
  const providerConfigRevision = useAppStore((s) => s.providerConfigRevision);
  const connecting = useAppStore((s) => s.connecting);
  const rehydrating = useAppStore((s) => s.rehydrating);
  const desynchronized = useAppStore((s) => s.desynchronized);
  const setThinkingLevels = useAppStore((s) => s.setThinkingLevels);
  const pushNotification = useAppStore((s) => s.pushNotification);
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [enabledProviders, setEnabledProviders] = useState<string[] | undefined>();
  const [menuOpen, setMenuOpen] = useState(false);
  const [modelMenuWidth, setModelMenuWidth] = useState(MODEL_MENU_MIN_WIDTH);
  const [modelMenuResizeMax, setModelMenuResizeMax] = useState(MODEL_MENU_RESIZE_MAX_WIDTH);
  const [thinkingModelKey, setThinkingModelKey] = useState<string | null>(null);
  const [thinkingMenuTop, setThinkingMenuTop] = useState(0);
  const listRequest = useRef(0);
  const menuRef = useRef<HTMLDivElement>(null);
  const modelMenuMeasureRef = useRef<HTMLSpanElement>(null);
  const modelMenuPanelRef = useRef<HTMLDivElement>(null);
  const modelMenuManuallyResized = useRef(false);
  const modelMenuResizeStart = useRef<{
    pointerId: number;
    x: number;
    width: number;
  } | null>(null);
  const hostInstanceId = host?.hostInstanceId;
  const workspaceId = workspace?.id;
  const workspaceRevision = workspace?.revision;
  const sessionId = session?.sessionId;
  const sessionRevision = session?.revision;

  useEffect(() => {
    const current = useAppStore.getState();
    const requestHost = current.host;
    const requestWorkspace = current.workspace;
    const requestSession = current.session;
    if (
      !requestHost ||
      !requestWorkspace ||
      !requestSession ||
      requestHost.hostInstanceId !== hostInstanceId ||
      requestWorkspace.id !== workspaceId ||
      requestWorkspace.revision !== workspaceRevision ||
      requestSession.sessionId !== sessionId ||
      requestSession.revision !== sessionRevision ||
      !canRequestModelList({
        hasHost: hostInstanceId !== undefined,
        hasWorkspace: workspaceId !== undefined,
        hasSession: sessionId !== undefined,
        connecting,
        rehydrating,
        desynchronized,
      })
    ) {
      listRequest.current += 1;
      setModels([]);
      setEnabledProviders(undefined);
      return;
    }
    let cancelled = false;
    const request = ++listRequest.current;
    const expectedHostId = requestHost.hostInstanceId;
    const expectedWorkspaceId = requestWorkspace.id;
    const expectedWorkspaceRevision = requestWorkspace.revision;
    const expectedSessionId = requestSession.sessionId;
    const expectedSessionRevision = requestSession.revision;
    const isCurrentRequest = () => {
      const current = useAppStore.getState();
      return (
        !cancelled &&
        request === listRequest.current &&
        current.host?.hostInstanceId === expectedHostId &&
        current.workspace?.id === expectedWorkspaceId &&
        current.workspace?.revision === expectedWorkspaceRevision &&
        current.session?.sessionId === expectedSessionId &&
        current.session?.revision === expectedSessionRevision
      );
    };
    void (async () => {
      let res;
      try {
        res = await requestWithRetry(
          () =>
            hostClient.request(
              "model.list",
              activeSessionContext(requestHost, requestWorkspace, requestSession),
              null,
            ),
          undefined,
          isCurrentRequest,
        );
      } catch {
        return;
      }
      if (!res || !isCurrentRequest()) return;
      const current = useAppStore.getState();
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
    return () => {
      cancelled = true;
    };
  }, [
    hostInstanceId,
    workspaceId,
    workspaceRevision,
    sessionId,
    sessionRevision,
    providerConfigRevision,
    connecting,
    rehydrating,
    desynchronized,
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
  const thinkingModelSelected =
    thinkingModel !== undefined &&
    session?.model?.provider === thinkingModel.provider &&
    session.model.modelId === thinkingModel.modelId;
  const thinkingMenuLevels =
    thinkingModel?.thinkingLevels ?? (thinkingModelSelected ? availableThinkingLevels : ["off"]);
  const modelMenuLabels =
    modelOptions.length > 0 ? modelOptions.map(modelOptionLabel) : [t("modelNoneEnabled")];
  const modelMenuMeasureKey = modelMenuLabels.join("\n");

  useLayoutEffect(() => {
    if (modelMenuManuallyResized.current) return;
    const contentWidth = modelMenuMeasureRef.current?.scrollWidth;
    if (contentWidth === undefined) return;
    const nextWidth = Math.min(
      MODEL_MENU_DEFAULT_MAX_WIDTH,
      Math.max(MODEL_MENU_MIN_WIDTH, Math.ceil(contentWidth) + MODEL_MENU_ROW_CONTROLS_WIDTH),
    );
    setModelMenuWidth((current) => (current === nextWidth ? current : nextWidth));
  }, [modelMenuMeasureKey]);

  useLayoutEffect(() => {
    if (!menuOpen) return;
    const clampToViewport = () => {
      const menuLeft = modelMenuPanelRef.current?.getBoundingClientRect().left ?? 0;
      const maxWidth = modelMenuMaxWidth(menuLeft, window.innerWidth);
      setModelMenuResizeMax(maxWidth);
      setModelMenuWidth((current) => Math.min(current, maxWidth));
    };
    clampToViewport();
    window.addEventListener("resize", clampToViewport);
    return () => window.removeEventListener("resize", clampToViewport);
  }, [menuOpen]);

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
    pushNotification(res.error?.message ?? t("modelSwitchFailed"), "error");
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
    pushNotification(res.error?.message ?? t("modelThinkingSetFailed"), "error");
  }

  function resizeModelMenu(width: number) {
    const menuLeft = modelMenuPanelRef.current?.getBoundingClientRect().left ?? 0;
    const maxWidth = modelMenuMaxWidth(menuLeft, window.innerWidth);
    modelMenuManuallyResized.current = true;
    setModelMenuResizeMax(maxWidth);
    setModelMenuWidth(clampModelMenuWidth(width, menuLeft, window.innerWidth));
  }

  function finishModelMenuResize(target: HTMLDivElement, pointerId: number) {
    if (modelMenuResizeStart.current?.pointerId !== pointerId) return;
    modelMenuResizeStart.current = null;
    if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
  }

  return (
    <div className="flex min-w-0 items-center">
      <div ref={menuRef} className="relative flex h-7 min-w-0 max-w-[280px] items-center">
        <span
          ref={modelMenuMeasureRef}
          aria-hidden="true"
          className="pointer-events-none invisible absolute flex w-max flex-col whitespace-nowrap text-xs"
        >
          {modelMenuLabels.map((label, index) => (
            <span key={`${index}:${label}`}>{label}</span>
          ))}
        </span>
        <button
          type="button"
          className="flex h-7 min-w-0 max-w-full cursor-pointer items-center gap-1 text-xs text-muted hover:text-foreground disabled:cursor-default disabled:opacity-40"
          disabled={!session}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title={session?.model ? modelOptionLabel(session.model) : t("modelSelect")}
          onClick={() => {
            setMenuOpen((open) => !open);
            setThinkingModelKey(null);
          }}
        >
          <span className="truncate">
            {session?.model ? modelOptionLabel(session.model) : t("modelNone")}
          </span>
          <ChevronDown
            className={`shrink-0 transition-transform ${menuOpen ? "rotate-180" : ""}`}
            size={13}
          />
        </button>
        {menuOpen && (
          <div
            className="absolute bottom-full left-0 z-50 mb-2 min-w-[120px]"
            style={{ width: modelMenuWidth }}
          >
            <div
              ref={modelMenuPanelRef}
              className="theme-floating-surface max-h-80 w-full overflow-y-auto rounded-md border border-border bg-surface-raised py-0.5 shadow-lg"
              role="menu"
              aria-label={t("modelMenuLabel")}
            >
              {modelOptions.length === 0 ? (
                <p className="px-2 py-1.5 text-xs text-muted">{t("modelNoneEnabled")}</p>
              ) : (
                modelOptions.map((model) => {
                  const key = `${model.provider}/${model.modelId}`;
                  const selected =
                    session?.model?.provider === model.provider &&
                    session.model.modelId === model.modelId;
                  const levels =
                    model.thinkingLevels ?? (selected ? availableThinkingLevels : ["off"]);
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
                        title={t("modelThinkingFor", { model: modelOptionLabel(model) })}
                        aria-label={t("modelThinkingFor", { model: modelOptionLabel(model) })}
                        aria-expanded={thinkingModelKey === key}
                        onClick={(event) => {
                          if (thinkingModelKey === key) {
                            setThinkingModelKey(null);
                            return;
                          }
                          const panel = modelMenuPanelRef.current?.getBoundingClientRect();
                          const button = event.currentTarget.getBoundingClientRect();
                          const estimatedHeight = Math.min(
                            220,
                            Math.max(36, levels.length * 28 + 8),
                          );
                          const rowTop = panel ? button.top - panel.top : 0;
                          setThinkingMenuTop(
                            panel
                              ? Math.max(0, Math.min(rowTop, panel.height - estimatedHeight))
                              : 0,
                          );
                          setThinkingModelKey(key);
                        }}
                      >
                        <Brain size={14} />
                      </button>
                    </div>
                  );
                })
              )}
            </div>
            <div
              role="separator"
              tabIndex={0}
              aria-label={t("modelMenuResize")}
              aria-orientation="vertical"
              aria-valuemin={MODEL_MENU_MIN_WIDTH}
              aria-valuemax={modelMenuResizeMax}
              aria-valuenow={modelMenuWidth}
              title={t("modelMenuResize")}
              className="group absolute -right-2 top-0 z-10 h-full w-2 cursor-col-resize touch-none rounded-sm outline-none"
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                modelMenuResizeStart.current = {
                  pointerId: event.pointerId,
                  x: event.clientX,
                  width: modelMenuWidth,
                };
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                const start = modelMenuResizeStart.current;
                if (!start || start.pointerId !== event.pointerId) return;
                resizeModelMenu(start.width + event.clientX - start.x);
              }}
              onPointerUp={(event) => finishModelMenuResize(event.currentTarget, event.pointerId)}
              onPointerCancel={(event) =>
                finishModelMenuResize(event.currentTarget, event.pointerId)
              }
              onLostPointerCapture={() => {
                modelMenuResizeStart.current = null;
              }}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                event.preventDefault();
                resizeModelMenu(
                  modelMenuWidth +
                    (event.key === "ArrowRight" ? MODEL_MENU_RESIZE_STEP : -MODEL_MENU_RESIZE_STEP),
                );
              }}
            >
              <span
                aria-hidden="true"
                className="pointer-events-none absolute left-1/2 top-1/2 h-10 w-px -translate-x-1/2 -translate-y-1/2 bg-border transition-colors group-hover:bg-accent group-focus-visible:bg-accent"
              />
            </div>
            {thinkingModel && (
              <div
                className="theme-floating-surface absolute left-full ml-2 min-w-[112px] overflow-hidden rounded-md border border-border bg-surface-raised py-1 shadow-lg"
                style={{ top: thinkingMenuTop }}
                role="menu"
                aria-label={t("modelThinkingFor", { model: modelOptionLabel(thinkingModel) })}
              >
                {thinkingMenuLevels.length === 0 ? (
                  <span className="block px-2 py-1.5 text-[11px] text-muted">
                    {t("modelNoThinkingLevels")}
                  </span>
                ) : (
                  thinkingMenuLevels.map((level) => {
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
                        {thinkingLevelLabel(level)}
                      </button>
                    );
                  })
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
