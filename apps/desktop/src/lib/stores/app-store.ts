import { create } from "zustand";
import type {
  DesktopSettings,
  ExtensionMessageRenderSnapshot,
  ExtensionUiGroupStatus,
  ExtensionUiOrigin,
  HostStatusSnapshot,
  PackageMutationResult,
  PackageSnapshot,
  SessionSnapshot,
  SessionTargetContext,
  ToolSnapshot,
  WorkspaceSnapshot,
  HostEventPayloadMap,
  JsonValue,
  ProviderLoginPrompt,
  SessionSummary,
} from "@pideck/protocol";
import { sanitizeExtensionUiSettings, trustedExtensionId } from "@pideck/protocol";
import { isExtensionDeckV1Enabled } from "../extension-deck-gate";
import { resolveExtensionPresentation } from "../extension-ui-resolver";
import {
  applyPackageSnapshot as epochApplyPackages,
  applySessionSnapshot as epochApplySession,
  applyWorkspaceSnapshot as epochApplyWorkspace,
  beginHostEpoch as epochBeginHost,
  clearWorkspaceEpoch as epochClearWorkspace,
  emptyEpoch,
  markDesynchronized as epochMarkDesync,
  noteSequence as epochNoteSequence,
  type EpochState,
} from "./epoch-store";
import {
  emptySessionCatalog,
  replaceSessionCatalog as replaceCatalog,
  setSessionRuntimeState as setCatalogRuntimeState,
  updateSessionCatalogInfo as updateCatalogInfo,
  isLiveCatalogRuntime,
  isStaleForegroundSnapshot,
  shouldProjectSnapshotIntoCatalog,
  upsertSessionSnapshot as upsertCatalogSnapshot,
  type SessionCatalogState,
  type SessionRuntimeState,
} from "./session-catalog";
import {
  adoptLiveTranscriptDraft,
  applyAgentEventBatchToTranscript,
  applyAgentEventToTranscript,
  dropTranscriptDraft,
  isLiveTranscriptSession,
  overlayLiveTranscriptMessages,
  parkTranscriptDraft,
} from "../chat/transcript-drafts";
import type { AgentEventEnvelope, TimedAgentEventEnvelope } from "../chat/transcript-reducer";
import { sidebarPref } from "../sidebar-prefs";
import type { AppUpdate } from "../updater";
import {
  draftKeyForTarget,
  draftTargetFromRecord,
  type DraftKey,
  type DraftRecord,
  type DraftTarget,
} from "../draft-target";
import {
  alignExtensionUiToSession,
  extensionUiSessionId,
  isExtensionUiRequestExpired,
  registerDecisionGroupRequest,
  settleDecisionGroupRequest,
  type ExtensionDecisionGroupState,
  type ExtensionDecisionStepOutcome,
  type ExtensionUiRequestState,
} from "./extension-ui-state";

export type NavPage = "chat" | "packages" | "settings";

/** Live view of the single in-flight builtin Provider login flow. */
type ProviderLoginUiState = {
  loginId: string;
  providerId: string;
  authUrl?: { url: string; instructions?: string };
  deviceCode?: {
    userCode: string;
    verificationUri: string;
    expiresInSeconds?: number;
  };
  infos: Array<{ message: string; links?: Array<{ url: string; label?: string }> }>;
  progress?: string;
  prompt: ProviderLoginPrompt | null;
  done?: { ok: boolean; message?: string };
};

type PackageProgressState = HostEventPayloadMap["package.progress"] & {
  lastEventAt: number;
};

type PackageRetryState = {
  method: string;
  params: JsonValue;
};

type ExtensionWidgetState = {
  key: string;
  widget: JsonValue;
  placement?: "aboveEditor" | "belowEditor";
  origin?: ExtensionUiOrigin;
  hostInstanceId: string;
  workspaceId: string | null;
  workspaceRevision: number;
  sessionId: string | null;
  sessionRevision: number;
};

/** Live ui.custom() panel. Transport stays request-scoped; shell home is resolved separately. */
export type ExtensionTerminalState = {
  requestId: string;
  title?: string;
  cols: number;
  rows: number;
  origin?: ExtensionUiOrigin;
  overlay?: boolean;
  context: SessionTargetContext;
};

export type AppNotification = {
  id: string;
  message: string;
  level: string;
  createdAt: number;
  /** Cleared when the notification center is opened; drives the unread badge. */
  read: boolean;
};

type AppUpdatePhase =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "upToDate" }
  | { state: "available"; update: AppUpdate }
  | {
      state: "downloading";
      update: AppUpdate;
      downloadedBytes: number;
      totalBytes: number | null;
    }
  | { state: "installing"; update: AppUpdate };

/**
 * Close the extension terminal panel, restoring the dock to its pre-panel
 * state unless the user toggled the dock manually while the panel was open.
 */
function clearedExtensionLiveContent() {
  return {
    extensionStatus: null as string | null,
    extensionStatuses: {} as Record<string, string>,
    extensionStatusOrigins: {} as Record<string, ExtensionUiOrigin>,
    extensionWidgets: {} as Record<string, ExtensionWidgetState>,
    collapsedExtensionWidgetKeys: {} as Record<string, true>,
    lastExtensionWidgetAttentionRunId: null as string | null,
  };
}

function resetExtensionTerminal(state: {
  extensionTerminal: ExtensionTerminalState | null;
  dockOpen: boolean;
  dockRestoreOnPanelClose: boolean | null;
}): {
  extensionTerminal: null;
  dockOpen: boolean;
  dockRestoreOnPanelClose: null;
} {
  return {
    extensionTerminal: null,
    dockOpen: state.extensionTerminal
      ? (state.dockRestoreOnPanelClose ?? state.dockOpen)
      : state.dockOpen,
    dockRestoreOnPanelClose: null,
  };
}

export type SettingsSection =
  | "general"
  | "appearance"
  | "extensionUi"
  | "shortcuts"
  | "providers"
  | "packages"
  | "usage"
  | "host";

export type AppState = EpochState & {
  page: NavPage;
  /** Section the Settings overlay should open on (null = default "general"). */
  settingsSection: SettingsSection | null;
  /**
   * Set when agent.prompt is rejected with AUTH_REQUIRED: the chat banner
   * points at Settings → Providers. Cleared on dismiss, on the next accepted
   * prompt, and when the provider config revision moves (login/logout/save).
   */
  authBlocked: { providerId: string | null } | null;
  desktopSettings: DesktopSettings | null;
  extensionUiRequest: ExtensionUiRequestState | null;
  extensionUiQueue: ExtensionUiRequestState[];
  extensionDecisionGroups: Record<string, ExtensionDecisionGroupState>;
  extensionStatus: string | null;
  extensionStatuses: Record<string, string>;
  extensionStatusOrigins: Record<string, ExtensionUiOrigin>;
  extensionWidgets: Record<string, ExtensionWidgetState>;
  collapsedExtensionWidgetKeys: Record<string, true>;
  lastExtensionWidgetAttentionRunId: string | null;
  extensionTerminal: ExtensionTerminalState | null;
  /** Right dock visibility. Auto-opens for extension panels; manual toggles persist. */
  dockOpen: boolean;
  /** Dock state to restore when the auto-opened panel closes (null = user took over). */
  dockRestoreOnPanelClose: boolean | null;
  packageProgress: PackageProgressState | null;
  packageRetry: PackageRetryState | null;
  thinkingLevels: string[];
  providerConfigRevision: number;
  sessionCatalog: SessionCatalogState;
  transcriptDrafts: Record<string, SessionSnapshot>;
  draftTexts: Record<DraftKey, string>;
  draftTargets: Record<DraftKey, DraftTarget>;
  draftEditVersions: Record<DraftKey, number>;
  draftHydratedWorkspace: string | null;
  appUpdatePhase: AppUpdatePhase;
  notifications: AppNotification[];
  hostFatal: string | null;
  connecting: boolean;
  rehydrating: boolean;
  /** True while the Providers settings form holds unsaved edits (guards Settings close/nav). */
  providersDirty: boolean;
  providerLogin: ProviderLoginUiState | null;
  beginProviderLogin: (loginId: string, providerId: string) => void;
  applyProviderLoginEvent: (payload: HostEventPayloadMap["provider.loginEvent"]) => void;
  clearProviderLogin: () => void;
  setPage: (page: NavPage) => void;
  openSettingsSection: (section: SettingsSection) => void;
  setAuthBlocked: (blocked: { providerId: string | null } | null) => void;
  setProvidersDirty: (dirty: boolean) => void;
  /** New host epoch: clears workspace/session/packages/tools/extension UI. */
  beginHostEpoch: (host: HostStatusSnapshot) => void;
  setHost: (host: HostStatusSnapshot | null) => void;
  applyWorkspaceSnapshot: (ws: WorkspaceSnapshot) => void;
  clearWorkspaceEpoch: () => void;
  setWorkspace: (ws: WorkspaceSnapshot | null) => void;
  applySessionSnapshot: (s: SessionSnapshot | null) => void;
  applyAgentTranscriptEvent: (
    sessionId: string,
    payload: AgentEventEnvelope,
    sessionRevision?: number,
    eventTime?: number,
  ) => void;
  applyAgentTranscriptEventBatch: (sessionId: string, events: TimedAgentEventEnvelope[]) => void;
  setSession: (s: SessionSnapshot | null) => void;
  applyPackageSnapshot: (p: PackageSnapshot | null) => void;
  applyPackageMutationResult: (result: PackageMutationResult) => void;
  setPackages: (p: PackageSnapshot | null) => void;
  setTools: (t: ToolSnapshot | null) => void;
  setDesktopSettings: (d: DesktopSettings | null) => void;
  setExtensionUiRequest: (r: ExtensionUiRequestState | null) => void;
  enqueueExtensionUiRequest: (r: ExtensionUiRequestState) => void;
  presentCandidateExtensionUiRequest: (r: ExtensionUiRequestState) => void;
  closeExtensionUiRequest: (requestId: string, outcome?: ExtensionDecisionStepOutcome) => void;
  closeExtensionDecisionGroup: (groupKey: string, status: ExtensionUiGroupStatus) => void;
  openExtensionTerminal: (t: ExtensionTerminalState) => void;
  closeExtensionTerminal: (requestId: string) => void;
  setDockOpen: (open: boolean) => void;
  setExtensionStatus: (
    key: string | undefined,
    text: string | null,
    origin?: ExtensionUiOrigin,
  ) => void;
  setExtensionMessageRender: (
    entryId: string,
    render: ExtensionMessageRenderSnapshot | null,
  ) => void;
  setExtensionWidget: (widget: ExtensionWidgetState) => void;
  toggleExtensionWidgetCollapsed: (key: string) => void;
  requestExtensionWidgetAttention: (runId: string, key: string) => void;
  setPackageProgress: (progress: PackageProgressState | null) => void;
  setPackageRetry: (retry: PackageRetryState | null) => void;
  setThinkingLevels: (levels: string[]) => void;
  refreshProviderConfig: () => void;
  replaceSessionCatalog: (workspaceId: string, items: SessionSummary[]) => void;
  clearSessionCatalog: () => void;
  updateSessionCatalogInfo: (sessionId: string, name?: string) => void;
  setSessionRuntimeState: (
    sessionId: string,
    state: SessionRuntimeState,
    error?: string,
    updatedAt?: number,
    sessionRevision?: number,
  ) => void;
  setDraftTextLocal: (target: DraftTarget, text: string) => number;
  mergeHydratedDrafts: (
    canonicalCwd: string,
    drafts: readonly DraftRecord[],
    baselineVersions: Readonly<Record<DraftKey, number>>,
  ) => void;
  clearDraftWorkspace: (canonicalCwd: string) => void;
  setAppUpdatePhase: (phase: AppUpdatePhase) => void;
  pushNotification: (message: string, level?: string) => void;
  dismissNotification: (id: string) => void;
  clearNotifications: () => void;
  markNotificationsRead: () => void;
  setHostFatal: (msg: string | null) => void;
  /**
   * Settle into a terminal Host failure: record the fatal message and stop
   * connecting/rehydrating/desync so `startupSettled` can flip true, the
   * startup screen lifts, and the Host-unavailable panel (with its
   * Settings → Restart Host guidance) becomes reachable. Local epoch state is
   * kept so the user retains workspace/session context behind the panel.
   */
  settleHostFailure: (message: string) => void;
  setConnecting: (v: boolean) => void;
  setRehydrating: (v: boolean) => void;
  /** Requested cwd while a workspace switch is in flight; drives switch feedback UI. */
  workspaceSwitchTarget: string | null;
  setWorkspaceSwitchTarget: (target: string | null) => void;
  markDesynchronized: (reason: string) => void;
  noteSequence: (sequence: number) => "apply" | "drop" | "gap";
  completeRehydrate: (snap: {
    host?: HostStatusSnapshot | null;
    workspace?: WorkspaceSnapshot | null;
    session?: SessionSnapshot | null;
    packages?: PackageSnapshot | null;
    tools?: ToolSnapshot | null;
    /** Authoritative event watermark captured with the Host recovery snapshot. */
    lastSequence?: number;
  }) => void;
  clearHostEpoch: (reason: string) => void;
};

function epochSlice(s: AppState): EpochState {
  return {
    host: s.host,
    workspace: s.workspace,
    session: s.session,
    packages: s.packages,
    tools: s.tools,
    desynchronized: s.desynchronized,
    desyncReason: s.desyncReason,
    lastSequence: s.lastSequence,
  };
}

export const useAppStore = create<AppState>((set, get) => ({
  page: "chat",
  settingsSection: null,
  authBlocked: null,
  ...emptyEpoch(),
  desktopSettings: null,
  extensionUiRequest: null,
  extensionUiQueue: [],
  extensionDecisionGroups: {},
  extensionStatus: null,
  extensionStatuses: {},
  extensionStatusOrigins: {},
  extensionWidgets: {},
  collapsedExtensionWidgetKeys: {},
  lastExtensionWidgetAttentionRunId: null,
  extensionTerminal: null,
  dockOpen: sidebarPref("pideck.dock.open"),
  dockRestoreOnPanelClose: null,
  packageProgress: null,
  packageRetry: null,
  thinkingLevels: [],
  providerConfigRevision: 0,
  sessionCatalog: emptySessionCatalog(),
  transcriptDrafts: {},
  draftTexts: {},
  draftTargets: {},
  draftEditVersions: {},
  draftHydratedWorkspace: null,
  appUpdatePhase: { state: "idle" },
  notifications: [],
  hostFatal: null,
  connecting: true,
  rehydrating: false,
  providersDirty: false,
  providerLogin: null,
  beginProviderLogin: (loginId, providerId) =>
    set((state) =>
      // API-key flows prompt synchronously, so the loginEvent can outrun the
      // loginStart response; never reset a flow the event stream already began.
      state.providerLogin?.loginId === loginId
        ? {}
        : { providerLogin: { loginId, providerId, infos: [], prompt: null } },
    ),
  applyProviderLoginEvent: (payload) =>
    set((state) => {
      // The host is authoritative: adopt events for flows this client did not
      // start (or whose loginStart response has not resolved yet).
      const current: ProviderLoginUiState =
        state.providerLogin && state.providerLogin.loginId === payload.loginId
          ? state.providerLogin
          : {
              loginId: payload.loginId,
              providerId: payload.providerId,
              infos: [],
              prompt: null,
            };
      const event = payload.event;
      switch (event.kind) {
        case "info":
          return {
            providerLogin: {
              ...current,
              infos: [
                ...current.infos,
                { message: event.message, ...(event.links ? { links: event.links } : {}) },
              ],
            },
          };
        case "auth_url":
          return {
            providerLogin: {
              ...current,
              authUrl: {
                url: event.url,
                ...(event.instructions ? { instructions: event.instructions } : {}),
              },
            },
          };
        case "device_code":
          return {
            providerLogin: {
              ...current,
              deviceCode: {
                userCode: event.userCode,
                verificationUri: event.verificationUri,
                ...(event.expiresInSeconds !== undefined
                  ? { expiresInSeconds: event.expiresInSeconds }
                  : {}),
              },
            },
          };
        case "progress":
          return { providerLogin: { ...current, progress: event.message } };
        case "prompt":
          return { providerLogin: { ...current, prompt: event.prompt } };
        case "prompt_cancel":
          return current.prompt?.promptId === event.promptId
            ? { providerLogin: { ...current, prompt: null } }
            : { providerLogin: current };
        case "done":
          return {
            providerLogin: {
              ...current,
              prompt: null,
              done: { ok: event.ok, ...(event.message ? { message: event.message } : {}) },
            },
          };
        default:
          return { providerLogin: current };
      }
    }),
  clearProviderLogin: () => set({ providerLogin: null }),
  setPage: (page) =>
    set({
      page,
      // Closing Settings (back to chat) drops the section request so the next
      // open lands on the default section again.
      ...(page === "chat" ? { settingsSection: null } : {}),
    }),
  openSettingsSection: (section) => set({ page: "settings", settingsSection: section }),
  setAuthBlocked: (authBlocked) => set({ authBlocked }),
  setProvidersDirty: (dirty) => set({ providersDirty: dirty }),

  beginHostEpoch: (host) => {
    const next = epochBeginHost(epochSlice(get()), host);
    set({
      ...next,
      extensionUiRequest: null,
      extensionUiQueue: [],
      extensionDecisionGroups: {},
      ...clearedExtensionLiveContent(),
      ...resetExtensionTerminal(get()),
      packageProgress: null,
      packageRetry: null,
      thinkingLevels: [],
      providerConfigRevision: 0,
      sessionCatalog: emptySessionCatalog(),
      transcriptDrafts: {},
      hostFatal: null,
      desynchronized: false,
      desyncReason: undefined,
      rehydrating: false,
      providerLogin: null,
    });
  },

  setHost: (host) => {
    if (!host) {
      set({ host: null });
      return;
    }
    const prev = get().host;
    if (!prev || prev.hostInstanceId !== host.hostInstanceId) {
      get().beginHostEpoch(host);
      return;
    }
    set({ host });
  },

  applyWorkspaceSnapshot: (workspace) => {
    const current = get();
    const next = epochApplyWorkspace(epochSlice(current), workspace);
    const previousWorkspace = current.workspace;
    const workspaceChanged = Boolean(previousWorkspace && previousWorkspace.id !== workspace.id);
    const generationChanged = Boolean(
      previousWorkspace &&
      (previousWorkspace.id !== workspace.id || previousWorkspace.revision !== workspace.revision),
    );
    const transcriptDrafts = generationChanged
      ? parkTranscriptDraft(current.transcriptDrafts, current.session)
      : current.transcriptDrafts;
    set({
      ...next,
      transcriptDrafts,
      ...(generationChanged ? { sessionCatalog: emptySessionCatalog() } : {}),
      ...(workspaceChanged
        ? {
            extensionUiRequest: null,
            extensionUiQueue: [],
            extensionDecisionGroups: {},
            ...clearedExtensionLiveContent(),
            ...resetExtensionTerminal(current),
            packageProgress: null,
            packageRetry: null,
            thinkingLevels: [],
          }
        : {}),
    });
  },

  clearWorkspaceEpoch: () => {
    const next = epochClearWorkspace(epochSlice(get()));
    set({
      ...next,
      sessionCatalog: emptySessionCatalog(),
      transcriptDrafts: {},
      extensionUiRequest: null,
      extensionUiQueue: [],
      extensionDecisionGroups: {},
      ...clearedExtensionLiveContent(),
      ...resetExtensionTerminal(get()),
      packageProgress: null,
      packageRetry: null,
      thinkingLevels: [],
    });
  },

  setWorkspace: (workspace) => {
    if (!workspace) {
      get().clearWorkspaceEpoch();
      set({ workspace: null });
      return;
    }
    get().applyWorkspaceSnapshot(workspace);
  },

  applySessionSnapshot: (session) => {
    const current = get();
    if (isStaleForegroundSnapshot(current.session, session)) return;
    const previousSession = current.session;
    let transcriptDrafts = current.transcriptDrafts;
    let adopted = session;
    if (previousSession && previousSession.sessionId !== session?.sessionId) {
      transcriptDrafts = parkTranscriptDraft(transcriptDrafts, previousSession);
    }
    if (session && previousSession?.sessionId !== session.sessionId) {
      const parked = adoptLiveTranscriptDraft(transcriptDrafts, session);
      adopted = parked.session;
      transcriptDrafts = parked.drafts;
    } else if (session && previousSession) {
      adopted = overlayLiveTranscriptMessages(session, previousSession);
      if (!isLiveTranscriptSession(session)) {
        transcriptDrafts = dropTranscriptDraft(transcriptDrafts, session.sessionId);
      }
    }
    const next = epochApplySession(epochSlice(current), adopted);
    let baseCatalog = current.sessionCatalog;
    if (previousSession && previousSession.sessionId !== session?.sessionId) {
      if (
        current.workspace &&
        shouldProjectSnapshotIntoCatalog(baseCatalog, current.workspace, previousSession)
      ) {
        baseCatalog = upsertCatalogSnapshot(baseCatalog, current.workspace.id, previousSession);
      }
      const previousRuntime = baseCatalog.entries[previousSession.sessionId]?.runtimeState;
      const previousStillLive = isLiveCatalogRuntime(previousRuntime) || !previousSession.isIdle;
      if (!previousStillLive) {
        baseCatalog = setCatalogRuntimeState(baseCatalog, previousSession.sessionId, "inactive");
      }
    }
    const sessionCatalog =
      adopted && current.workspace
        ? upsertCatalogSnapshot(baseCatalog, current.workspace.id, adopted)
        : baseCatalog;
    const generationChanged = Boolean(
      previousSession &&
      (!adopted ||
        previousSession.sessionId !== adopted.sessionId ||
        previousSession.revision !== adopted.revision),
    );
    const extensionUi = alignExtensionUiToSession(
      current.extensionUiRequest,
      current.extensionUiQueue,
      adopted?.sessionId ?? null,
    );
    set({
      ...next,
      sessionCatalog,
      transcriptDrafts,
      ...extensionUi,
      ...(generationChanged
        ? {
            ...clearedExtensionLiveContent(),
            ...resetExtensionTerminal(current),
            packageProgress: null,
            packageRetry: null,
            thinkingLevels: [],
          }
        : {}),
    });
  },

  applyAgentTranscriptEvent: (sessionId, payload, sessionRevision, eventTime) => {
    const current = get();
    const foreground = current.session;
    if (foreground?.sessionId === sessionId) {
      const next = applyAgentEventToTranscript(foreground, payload, eventTime, sessionRevision);
      if (!next) return;
      const transcriptDrafts = isLiveTranscriptSession(next)
        ? current.transcriptDrafts
        : dropTranscriptDraft(current.transcriptDrafts, sessionId);
      const sessionCatalog = current.workspace
        ? upsertCatalogSnapshot(current.sessionCatalog, current.workspace.id, next)
        : current.sessionCatalog;
      if (sessionRevision !== undefined && sessionRevision > foreground.revision) {
        const epoch = epochApplySession(epochSlice(current), next);
        set({ ...epoch, transcriptDrafts, sessionCatalog });
        return;
      }
      set({ session: next, tools: next.tools ?? current.tools, transcriptDrafts, sessionCatalog });
      return;
    }
    const draft = current.transcriptDrafts[sessionId];
    if (!draft) return;
    const next = applyAgentEventToTranscript(draft, payload, eventTime, sessionRevision);
    if (!next) return;
    set({
      transcriptDrafts: isLiveTranscriptSession(next)
        ? { ...current.transcriptDrafts, [sessionId]: next }
        : dropTranscriptDraft(current.transcriptDrafts, sessionId),
      sessionCatalog:
        current.workspace &&
        shouldProjectSnapshotIntoCatalog(current.sessionCatalog, current.workspace, next)
          ? upsertCatalogSnapshot(current.sessionCatalog, current.workspace.id, next)
          : current.sessionCatalog,
    });
  },

  applyAgentTranscriptEventBatch: (sessionId, events) => {
    if (events.length === 0) return;
    const current = get();
    const sessionRevision = events.reduce(
      (highest, event) =>
        typeof event.sessionRevision === "number"
          ? Math.max(highest, event.sessionRevision)
          : highest,
      0,
    );
    const foreground = current.session;
    if (foreground?.sessionId === sessionId) {
      const next = applyAgentEventBatchToTranscript(
        foreground,
        events,
        sessionRevision || undefined,
      );
      if (!next) return;
      const transcriptDrafts = isLiveTranscriptSession(next)
        ? current.transcriptDrafts
        : dropTranscriptDraft(current.transcriptDrafts, sessionId);
      const sessionCatalog = current.workspace
        ? upsertCatalogSnapshot(current.sessionCatalog, current.workspace.id, next)
        : current.sessionCatalog;
      if (sessionRevision > foreground.revision) {
        const epoch = epochApplySession(epochSlice(current), next);
        set({ ...epoch, transcriptDrafts, sessionCatalog });
        return;
      }
      set({ session: next, tools: next.tools ?? current.tools, transcriptDrafts, sessionCatalog });
      return;
    }
    const draft = current.transcriptDrafts[sessionId];
    if (!draft) return;
    const next = applyAgentEventBatchToTranscript(draft, events, sessionRevision || undefined);
    if (!next) return;
    set({
      transcriptDrafts: isLiveTranscriptSession(next)
        ? { ...current.transcriptDrafts, [sessionId]: next }
        : dropTranscriptDraft(current.transcriptDrafts, sessionId),
      sessionCatalog:
        current.workspace &&
        shouldProjectSnapshotIntoCatalog(current.sessionCatalog, current.workspace, next)
          ? upsertCatalogSnapshot(current.sessionCatalog, current.workspace.id, next)
          : current.sessionCatalog,
    });
  },

  setSession: (session) => {
    get().applySessionSnapshot(session);
  },

  applyPackageSnapshot: (packages) => {
    const next = epochApplyPackages(epochSlice(get()), packages);
    set({
      ...next,
      ...(packages?.mutation?.reconcileRequired ? {} : { packageRetry: null }),
    });
  },

  applyPackageMutationResult: (result) => {
    const previous = get();
    let nextEpoch = epochApplyPackages(epochSlice(previous), result.packageSnapshot);
    const generationChanged = Boolean(
      result.session &&
      previous.session &&
      (previous.session.sessionId !== result.session.sessionId ||
        previous.session.revision !== result.session.revision),
    );
    if (result.session) {
      nextEpoch = epochApplySession(nextEpoch, result.session);
    }
    const sessionCatalog =
      result.session && previous.workspace
        ? upsertCatalogSnapshot(previous.sessionCatalog, previous.workspace.id, result.session)
        : previous.sessionCatalog;
    set({
      ...nextEpoch,
      sessionCatalog,
      ...(generationChanged
        ? {
            extensionUiRequest: null,
            extensionUiQueue: [],
            extensionDecisionGroups: {},
            ...clearedExtensionLiveContent(),
            ...resetExtensionTerminal(previous),
            packageProgress: null,
            packageRetry: null,
            thinkingLevels: [],
          }
        : result.reconcileRequired
          ? {}
          : { packageRetry: null }),
    });
  },

  setPackages: (packages) => {
    get().applyPackageSnapshot(packages);
  },

  setTools: (tools) => set({ tools }),
  setDesktopSettings: (desktopSettings) =>
    set({
      desktopSettings: desktopSettings
        ? {
            ...desktopSettings,
            extensionUi: sanitizeExtensionUiSettings(desktopSettings.extensionUi),
          }
        : null,
    }),
  setExtensionUiRequest: (request) =>
    set((state) => {
      const now = Date.now();
      let queue = state.extensionUiQueue.filter(
        (queued) => !isExtensionUiRequestExpired(queued, now),
      );
      if (request === null) {
        const targetSessionId = state.extensionUiRequest
          ? extensionUiSessionId(state.extensionUiRequest)
          : (state.session?.sessionId ?? null);
        const nextIndex = targetSessionId
          ? queue.findIndex((queued) => extensionUiSessionId(queued) === targetSessionId)
          : -1;
        if (nextIndex < 0) {
          return { extensionUiRequest: null, extensionUiQueue: queue };
        }
        const next = queue[nextIndex]!;
        return {
          extensionUiRequest: next,
          extensionUiQueue: queue.filter((_, index) => index !== nextIndex),
        };
      }
      let active =
        state.extensionUiRequest && !isExtensionUiRequestExpired(state.extensionUiRequest, now)
          ? state.extensionUiRequest
          : null;
      if (!active && queue.length > 0) {
        [active, ...queue] = queue;
      }
      if (isExtensionUiRequestExpired(request, now)) {
        return { extensionUiRequest: active, extensionUiQueue: queue };
      }
      const extensionDecisionGroups = registerDecisionGroupRequest(
        state.extensionDecisionGroups,
        request,
      );
      if (active?.requestId === request.requestId) {
        return { extensionUiRequest: request, extensionUiQueue: queue, extensionDecisionGroups };
      }
      const existingIndex = queue.findIndex((queued) => queued.requestId === request.requestId);
      if (existingIndex >= 0) {
        queue = [...queue];
        queue[existingIndex] = request;
        return { extensionUiRequest: active, extensionUiQueue: queue, extensionDecisionGroups };
      }
      if (!active) {
        return { extensionUiRequest: request, extensionUiQueue: queue, extensionDecisionGroups };
      }
      return {
        extensionUiRequest: active,
        extensionUiQueue: [...queue, request],
        extensionDecisionGroups,
      };
    }),
  enqueueExtensionUiRequest: (request) =>
    set((state) => {
      const now = Date.now();
      if (isExtensionUiRequestExpired(request, now)) return {};
      const extensionDecisionGroups = registerDecisionGroupRequest(
        state.extensionDecisionGroups,
        request,
      );
      if (state.extensionUiRequest?.requestId === request.requestId) {
        return { extensionUiRequest: request, extensionDecisionGroups };
      }
      const queue = state.extensionUiQueue.filter(
        (queued) => !isExtensionUiRequestExpired(queued, now),
      );
      const existingIndex = queue.findIndex((queued) => queued.requestId === request.requestId);
      if (existingIndex >= 0) {
        const nextQueue = [...queue];
        nextQueue[existingIndex] = request;
        return { extensionUiQueue: nextQueue, extensionDecisionGroups };
      }
      return { extensionUiQueue: [...queue, request], extensionDecisionGroups };
    }),
  presentCandidateExtensionUiRequest: (request) =>
    set((state) => {
      const now = Date.now();
      if (isExtensionUiRequestExpired(request, now)) return {};
      const extensionDecisionGroups = registerDecisionGroupRequest(
        state.extensionDecisionGroups,
        request,
      );
      let queue = state.extensionUiQueue.filter(
        (queued) =>
          queued.requestId !== request.requestId && !isExtensionUiRequestExpired(queued, now),
      );
      const active =
        state.extensionUiRequest && !isExtensionUiRequestExpired(state.extensionUiRequest, now)
          ? state.extensionUiRequest
          : null;
      if (active && active.requestId !== request.requestId) {
        queue = [active, ...queue.filter((queued) => queued.requestId !== active.requestId)];
      }
      return {
        extensionUiRequest: request,
        extensionUiQueue: queue,
        extensionDecisionGroups,
      };
    }),
  closeExtensionUiRequest: (requestId, outcome = "stale") =>
    set((state) => {
      const active = state.extensionUiRequest;
      if (active?.requestId !== requestId) {
        const queuedIndex = state.extensionUiQueue.findIndex(
          (queued) => queued.requestId === requestId,
        );
        if (queuedIndex < 0) return {};
        const queuedRequest = state.extensionUiQueue[queuedIndex]!;
        return {
          extensionUiQueue: state.extensionUiQueue.filter((_, index) => index !== queuedIndex),
          extensionDecisionGroups: settleDecisionGroupRequest(
            state.extensionDecisionGroups,
            queuedRequest,
            outcome,
          ),
        };
      }

      const now = Date.now();
      const extensionDecisionGroups = settleDecisionGroupRequest(
        state.extensionDecisionGroups,
        active,
        outcome,
      );
      const targetSessionId = extensionUiSessionId(active);
      const queue = state.extensionUiQueue.filter(
        (queued) => queued.requestId !== requestId && !isExtensionUiRequestExpired(queued, now),
      );
      const nextIndex = targetSessionId
        ? queue.findIndex((queued) => extensionUiSessionId(queued) === targetSessionId)
        : -1;
      if (nextIndex < 0) {
        return { extensionUiRequest: null, extensionUiQueue: queue, extensionDecisionGroups };
      }
      return {
        extensionUiRequest: queue[nextIndex]!,
        extensionUiQueue: queue.filter((_, index) => index !== nextIndex),
        extensionDecisionGroups,
      };
    }),
  closeExtensionDecisionGroup: (groupKey, status) =>
    set((state) => {
      const group = state.extensionDecisionGroups[groupKey];
      if (!group) return {};
      const activeRequestStillPresent =
        group.activeRequestId !== null &&
        (state.extensionUiRequest?.requestId === group.activeRequestId ||
          state.extensionUiQueue.some((request) => request.requestId === group.activeRequestId));
      if (!activeRequestStillPresent) {
        const extensionDecisionGroups = { ...state.extensionDecisionGroups };
        delete extensionDecisionGroups[groupKey];
        return { extensionDecisionGroups };
      }
      return {
        extensionDecisionGroups: {
          ...state.extensionDecisionGroups,
          [groupKey]: { ...group, status },
        },
      };
    }),
  openExtensionTerminal: (panel) =>
    set((state) => {
      const { home } = resolveExtensionPresentation({
        family: "custom",
        settings: sanitizeExtensionUiSettings(state.desktopSettings?.extensionUi),
        extensionId: trustedExtensionId(panel.origin),
        hint: { overlay: panel.overlay },
      });
      const dockCustom = !isExtensionDeckV1Enabled() || home.kind === "dock";
      return {
        extensionTerminal: panel,
        ...(dockCustom
          ? {
              dockOpen: true,
              dockRestoreOnPanelClose: state.extensionTerminal
                ? state.dockRestoreOnPanelClose
                : state.dockOpen,
            }
          : {}),
      };
    }),
  closeExtensionTerminal: (requestId) =>
    set((state) => {
      if (state.extensionTerminal?.requestId !== requestId) return {};
      return resetExtensionTerminal(state);
    }),
  setDockOpen: (open) =>
    set({
      dockOpen: open,
      // Manual toggle takes over — the panel close no longer restores.
      dockRestoreOnPanelClose: null,
    }),
  setExtensionStatus: (key, text, origin) =>
    set((state) => {
      const statusKey = key || "default";
      const extensionStatuses = { ...state.extensionStatuses };
      const extensionStatusOrigins = { ...state.extensionStatusOrigins };
      if (text?.trim()) {
        extensionStatuses[statusKey] = text;
        if (origin) extensionStatusOrigins[statusKey] = origin;
      } else {
        delete extensionStatuses[statusKey];
        delete extensionStatusOrigins[statusKey];
      }
      const values = Object.values(extensionStatuses);
      return {
        extensionStatuses,
        extensionStatusOrigins,
        extensionStatus: values.length > 0 ? values[values.length - 1] : null,
      };
    }),
  setExtensionMessageRender: (entryId, render) =>
    set((state) => {
      if (!state.session) return {};
      const extensionMessageRenders = {
        ...(state.session.extensionMessageRenders ?? {}),
      };
      if (render) extensionMessageRenders[entryId] = render;
      else delete extensionMessageRenders[entryId];
      return {
        session: {
          ...state.session,
          ...(Object.keys(extensionMessageRenders).length > 0
            ? { extensionMessageRenders }
            : { extensionMessageRenders: undefined }),
        },
      };
    }),
  setExtensionWidget: (extensionWidget) =>
    set((state) => {
      const key = extensionWidget.key || "default";
      if (extensionWidget.widget === null) {
        const extensionWidgets = { ...state.extensionWidgets };
        const collapsedExtensionWidgetKeys = { ...state.collapsedExtensionWidgetKeys };
        delete extensionWidgets[key];
        delete collapsedExtensionWidgetKeys[key];
        return {
          extensionWidgets,
          collapsedExtensionWidgetKeys,
        };
      }
      return {
        extensionWidgets: {
          ...state.extensionWidgets,
          [key]: { ...extensionWidget, key },
        },
      };
    }),
  toggleExtensionWidgetCollapsed: (key) =>
    set((state) => {
      if (!state.extensionWidgets[key]) return {};
      const collapsedExtensionWidgetKeys = { ...state.collapsedExtensionWidgetKeys };
      if (collapsedExtensionWidgetKeys[key]) delete collapsedExtensionWidgetKeys[key];
      else collapsedExtensionWidgetKeys[key] = true;
      return { collapsedExtensionWidgetKeys };
    }),
  requestExtensionWidgetAttention: (runId, _key) =>
    set((state) => {
      if (state.lastExtensionWidgetAttentionRunId === runId) return {};
      return { lastExtensionWidgetAttentionRunId: runId };
    }),
  setPackageProgress: (packageProgress) => set({ packageProgress }),
  setPackageRetry: (packageRetry) => set({ packageRetry }),
  setThinkingLevels: (thinkingLevels) => set({ thinkingLevels: [...thinkingLevels] }),
  refreshProviderConfig: () =>
    set((state) => ({ providerConfigRevision: state.providerConfigRevision + 1 })),
  replaceSessionCatalog: (workspaceId, items) =>
    set((state) => ({
      sessionCatalog: replaceCatalog(state.sessionCatalog, workspaceId, items),
    })),
  clearSessionCatalog: () => set({ sessionCatalog: emptySessionCatalog() }),
  updateSessionCatalogInfo: (sessionId, name) =>
    set((state) => ({
      sessionCatalog: updateCatalogInfo(state.sessionCatalog, sessionId, name),
    })),
  setSessionRuntimeState: (sessionId, runtimeState, error, updatedAt, sessionRevision) =>
    set((state) => ({
      sessionCatalog: setCatalogRuntimeState(
        state.sessionCatalog,
        sessionId,
        runtimeState,
        error,
        updatedAt,
        sessionRevision,
      ),
    })),
  setDraftTextLocal: (target, text) => {
    const key = draftKeyForTarget(target);
    let version = 0;
    set((state) => {
      version = (state.draftEditVersions[key] ?? 0) + 1;
      const draftTexts = { ...state.draftTexts };
      if (text) draftTexts[key] = text;
      else delete draftTexts[key];
      return {
        draftTexts,
        draftTargets: { ...state.draftTargets, [key]: target },
        draftEditVersions: { ...state.draftEditVersions, [key]: version },
      };
    });
    return version;
  },
  mergeHydratedDrafts: (canonicalCwd, drafts, baselineVersions) =>
    set((state) => {
      if (state.workspace?.canonicalCwd !== canonicalCwd) return {};
      const draftTexts = { ...state.draftTexts };
      const draftTargets = { ...state.draftTargets };
      for (const record of drafts) {
        const target = draftTargetFromRecord(record);
        const key = draftKeyForTarget(target);
        if ((state.draftEditVersions[key] ?? 0) !== (baselineVersions[key] ?? 0)) continue;
        draftTexts[key] = record.text;
        draftTargets[key] = target;
      }
      return {
        draftTexts,
        draftTargets,
        draftHydratedWorkspace: canonicalCwd,
      };
    }),
  clearDraftWorkspace: (canonicalCwd) =>
    set((state) => {
      const draftTexts = { ...state.draftTexts };
      const draftTargets = { ...state.draftTargets };
      const draftEditVersions = { ...state.draftEditVersions };
      for (const [key, target] of Object.entries(state.draftTargets)) {
        if (target.canonicalCwd !== canonicalCwd) continue;
        delete draftTexts[key];
        delete draftTargets[key];
        delete draftEditVersions[key];
      }
      return {
        draftTexts,
        draftTargets,
        draftEditVersions,
        draftHydratedWorkspace:
          state.draftHydratedWorkspace === canonicalCwd ? null : state.draftHydratedWorkspace,
      };
    }),
  setAppUpdatePhase: (appUpdatePhase) => set({ appUpdatePhase }),
  pushNotification: (message, level = "info") =>
    set((s) => ({
      notifications: [
        ...s.notifications.slice(-49),
        { id: crypto.randomUUID(), message, level, createdAt: Date.now(), read: false },
      ],
    })),
  markNotificationsRead: () =>
    set((state) =>
      state.notifications.some((notification) => !notification.read)
        ? {
            notifications: state.notifications.map((notification) =>
              notification.read ? notification : { ...notification, read: true },
            ),
          }
        : state,
    ),
  dismissNotification: (id) =>
    set((state) => ({
      notifications: state.notifications.filter((notification) => notification.id !== id),
    })),
  clearNotifications: () => set({ notifications: [] }),
  setHostFatal: (hostFatal) => set({ hostFatal }),
  settleHostFailure: (message) =>
    set({
      hostFatal: message,
      connecting: false,
      rehydrating: false,
      desynchronized: false,
      desyncReason: undefined,
    }),
  setConnecting: (connecting) => set({ connecting }),
  setRehydrating: (rehydrating) => set({ rehydrating }),
  workspaceSwitchTarget: null,
  setWorkspaceSwitchTarget: (workspaceSwitchTarget) => set({ workspaceSwitchTarget }),

  markDesynchronized: (reason) => {
    const next = epochMarkDesync(epochSlice(get()), reason);
    set({ ...next });
  },

  noteSequence: (sequence) => {
    const r = epochNoteSequence(epochSlice(get()), sequence);
    set({ ...r.state });
    return r.action;
  },

  completeRehydrate: (snap) => {
    const current = get();
    const workspace = snap.workspace !== undefined ? snap.workspace : current.workspace;
    const session = snap.session !== undefined ? snap.session : current.session;
    set({
      host: snap.host !== undefined ? snap.host : current.host,
      workspace,
      session,
      packages: snap.packages !== undefined ? snap.packages : current.packages,
      tools:
        snap.tools !== undefined
          ? snap.tools
          : snap.session !== undefined
            ? (snap.session?.tools ?? null)
            : current.tools,
      transcriptDrafts: {},
      sessionCatalog:
        workspace && session
          ? upsertCatalogSnapshot(current.sessionCatalog, workspace.id, session)
          : current.sessionCatalog,
      // Reset desync and advance sequence watermark so post-rehydrate events apply.
      lastSequence:
        snap.lastSequence !== undefined ? snap.lastSequence : Math.max(current.lastSequence, 0),
      desynchronized: false,
      desyncReason: undefined,
      rehydrating: false,
      extensionUiRequest: null,
      extensionUiQueue: [],
      extensionDecisionGroups: {},
      ...clearedExtensionLiveContent(),
      ...resetExtensionTerminal(current),
      packageProgress: null,
      packageRetry: null,
    });
  },

  clearHostEpoch: (reason) => {
    set({
      ...emptyEpoch(),
      extensionUiRequest: null,
      extensionUiQueue: [],
      extensionDecisionGroups: {},
      ...clearedExtensionLiveContent(),
      ...resetExtensionTerminal(get()),
      packageProgress: null,
      packageRetry: null,
      thinkingLevels: [],
      providerConfigRevision: 0,
      sessionCatalog: emptySessionCatalog(),
      transcriptDrafts: {},
      hostFatal: reason,
      rehydrating: false,
    });
  },
}));
