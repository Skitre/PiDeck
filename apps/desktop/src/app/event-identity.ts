import type { HostEventEnvelope, SessionRuntimeState } from "@pideck/protocol";

export type EventIdentityState = {
  hostInstanceId: string | null;
  workspaceId: string | null;
  workspaceRevision: number | undefined;
  sessionId: string | null;
  sessionRevision: number | undefined;
};

/**
 * Authoritative snapshot events are allowed to advance their own generation.
 * Sequence ordering plus payload/envelope validation guards those transitions;
 * unrelated business events must still match the full active identity.
 */
export function expectedIdentityForEvent(
  event: HostEventEnvelope,
  state: EventIdentityState,
): {
  hostInstanceId: string | null;
  workspaceId?: string | null;
  workspaceRevision?: number;
  sessionId?: string | null;
  sessionRevision?: number;
} {
  const host = { hostInstanceId: state.hostInstanceId };

  switch (event.event) {
    case "host.ready":
    case "host.statusChanged":
    case "host.fatal":
    case "workspace.changed":
    case "workspace.trustRequired":
    case "extensionUi.request":
    case "extensionUi.customStarted":
    case "extensionUi.customFrame":
    case "extensionUi.customClosed":
      return host;
    case "session.snapshot":
    case "session.infoChanged":
    case "session.runtimeChanged":
    case "agent.event":
    case "package.diagnostic":
    case "extensionUi.statusChanged":
    case "extensionUi.widgetChanged":
    case "extensionUi.notification":
    case "package.progress":
    case "package.snapshot":
    case "package.resourcesChanged":
      return {
        ...host,
        workspaceId: state.workspaceId,
        workspaceRevision: state.workspaceRevision,
      };
    default:
      return {
        ...host,
        workspaceId: state.workspaceId,
        workspaceRevision: state.workspaceRevision,
        sessionId: state.sessionId,
        sessionRevision: state.sessionRevision,
      };
  }
}

export function isBackgroundExtensionUiRequest(args: {
  eventSessionId: string;
  activeSessionId: string | null;
  catalogRuntimeState?: SessionRuntimeState;
}): boolean {
  return (
    args.eventSessionId !== args.activeSessionId &&
    (args.catalogRuntimeState === "running" || args.catalogRuntimeState === "queued")
  );
}
