import type { HostError, JsonValue } from "./errors.js";

export type HostIdentity = {
  hostInstanceId: string;
  workspaceId: string | null;
  workspaceRevision: number;
  sessionId: string | null;
  sessionRevision: number;
  packageRevision: number;
};

export type HostCapabilities = {
  packageUpdateCheck: boolean;
  extensionUi: true;
  projectTrust: true;
  sessionExport: boolean;
};

export type ModelConfigHealth = {
  state: "ok" | "error";
  source: "ModelRegistry.getError";
  message?: string;
  migrationHint?: {
    code: "SESSION_AFFINITY_FORMAT_REQUIRED";
    message: string;
  };
};

export type HostPhase =
  | "booting"
  | "waitingForWorkspace"
  | "trustRequired"
  | "ready"
  | "agentBusy"
  | "packageBusy"
  | "reloading"
  | "workspaceError"
  | "shuttingDown"
  | "fatal";

export type HostStatusSnapshot = HostIdentity & {
  protocolVersion: 1;
  sdkVersion: string;
  nodeVersion: string;
  agentDir: string;
  phase: HostPhase;
  capabilities: HostCapabilities;
  modelConfigHealth: ModelConfigHealth;
  lastError?: HostError;
  fatalError?: HostError;
};

export type TrustOption = {
  id: "trustOnce" | "trust" | "deny";
  label: string;
  trusted: boolean;
  persisted: boolean;
};

export type WorkspaceSnapshot = {
  id: string;
  cwd: string;
  canonicalCwd: string;
  revision: number;
  trust: {
    required: boolean;
    decision: "trusted" | "denied" | "session" | "pending" | "notRequired";
    persistedAtPath?: string;
  };
  servicesReady: boolean;
};

export type SessionSummary = {
  sessionId: string;
  sessionPath: string;
  name?: string;
  cwd: string;
  updatedAt: number;
  messageCount?: number;
  archived?: boolean;
  runtimeState?: SessionRuntimeState;
  sessionRevision?: number;
};

export type SessionRuntimeState =
  | "starting"
  | "running"
  | "queued"
  | "idle"
  | "error"
  | "inactive";

export type ModelSummary = {
  provider: string;
  modelId: string;
  name: string;
  thinkingLevels?: string[];
};

export type ProviderApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai";

export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;

export type ProviderModelConfig = {
  id: string;
  name: string;
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  input: Array<"text" | "image">;
  contextWindow: number;
  maxTokens: number;
};

export type DiscoveredProviderModel = ProviderModelConfig & {
  enabled: boolean;
  thinkingSource: "provider" | "profile" | "inferred" | "configured" | "manual" | "default";
};

export type ProviderAuthStatus = {
  configured: boolean;
  source?:
    | "stored"
    | "runtime"
    | "environment"
    | "fallback"
    | "models_json_key"
    | "models_json_command";
  label?: string;
};

export type ProviderSnapshot = {
  id: string;
  name: string;
  baseUrl: string;
  api: ProviderApi;
  authHeader: boolean;
  headers: Record<string, string>;
  models: ProviderModelConfig[];
  auth: ProviderAuthStatus;
};

export type ProviderDraft = Omit<ProviderSnapshot, "auth">;

export type SerializableAgentContent = {
  type: string;
  text?: string;
  [key: string]: JsonValue | undefined;
};

export type SerializableAgentToolResult = {
  content: SerializableAgentContent[];
  details: JsonValue;
  addedToolNames?: string[];
  terminate?: boolean;
};

export type SerializableToolInfo = {
  name: string;
  description?: string;
  parameters?: JsonValue;
  source?: string;
};

export type ToolSnapshot = {
  revision: number;
  workspaceId: string;
  sessionId: string;
  sessionRevision: number;
  tools: SerializableToolInfo[];
  active: string[];
};

export type SerializableAgentMessage = {
  role: string;
  content: SerializableAgentContent[] | string;
  [key: string]: JsonValue | SerializableAgentContent[] | string | undefined;
};

export type SessionSnapshot = {
  sessionId: string;
  sessionPath?: string;
  name?: string;
  cwd: string;
  revision: number;
  isStreaming: boolean;
  isIdle: boolean;
  isCompacting: boolean;
  isRetrying: boolean;
  model?: ModelSummary;
  thinkingLevel: string;
  autoCompactionEnabled: boolean;
  autoRetryEnabled: boolean;
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
  pending: { steering: string[]; followUp: string[] };
  messages: SerializableAgentMessage[];
  tools: ToolSnapshot;
};

export type PackageRecord = {
  id: string;
  source: string;
  kind: "npm" | "git" | "local";
  scope: "user" | "project";
  filtered: boolean;
  installed: boolean;
  installedPath?: string;
  displayName: string;
  versionOrRef?: string;
  updateAvailable?: boolean;
  effective: boolean;
  shadowedByPackageId?: string;
  overridesPackageId?: string;
  resourceCounts: {
    extensions: number;
    skills: number;
    prompts: number;
    themes: number;
    enabled: number;
    disabled: number;
  } | null;
  resourceCountsState: "resolvedEffective" | "unknownShadowed";
};

export type PackageResource = {
  id: string;
  packageId: string;
  type: "extension" | "skill" | "prompt" | "theme";
  name: string;
  path: string;
  relativePath?: string;
  enabled: boolean;
  scope: "user" | "project" | "temporary";
  origin: "package";
  diagnostic?: {
    severity: "info" | "warning" | "error";
    message: string;
  };
};

export type TopLevelResource = {
  id: string;
  type: "extension" | "skill" | "prompt" | "theme";
  name: string;
  path: string;
  enabled: boolean;
  scope: "user" | "project";
  source: "auto" | "local";
  origin: "top-level";
  diagnostic?: {
    severity: "info" | "warning" | "error";
    message: string;
  };
};

export type PackageDiagnostic = {
  severity: "info" | "warning" | "error";
  source?: string;
  message: string;
};

export type PackageSnapshot = {
  revision: number;
  workspaceId: string;
  scope: "user" | "project" | "all";
  configured: PackageRecord[];
  packageResources: PackageResource[];
  topLevelResources: TopLevelResource[];
  updateCheck: {
    supported: boolean;
    checkedAt?: number;
  };
  diagnostics: PackageDiagnostic[];
  /** When true, agent.prompt is blocked until package.reloadResources succeeds. */
  resourceReloadRequired?: boolean;
  mutation?: {
    operationId: string;
    status: "running" | "partialFailure";
    reconcileRequired: boolean;
  };
};

export type PackageMutationResult = {
  operationId: string;
  status: "committed" | "partialFailure" | "failed";
  packageSnapshot: PackageSnapshot;
  session?: SessionSnapshot;
  warnings: HostError[];
  reconcileRequired: boolean;
};

export type PackageUpdateSummary = {
  packageId: string;
  source: string;
  current?: string;
  available?: string;
};

export type ResourceType = "extension" | "skill" | "prompt" | "theme";

export type PiSettingsSnapshot = {
  defaultModel?: ModelSummary;
  defaultThinkingLevel?: string;
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
  autoCompaction: boolean;
  autoRetry: boolean;
  defaultProjectTrust?: string;
};

export type PiSettingsPatch = {
  defaultThinkingLevel?: string;
  steeringMode?: "all" | "one-at-a-time";
  followUpMode?: "all" | "one-at-a-time";
  autoCompaction?: boolean;
  autoRetry?: boolean;
  defaultProjectTrust?: string;
};

export type ExtensionUiRequest = {
  requestId: string;
  kind: "select" | "confirm" | "input" | "editor";
  title?: string;
  message?: string;
  options?: Array<{ id: string; label: string }>;
  defaultValue?: string;
  timeoutMs?: number;
};

export type SerializableSessionEntry = {
  id: string;
  type: string;
  [key: string]: JsonValue | undefined;
};

export type SerializableSessionTreeNode = {
  entry: SerializableSessionEntry;
  children: SerializableSessionTreeNode[];
  label?: string;
  labelTimestamp?: string;
};

export type SessionStatsSnapshot = {
  messageCount: number;
  toolCallCount?: number;
  tokenUsage?: JsonValue;
};

export type SerializableImage = {
  mediaType: string;
  data: string;
};

export type SerializableCompactionResult = {
  summary?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  [key: string]: JsonValue | undefined;
};

export type SerializableAgentSessionEvent = {
  type: string;
  [key: string]: JsonValue | undefined;
};

export type DesktopSettings = {
  theme: "light" | "dark" | "system";
  defaultWorkspace?: string;
  restoreLastSession: boolean;
  lastWorkspace?: string;
  lastSessionPath?: string;
  agentDir?: string;
  autoRestartHostOnce: boolean;
  /** Persistent list of workspace folders shown in the sidebar. */
  knownWorkspaces?: string[];
};

export type DesktopSettingsPatch = Partial<DesktopSettings>;
