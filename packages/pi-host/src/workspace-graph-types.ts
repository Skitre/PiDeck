import type {
  AgentSession,
  DefaultPackageManager,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  SessionInfo,
} from "@earendil-works/pi-coding-agent";
import type { FileCredentialStore } from "./credential-store.js";
import type {
  ExtensionProviderOwnership,
  ProviderOwnerToken,
  SuspendedProviders,
} from "./extension-provider-ownership.js";
import type { MigrationMilestone } from "./migration-backup.js";
import type {
  HostIdentity,
  ModelConfigHealth,
  PackageSnapshot,
  SessionSnapshot,
} from "@pideck/protocol";
import type { ResourceIdMap } from "./package-snapshot.js";
import type { AttachmentStore } from "./attachment-store.js";
import type { UserResourceCache } from "./user-resource-cache.js";

export type WorkspaceGraph = {
  workspaceId: string;
  cwd: string;
  canonicalCwd: string;
  revision: number;
  servicesReady: boolean;
  settingsManager: SettingsManager | null;
  packageManager: DefaultPackageManager | null;
  resourceLoader: DefaultResourceLoader | null;
  sessionManager: SessionManager | null;
  agentSession: AgentSession | null;
  extensionsResult: unknown;
  packageSnapshot: PackageSnapshot | null;
  sessionSnapshot: SessionSnapshot | null;
  toolRevision: number;
  /** Private resourceId -> metadata map for package and standalone preferences. */
  resourceIdMap: ResourceIdMap;
  unsubscribeAgent: (() => void) | null;
  extensionUiActivate: (() => Promise<() => void>) | null;
  extensionUiCleanup: (() => void) | null;
  extensionUiUpdateIdentity: ((identity: HostIdentity) => void) | null;
  extensionUiReplayState: (() => void) | null;
  /** After package mutation reload failure — block prompts until reload succeeds */
  resourceReloadRequired: boolean;
  backgroundSessions: Map<string, BackgroundSessionRuntime>;
  /** Disk/config fingerprint captured when this graph was parked. */
  retainedFingerprint?: string;
  /** Ownership token for providers registered by this workspace's extensions. */
  providerOwner?: ProviderOwnerToken | null;
  /** Extension providers unregistered while this graph is parked. */
  suspendedProviders?: SuspendedProviders;
};

export type BackgroundSessionRuntime = {
  sessionId: string;
  sessionRevision: number;
  sessionManager: SessionManager;
  agentSession: AgentSession;
  resourceLoader: DefaultResourceLoader;
  extensionsResult: unknown;
  toolRevision: number;
  sessionSnapshot: SessionSnapshot;
  unsubscribeAgent: (() => void) | null;
  extensionUiActivate: (() => Promise<() => void>) | null;
  extensionUiCleanup: (() => void) | null;
  extensionUiUpdateIdentity: ((identity: HostIdentity) => void) | null;
  extensionUiReplayState: (() => void) | null;
};

export type ManagedSessionInfo = SessionInfo & { archived: boolean };

export type GraphFactoryDeps = {
  agentDir: string;
  /** Host-owned managed document store. Optional in isolated controller tests. */
  attachmentStore?: AttachmentStore;
  /** Persistent auth.json store injected into the Host-owned runtime. */
  credentialStore: FileCredentialStore;
  /**
   * The single authoritative runtime. Every createAgentSession call must
   * receive this instance; omitting it makes the SDK build a second runtime
   * with its own provider and auth state.
   */
  modelRuntime: ModelRuntime;
  /** Synchronous compatibility facade over `modelRuntime`. Owns no state. */
  modelRegistry: ModelRegistry;
  /**
   * Workspace-scoped ownership for extension-registered providers. The shared
   * runtime never unregisters them; this layer suspends a workspace's
   * providers when its graph is parked and drops them when it is disposed.
   */
  providerOwnership: ExtensionProviderOwnership;
  getModelConfigHealth: () => ModelConfigHealth;
  /** Local reconcile only — never reaches the network. */
  refreshModelHealth: (signal?: AbortSignal) => Promise<ModelConfigHealth> | ModelConfigHealth;
  /**
   * Report that a migration-dependent path succeeded. Absent once the
   * migration is complete. Never throws — a lost milestone only retains the
   * backup longer.
   */
  recordMigrationMilestone?: (milestone: MigrationMilestone) => Promise<void>;
  packageUpdateCheck: boolean;
  /** Process-wide user/global Extension cache. Created by the factory when omitted. */
  userResourceCache?: UserResourceCache;
};
