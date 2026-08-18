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
  sessionExport: boolean;
};

/** Stage an interrupted provider mutation had reached. */
export type ProviderMutationStage = "prepared" | "committed";

export type ModelConfigHealth = {
  /**
   * `degraded` means an interrupted provider mutation could not be fully
   * rolled back. The configuration may mix old and new state, so the Host must
   * not claim it is healthy.
   */
  state: "ok" | "error" | "degraded";
  source: "ModelRegistry.getError" | "provider.journal";
  message?: string;
  migrationHint?: {
    code: "SESSION_AFFINITY_FORMAT_REQUIRED";
    message: string;
  };
  /** Present only while a provider mutation journal is unresolved. */
  recovery?: {
    journalId: string;
    stage: ProviderMutationStage;
    /** False when models.json or the credential file could not be restored. */
    restored: boolean;
  };
};

export type HostPhase =
  | "booting"
  | "waitingForWorkspace"
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
  extensionDecisionPresentation?: ExtensionDecisionPresentation;
  lastError?: HostError;
  fatalError?: HostError;
};

export type WorkspaceSnapshot = {
  id: string;
  cwd: string;
  canonicalCwd: string;
  revision: number;
  servicesReady: boolean;
};

export type WorkspaceDirectoryEntry = {
  name: string;
  path: string;
  kind: "file" | "dir";
  symlink: boolean;
};

export type GitChangeKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "type_changed"
  | "untracked"
  | "conflicted";

export type GitFileChange = {
  path: string;
  originalPath?: string;
  staged: GitChangeKind | null;
  unstaged: GitChangeKind | null;
  conflict: boolean;
  submodule: boolean;
  pathSupported: boolean;
};

export type GitStatusSnapshot =
  | {
      state: "ready";
      revision: number;
      repositoryRoot: string;
      workspaceIsRepositoryRoot: boolean;
      branch: string | null;
      detached: boolean;
      unborn: boolean;
      headSha: string | null;
      upstream: string | null;
      ahead: number;
      behind: number;
      indexGeneration: string;
      files: GitFileChange[];
      warnings: string[];
    }
  | { state: "not_repository"; revision: number }
  | { state: "unavailable"; revision: number; message: string }
  | { state: "error"; revision: number; message: string };

export type GitDiffSnapshot = {
  path: string;
  area: "staged" | "unstaged";
  patch: string;
  additions: number;
  deletions: number;
  binary: boolean;
  truncated: boolean;
  contentGeneration: string;
  hunks: GitDiffHunk[];
  hunkOperations: GitHunkOperation[];
};

export type GitDiffHunk = {
  id: string;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  additions: number;
  deletions: number;
};

export type GitHunkOperation = "stage" | "unstage" | "discard";

export type GitBranch = {
  name: string;
  current: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
};

export type GitBranchList = {
  statusRevision: number;
  current: string | null;
  detached: boolean;
  branches: GitBranch[];
  truncated: boolean;
};

export type GitCommitSummary = {
  sha: string;
  shortSha: string;
  parents: string[];
  authorName: string;
  authoredAt: string;
  subject: string;
  refs: string[];
};

export type GitHistoryResult = {
  commits: GitCommitSummary[];
  nextCursor: string | null;
};

export type GitCommitDiffSnapshot = {
  commitSha: string;
  parentSha: string | null;
  patch: string;
  additions: number;
  deletions: number;
  binary: boolean;
  truncated: boolean;
};

export type GitMutationResult = {
  applied: true;
  snapshot?: GitStatusSnapshot;
  warning?: string;
};

export type GitCommitResult = GitMutationResult & {
  commitSha: string | null;
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

export type SessionRuntimeState = "starting" | "running" | "queued" | "idle" | "error" | "inactive";

export type ModelSummary = {
  provider: string;
  modelId: string;
  name: string;
  thinkingLevels?: string[];
};

export type ProviderApi =
  "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

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
    "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";
  label?: string;
};

export type ProviderCompatibility = {
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
};

export type ProviderCompatibilityDraft = {
  supportsDeveloperRole?: boolean | null;
  supportsReasoningEffort?: boolean | null;
};

export type ProviderSnapshot = {
  id: string;
  enabled: boolean;
  name: string;
  baseUrl: string;
  modelsUrl?: string;
  api: ProviderApi;
  authHeader: boolean;
  headers: Record<string, string>;
  compat?: ProviderCompatibility;
  models: ProviderModelConfig[];
  auth: ProviderAuthStatus;
};

export type ProviderDraft = Omit<ProviderSnapshot, "auth" | "enabled" | "compat" | "authHeader"> & {
  /** Rolling-compatibility hint for Hosts that predate automatic auth selection. */
  authHeader?: boolean;
  compat?: ProviderCompatibilityDraft;
};

/** Login-capable builtin (SDK) provider and its credential state. */
export type BuiltinProviderAuthStatus = {
  providerId: string;
  name: string;
  supportsOauth: boolean;
  /** Subscription label from the SDK, e.g. "Anthropic (Claude Pro/Max)". */
  oauthLabel?: string;
  supportsApiKeyLogin: boolean;
  configured: boolean;
  /** Human-readable auth source, e.g. "OAuth" or "ANTHROPIC_API_KEY". */
  authLabel?: string;
  /** True when auth.json holds a credential PiDeck can log out of. */
  hasStoredCredential: boolean;
  enabled: boolean;
};

export type BuiltinProviderModelChoice = {
  id: string;
  name: string;
  /** Whether the model is offered in the chat model picker. */
  enabled: boolean;
};

export type BuiltinProviderModelsResult = {
  providerId: string;
  models: BuiltinProviderModelChoice[];
};

export type ProviderLoginPrompt = {
  promptId: string;
  kind: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: Array<{ id: string; label: string; description?: string }>;
};

export type ProviderLoginFlowEvent =
  | { kind: "info"; message: string; links?: Array<{ url: string; label?: string }> }
  | { kind: "auth_url"; url: string; instructions?: string }
  | {
      kind: "device_code";
      userCode: string;
      verificationUri: string;
      expiresInSeconds?: number;
    }
  | { kind: "progress"; message: string }
  | { kind: "prompt"; prompt: ProviderLoginPrompt }
  | { kind: "prompt_cancel"; promptId: string }
  | { kind: "done"; ok: boolean; message?: string };

export type ProviderConnectionCategory =
  | "ok"
  | "configuration"
  | "authentication"
  | "blocked"
  | "rate_limit"
  | "not_found"
  | "timeout"
  | "network"
  | "protocol"
  | "provider";

export type ProviderConnectionResult = {
  providerId: string;
  modelId: string;
  api: ProviderApi;
  ok: boolean;
  latencyMs: number;
  category: ProviderConnectionCategory;
  message: string;
  suggestion?: string;
};

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
  usage?: SerializableUsage;
  [key: string]: JsonValue | SerializableAgentContent[] | string | undefined;
};

/**
 * Plain-text projection produced by a registered Pi Extension message renderer.
 * Extension components and terminal control sequences never cross the Host boundary.
 */
export type ExtensionMessageRenderSnapshot = {
  version: 1;
  collapsed: string[];
  expanded: string[];
  /** Position in the current context-message projection, used before Desktop receives the entry ID. */
  messageIndex?: number;
};

export type SerializableUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  reasoning?: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
};

export type SessionContextUsage = {
  tokens: number | null;
  contextWindow: number;
  breakdown?: SessionContextBreakdown;
};

export type SessionContextBreakdown = {
  systemPrompt: number;
  toolDefinitions: number;
  userPrompts: number;
  assistantMessages: number;
  toolResults: number;
  summaries: number;
  other: number;
};

export type QueueSnapshot = {
  revision: number;
  steering: string[];
  followUp: string[];
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
  pending: QueueSnapshot;
  contextUsage?: SessionContextUsage;
  messages: SerializableAgentMessage[];
  /**
   * The compaction-aware entry path for the current session leaf.
   *
   * This is optional so clients can continue to consume snapshots produced by
   * older hosts that only exposed the projected agent messages.
   */
  entries?: SerializableSessionEntry[];
  /** The leaf represented by `entries`, when the host exposes the entry path. */
  leafId?: string | null;
  /** Registered Extension renderer output, keyed by persisted custom-message entry ID. */
  extensionMessageRenders?: Record<string, ExtensionMessageRenderSnapshot>;
  tools: ToolSnapshot;
};

export type PackageCatalogItem = {
  /** npm package name, e.g. "@scope/pkg" or "pi-web-access". */
  name: string;
  description: string;
  author?: string;
  /** Resource kinds advertised by the catalog, e.g. ["extension", "skill"]. */
  types: string[];
  downloadsPerMonth?: number;
  /** Publication timestamp in epoch milliseconds. */
  publishedAt?: number;
  npmUrl?: string;
  githubUrl?: string;
  /** Catalog-provided text blob for client-side filtering. */
  searchText: string;
  /** Source string accepted by package.install, e.g. "npm:pi-web-access". */
  installSource: string;
  /** Detail page on the catalog site. */
  pageUrl: string;
};

export type PackageCatalog = {
  generatedAt: number;
  /** True when served from the in-memory cache instead of a fresh fetch. */
  fromCache: boolean;
  items: PackageCatalogItem[];
  /** 1-based page that produced `items`. */
  page: number;
  pageSize: number;
  /** Catalog-reported match count for the current query. */
  total: number;
  lastPage: number;
};

export type PackageRecord = {
  id: string;
  identity: string;
  source: string;
  kind: "npm" | "git" | "local";
  scope: "user" | "project";
  filtered: boolean;
  installed: boolean;
  installedPath?: string;
  displayName: string;
  description?: string;
  versionOrRef?: string;
  updateAvailable?: boolean;
  effective: boolean;
  shadowedByPackageId?: string;
  overridesPackageId?: string;
  projectOverride?: {
    source: string;
    overrideCount: number;
  };
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

export type PackageDiagnostic = {
  severity: "info" | "warning" | "error";
  source?: string;
  message: string;
};

export type UserResourcePreference = "enabled" | "disabled";

export type ProjectResourcePreference = "inherit" | "enabled" | "disabled";

export type ResourceControl =
  | { kind: "preference"; scopes: Array<"user" | "project"> }
  | { kind: "owner-extension"; ownerResourceId: string }
  | { kind: "read-only"; reason: string };

export type ResourceRecord = {
  id: string;
  type: "extension" | "skill" | "prompt" | "theme";
  name: string;
  description?: string;
  path: string;
  relativePath?: string;
  scope: "user" | "project" | "temporary";
  origin: "package" | "top-level" | "extension";
  source: string;
  packageId?: string;
  enabled: boolean;
  preferences: {
    user?: UserResourcePreference;
    project?: ProjectResourcePreference;
  };
  control: ResourceControl;
  manualOnly?: boolean;
  diagnostics: PackageDiagnostic[];
};

export type ResourcePreferenceUpdate =
  | {
      resourceId: string;
      targetScope: "user";
      preference: UserResourcePreference;
    }
  | {
      resourceId: string;
      targetScope: "project";
      preference: ProjectResourcePreference;
    };

export type PackageSnapshot = {
  revision: number;
  workspaceId: string;
  scope: "user" | "project" | "all";
  configured: PackageRecord[];
  resources: ResourceRecord[];
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

export type RehydrateSnapshot = {
  /** Highest Host event sequence reflected by this composite snapshot. */
  watermark: number;
  host: HostStatusSnapshot;
  workspace: WorkspaceSnapshot | null;
  session: SessionSnapshot | null;
  tools: ToolSnapshot | null;
  packages: PackageSnapshot | null;
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

/** Resource kinds exposed by package and top-level resource listings. */
export type PackageResourceType = ResourceRecord["type"];

/** @deprecated Prefer PackageResourceType for package/resource APIs. */
export type ResourceType = PackageResourceType;

export type ExtensionPresentationAudience = "agent" | "user";
export type ExtensionPresentationKind = "activity" | "progress" | "decision" | "result" | "warning";
export type ExtensionPresentationStatus =
  "pending" | "running" | "resolved" | "cancelled" | "expired" | "failed";
export type ExtensionPresentationSeverity = "neutral" | "info" | "warning" | "danger";

/** Portable, declarative presentation hints for custom Extension messages. */
export type ExtensionPresentation = {
  version: 1;
  extensionId: string;
  audience: ExtensionPresentationAudience;
  kind: ExtensionPresentationKind;
  correlationId: string;
  sourceLabel?: string;
  status?: ExtensionPresentationStatus;
  severity?: ExtensionPresentationSeverity;
  groupKey?: string;
  title?: string;
  summary?: string;
  /** References a live Extension UI request; it is never executable by itself. */
  actionRequestId?: string;
  technicalDetails?: JsonValue;
};

export type ExtensionUiOption = {
  id: string;
  label: string;
  description?: string;
  destructive?: boolean;
};

export type ExtensionUiClosedReason = "aborted" | "timed-out" | "disposed" | "stale";

export type ExtensionUiClosed = {
  requestId: string;
  reason: ExtensionUiClosedReason;
};

export type ExtensionUiGroupStatus = "completed" | "failed" | "cancelled" | "stale";

export type ExtensionUiGroupClosed = {
  groupKey: string;
  status: ExtensionUiGroupStatus;
};

export type ExtensionUiSourceKind = "package" | "user" | "project" | "synthetic";

type ExtensionUiKnownOrigin = {
  extensionId: string;
  extensionDisplayName: string;
  sourceKind: ExtensionUiSourceKind;
};

export type ExtensionUiOrigin =
  | { invocationKind: "unknown" }
  | (ExtensionUiKnownOrigin & {
      invocationKind: "tool";
      toolName: string;
      toolCallId: string;
    })
  | (ExtensionUiKnownOrigin & {
      invocationKind: "command";
      commandName: string;
    })
  | (ExtensionUiKnownOrigin & {
      invocationKind: "shortcut";
      shortcut: string;
    })
  | (ExtensionUiKnownOrigin & {
      invocationKind: "event";
      eventType: string;
      toolName?: string;
      toolCallId?: string;
    })
  | (ExtensionUiKnownOrigin & { invocationKind: "background" });

export type ExtensionDecisionPresentation = "legacy-modal" | "auto" | "inline-first";

export type ExtensionUiPresentation = "inline" | "modal";
export type ExtensionUiRisk = "normal" | "high";

export type ExtensionUiRouteReason =
  | "stale-owner"
  | "explicit-modal"
  | "explicit-inline"
  | "high-risk"
  | "destructive-option"
  | "project-trust"
  | "session-lifecycle"
  | "active-tool"
  | "active-command"
  | "background-session"
  | "inline-unavailable"
  | "unknown-origin";

export type ExtensionUiRequest = {
  requestId: string;
  kind: "select" | "confirm" | "input" | "editor";
  title?: string;
  message?: string;
  options?: ExtensionUiOption[];
  defaultValue?: string;
  timeoutMs?: number;
  sourceLabel?: string;
  correlationId?: string;
  presentationHint?: ExtensionUiPresentation;
  riskHint?: ExtensionUiRisk;
  presentation?: ExtensionUiPresentation;
  risk?: ExtensionUiRisk;
  routeReason?: ExtensionUiRouteReason;
  groupKey?: string;
  allowFreeform?: boolean;
  origin?: ExtensionUiOrigin;
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

export type SessionTokenTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

export type SessionStatsSnapshot = {
  messageCount: number;
  toolCallCount?: number;
  tokenUsage?: JsonValue;
  userMessageCount?: number;
  assistantMessageCount?: number;
  toolResultCount?: number;
  /** Aggregated over ALL session entries, including compacted-away history. */
  tokens?: SessionTokenTotals;
  cost?: number;
  sessionFile?: string;
};

export type SessionUsageReportItem = {
  sessionId: string;
  sessionPath: string;
  name?: string;
  updatedAt: number;
  archived: boolean;
  messageCount: number;
  usage: SerializableUsage;
};

export type SessionUsageReport = {
  workspaceId: string;
  generatedAt: number;
  totals: {
    sessionCount: number;
    messageCount: number;
    usage: SerializableUsage;
  };
  sessions: SessionUsageReportItem[];
};

export type SessionSearchMatch = {
  role: "user" | "assistant";
  /** Short excerpt around the first matched term, whitespace-collapsed. */
  snippet: string;
};

export type SessionSearchResultItem = {
  sessionId: string;
  sessionPath: string;
  name?: string;
  /** Workspace path recorded in the session header. */
  cwd: string;
  archived: boolean;
  updatedAt: number;
  /** Total matching message blocks in the session (may exceed matches.length). */
  matchCount: number;
  /** Capped list of match excerpts. */
  matches: SessionSearchMatch[];
  /** True when the session name itself matched the query. */
  nameMatched: boolean;
};

export type SessionSearchReport = {
  generatedAt: number;
  query: string;
  /** Total session files scanned across all workspaces. */
  scannedCount: number;
  /** True when more sessions matched than the returned item cap. */
  truncated: boolean;
  items: SessionSearchResultItem[];
};

export type CommandSummary = {
  /** Text after the leading slash, e.g. "plan" or "skill:review" */
  invocation: string;
  description: string;
  argumentHint?: string;
  kind: "template" | "command" | "skill";
};

export type SerializableImage = {
  mediaType: string;
  data: string;
};

export type AttachmentStatus = "copying" | "parsing" | "ready" | "needs_ocr" | "failed";

export type AttachmentMediaType =
  | "application/pdf"
  | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  | "text/plain";

export type AttachmentUnit = "page" | "chunk";

export type AttachmentSnapshot = {
  id: string;
  name: string;
  mediaType: AttachmentMediaType;
  sizeBytes: number;
  status: AttachmentStatus;
  unit?: AttachmentUnit;
  unitCount?: number;
  processedUnits?: number;
  error?: string;
};

export type SerializableCompactionResult = {
  summary?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  [key: string]: JsonValue | undefined;
};

/** Compact, replayable projection of the SDK's AssistantMessageEvent. */
export type SerializableAssistantMessageEvent =
  | { type: "start" }
  | { type: "text_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number; content: string }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "thinking_end"; contentIndex: number; content: string }
  | { type: "toolcall_start"; contentIndex: number; id: string; name: string }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_end"; contentIndex: number; toolCall: JsonValue }
  | { type: "done"; reason: string }
  | { type: "error"; reason: string; errorMessage?: string };

export type SerializableAgentSessionEvent = {
  type: string;
  [key: string]: JsonValue | undefined;
};

export const DESKTOP_THEMES = ["light", "dark", "system"] as const;
export type DesktopTheme = (typeof DESKTOP_THEMES)[number];

export const DESKTOP_THEME_FAMILIES = ["pideck", "vercel", "apple"] as const;
export type DesktopThemeFamily = (typeof DESKTOP_THEME_FAMILIES)[number];

export const DESKTOP_LANGUAGES = ["system", "en", "zh"] as const;
export type DesktopLanguage = (typeof DESKTOP_LANGUAGES)[number];

export const DESKTOP_INTERFACE_DENSITIES = ["compact", "standard", "comfortable"] as const;
export type DesktopInterfaceDensity = (typeof DESKTOP_INTERFACE_DENSITIES)[number];

export const BUSY_SEND_BEHAVIORS = ["followUp", "steer"] as const;
export type BusySendBehavior = (typeof BUSY_SEND_BEHAVIORS)[number];

export const TERMINAL_PROFILE_IDS = [
  "auto",
  "pwsh",
  "windows-powershell",
  "cmd",
  "git-bash",
  "wsl-default",
  "zsh",
  "bash",
  "fish",
  "sh",
] as const;
export type TerminalProfileId = (typeof TERMINAL_PROFILE_IDS)[number];

export type DesktopSettings = {
  theme: DesktopTheme;
  /** Visual theme family; absent values use the original PiDeck palette. */
  themeFamily?: DesktopThemeFamily;
  defaultWorkspace?: string;
  restoreLastSession: boolean;
  lastWorkspace?: string;
  lastSessionPath?: string;
  agentDir?: string;
  autoRestartHostOnce: boolean;
  /** How Composer send behaves while the Session is already running. Absent values use follow-up. */
  busySendBehavior?: BusySendBehavior;
  extensionDecisionPresentation: ExtensionDecisionPresentation;
  terminalProfile: TerminalProfileId;
  /** UI language; "system" (or absent) follows the OS locale. */
  language?: DesktopLanguage;
  /** Spacing density for frequently used interface controls and rows. */
  interfaceDensity?: DesktopInterfaceDensity;
  /** Maximum width of the aligned conversation surfaces, in CSS pixels. */
  conversationContentWidth?: number;
  /** Base font size for conversation content, in CSS pixels. */
  conversationFontSize?: number;
  /** Font size for inline and fenced conversation code, in CSS pixels. */
  codeFontSize?: number;
  /** Persistent list of workspace folders shown in the sidebar. */
  knownWorkspaces?: string[];
  /** Per-command shortcut overrides. null explicitly disables a command binding. */
  shortcutOverrides?: Record<string, string | null>;
};

export type DesktopSettingsPatch = Partial<DesktopSettings>;
