import { useEffect, useState } from "react";
import { useAppStore } from "../lib/stores/app-store";
import { hostClient } from "../lib/bridge/host-client";
import { createTauriTransport } from "../lib/bridge/tauri-transport";
import { fullRehydrate } from "../lib/bridge/rehydrate";
import { Sidebar } from "../components/Sidebar";
import { RightDock } from "../components/RightDock";
import { WindowControls } from "../components/WindowControls";
import { ChatPage } from "../features/chat/ChatPage";
import { SettingsPage } from "../features/settings/SettingsPage";
import { ExtensionUiModal } from "../features/chat/ExtensionUiModal";
import { applyTheme } from "../lib/theme";
import {
  applyAgentEvent,
  applyAgentEventBatch,
  type AgentEventEnvelope,
  type TimedAgentEventEnvelope,
} from "../lib/chat/transcript-reducer";
import { classifyToolSnapshot } from "../lib/stores/tool-revision";
import { expectedIdentityForEvent, isBackgroundExtensionUiRequest } from "./event-identity";
import { mergeHostIdentity, nullableSessionContext } from "../lib/bridge/host-context";
import {
  persistDesktopSettings,
  persistRecentDesktopLocation,
  type DesktopSettingsSnapshot,
} from "../lib/desktop-settings";
import {
  clearExtensionTerminal as clearExtensionTerminalFrames,
  pushExtensionTerminalFrame,
} from "../lib/chat/extension-terminal-bus";
import type { HostEventEnvelope, HostEventPayloadMap } from "@pideck/protocol";

function SettingsOverlay({ section }: { section: "general" | "packages" }) {
  const setPage = useAppStore((s) => s.setPage);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const firstFrame = requestAnimationFrame(() => {
      requestAnimationFrame(() => setActive(true));
    });
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setActive(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      cancelAnimationFrame(firstFrame);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  return (
    <div
      className={`absolute inset-0 z-40 bg-surface transition-[opacity,transform] duration-300 ease-out ${
        active ? "translate-y-0 opacity-100" : "translate-y-6 opacity-0"
      }`}
      onTransitionEnd={(event) => {
        if (event.target === event.currentTarget && !active) setPage("chat");
      }}
    >
      <SettingsPage
        initialSection={section}
        onClose={() => setActive(false)}
      />
    </div>
  );
}

async function runFullRehydrate(expectedHostInstanceId: string): Promise<void> {
  const store = useAppStore.getState();
  store.setRehydrating(true);
  try {
    const snap = await fullRehydrate(expectedHostInstanceId);
    useAppStore.getState().completeRehydrate({
      ...snap,
      lastSequence: hostClient.getLastSequence(),
    });
    useAppStore.getState().setHostFatal(null);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    useAppStore.getState().markDesynchronized(message);
    useAppStore.getState().setHostFatal(message);
    throw err;
  } finally {
    useAppStore.getState().setRehydrating(false);
  }
}

export function applyModelChanged(payload: HostEventPayloadMap["model.changed"]): void {
  const store = useAppStore.getState();
  const currentSession = store.session;
  if (!currentSession) return;
  store.applySessionSnapshot({
    ...currentSession,
    model: payload.model,
    thinkingLevel: payload.thinkingLevel,
  });
  store.setThinkingLevels(payload.availableThinkingLevels);
}

function handleHostEvent(
  event: HostEventEnvelope,
  requestRecovery: (reason: string) => void,
  agentEventBuffer: {
    enqueue: (payload: AgentEventEnvelope) => void;
    flush: () => void;
  },
): void {
  const store = useAppStore.getState();
  const lifecycleEvent = event.event === "host.statusChanged" || event.event === "host.fatal";
  if ((store.rehydrating || store.desynchronized) && !lifecycleEvent) return;

  const seqAction = store.noteSequence(event.sequence);
  if (seqAction === "drop") return;
  if (seqAction === "gap") {
    requestRecovery(`sequence gap at ${event.sequence}`);
    return;
  }

  const hostId = store.host?.hostInstanceId ?? hostClient.getHostInstanceId();
  if (
    !lifecycleEvent &&
    !hostClient.shouldAcceptEvent(
      event,
      expectedIdentityForEvent(event, {
        hostInstanceId: hostId,
        workspaceId: store.workspace?.id ?? null,
        workspaceRevision: store.workspace?.revision,
        sessionId: store.session?.sessionId ?? null,
        sessionRevision: store.session?.revision,
      }),
    )
  ) {
    store.markDesynchronized(`identity mismatch for ${event.event}`);
    requestRecovery(`identity mismatch for ${event.event}`);
    return;
  }

  const bufferableMessageUpdate =
    event.event === "agent.event" && event.payload.event.type === "message_update";
  if (!bufferableMessageUpdate) agentEventBuffer.flush();

  switch (event.event) {
    case "host.ready": {
      store.beginHostEpoch(event.payload);
      store.setHostFatal(null);
      store.setConnecting(false);
      break;
    }
    case "host.statusChanged": {
      store.setHost(event.payload);
      break;
    }
    case "host.fatal": {
      const message = event.payload.error?.message ?? "Host fatal";
      store.setHostFatal(message);
      store.pushNotification(`Host unavailable: ${message}`, "error");
      store.setConnecting(false);
      break;
    }
    case "workspace.changed":
      if (
        event.payload.id !== event.workspaceId ||
        event.payload.revision !== event.workspaceRevision
      ) {
        requestRecovery("workspace.changed payload generation mismatch");
        return;
      }
      store.applyWorkspaceSnapshot(event.payload);
      break;
    case "session.snapshot":
      if (
        (event.payload === null && event.sessionId !== null) ||
        (event.payload !== null &&
          (event.payload.sessionId !== event.sessionId ||
            event.payload.revision !== event.sessionRevision))
      ) {
        requestRecovery("session.snapshot payload generation mismatch");
        return;
      }
      store.applySessionSnapshot(event.payload);
      break;
    case "session.runtimeChanged":
      if (
        event.payload.sessionId !== event.sessionId ||
        event.payload.sessionRevision !== event.sessionRevision
      ) {
        requestRecovery("session.runtimeChanged payload generation mismatch");
        return;
      }
      store.setSessionRuntimeState(
        event.payload.sessionId,
        event.payload.state,
        event.payload.error,
        event.payload.updatedAt,
      );
      break;
    case "agent.toolsChanged": {
      const action = classifyToolSnapshot(store.tools, event.payload);
      if (
        event.payload.workspaceId !== event.workspaceId ||
        event.payload.sessionId !== event.sessionId ||
        event.payload.sessionRevision !== event.sessionRevision ||
        action === "recover"
      ) {
        requestRecovery("agent.toolsChanged payload generation mismatch");
        return;
      }
      if (action === "apply") {
        store.setTools(event.payload);
      }
      break;
    }
    case "package.snapshot":
      if (
        event.payload.workspaceId !== event.workspaceId ||
        event.payload.revision !== event.packageRevision
      ) {
        requestRecovery("package.snapshot payload generation mismatch");
        return;
      }
      store.applyPackageSnapshot(event.payload);
      break;
    case "package.resourcesChanged":
      if (
        event.payload.packages.workspaceId !== event.workspaceId ||
        event.payload.packages.revision !== event.packageRevision ||
        (event.payload.session !== undefined &&
          (event.payload.session.sessionId !== event.sessionId ||
            event.payload.session.revision !== event.sessionRevision))
      ) {
        requestRecovery("package.resourcesChanged payload generation mismatch");
        return;
      }
      store.applyPackageSnapshot(event.payload.packages);
      if (event.payload.session) {
        store.applySessionSnapshot(event.payload.session);
      }
      break;
    case "package.progress":
      store.setPackageProgress({
        ...event.payload,
        lastEventAt: Date.now(),
      });
      break;
    case "extensionUi.request":
      if (!event.sessionId) {
        requestRecovery("extensionUi.request missing session identity");
        return;
      }
      const extensionRequest = {
        ...event.payload,
        expiresAt: event.payload.timeoutMs
          ? Date.now() + event.payload.timeoutMs
          : undefined,
        context: {
          expectedHostInstanceId: event.hostInstanceId,
          expectedWorkspaceId: event.workspaceId,
          expectedWorkspaceRevision: event.workspaceRevision,
          expectedSessionId: event.sessionId,
          expectedSessionRevision: event.sessionRevision,
        },
      };
      if (
        isBackgroundExtensionUiRequest({
          eventSessionId: event.sessionId,
          activeSessionId: store.session?.sessionId ?? null,
          catalogRuntimeState: store.sessionCatalog.entries[event.sessionId]?.runtimeState,
        })
      ) {
        store.enqueueExtensionUiRequest(extensionRequest);
      } else {
        store.setExtensionUiRequest(extensionRequest);
      }
      break;
    case "extensionUi.statusChanged":
      if (
        event.sessionId === store.session?.sessionId &&
        event.sessionRevision === store.session?.revision
      ) {
        store.setExtensionStatus(event.payload.key, event.payload.text ?? "");
      }
      break;
    case "extensionUi.widgetChanged":
      if (
        event.sessionId === store.session?.sessionId &&
        event.sessionRevision === store.session?.revision
      ) {
        store.setExtensionWidget({
          key: event.payload.key ?? "default",
          widget: event.payload.widget,
          ...(event.payload.placement ? { placement: event.payload.placement } : {}),
          hostInstanceId: event.hostInstanceId,
          workspaceId: event.workspaceId,
          workspaceRevision: event.workspaceRevision,
          sessionId: event.sessionId,
          sessionRevision: event.sessionRevision,
        });
      }
      break;
    case "extensionUi.notification":
      store.pushNotification(event.payload.message ?? "", event.payload.level ?? "info");
      break;
    case "extensionUi.customStarted":
      if (!event.sessionId) {
        requestRecovery("extensionUi.customStarted missing session identity");
        return;
      }
      store.openExtensionTerminal({
        requestId: event.payload.requestId,
        title: event.payload.title,
        cols: event.payload.cols,
        rows: event.payload.rows,
        context: {
          expectedHostInstanceId: event.hostInstanceId,
          expectedWorkspaceId: event.workspaceId,
          expectedWorkspaceRevision: event.workspaceRevision,
          expectedSessionId: event.sessionId,
          expectedSessionRevision: event.sessionRevision,
        },
      });
      break;
    case "extensionUi.customFrame":
      pushExtensionTerminalFrame(event.payload.requestId, event.payload.data);
      break;
    case "extensionUi.customClosed":
      clearExtensionTerminalFrames(event.payload.requestId);
      store.closeExtensionTerminal(event.payload.requestId);
      break;
    case "model.changed":
      applyModelChanged(event.payload);
      break;
    case "session.infoChanged": {
      store.updateSessionCatalogInfo(event.payload.sessionId, event.payload.name);
      const currentSession = store.session;
      if (currentSession?.sessionId === event.payload.sessionId) {
        store.applySessionSnapshot({
          ...currentSession,
          name: event.payload.name,
        });
      }
      break;
    }
    case "package.diagnostic":
      store.pushNotification(event.payload.message, event.payload.severity);
      break;
    case "agent.event": {
      if (bufferableMessageUpdate) {
        agentEventBuffer.enqueue(event.payload);
        break;
      }
      const cur = useAppStore.getState().session;
      if (
        !cur ||
        event.sessionId !== cur.sessionId ||
        event.sessionRevision !== cur.revision
      ) {
        break;
      }
      const next = applyAgentEvent(cur, event.payload);
      if (next) useAppStore.getState().applySessionSnapshot(next);
      if (event.payload.event.type === "error" && event.sessionId) {
        const rawError = event.payload.event.error;
        const message =
          typeof rawError === "string"
            ? rawError
            : typeof event.payload.event.message === "string"
              ? event.payload.event.message
              : "Agent error";
        useAppStore.getState().setSessionRuntimeState(event.sessionId, "error", message);
        useAppStore.getState().pushNotification(`Session failed: ${message}`, "error");
      }
      break;
    }
    case "agent.queueChanged": {
      const cur = useAppStore.getState().session;
      if (cur) {
        useAppStore.getState().applySessionSnapshot({
          ...cur,
          pending: {
            steering: event.payload.steering ?? cur.pending.steering,
            followUp: event.payload.followUp ?? cur.pending.followUp,
          },
        });
      }
      break;
    }
    case "agent.compactionChanged": {
      const cur = useAppStore.getState().session;
      if (cur) {
        useAppStore.getState().applySessionSnapshot({
          ...cur,
          isCompacting: Boolean(event.payload.active),
          isIdle: event.payload.active ? false : cur.isIdle,
        });
      }
      break;
    }
    case "agent.retryChanged": {
      const cur = useAppStore.getState().session;
      if (cur) {
        useAppStore.getState().applySessionSnapshot({
          ...cur,
          isRetrying: Boolean(event.payload.active),
          isIdle: event.payload.active ? false : cur.isIdle,
        });
      }
      break;
    }
    default:
      break;
  }
}

export function App() {
  const page = useAppStore((s) => s.page);
  const hostFatal = useAppStore((s) => s.hostFatal);
  const connecting = useAppStore((s) => s.connecting);
  const rehydrating = useAppStore((s) => s.rehydrating);
  const desynchronized = useAppStore((s) => s.desynchronized);
  const desktopSettings = useAppStore((s) => s.desktopSettings);
  const hostInstanceId = useAppStore((s) => s.host?.hostInstanceId ?? "");
  const sessionId = useAppStore((s) => s.session?.sessionId ?? "");
  const sessionRevision = useAppStore((s) => s.session?.revision ?? 0);
  const workspacePath = useAppStore((s) => s.workspace?.canonicalCwd);
  const activeSessionPath = useAppStore((s) => s.session?.sessionPath);

  useEffect(() => {
    let unsub = () => {};
    let cancelPendingAgentEvents = () => {};
    let cancelled = false;

    (async () => {
      const store = useAppStore.getState();
      store.setConnecting(true);
      try {
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          const snapshot = await invoke<DesktopSettingsSnapshot>("desktop_settings_get");
          if (!cancelled && snapshot.settings) {
            store.setDesktopSettings(snapshot.settings);
            applyTheme(snapshot.settings.theme);
            if (snapshot.warning) {
              store.pushNotification(
                snapshot.recoveredFrom
                  ? `${snapshot.warning}. Backup: ${snapshot.recoveredFrom}`
                  : snapshot.warning,
                "warning",
              );
            }
          }
        } catch (error) {
          store.setDesktopSettings({
            theme: "dark",
            restoreLastSession: true,
            autoRestartHostOnce: true,
          });
          applyTheme("dark");
          store.pushNotification(
            `Desktop settings could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
        }

        const transport = await createTauriTransport();
        if (cancelled) {
          // Effect already cleaned up (StrictMode/HMR unmount) — release the
          // native listeners instead of attaching an orphaned transport.
          transport.dispose?.();
          return;
        }

        let agentEventFrame: number | null = null;
        let pendingAgentEvents: TimedAgentEventEnvelope[] = [];

        const flushAgentEvents = () => {
          if (agentEventFrame !== null) {
            window.cancelAnimationFrame(agentEventFrame);
            agentEventFrame = null;
          }
          if (pendingAgentEvents.length === 0) return;
          const batch = pendingAgentEvents;
          pendingAgentEvents = [];
          const currentSession = useAppStore.getState().session;
          const nextSession = applyAgentEventBatch(currentSession, batch);
          if (nextSession) useAppStore.getState().applySessionSnapshot(nextSession);
        };

        const cancelAgentEvents = () => {
          if (agentEventFrame !== null) {
            window.cancelAnimationFrame(agentEventFrame);
            agentEventFrame = null;
          }
          pendingAgentEvents = [];
        };
        cancelPendingAgentEvents = cancelAgentEvents;

        const agentEventBuffer = {
          enqueue: (payload: AgentEventEnvelope) => {
            pendingAgentEvents.push({ payload, receivedAt: Date.now() });
            if (agentEventFrame !== null) return;
            agentEventFrame = window.requestAnimationFrame(() => {
              agentEventFrame = null;
              flushAgentEvents();
            });
          },
          flush: flushAgentEvents,
        };

        let pendingRecoveryHostId: string | "bootstrap" | null = null;
        let recoveryLoop: Promise<void> | null = null;

        const scheduleRecovery = (hostId: string | null, reason: string) => {
          const target = hostId ?? "bootstrap";
          pendingRecoveryHostId = target;
          if (recoveryLoop) return;

          recoveryLoop = (async () => {
            while (!cancelled && pendingRecoveryHostId) {
              const expectedHostId = pendingRecoveryHostId;
              pendingRecoveryHostId = null;
              const epochStore = useAppStore.getState();
              epochStore.setConnecting(true);
              hostClient.rejectAllPending(reason);

              let lastError: unknown;
              for (let attempt = 0; attempt < 5 && !cancelled; attempt += 1) {
                try {
                  const status = await hostClient.hello("pideck", "0.1.0");
                  if (expectedHostId !== "bootstrap" && status.hostInstanceId !== expectedHostId) {
                    throw new Error("Host generation changed during hello");
                  }
                  useAppStore.getState().beginHostEpoch(status);
                  const configuredSettings = useAppStore.getState().desktopSettings;
                  const configuredWorkspace =
                    configuredSettings?.defaultWorkspace ?? configuredSettings?.lastWorkspace;
                  const sessionPathToRestore = configuredSettings?.restoreLastSession
                    ? configuredSettings.lastSessionPath
                    : undefined;
                  if (!status.workspaceId && configuredWorkspace) {
                    const selected = await hostClient.request(
                      "workspace.setCurrent",
                      {
                        expectedHostInstanceId: status.hostInstanceId,
                        expectedWorkspaceId: null,
                        expectedWorkspaceRevision: status.workspaceRevision,
                      },
                      { cwd: configuredWorkspace },
                      180_000,
                    );
                    if (!selected.ok) {
                      throw new Error(selected.error.message);
                    }
                    useAppStore.getState().setHost({
                      ...status,
                      workspaceId: selected.workspaceId,
                      workspaceRevision: selected.workspaceRevision,
                      sessionId: selected.sessionId,
                      sessionRevision: selected.sessionRevision,
                      packageRevision: selected.packageRevision,
                    });
                  }
                  await runFullRehydrate(status.hostInstanceId);
                  const hydrated = useAppStore.getState();
                  if (
                    sessionPathToRestore &&
                    hydrated.host &&
                    hydrated.workspace?.servicesReady &&
                    hydrated.session?.sessionPath !== sessionPathToRestore
                  ) {
                    const restored = await hostClient.request(
                      "session.open",
                      nullableSessionContext(hydrated.host, hydrated.workspace),
                      { sessionPath: sessionPathToRestore },
                      180_000,
                    );
                    if (restored.ok) {
                      const currentHost = useAppStore.getState().host;
                      if (currentHost) {
                        const nextHost = mergeHostIdentity(currentHost, restored);
                        if (nextHost) useAppStore.getState().setHost(nextHost);
                      }
                      await runFullRehydrate(restored.hostInstanceId);
                    } else if (restored.error.code === "SESSION_NOT_FOUND") {
                      await persistDesktopSettings({ lastSessionPath: null });
                    } else {
                      useAppStore.getState().pushNotification(
                        `Could not restore the last session: ${restored.error.message}`,
                        "warning",
                      );
                    }
                  }
                  useAppStore.getState().setHostFatal(null);
                  useAppStore.getState().setConnecting(false);
                  lastError = null;
                  break;
                } catch (err) {
                  lastError = err;
                  if (pendingRecoveryHostId) break;
                  await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
                }
              }

              if (lastError && !pendingRecoveryHostId && !cancelled) {
                const message = lastError instanceof Error ? lastError.message : String(lastError);
                useAppStore.getState().setHostFatal(message);
                useAppStore.getState().pushNotification(`Host recovery failed: ${message}`, "error");
                useAppStore.getState().setConnecting(false);
              }
            }
          })().finally(() => {
            recoveryLoop = null;
            if (!cancelled && pendingRecoveryHostId) {
              scheduleRecovery(pendingRecoveryHostId === "bootstrap" ? null : pendingRecoveryHostId, reason);
            }
          });
        };

        const requestRecovery = (reason: string) => {
          cancelAgentEvents();
          useAppStore.getState().markDesynchronized(reason);
          scheduleRecovery(hostClient.getHostInstanceId(), reason);
        };

        unsub = hostClient.onEvent((event) => {
          if (event.event === "host.ready") {
            cancelAgentEvents();
            scheduleRecovery(event.hostInstanceId, "host ready");
            return;
          }
          if (event.event === "host.fatal") {
            hostClient.rejectAllPending(event.payload.error.message);
          }
          handleHostEvent(event, requestRecovery, agentEventBuffer);
        });
        hostClient.attach(transport);

        window.setTimeout(() => {
          if (!hostClient.getHostInstanceId()) {
            scheduleRecovery(null, "bootstrap hello");
          }
        }, 1500);
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          store.setHostFatal(message);
          store.pushNotification(`Desktop startup failed: ${message}`, "error");
          store.setConnecting(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      cancelPendingAgentEvents();
      unsub();
      hostClient.detach("application unmounted");
    };
  }, []);

  useEffect(() => {
    if (desktopSettings?.theme) applyTheme(desktopSettings.theme);
  }, [desktopSettings?.theme]);

  useEffect(() => {
    if (
      connecting ||
      rehydrating ||
      desynchronized ||
      !desktopSettings ||
      !workspacePath
    ) {
      return;
    }
    void persistRecentDesktopLocation(workspacePath, activeSessionPath ?? null);
  }, [
    connecting,
    rehydrating,
    desynchronized,
    desktopSettings !== null,
    workspacePath,
    activeSessionPath,
  ]);

  return (
    <div
      className="relative flex h-full flex-col overflow-hidden bg-surface text-foreground"
      data-pideck-app
      data-host-instance-id={hostInstanceId}
      data-session-id={sessionId}
      data-session-revision={sessionRevision}
      data-rehydrating={rehydrating ? "true" : "false"}
      data-desynchronized={desynchronized ? "true" : "false"}
    >
      <div className="absolute right-0 top-0 z-50">
        <WindowControls />
      </div>
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col">
          {hostFatal ? (
            <div className="m-6 rounded-lg border border-danger/40 bg-danger/10 p-4">
              <h2 className="mb-2 font-semibold text-danger">Host unavailable</h2>
              <p className="text-sm text-muted">{hostFatal}</p>
              <p className="mt-2 text-xs text-muted">
                Use Settings → Restart Host after fixing the problem. Packages and
                Settings remain available when the host recovers.
              </p>
            </div>
          ) : (
            <ChatPage />
          )}
        </main>
        <RightDock />
      </div>
      {page !== "chat" && (
        <SettingsOverlay section={page === "packages" ? "packages" : "general"} />
      )}
      <ExtensionUiModal />
    </div>
  );
}
