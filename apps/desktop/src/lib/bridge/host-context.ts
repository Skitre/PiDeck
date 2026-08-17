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
  SessionTargetContext,
  WorkspaceContext,
  WorkspaceSnapshot,
} from "@pideck/protocol";

export function hostContext(host: HostStatusSnapshot): HostContext {
  return { expectedHostInstanceId: host.hostInstanceId };
}

export function workspaceContext(
  host: HostStatusSnapshot,
  workspace: WorkspaceSnapshot | null,
): WorkspaceContext {
  return {
    expectedHostInstanceId: host.hostInstanceId,
    expectedWorkspaceId: workspace?.id ?? host.workspaceId,
    expectedWorkspaceRevision: workspace?.revision ?? host.workspaceRevision,
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

export function sessionTargetContext(
  host: HostStatusSnapshot,
  workspace: WorkspaceSnapshot,
  sessionId: string,
  sessionRevision: number,
): SessionTargetContext {
  return {
    expectedHostInstanceId: host.hostInstanceId,
    expectedWorkspaceId: workspace.id,
    expectedWorkspaceRevision: workspace.revision,
    expectedSessionId: sessionId,
    expectedSessionRevision: sessionRevision,
  };
}

/** Follow Host-side identity migration when a captured Extension UI target is promoted. */
export function latestSessionTargetContext(
  captured: SessionTargetContext,
  host: HostStatusSnapshot | null,
  workspace: WorkspaceSnapshot | null,
  session: SessionSnapshot | null,
): SessionTargetContext {
  if (
    !host ||
    !workspace ||
    !session ||
    host.hostInstanceId !== captured.expectedHostInstanceId ||
    workspace.id !== captured.expectedWorkspaceId ||
    workspace.revision !== captured.expectedWorkspaceRevision ||
    session.sessionId !== captured.expectedSessionId ||
    session.revision < captured.expectedSessionRevision
  ) {
    return captured;
  }
  return activeSessionContext(host, workspace, session);
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
