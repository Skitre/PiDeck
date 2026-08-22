import { useEffect, useState } from "react";
import { useBrowserOcclusion } from "../lib/browser-occlusion";
import { useAppStore, type SettingsSection } from "../lib/stores/app-store";
import { hostClient, isSyntheticLifecycleFatal } from "../lib/bridge/host-client";
import { createTauriTransport } from "../lib/bridge/tauri-transport";
import { RecoveryEventBuffer, fullRehydrate } from "../lib/bridge/rehydrate";
import { Sidebar } from "../components/Sidebar";
import { RightDock } from "../components/RightDock";
import {
  WindowControls,
  resolveWindowControlsPlatform,
  shouldRenderWindowControls,
} from "../components/WindowControls";
import { ChatPage } from "../features/chat/ChatPage";
import { SettingsPage } from "../features/settings/SettingsPage";
import { Dialog } from "../components/Dialog";
import { ExtensionUiModal } from "../features/chat/ExtensionUiModal";
import { GlobalSearchHost } from "../features/sessions/GlobalSearchModal";
import { WorkspaceSwitchTransition } from "../features/workspaces/WorkspaceSwitchTransition";
import { applyTheme } from "../lib/theme";
import { applyAppearancePreferences } from "../lib/appearance-preferences";
import { groupTimedAgentEventsBySession } from "../lib/chat/transcript-drafts";
import { type TimedAgentEventEnvelope } from "../lib/chat/transcript-reducer";
import { classifyToolSnapshot } from "../lib/stores/tool-revision";
import { expectedIdentityForEvent, extensionUiRequestDelivery } from "./event-identity";
import { observeExtensionUiHostEvent } from "../lib/extension-ui-observation";
import { publishValidatedHostEvent } from "../lib/bridge/validated-host-events";
import { mergeHostIdentity, nullableSessionContext } from "../lib/bridge/host-context";
import { requestSessionOpenWithRetry } from "../lib/bridge/session-open-request";
import { summarizeHostFailure } from "../lib/host-failure-message";
import { getAppVersion } from "../lib/app-version";
import { checkForAppUpdate } from "../lib/updater";
import { applyLanguage } from "../lib/i18n";
import { tCurrent, useT } from "../lib/i18n/use-t";
import { shouldRestoreLastSession } from "./session-restore";
import { StartupScreen, resolveStartupStage, useInitialStartupScreen } from "./StartupScreen";
import { DraftPersistenceController } from "./DraftPersistenceController";
import {
  extensionUiHostConfigureParams,
  hydrateDesktopSettings,
  notifyDesktopSettingsSaveFailure,
  persistDesktopSettings,
  persistRecentDesktopLocation,
  type DesktopSettingsSnapshot,
} from "../lib/desktop-settings";
import {
  clearExtensionTerminal as clearExtensionTerminalFrames,
  pushExtensionTerminalFrame,
} from "../lib/chat/extension-terminal-bus";
import type { HostEventEnvelope, HostEventPayloadMap } from "@pideck/protocol";
import { CommandLayer } from "../lib/commands/CommandLayer";
import {
  resolveWindowFrameAttribute,
  resolveWindowFrameMode,
  type WindowFrameMode,
} from "../lib/window-frame";

function SettingsOverlay({ section }: { section: SettingsSection }) {
  const t = useT();
  useBrowserOcclusion("settings");
  const setPage = useAppStore((s) => s.setPage);
  const [active, setActive] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  useEffect(() => {
    const firstFrame = requestAnimationFrame(() => {
      requestAnimationFrame(() => setActive(true));
    });
    const closeOnEscape = (event: KeyboardEvent) => {
      // Dialogs inside Settings consume their own Escape before it reaches window.
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (useAppStore.getState().providersDirty) {
        setConfirmDiscard(true);
        return;
      }
      setActive(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      cancelAnimationFrame(firstFrame);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  const requestClose = () => {
    if (useAppStore.getState().providersDirty) setConfirmDiscard(true);
    else setActive(false);
  };

  return (
    <div
      className={`absolute inset-0 z-40 bg-surface transition-[opacity,transform] duration-300 ease-out ${
        active ? "translate-y-0 opacity-100" : "translate-y-6 opacity-0"
      }`}
      onTransitionEnd={(event) => {
        if (event.target === event.currentTarget && !active) setPage("chat");
      }}
    >
      <SettingsPage initialSection={section} onClose={requestClose} />
      {confirmDiscard && (
        <Dialog
          title={t("settingsDiscardTitle")}
          confirmLabel={t("settingsDiscardConfirm")}
          tone="warning"
          onCancel={() => setConfirmDiscard(false)}
          onConfirm={() => {
            setConfirmDiscard(false);
            setActive(false);
          }}
        >
          <p>{t("settingsDiscardCloseBody")}</p>
        </Dialog>
      )}
    </div>
  );
}

export async function runFullRehydrate(
  expectedHostInstanceId: string,
  recoveryEvents: RecoveryEventBuffer,
  requestRecovery: (reason: string) => void,
  agentEventBuffer: {
    enqueue: (event: HostEventEnvelope<"agent.event">) => void;
    flush: () => void;
  },
): Promise<boolean> {
  const store = useAppStore.getState();
  recoveryEvents.begin(expectedHostInstanceId);
  store.setRehydrating(true);
  try {
    const snap = await fullRehydrate(expectedHostInstanceId);
    const recovered = recoveryEvents.finish(snap.host.hostInstanceId, snap.watermark);
    useAppStore.getState().completeRehydrate({
      ...snap,
      lastSequence: snap.watermark,
    });
    if (recovered.overflowed) {
      requestRecovery("recovery event buffer overflowed");
      return false;
    }
    for (const event of recovered.events) {
      if (handleHostEvent(event, requestRecovery, agentEventBuffer)) {
        publishValidatedHostEvent(event);
      }
      if (useAppStore.getState().desynchronized) return false;
    }
    useAppStore.getState().setHostFatal(null);
    return true;
  } catch (err) {
    recoveryEvents.cancel();
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

export function handleHostEvent(
  event: HostEventEnvelope,
  requestRecovery: (reason: string) => void,
  agentEventBuffer: {
    enqueue: (event: HostEventEnvelope<"agent.event">) => void;
    flush: () => void;
  },
): boolean {
  const store = useAppStore.getState();
  const lifecycleEvent = event.event === "host.statusChanged" || event.event === "host.fatal";
  if ((store.rehydrating || store.desynchronized) && !lifecycleEvent) return false;

  if (!isSyntheticLifecycleFatal(event)) {
    const seqAction = store.noteSequence(event.sequence);
    if (seqAction === "drop") return false;
    if (seqAction === "gap") {
      requestRecovery(`sequence gap at ${event.sequence}`);
      return false;
    }
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
    return false;
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
      const summary = summarizeHostFailure(message);
      console.error("[pi-host] fatal", message);
      store.settleHostFailure(summary);
      store.pushNotification(`Host unavailable: ${summary}`, "error");
      break;
    }
    case "workspace.changed":
      if (
        event.payload.id !== event.workspaceId ||
        event.payload.revision !== event.workspaceRevision
      ) {
        requestRecovery("workspace.changed payload generation mismatch");
        return false;
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
        return false;
      }
      store.applySessionSnapshot(event.payload);
      break;
    case "session.runtimeChanged":
      if (
        event.payload.sessionId !== event.sessionId ||
        event.payload.sessionRevision !== event.sessionRevision
      ) {
        requestRecovery("session.runtimeChanged payload generation mismatch");
        return false;
      }
      store.setSessionRuntimeState(
        event.payload.sessionId,
        event.payload.state,
        event.payload.error,
        event.payload.updatedAt,
        event.payload.sessionRevision,
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
        return false;
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
        return false;
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
        return false;
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
        return false;
      }
      observeExtensionUiHostEvent(event.event, event.payload);
      const extensionRequest = {
        ...event.payload,
        expiresAt: event.payload.timeoutMs ? Date.now() + event.payload.timeoutMs : undefined,
        context: {
          expectedHostInstanceId: event.hostInstanceId,
          expectedWorkspaceId: event.workspaceId,
          expectedWorkspaceRevision: event.workspaceRevision,
          expectedSessionId: event.sessionId,
          expectedSessionRevision: event.sessionRevision,
        },
      };
      const delivery = extensionUiRequestDelivery({
        eventSessionId: event.sessionId,
        activeSessionId: store.session?.sessionId ?? null,
        catalogRuntimeState: store.sessionCatalog.entries[event.sessionId]?.runtimeState,
      });
      if (delivery === "background") {
        store.enqueueExtensionUiRequest(extensionRequest);
      } else if (delivery === "candidate") {
        store.presentCandidateExtensionUiRequest(extensionRequest);
      } else {
        store.setExtensionUiRequest(extensionRequest);
      }
      break;
    case "extensionUi.closed":
      if (!event.sessionId) {
        requestRecovery("extensionUi.closed missing session identity");
        return false;
      }
      store.closeExtensionUiRequest(
        event.payload.requestId,
        event.payload.reason === "aborted"
          ? "cancelled"
          : event.payload.reason === "timed-out"
            ? "expired"
            : "stale",
      );
      break;
    case "extensionUi.groupClosed":
      if (!event.sessionId) {
        requestRecovery("extensionUi.groupClosed missing session identity");
        return false;
      }
      store.closeExtensionDecisionGroup(event.payload.groupKey, event.payload.status);
      break;
    case "extensionUi.statusChanged":
      observeExtensionUiHostEvent(event.event, event.payload);
      if (
        event.sessionId === store.session?.sessionId &&
        event.sessionRevision === store.session?.revision
      ) {
        store.setExtensionStatus(event.payload.key, event.payload.text ?? "", event.payload.origin);
      }
      break;
    case "extensionUi.widgetChanged":
      observeExtensionUiHostEvent(event.event, event.payload);
      if (
        event.sessionId === store.session?.sessionId &&
        event.sessionRevision === store.session?.revision
      ) {
        store.setExtensionWidget({
          key: event.payload.key ?? "default",
          widget: event.payload.widget,
          ...(event.payload.placement ? { placement: event.payload.placement } : {}),
          ...(event.payload.origin ? { origin: event.payload.origin } : {}),
          hostInstanceId: event.hostInstanceId,
          workspaceId: event.workspaceId,
          workspaceRevision: event.workspaceRevision,
          sessionId: event.sessionId,
          sessionRevision: event.sessionRevision,
        });
      }
      break;
    case "extensionUi.widgetAttentionRequested":
      if (
        event.sessionId === store.session?.sessionId &&
        event.sessionRevision === store.session?.revision
      ) {
        store.requestExtensionWidgetAttention(event.payload.runId, event.payload.key);
      }
      break;
    case "extensionUi.messageRendered":
      if (
        event.sessionId === store.session?.sessionId &&
        event.sessionRevision === store.session?.revision
      ) {
        store.setExtensionMessageRender(event.payload.entryId, event.payload.render);
      }
      break;
    case "extensionUi.notification":
      store.pushNotification(event.payload.message ?? "", event.payload.level ?? "info");
      break;
    case "extensionUi.customStarted":
      if (!event.sessionId) {
        requestRecovery("extensionUi.customStarted missing session identity");
        return false;
      }
      observeExtensionUiHostEvent(event.event, event.payload);
      store.openExtensionTerminal({
        requestId: event.payload.requestId,
        title: event.payload.title,
        cols: event.payload.cols,
        rows: event.payload.rows,
        ...(event.payload.origin ? { origin: event.payload.origin } : {}),
        ...(event.payload.overlay !== undefined ? { overlay: event.payload.overlay } : {}),
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
    case "provider.loginEvent":
      store.applyProviderLoginEvent(event.payload);
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
        agentEventBuffer.enqueue(event);
        break;
      }
      if (!event.sessionId) break;
      useAppStore
        .getState()
        .applyAgentTranscriptEvent(event.sessionId, event.payload, event.sessionRevision);
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
      if (cur && event.payload.revision >= cur.pending.revision) {
        useAppStore.getState().applySessionSnapshot({
          ...cur,
          pending: {
            revision: event.payload.revision,
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
  return true;
}

export function App() {
  const windowControlsPlatform = resolveWindowControlsPlatform();
  const nativeWindowAvailable = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const [windowFrameMode, setWindowFrameMode] = useState<WindowFrameMode>("floating");
  const page = useAppStore((s) => s.page);
  const settingsSection = useAppStore((s) => s.settingsSection);
  const settingsOverlayOpen = page !== "chat";
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
  const startupSettled = desktopSettings !== null && !connecting && !rehydrating && !desynchronized;
  const startupPhase = useInitialStartupScreen(startupSettled);
  const startupVisible = startupPhase !== "complete";
  const startupStage = resolveStartupStage({
    settingsReady: desktopSettings !== null,
    hostReady: hostInstanceId !== "",
    workspaceReady: Boolean(workspacePath),
    sessionReady: sessionId !== "",
    connecting,
    rehydrating,
    desynchronized,
  });

  useEffect(() => {
    let unsub = () => {};
    let unsubTransportError = () => {};
    let cancelPendingAgentEvents = () => {};
    let cancelled = false;
    let bootstrapTimer: number | null = null;

    (async () => {
      const store = useAppStore.getState();
      store.setConnecting(true);
      try {
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          const snapshot = await invoke<DesktopSettingsSnapshot>("desktop_settings_get");
          if (!cancelled && snapshot.settings) {
            store.setDesktopSettings(hydrateDesktopSettings(snapshot.settings));
            applyTheme(snapshot.settings.theme, { family: snapshot.settings.themeFamily });
            applyAppearancePreferences(snapshot.settings);
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
            extensionDecisionPresentation: "auto",
            terminalProfile: "auto",
          });
          applyTheme("dark");
          applyAppearancePreferences({
            theme: "dark",
            restoreLastSession: true,
            autoRestartHostOnce: true,
            extensionDecisionPresentation: "auto",
            terminalProfile: "auto",
          });
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
          const current = useAppStore.getState();
          const hostInstanceId = current.host?.hostInstanceId;
          const batch = pendingAgentEvents.filter(
            (event) => event.hostInstanceId === hostInstanceId,
          );
          pendingAgentEvents = [];
          for (const [sessionId, events] of groupTimedAgentEventsBySession(batch)) {
            useAppStore.getState().applyAgentTranscriptEventBatch(sessionId, events);
          }
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
          enqueue: (event: HostEventEnvelope<"agent.event">) => {
            pendingAgentEvents.push({
              hostInstanceId: event.hostInstanceId,
              workspaceId: event.workspaceId,
              workspaceRevision: event.workspaceRevision,
              sessionId: event.sessionId,
              sessionRevision: event.sessionRevision,
              packageRevision: event.packageRevision,
              sequence: event.sequence,
              payload: event.payload,
              receivedAt: Date.now(),
            });
            if (agentEventFrame !== null) return;
            agentEventFrame = window.requestAnimationFrame(() => {
              agentEventFrame = null;
              flushAgentEvents();
            });
          },
          flush: flushAgentEvents,
        };
        const recoveryEvents = new RecoveryEventBuffer();

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
                  const helloSettings = useAppStore.getState().desktopSettings;
                  const configuredPresentation =
                    helloSettings?.extensionDecisionPresentation ?? "auto";
                  const status = await hostClient.hello(
                    "pideck",
                    await getAppVersion(),
                    configuredPresentation,
                    extensionUiHostConfigureParams(helloSettings)
                      .extensionDialogPresentationOverrides,
                  );
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
                  const recovered = await runFullRehydrate(
                    status.hostInstanceId,
                    recoveryEvents,
                    requestRecovery,
                    agentEventBuffer,
                  );
                  if (!recovered) {
                    lastError = new Error("Host recovery was superseded by a newer recovery");
                    break;
                  }
                  const hydrated = useAppStore.getState();
                  if (
                    sessionPathToRestore &&
                    shouldRestoreLastSession({
                      reason,
                      restoreLastSession: configuredSettings?.restoreLastSession ?? true,
                      lastSessionPath: sessionPathToRestore,
                      lastWorkspace: configuredSettings?.lastWorkspace,
                      currentWorkspacePath: hydrated.workspace?.canonicalCwd,
                      currentSessionPath: hydrated.session?.sessionPath,
                    }) &&
                    hydrated.host &&
                    hydrated.workspace?.servicesReady
                  ) {
                    const restoreContext = nullableSessionContext(
                      hydrated.host,
                      hydrated.workspace,
                    );
                    const restored = await requestSessionOpenWithRetry(
                      () =>
                        hostClient.request(
                          "session.open",
                          restoreContext,
                          { sessionPath: sessionPathToRestore },
                          180_000,
                        ),
                      undefined,
                      () => {
                        const current = useAppStore.getState();
                        return (
                          !cancelled &&
                          current.host?.hostInstanceId === restoreContext.expectedHostInstanceId &&
                          current.workspace?.id === restoreContext.expectedWorkspaceId &&
                          current.workspace?.revision ===
                            restoreContext.expectedWorkspaceRevision &&
                          // The restore decision was made against this session
                          // generation; once it moves, re-evaluate instead of
                          // re-sending a context the Host must reject.
                          current.host?.sessionId === restoreContext.expectedSessionId &&
                          current.host?.sessionRevision === restoreContext.expectedSessionRevision
                        );
                      },
                    );
                    if (!restored) {
                      lastError = new Error("Session restore was superseded during recovery");
                      continue;
                    }
                    if (restored.ok) {
                      const currentHost = useAppStore.getState().host;
                      if (currentHost) {
                        const nextHost = mergeHostIdentity(currentHost, restored);
                        if (nextHost) useAppStore.getState().setHost(nextHost);
                      }
                      const restoredRecovery = await runFullRehydrate(
                        restored.hostInstanceId,
                        recoveryEvents,
                        requestRecovery,
                        agentEventBuffer,
                      );
                      if (!restoredRecovery) {
                        lastError = new Error("Host recovery was superseded after session restore");
                        break;
                      }
                    } else if (restored.error.code === "SESSION_NOT_FOUND") {
                      await persistDesktopSettings({ lastSessionPath: null });
                    } else if (restored.error.code === "STALE_REVISION") {
                      // Another mutation committed between the rehydrate
                      // snapshot and this open (e.g. an orphaned session.open
                      // from the pre-recovery epoch). Re-run the attempt
                      // against fresh Host state instead of surfacing it.
                      lastError = new Error(
                        `Session restore raced a newer session change: ${restored.error.message}`,
                      );
                      continue;
                    } else {
                      useAppStore
                        .getState()
                        .pushNotification(
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
                // Recovery gave up: settle into the terminal failure state so
                // the startup screen lifts (desynchronized would otherwise pin
                // startupSettled=false forever) and the fatal panel's
                // Settings → Restart Host path becomes reachable.
                useAppStore.getState().settleHostFailure(message);
                useAppStore
                  .getState()
                  .pushNotification(`Host recovery failed: ${message}`, "error");
              }
            }
          })().finally(() => {
            recoveryLoop = null;
            if (!cancelled && pendingRecoveryHostId) {
              scheduleRecovery(
                pendingRecoveryHostId === "bootstrap" ? null : pendingRecoveryHostId,
                reason,
              );
            }
          });
        };

        const requestRecovery = (reason: string) => {
          cancelAgentEvents();
          useAppStore.getState().markDesynchronized(reason);
          scheduleRecovery(hostClient.getHostInstanceId(), reason);
        };

        let transportRepair: Promise<void> | null = null;
        const repairTransport = (transportError: Error) => {
          if (transportRepair || cancelled) return;
          cancelAgentEvents();
          const failureReason = `Host transport failed: ${transportError.message}`;
          const currentStore = useAppStore.getState();
          currentStore.markDesynchronized(failureReason);
          currentStore.setConnecting(true);
          hostClient.rejectAllPending(failureReason);
          transportRepair = (async () => {
            try {
              const { invoke } = await import("@tauri-apps/api/core");
              const running = await invoke<boolean>("pi_host_status");
              if (!running) await invoke("pi_host_restart");
              scheduleRecovery(hostClient.getHostInstanceId(), failureReason);
            } catch (repairError) {
              const fullMessage =
                repairError instanceof Error ? repairError.message : String(repairError);
              const message = summarizeHostFailure(fullMessage);
              console.error("[pi-host] transport recovery failed", fullMessage);
              const latestStore = useAppStore.getState();
              latestStore.setHostFatal(message);
              latestStore.pushNotification(`Host recovery failed: ${message}`, "error");
              latestStore.setConnecting(false);
            } finally {
              transportRepair = null;
            }
          })();
        };

        unsub = hostClient.onEvent((event) => {
          if (event.event === "host.ready") {
            cancelAgentEvents();
            recoveryEvents.cancel();
            scheduleRecovery(event.hostInstanceId, "host ready");
            return;
          }
          if (event.event === "host.fatal") {
            hostClient.rejectAllPending(event.payload.error.message);
          }
          if (recoveryEvents.capture(event)) return;
          if (handleHostEvent(event, requestRecovery, agentEventBuffer)) {
            publishValidatedHostEvent(event);
          }
        });
        unsubTransportError = hostClient.onTransportError(repairTransport);
        hostClient.attach(transport);

        // Remounts detach the transport but keep hostInstanceId; host.ready
        // will not fire again, so re-hello immediately instead of waiting.
        const knownHostId = hostClient.getHostInstanceId();
        if (knownHostId) {
          scheduleRecovery(knownHostId, "transport reattached");
        } else {
          bootstrapTimer = window.setTimeout(() => {
            if (!cancelled && !hostClient.getHostInstanceId()) {
              scheduleRecovery(null, "bootstrap hello");
            }
          }, 1500);
        }
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
      if (bootstrapTimer !== null) window.clearTimeout(bootstrapTimer);
      cancelPendingAgentEvents();
      unsub();
      unsubTransportError();
      hostClient.detach("application unmounted");
    };
  }, []);

  useEffect(() => {
    if (desktopSettings?.theme) {
      applyTheme(desktopSettings.theme, { family: desktopSettings.themeFamily });
    }
  }, [desktopSettings?.theme, desktopSettings?.themeFamily]);

  useEffect(() => {
    applyLanguage(desktopSettings?.language);
  }, [desktopSettings?.language]);

  useEffect(() => {
    applyAppearancePreferences(desktopSettings);
  }, [desktopSettings]);

  useEffect(() => {
    if (!nativeWindowAvailable) return;

    let disposed = false;
    let pendingFrame: number | null = null;
    let stopListening = () => {};

    void (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const appWindow = getCurrentWindow();

      const syncFrameMode = async () => {
        const [maximized, fullscreen] = await Promise.all([
          appWindow.isMaximized(),
          appWindow.isFullscreen(),
        ]);
        if (!disposed) setWindowFrameMode(resolveWindowFrameMode(maximized, fullscreen));
      };

      const scheduleFrameSync = () => {
        if (pendingFrame !== null) return;
        pendingFrame = window.requestAnimationFrame(() => {
          pendingFrame = null;
          void syncFrameMode().catch(() => undefined);
        });
      };

      const unlisten = await appWindow.onResized(scheduleFrameSync);
      if (disposed) {
        unlisten();
        return;
      }
      stopListening = unlisten;
      await syncFrameMode();
    })().catch(() => undefined);

    return () => {
      disposed = true;
      stopListening();
      if (pendingFrame !== null) window.cancelAnimationFrame(pendingFrame);
    };
  }, [nativeWindowAvailable]);

  useEffect(() => {
    let cancelled = false;
    // Startup check is best-effort: offline or a bad feed stays silent, and
    // the manual check in Settings → Host surfaces errors instead.
    void checkForAppUpdate()
      .then((update) => {
        if (update && !cancelled) {
          const store = useAppStore.getState();
          if (
            store.appUpdatePhase.state !== "downloading" &&
            store.appUpdatePhase.state !== "installing"
          ) {
            store.setAppUpdatePhase({ state: "available", update });
          }
          store.pushNotification(tCurrent("notifUpdateAvailable", { version: update.version }));
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (connecting || rehydrating || desynchronized || !desktopSettings || !workspacePath) {
      return;
    }
    void persistRecentDesktopLocation(workspacePath, activeSessionPath ?? null).catch(
      notifyDesktopSettingsSaveFailure,
    );
  }, [connecting, rehydrating, desynchronized, desktopSettings, workspacePath, activeSessionPath]);

  return (
    <div
      className="relative flex h-full flex-col overflow-hidden bg-surface text-foreground"
      data-pideck-app
      data-window-platform={windowControlsPlatform}
      data-window-frame={resolveWindowFrameAttribute(nativeWindowAvailable, windowFrameMode)}
      data-host-instance-id={hostInstanceId}
      data-session-id={sessionId}
      data-session-revision={sessionRevision}
      data-rehydrating={rehydrating ? "true" : "false"}
      data-desynchronized={desynchronized ? "true" : "false"}
    >
      <DraftPersistenceController />
      {shouldRenderWindowControls(windowControlsPlatform, settingsOverlayOpen) && (
        <WindowControls platform={windowControlsPlatform} />
      )}
      <div
        className={`flex min-h-0 flex-1 ${startupVisible ? "pointer-events-none" : ""}`}
        aria-hidden={startupVisible ? true : undefined}
      >
        <Sidebar />
        <main className="relative flex min-w-0 flex-1 flex-col bg-surface">
          {hostFatal ? (
            <div className="m-6 rounded-lg border border-danger/40 bg-danger/10 p-4">
              <h2 className="mb-2 font-semibold text-danger">Host unavailable</h2>
              <p className="text-sm text-muted">{hostFatal}</p>
              <p className="mt-2 text-xs text-muted">
                Use Settings → Restart Host after fixing the problem. Packages and Settings remain
                available when the host recovers.
              </p>
            </div>
          ) : (
            <WorkspaceSwitchTransition>
              <ChatPage />
            </WorkspaceSwitchTransition>
          )}
        </main>
        <RightDock />
      </div>
      {settingsOverlayOpen && (
        <SettingsOverlay
          section={page === "packages" ? "packages" : (settingsSection ?? "general")}
        />
      )}
      <ExtensionUiModal />
      <GlobalSearchHost />
      <CommandLayer />
      {startupVisible && (
        <StartupScreen stage={startupStage} exiting={startupPhase === "exiting"} />
      )}
    </div>
  );
}
