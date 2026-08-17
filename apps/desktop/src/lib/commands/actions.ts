import { hostClient } from "../bridge/host-client";
import {
  activeSessionContext,
  captureRequestGeneration,
  isCurrentRequestGeneration,
  mergeHostIdentity,
  nullableSessionContext,
} from "../bridge/host-context";
import { tCurrent } from "../i18n/use-t";
import { useAppStore } from "../stores/app-store";

let createPending = false;
const createPendingListeners = new Set<(pending: boolean) => void>();

function setCreatePending(pending: boolean): void {
  createPending = pending;
  for (const listener of createPendingListeners) listener(pending);
}

export function isCreateSessionPending(): boolean {
  return createPending;
}

export function subscribeCreateSessionPending(listener: (pending: boolean) => void): () => void {
  createPendingListeners.add(listener);
  return () => createPendingListeners.delete(listener);
}

export type AbortMethod = "agent.abort" | "agent.abortCompaction" | "agent.abortRetry";

export function abortMethodForSession(session: {
  isCompacting?: boolean;
  isRetrying?: boolean;
}): AbortMethod {
  if (session.isCompacting) return "agent.abortCompaction";
  if (session.isRetrying) return "agent.abortRetry";
  return "agent.abort";
}

export async function createNewSession(): Promise<boolean> {
  const state = useAppStore.getState();
  if (!state.host || !state.workspace?.servicesReady || createPending) return false;
  const generation = captureRequestGeneration(state.host);
  setCreatePending(true);
  try {
    const response = await hostClient.request(
      "session.create",
      nullableSessionContext(state.host, state.workspace),
      {},
    );
    if (!isCurrentRequestGeneration(useAppStore.getState().host, generation)) {
      return false;
    }
    if (!response.ok) {
      useAppStore
        .getState()
        .pushNotification(
          response.error?.code === "SESSION_LIMIT"
            ? tCurrent("sessionsLimitReached")
            : (response.error?.message ?? tCurrent("notifCreateSessionFailed")),
          "error",
        );
      return false;
    }
    const current = useAppStore.getState();
    current.applySessionSnapshot(response.result);
    if (current.host) {
      const nextHost = mergeHostIdentity(current.host, response);
      if (nextHost) current.setHost(nextHost);
    }
    return true;
  } catch (error) {
    useAppStore
      .getState()
      .pushNotification(
        error instanceof Error ? error.message : tCurrent("notifCreateSessionFailed"),
        "error",
      );
    return false;
  } finally {
    setCreatePending(false);
  }
}

export async function abortCurrentAgent(): Promise<boolean> {
  const state = useAppStore.getState();
  if (!state.host || !state.workspace || !state.session || state.session.isIdle) {
    return false;
  }
  const generation = captureRequestGeneration(state.host);
  try {
    const method = abortMethodForSession(state.session);
    if (method !== "agent.abort") {
      const response = await hostClient.request(
        method,
        activeSessionContext(state.host, state.workspace, state.session),
        null,
      );
      if (
        !isCurrentRequestGeneration(useAppStore.getState().host, generation, {
          session: true,
        })
      ) {
        return false;
      }
      if (!response.ok) {
        useAppStore
          .getState()
          .pushNotification(
            response.error?.message ??
              tCurrent(
                method === "agent.abortCompaction"
                  ? "notifCompactStopFailed"
                  : "composerAbortFailed",
              ),
            "error",
          );
        return false;
      }
      return true;
    }
    const response = await hostClient.request(
      "agent.abort",
      activeSessionContext(state.host, state.workspace, state.session),
      null,
    );
    if (
      !isCurrentRequestGeneration(useAppStore.getState().host, generation, {
        session: true,
      })
    ) {
      return false;
    }
    if (!response.ok) {
      useAppStore
        .getState()
        .pushNotification(response.error?.message ?? tCurrent("composerAbortFailed"), "error");
      return false;
    }
    useAppStore.getState().applySessionSnapshot(response.result.session);
    if (response.result.error) {
      useAppStore.getState().pushNotification(response.result.error.message, "error");
    }
    return true;
  } catch (error) {
    useAppStore
      .getState()
      .pushNotification(
        error instanceof Error ? error.message : tCurrent("composerAbortFailed"),
        "error",
      );
    return false;
  }
}
