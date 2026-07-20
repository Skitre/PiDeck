import { useEffect, useRef, useState } from "react";
import type { ModelSummary } from "@pideck/protocol";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import {
  activeSessionContext,
  captureRequestGeneration,
  isCurrentRequestGeneration,
} from "../../lib/bridge/host-context";
import { formatTokenCount } from "../../lib/format-token-count";

export function includeCurrentModel(
  models: ModelSummary[],
  current: ModelSummary | undefined,
): ModelSummary[] {
  if (!current) return models;
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

/** Model + thinking-level pickers; lives in the composer's bottom bar. */
export function ModelControls() {
  const host = useAppStore((s) => s.host);
  const workspace = useAppStore((s) => s.workspace);
  const session = useAppStore((s) => s.session);
  const setSession = useAppStore((s) => s.applySessionSnapshot);
  const thinkingLevels = useAppStore((s) => s.thinkingLevels);
  const providerConfigRevision = useAppStore((s) => s.providerConfigRevision);
  const setThinkingLevels = useAppStore((s) => s.setThinkingLevels);
  const [models, setModels] = useState<ModelSummary[]>([]);
  const listRequest = useRef(0);
  const hostInstanceId = host?.hostInstanceId;
  const workspaceId = workspace?.id;
  const workspaceRevision = workspace?.revision;
  const sessionId = session?.sessionId;
  const sessionRevision = session?.revision;

  useEffect(() => {
    if (!host || !workspace || !session) {
      listRequest.current += 1;
      setModels([]);
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

  const modelOptions = includeCurrentModel(models, session?.model);
  const availableThinkingLevels = thinkingLevelsForModel(
    modelOptions,
    session?.model,
    thinkingLevels,
  );

  async function setModel(provider: string, modelId: string) {
    if (!host || !workspace || !session) return;
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
      return;
    }
    if (res.ok) {
      setSession(res.result.session);
      setThinkingLevels(res.result.thinkingLevels);
    }
  }

  async function setThinking(level: string) {
    if (!host || !workspace || !session) return;
    const generation = captureRequestGeneration(host);
    const res = await hostClient.request(
      "model.setThinkingLevel",
      activeSessionContext(host, workspace, session),
      { level },
    );
    if (
      !isCurrentRequestGeneration(useAppStore.getState().host, generation, {
        session: true,
      })
    ) {
      return;
    }
    if (res.ok) setSession(res.result);
  }

  return (
    <>
      <select
        className="h-7 max-w-[180px] truncate rounded-md border border-border bg-surface px-1.5 text-xs"
        value={
          session?.model ? `${session.model.provider}/${session.model.modelId}` : ""
        }
        onChange={(event) => {
          const [provider, ...rest] = event.target.value.split("/");
          void setModel(provider!, rest.join("/"));
        }}
        disabled={!session}
        title="Model"
      >
        {!session?.model && <option value="">No model</option>}
        {modelOptions.map((model) => (
          <option
            key={`${model.provider}/${model.modelId}`}
            value={`${model.provider}/${model.modelId}`}
          >
            {model.name || model.modelId}
          </option>
        ))}
      </select>
      <select
        className="h-7 rounded-md border border-border bg-surface px-1.5 text-xs capitalize"
        value={session?.thinkingLevel ?? ""}
        onChange={(event) => void setThinking(event.target.value)}
        disabled={!session}
        title="Thinking level"
      >
        {availableThinkingLevels.length === 0 && (
          <option value={session?.thinkingLevel ?? ""}>
            {session?.thinkingLevel ?? "Off"}
          </option>
        )}
        {availableThinkingLevels.map((level) => (
          <option key={level} value={level}>
            {level}
          </option>
        ))}
      </select>
      <ContextUsageRing />
    </>
  );
}
