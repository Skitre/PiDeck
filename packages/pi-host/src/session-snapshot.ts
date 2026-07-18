import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  ModelSummary,
  SerializableAgentMessage,
  SerializableToolInfo,
  SessionSnapshot,
  ToolSnapshot,
} from "@pi-desktop/protocol";
import { toJsonValue } from "@pi-desktop/protocol";

export function buildToolSnapshot(args: {
  session: AgentSession;
  workspaceId: string;
  sessionId: string;
  sessionRevision: number;
  toolRevision: number;
}): ToolSnapshot {
  const tools: SerializableToolInfo[] = args.session.getAllTools().map((t) => {
    const anyT = t as {
      name: string;
      description?: string;
      parameters?: unknown;
      sourceLabel?: string;
      source?: { kind?: string } | string;
    };
    const source =
      anyT.sourceLabel ??
      (typeof anyT.source === "string" ? anyT.source : anyT.source?.kind);
    return {
      name: anyT.name,
      description: anyT.description,
      parameters: anyT.parameters !== undefined ? toJsonValue(anyT.parameters) : undefined,
      source,
    };
  });

  return {
    revision: args.toolRevision,
    workspaceId: args.workspaceId,
    sessionId: args.sessionId,
    sessionRevision: args.sessionRevision,
    tools,
    active: [...args.session.getActiveToolNames()],
  };
}

export function buildSessionSnapshot(args: {
  session: AgentSession;
  sessionManager: SessionManager;
  cwd: string;
  sessionId: string;
  revision: number;
  workspaceId: string;
  toolRevision: number;
}): SessionSnapshot {
  const { session } = args;
  const model = session.model;
  const modelSummary: ModelSummary | undefined = model
    ? {
        provider: model.provider,
        modelId: model.id,
        name: model.name ?? model.id,
        thinkingLevels: session.getAvailableThinkingLevels?.() as string[] | undefined,
      }
    : undefined;

  const messages: SerializableAgentMessage[] = session.messages.map((m) =>
    toJsonValue(m) as SerializableAgentMessage,
  );

  return {
    sessionId: args.sessionId || session.sessionId,
    sessionPath: session.sessionFile,
    name: session.sessionName,
    cwd: args.cwd,
    revision: args.revision,
    isStreaming: !session.isIdle,
    isIdle: session.isIdle,
    isCompacting: session.isCompacting,
    isRetrying: session.isRetrying,
    model: modelSummary,
    thinkingLevel: String(session.thinkingLevel),
    autoCompactionEnabled: session.autoCompactionEnabled,
    autoRetryEnabled: session.autoRetryEnabled,
    steeringMode: session.steeringMode,
    followUpMode: session.followUpMode,
    pending: {
      steering: [...session.getSteeringMessages()],
      followUp: [...session.getFollowUpMessages()],
    },
    messages,
    tools: buildToolSnapshot({
      session,
      workspaceId: args.workspaceId,
      sessionId: args.sessionId || session.sessionId,
      sessionRevision: args.revision,
      toolRevision: args.toolRevision,
    }),
  };
}
