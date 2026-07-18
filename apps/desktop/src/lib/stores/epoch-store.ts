/**
 * Epoch helpers for Host/Workspace/Session rehydrate (R7).
 */
import type {
  HostStatusSnapshot,
  PackageSnapshot,
  SessionSnapshot,
  ToolSnapshot,
  WorkspaceSnapshot,
} from "@pi-desktop/protocol";

export type EpochState = {
  host: HostStatusSnapshot | null;
  workspace: WorkspaceSnapshot | null;
  session: SessionSnapshot | null;
  packages: PackageSnapshot | null;
  tools: ToolSnapshot | null;
  desynchronized: boolean;
  desyncReason?: string;
  lastSequence: number;
};

export function emptyEpoch(): EpochState {
  return {
    host: null,
    workspace: null,
    session: null,
    packages: null,
    tools: null,
    desynchronized: false,
    lastSequence: 0,
  };
}

export function beginHostEpoch(
  _prev: EpochState,
  status: HostStatusSnapshot,
): EpochState {
  return {
    ...emptyEpoch(),
    host: status,
    lastSequence: 0,
  };
}

export function clearWorkspaceEpoch(state: EpochState): EpochState {
  return {
    ...state,
    workspace: null,
    session: null,
    packages: null,
    tools: null,
  };
}

export function applyWorkspaceSnapshot(
  state: EpochState,
  workspace: WorkspaceSnapshot,
): EpochState {
  if (
    state.workspace &&
    (state.workspace.id !== workspace.id || state.workspace.revision !== workspace.revision)
  ) {
    return {
      ...state,
      workspace,
      session: null,
      packages: null,
      tools: null,
    };
  }
  return { ...state, workspace };
}

export function applySessionSnapshot(
  state: EpochState,
  session: SessionSnapshot | null,
): EpochState {
  return {
    ...state,
    session,
    tools: session?.tools ?? null,
  };
}

export function applyPackageSnapshot(
  state: EpochState,
  packages: PackageSnapshot | null,
): EpochState {
  return { ...state, packages };
}

export function markDesynchronized(state: EpochState, reason: string): EpochState {
  return { ...state, desynchronized: true, desyncReason: reason };
}

export function noteSequence(
  state: EpochState,
  sequence: number,
): { state: EpochState; action: "apply" | "drop" | "gap" } {
  if (state.lastSequence > 0 && sequence <= state.lastSequence) {
    return { state, action: "drop" };
  }
  if (state.lastSequence > 0 && sequence > state.lastSequence + 1) {
    // Advance lastSequence to the seen gap seq so later events do not re-gap forever.
    // Rehydrate will still run; completeRehydrate may also set lastSequence from hostClient.
    return {
      state: {
        ...markDesynchronized(state, `sequence gap ${state.lastSequence} -> ${sequence}`),
        lastSequence: sequence,
      },
      action: "gap",
    };
  }
  return { state: { ...state, lastSequence: sequence }, action: "apply" };
}
