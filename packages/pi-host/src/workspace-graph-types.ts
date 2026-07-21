import type {
  AgentSession,
  AuthStorage,
  DefaultPackageManager,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  SessionInfo,
} from "@earendil-works/pi-coding-agent";
import type {
  HostIdentity,
  ModelConfigHealth,
  PackageSnapshot,
  SessionSnapshot,
} from "@pideck/protocol";

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
  /** private resourceId -> metadata map for top-level toggles */
  resourceIdMap: Map<
    string,
    {
      type: "extension" | "skill" | "prompt" | "theme";
      scope: "user" | "project" | "temporary";
      path: string;
      baseDir?: string;
      origin: "package" | "top-level";
      packageSource?: string;
      packageScope?: "user" | "project";
    }
  >;
  unsubscribeAgent: (() => void) | null;
  extensionUiActivate: (() => Promise<() => void>) | null;
  extensionUiCleanup: (() => void) | null;
  extensionUiUpdateIdentity: ((identity: HostIdentity) => void) | null;
  /** After package mutation reload failure — block prompts until reload succeeds */
  resourceReloadRequired: boolean;
  backgroundSessions: Map<string, BackgroundSessionRuntime>;
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
};

export type ManagedSessionInfo = SessionInfo & { archived: boolean };

export type GraphFactoryDeps = {
  agentDir: string;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  getModelConfigHealth: () => ModelConfigHealth;
  refreshModelHealth: () => Promise<ModelConfigHealth> | ModelConfigHealth;
  packageUpdateCheck: boolean;
};
