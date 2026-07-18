import type {
  HostEventMessage,
  HostResponseMessage,
  HostStatusSnapshot,
  PackageSnapshot,
  SessionSnapshot,
  WorkspaceSnapshot,
  DesktopSettings,
  ExtensionUiRequest,
  ToolSnapshot,
} from "@pideck/protocol";

export type BridgeState = {
  connected: boolean;
  host: HostStatusSnapshot | null;
  workspace: WorkspaceSnapshot | null;
  session: SessionSnapshot | null;
  packages: PackageSnapshot | null;
  tools: ToolSnapshot | null;
  desktopSettings: DesktopSettings | null;
  extensionUiRequest: ExtensionUiRequest | null;
  extensionStatus: string | null;
  extensionWidget: unknown | null;
  fatalError: string | null;
  lastSequence: number;
};

export type { HostEventMessage, HostResponseMessage };
