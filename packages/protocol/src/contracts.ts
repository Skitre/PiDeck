/**
 * Method/event maps for fully typed cross-process envelopes (R2).
 */
import type { HostError, JsonValue } from "./errors.js";
import type { HostMethod } from "./methods.js";
import type { HostEventName } from "./events.js";
import type {
  EmptyContext,
  HostContext,
  WorkspaceContext,
  ActiveSessionContext,
  NullableSessionContext,
  ToolMutationContext,
  WorkspacePackageContext,
  SessionPackageContext,
} from "./methods.js";
import type {
  HostStatusSnapshot,
  WorkspaceSnapshot,
  SessionSnapshot,
  SessionSummary,
  SessionStatsSnapshot,
  SessionUsageReport,
  ToolSnapshot,
  ModelSummary,
  ModelConfigHealth,
  PackageSnapshot,
  PackageMutationResult,
  PackageUpdateSummary,
  PackageRecord,
  PackageResource,
  PiSettingsSnapshot,
  PiSettingsPatch,
  ExtensionUiRequest,
  SerializableSessionEntry,
  SerializableSessionTreeNode,
  SerializableCompactionResult,
  SerializableImage,
  SerializableAgentSessionEvent,
  SessionRuntimeState,
  ProviderDraft,
  ProviderSnapshot,
  DiscoveredProviderModel,
  CommandSummary,
} from "./types.js";

export type HostContextMap = {
  "system.hello": EmptyContext;
  "system.getStatus": HostContext;
  "system.shutdown": HostContext;
  "workspace.setCurrent": WorkspaceContext;
  "workspace.getCurrent": WorkspaceContext;
  "workspace.searchFiles": WorkspaceContext;
  "session.list": WorkspaceContext;
  "session.create": NullableSessionContext;
  "session.open": NullableSessionContext;
  "session.reload": ActiveSessionContext;
  "session.archive": WorkspaceContext;
  "session.restore": WorkspaceContext;
  "session.delete": WorkspaceContext;
  "session.cleanupArchived": WorkspaceContext;
  "session.getSnapshot": WorkspaceContext;
  "session.setName": ActiveSessionContext;
  "session.rename": WorkspaceContext;
  "session.getEntries": ActiveSessionContext;
  "session.getTree": ActiveSessionContext;
  "session.getStats": ActiveSessionContext;
  "session.usageReport": WorkspaceContext;
  "session.getCommands": ActiveSessionContext;
  "agent.prompt": ActiveSessionContext;
  "agent.steer": ActiveSessionContext;
  "agent.followUp": ActiveSessionContext;
  "agent.abort": ActiveSessionContext;
  "agent.clearQueue": ActiveSessionContext;
  "agent.setQueue": ActiveSessionContext;
  "agent.compact": ActiveSessionContext;
  "agent.abortCompaction": ActiveSessionContext;
  "agent.setAutoCompaction": ActiveSessionContext;
  "agent.setAutoRetry": ActiveSessionContext;
  "agent.abortRetry": ActiveSessionContext;
  "agent.getTools": ActiveSessionContext;
  "agent.setActiveTools": ToolMutationContext;
  "provider.list": HostContext;
  "provider.setEnabled": HostContext;
  "provider.save": HostContext;
  "provider.remove": HostContext;
  "provider.fetchModels": HostContext;
  "model.list": ActiveSessionContext;
  "model.setCurrent": ActiveSessionContext;
  "model.setThinkingLevel": ActiveSessionContext;
  "package.list": WorkspaceContext;
  "package.install": SessionPackageContext;
  "package.remove": SessionPackageContext;
  "package.checkUpdates": WorkspaceContext;
  "package.update": SessionPackageContext;
  "package.updateAll": SessionPackageContext;
  "package.getResources": WorkspacePackageContext;
  "package.setResourceEnabled": SessionPackageContext;
  "package.setResourceTypeEnabled": SessionPackageContext;
  "package.reloadResources": SessionPackageContext;
  "resource.setTopLevelEnabled": SessionPackageContext;
  "piSettings.get": WorkspaceContext;
  "piSettings.patch": NullableSessionContext;
  "extensionUi.respond": ActiveSessionContext;
  "extensionUi.customInput": ActiveSessionContext;
  "extensionUi.customResize": ActiveSessionContext;
};

export type HostRequestParams = {
  "system.hello": { clientName: string; clientVersion: string; protocolVersion: 1 };
  "system.getStatus": null;
  "system.shutdown": null;
  "workspace.setCurrent": { cwd: string };
  "workspace.getCurrent": null;
  "workspace.searchFiles": { query: string; limit?: number };
  "session.list": null;
  "session.create": { name?: string };
  "session.open": { sessionPath: string };
  "session.reload": null;
  "session.archive": { sessionId: string; sessionPath: string };
  "session.restore": { sessionId: string; sessionPath: string };
  "session.delete": { sessionId: string; sessionPath: string };
  "session.cleanupArchived": null;
  "session.getSnapshot": null;
  "session.setName": { name: string };
  "session.rename": { sessionId: string; sessionPath: string; name: string };
  "session.getEntries": { sinceEntryId?: string } | null;
  "session.getTree": null;
  "session.getStats": null;
  "session.usageReport": null;
  "session.getCommands": null;
  "agent.prompt": {
    text: string;
    images?: SerializableImage[];
    streamingBehavior?: "steer" | "followUp";
    /** Re-attach images remembered for this text in the host's queue
     * attachment table (used by run-now on queued items). */
    attachQueuedImages?: boolean;
  };
  "agent.steer": { text: string; images?: SerializableImage[] };
  "agent.followUp": { text: string; images?: SerializableImage[] };
  "agent.abort": null;
  "agent.clearQueue": null;
  "agent.setQueue": { steering: string[]; followUp: string[] };
  "agent.compact": { instructions?: string } | null;
  "agent.abortCompaction": null;
  "agent.setAutoCompaction": { enabled: boolean };
  "agent.setAutoRetry": { enabled: boolean };
  "agent.abortRetry": null;
  "agent.getTools": null;
  "agent.setActiveTools": { names: string[] };
  "provider.list": null;
  "provider.setEnabled": { providerId: string; enabled: boolean };
  "provider.save": {
    originalId?: string;
    provider: ProviderDraft;
    apiKey?: string;
    clearApiKey?: boolean;
  };
  "provider.remove": { providerId: string };
  "provider.fetchModels": { providerId: string };
  "model.list": null;
  "model.setCurrent": { provider: string; modelId: string };
  "model.setThinkingLevel": { level: string };
  "package.list": { scope: "user" | "project" | "all"; includeResources?: boolean };
  "package.install": { source: string; scope: "user" | "project" };
  "package.remove": { packageId: string };
  "package.checkUpdates": { packageId?: string } | null;
  "package.update": { packageId: string };
  "package.updateAll": { scope: "user" | "project" | "all" };
  "package.getResources": { packageId: string };
  "package.setResourceEnabled": {
    packageId: string;
    resourceId: string;
    enabled: boolean;
  };
  "package.setResourceTypeEnabled": {
    packageId: string;
    type: "extension" | "skill" | "prompt" | "theme";
    enabled: boolean;
  };
  "package.reloadResources": null;
  "resource.setTopLevelEnabled": { resourceId: string; enabled: boolean };
  "piSettings.get": null;
  "piSettings.patch": { patch: PiSettingsPatch };
  "extensionUi.respond": {
    requestId: string;
    status: "resolved" | "cancelled";
    value?: JsonValue;
  };
  "extensionUi.customInput": { requestId: string; data: string };
  "extensionUi.customResize": { requestId: string; cols: number; rows: number };
};

export type HostResultMap = {
  "system.hello": HostStatusSnapshot;
  "system.getStatus": HostStatusSnapshot;
  "system.shutdown": { accepted: true };
  "workspace.setCurrent": {
    workspace: WorkspaceSnapshot;
    session?: SessionSnapshot;
  };
  "workspace.getCurrent": WorkspaceSnapshot | null;
  "workspace.searchFiles": {
    files: { path: string; kind: "file" | "dir" }[];
    truncated: boolean;
  };
  "session.list": { workspaceId: string; items: SessionSummary[] };
  "session.create": SessionSnapshot;
  "session.open": SessionSnapshot;
  "session.reload": SessionSnapshot;
  "session.archive": { sessionId: string; sessionPath: string; archived: true };
  "session.restore": { sessionId: string; sessionPath: string; archived: false };
  "session.delete": { sessionId: string; deleted: true };
  "session.cleanupArchived": { deletedCount: number; failedCount: number };
  "session.getSnapshot": SessionSnapshot | null;
  "session.setName": SessionSnapshot;
  "session.rename": { sessionId: string; name: string; session?: SessionSnapshot };
  "session.getEntries": {
    entries: SerializableSessionEntry[];
    leafId: string | null;
  };
  "session.getTree": {
    tree: SerializableSessionTreeNode[];
    leafId: string | null;
  };
  "session.getStats": SessionStatsSnapshot;
  "session.usageReport": SessionUsageReport;
  "session.getCommands": { commands: CommandSummary[] };
  "agent.prompt": { accepted: true; runId: string };
  "agent.steer": { accepted: true };
  "agent.followUp": { accepted: true };
  "agent.abort": { aborted: boolean; session: SessionSnapshot };
  "agent.clearQueue": { steering: string[]; followUp: string[] };
  "agent.setQueue": { steering: string[]; followUp: string[] };
  "agent.compact": { result: SerializableCompactionResult; session: SessionSnapshot };
  "agent.abortCompaction": { accepted: true };
  "agent.setAutoCompaction": SessionSnapshot;
  "agent.setAutoRetry": SessionSnapshot;
  "agent.abortRetry": { accepted: true };
  "agent.getTools": ToolSnapshot;
  "agent.setActiveTools": ToolSnapshot;
  "provider.list": { providers: ProviderSnapshot[] };
  "provider.setEnabled": { providerId: string; enabled: boolean };
  "provider.save": { provider: ProviderSnapshot };
  "provider.remove": { providerId: string; removed: true };
  "provider.fetchModels": {
    providerId: string;
    models: DiscoveredProviderModel[];
  };
  "model.list": {
    models: ModelSummary[];
    current?: ModelSummary;
    enabledProviders?: string[];
    thinkingLevels: string[];
    configHealth: ModelConfigHealth;
  };
  "model.setCurrent": {
    model: ModelSummary;
    thinkingLevels: string[];
    session: SessionSnapshot;
  };
  "model.setThinkingLevel": SessionSnapshot;
  "package.list": PackageSnapshot;
  "package.install": PackageMutationResult;
  "package.remove": PackageMutationResult;
  "package.checkUpdates": { supported: boolean; updates: PackageUpdateSummary[] };
  "package.update": PackageMutationResult;
  "package.updateAll": PackageMutationResult;
  "package.getResources": { package: PackageRecord; resources: PackageResource[] };
  "package.setResourceEnabled": PackageMutationResult;
  "package.setResourceTypeEnabled": PackageMutationResult;
  "package.reloadResources": PackageMutationResult;
  "resource.setTopLevelEnabled": PackageMutationResult;
  "piSettings.get": PiSettingsSnapshot;
  "piSettings.patch": PiSettingsSnapshot;
  "extensionUi.respond": { accepted: true };
  "extensionUi.customInput": { accepted: true };
  "extensionUi.customResize": { accepted: true };
};

export type HostEventPayloadMap = {
  "host.ready": HostStatusSnapshot;
  "host.statusChanged": HostStatusSnapshot;
  "host.fatal": { error: HostError };
  "workspace.changed": WorkspaceSnapshot;
  "session.snapshot": SessionSnapshot | null;
  "session.infoChanged": { sessionId: string; name?: string };
  "session.runtimeChanged": {
    sessionId: string;
    sessionRevision: number;
    state: SessionRuntimeState;
    updatedAt: number;
    error?: string;
  };
  "agent.event": { runId: string; event: SerializableAgentSessionEvent };
  "agent.toolsChanged": ToolSnapshot;
  "agent.queueChanged": { steering: string[]; followUp: string[] };
  "agent.compactionChanged": {
    active: boolean;
    reason?: string;
    result?: SerializableCompactionResult;
    error?: HostError;
  };
  "agent.retryChanged": {
    active: boolean;
    attempt?: number;
    maxAttempts?: number;
    delayMs?: number;
    errorMessage?: string;
  };
  "model.changed": {
    model?: ModelSummary;
    thinkingLevel: string;
    availableThinkingLevels: string[];
  };
  "package.progress": {
    operationId: string;
    type: "start" | "progress" | "complete" | "error";
    action: string;
    source: string;
    message?: string;
  };
  "package.snapshot": PackageSnapshot;
  "package.resourcesChanged": {
    packages: PackageSnapshot;
    session?: SessionSnapshot;
  };
  "package.diagnostic": {
    severity: "info" | "warning" | "error";
    source?: string;
    message: string;
  };
  "extensionUi.request": ExtensionUiRequest;
  "extensionUi.statusChanged": { key?: string; text: string };
  "extensionUi.widgetChanged": { key?: string; widget: JsonValue };
  "extensionUi.notification": { message: string; level: string };
  "extensionUi.customStarted": {
    requestId: string;
    title?: string;
    cols: number;
    rows: number;
  };
  "extensionUi.customFrame": { requestId: string; data: string };
  "extensionUi.customClosed": { requestId: string };
};

// Compile-time completeness: every HostMethod/HostEventName key present
type _AssertMethods = keyof HostRequestParams extends HostMethod
  ? HostMethod extends keyof HostRequestParams
    ? true
    : never
  : never;
type _AssertEvents = keyof HostEventPayloadMap extends HostEventName
  ? HostEventName extends keyof HostEventPayloadMap
    ? true
    : never
  : never;
const _m: _AssertMethods = true;
const _e: _AssertEvents = true;
void _m;
void _e;
