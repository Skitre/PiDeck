import { useEffect, useRef, useState } from "react";
import type { ModelSummary } from "@pideck/protocol";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import {
  activeSessionContext,
  captureRequestGeneration,
  isCurrentRequestGeneration,
} from "../../lib/bridge/host-context";

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

export function ChatHeader() {
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
  const sessionName = session?.name?.trim() || "New conversation";
  const runtimeLabel = session?.isStreaming
    ? "Streaming"
    : session?.isCompacting
      ? "Compacting"
      : session?.isRetrying
        ? "Retrying"
        : session?.isIdle
          ? "Ready"
          : "Working";

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
    <div className="flex h-14 shrink-0 items-center gap-4 border-b border-border px-5">
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-sm font-semibold" title={sessionName}>
          {sessionName}
        </h1>
        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted">
          <span
            className={`size-1.5 rounded-full ${
              session?.isStreaming || (session && !session.isIdle)
                ? "bg-success"
                : "bg-muted"
            }`}
          />
          {session ? runtimeLabel : "No active session"}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <select
          className="h-8 max-w-[220px] truncate rounded-md border border-border bg-surface-raised px-2 text-xs"
          value={
            session?.model
              ? `${session.model.provider}/${session.model.modelId}`
              : ""
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
          className="h-8 rounded-md border border-border bg-surface-raised px-2 text-xs capitalize"
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
      </div>
    </div>
  );
}
