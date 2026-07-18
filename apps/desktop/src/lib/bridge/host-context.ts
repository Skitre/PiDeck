/**
 * Central context builders for HostClient requests (R2/R7).
 * Pages must not invent extra context fields.
 */
import type {
  ActiveSessionContext,
  HostContext,
  HostIdentity,
  HostStatusSnapshot,
  NullableSessionContext,
  SessionPackageContext,
  SessionSnapshot,
  ToolMutationContext,
  WorkspaceContext,
  WorkspacePackageContext,
  WorkspaceSnapshot,
} from "@pideck/protocol";

export function hostContext(host: HostStatusSnapshot): HostContext {
  return { expectedHostInstanceId: host.hostInstanceId };
}

export function workspaceContext(
  host: HostStatusSnapshot,
  workspace: WorkspaceSnapshot,
): WorkspaceContext {
  return {
    expectedHostInstanceId: host.hostInstanceId,
    expectedWorkspaceId: workspace.id,
    expectedWorkspaceRevision: workspace.revision,
  };
}

export function nullableSessionContext(
  host: HostStatusSnapshot,
  workspace: WorkspaceSnapshot,
): NullableSessionContext {
  return {
    ...workspaceContext(host, workspace),
    expectedSessionId: host.sessionId,
    expectedSessionRevision: host.sessionRevision,
  };
}

export function activeSessionContext(
  host: HostStatusSnapshot,
  workspace: WorkspaceSnapshot,
  session: SessionSnapshot,
): ActiveSessionContext {
  return {
    expectedHostInstanceId: host.hostInstanceId,
    expectedWorkspaceId: workspace.id,
    expectedWorkspaceRevision: workspace.revision,
    expectedSessionId: session.sessionId,
    expectedSessionRevision: session.revision,
  };
}

export function toolMutationContext(
  host: HostStatusSnapshot,
  workspace: WorkspaceSnapshot,
  session: SessionSnapshot,
  toolRevision: number,
): ToolMutationContext {
  return {
    ...activeSessionContext(host, workspace, session),
    expectedToolRevision: toolRevision,
  };
}

export function sessionPackageContext(
  host: HostStatusSnapshot,
  workspace: WorkspaceSnapshot,
): SessionPackageContext {
  return {
    expectedHostInstanceId: host.hostInstanceId,
    expectedWorkspaceId: workspace.id,
    expectedWorkspaceRevision: workspace.revision,
    expectedSessionId: host.sessionId,
    expectedSessionRevision: host.sessionRevision,
    expectedPackageRevision: host.packageRevision,
  };
}

export function workspacePackageContext(
  host: HostStatusSnapshot,
  workspace: WorkspaceSnapshot,
): WorkspacePackageContext {
  return {
    ...workspaceContext(host, workspace),
    expectedPackageRevision: host.packageRevision,
  };
}

/** Merge a response identity without allowing a late response to regress generations. */
export type RequestGeneration = {
  hostInstanceId: string;
  workspaceId: string | null;
  workspaceRevision: number;
  sessionId: string | null;
  sessionRevision: number;
  packageRevision: number;
};

export function captureRequestGeneration(host: HostStatusSnapshot): RequestGeneration {
  return {
    hostInstanceId: host.hostInstanceId,
    workspaceId: host.workspaceId,
    workspaceRevision: host.workspaceRevision,
    sessionId: host.sessionId,
    sessionRevision: host.sessionRevision,
    packageRevision: host.packageRevision,
  };
}

export type WorkspaceAuthorization = {
  generation: RequestGeneration;
  workspaceId: string;
  workspaceRevision: number;
  trustDecision: WorkspaceSnapshot["trust"]["decision"];
};

export function captureWorkspaceAuthorization(
  host: HostStatusSnapshot,
  workspace: WorkspaceSnapshot,
): WorkspaceAuthorization {
  return {
    generation: captureRequestGeneration(host),
    workspaceId: workspace.id,
    workspaceRevision: workspace.revision,
    trustDecision: workspace.trust.decision,
  };
}

export function isCurrentWorkspaceAuthorization(
  host: HostStatusSnapshot | null,
  workspace: WorkspaceSnapshot | null,
  authorization: WorkspaceAuthorization,
  options: { requireTrusted?: boolean } = {},
): boolean {
  if (!workspace || workspace.id !== authorization.workspaceId) return false;
  if (workspace.revision !== authorization.workspaceRevision) return false;
  if (workspace.trust.decision !== authorization.trustDecision) return false;
  if (
    options.requireTrusted &&
    workspace.trust.decision !== "trusted" &&
    workspace.trust.decision !== "session"
  ) {
    return false;
  }
  return isCurrentRequestGeneration(host, authorization.generation, {
    session: true,
    packages: true,
  });
}

export function isExpectedPackageMutationCompletion(
  current: HostStatusSnapshot | null,
  expected: RequestGeneration,
  response: HostIdentity,
): boolean {
  if (!current || current.hostInstanceId !== expected.hostInstanceId) return false;
  if (response.hostInstanceId !== expected.hostInstanceId) return false;
  if (
    current.workspaceId !== expected.workspaceId ||
    current.workspaceRevision !== expected.workspaceRevision ||
    response.workspaceId !== expected.workspaceId ||
    response.workspaceRevision !== expected.workspaceRevision
  ) {
    return false;
  }
  if (
    response.sessionRevision < expected.sessionRevision ||
    response.packageRevision < expected.packageRevision
  ) {
    return false;
  }
  const currentSessionIsCaptured =
    current.sessionId === expected.sessionId &&
    current.sessionRevision === expected.sessionRevision;
  const currentSessionIsResponse =
    current.sessionId === response.sessionId &&
    current.sessionRevision === response.sessionRevision;
  const currentPackageIsCaptured = current.packageRevision === expected.packageRevision;
  const currentPackageIsResponse = current.packageRevision === response.packageRevision;
  return (
    (currentSessionIsCaptured || currentSessionIsResponse) &&
    (currentPackageIsCaptured || currentPackageIsResponse)
  );
}

export function isCurrentRequestGeneration(
  current: HostStatusSnapshot | null,
  expected: RequestGeneration,
  options: { session?: boolean; packages?: boolean } = {},
): boolean {
  if (!current || current.hostInstanceId !== expected.hostInstanceId) return false;
  if (
    current.workspaceId !== expected.workspaceId ||
    current.workspaceRevision !== expected.workspaceRevision
  ) {
    return false;
  }
  if (
    options.session &&
    (current.sessionId !== expected.sessionId ||
      current.sessionRevision !== expected.sessionRevision)
  ) {
    return false;
  }
  if (options.packages && current.packageRevision !== expected.packageRevision) {
    return false;
  }
  return true;
}

export function mergeHostIdentity(
  current: HostStatusSnapshot,
  incoming: HostIdentity,
): HostStatusSnapshot | null {
  if (current.hostInstanceId !== incoming.hostInstanceId) return null;
  if (incoming.workspaceRevision < current.workspaceRevision) return current;
  if (
    incoming.workspaceRevision === current.workspaceRevision &&
    incoming.workspaceId !== current.workspaceId
  ) {
    return current;
  }
  if (incoming.workspaceRevision > current.workspaceRevision) {
    return { ...current, ...incoming };
  }

  const useIncomingSession = incoming.sessionRevision > current.sessionRevision;
  const sameSessionGeneration = incoming.sessionRevision === current.sessionRevision;
  const sessionIdentityMatches = incoming.sessionId === current.sessionId;

  return {
    ...current,
    workspaceId: incoming.workspaceId,
    workspaceRevision: incoming.workspaceRevision,
    sessionId:
      useIncomingSession || (sameSessionGeneration && sessionIdentityMatches)
        ? incoming.sessionId
        : current.sessionId,
    sessionRevision: Math.max(current.sessionRevision, incoming.sessionRevision),
    packageRevision: Math.max(current.packageRevision, incoming.packageRevision),
  };
}
