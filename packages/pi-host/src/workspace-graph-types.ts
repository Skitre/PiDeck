import type {
  AgentSession,
  AuthStorage,
  DefaultPackageManager,
  DefaultResourceLoader,
  ModelRegistry,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
  SessionInfo,
} from "@earendil-works/pi-coding-agent";
import type {
  HostIdentity,
  ModelConfigHealth,
  PackageSnapshot,
  SessionSnapshot,
  TrustOption,
} from "@pideck/protocol";

export type TrustDecisionUi = "trusted" | "denied" | "session" | "pending" | "notRequired";

export type WorkspaceGraph = {
  workspaceId: string;
  cwd: string;
  canonicalCwd: string;
  revision: number;
  trustDecision: TrustDecisionUi;
  projectTrusted: boolean;
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
  trustStore: ProjectTrustStore;
  getModelConfigHealth: () => ModelConfigHealth;
  refreshModelHealth: () => Promise<ModelConfigHealth> | ModelConfigHealth;
  packageUpdateCheck: boolean;
};

export const TRUST_OPTIONS: TrustOption[] = [
  {
    id: "trustOnce",
    label: "Trust this project for this session only",
    trusted: true,
    persisted: false,
  },
  {
    id: "trust",
    label: "Trust this project (persist)",
    trusted: true,
    persisted: true,
  },
  {
    id: "deny",
    label: "Do not trust project resources",
    trusted: false,
    persisted: true,
  },
];
