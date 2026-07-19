/** All P0 Host methods — PROJECT_SPEC §7.3 */
export const HOST_METHODS = [
  "system.hello",
  "system.getStatus",
  "system.shutdown",
  "workspace.setCurrent",
  "workspace.getCurrent",
  "workspace.getTrust",
  "workspace.searchFiles",
  "workspace.setTrust",
  "session.list",
  "session.create",
  "session.open",
  "session.reload",
  "session.archive",
  "session.restore",
  "session.delete",
  "session.cleanupArchived",
  "session.getSnapshot",
  "session.setName",
  "session.getEntries",
  "session.getTree",
  "session.getStats",
  "session.getPromptTemplates",
  "agent.prompt",
  "agent.steer",
  "agent.followUp",
  "agent.abort",
  "agent.clearQueue",
  "agent.compact",
  "agent.abortCompaction",
  "agent.setAutoCompaction",
  "agent.setAutoRetry",
  "agent.abortRetry",
  "agent.getTools",
  "agent.setActiveTools",
  "provider.list",
  "provider.save",
  "provider.remove",
  "provider.fetchModels",
  "model.list",
  "model.setCurrent",
  "model.setThinkingLevel",
  "package.list",
  "package.install",
  "package.remove",
  "package.checkUpdates",
  "package.update",
  "package.updateAll",
  "package.getResources",
  "package.setResourceEnabled",
  "package.setResourceTypeEnabled",
  "package.reloadResources",
  "resource.setTopLevelEnabled",
  "piSettings.get",
  "piSettings.patch",
  "extensionUi.respond",
] as const;

export type HostMethod = (typeof HOST_METHODS)[number];

export function isHostMethod(value: unknown): value is HostMethod {
  return typeof value === "string" && (HOST_METHODS as readonly string[]).includes(value);
}

export type EmptyContext = Record<never, never>;

export type HostContext = {
  expectedHostInstanceId: string;
};

export type WorkspaceContext = HostContext & {
  expectedWorkspaceId: string | null;
  expectedWorkspaceRevision: number;
};

export type ActiveSessionContext = WorkspaceContext & {
  expectedSessionId: string;
  expectedSessionRevision: number;
};

export type NullableSessionContext = WorkspaceContext & {
  expectedSessionId: string | null;
  expectedSessionRevision: number;
};

export type ToolMutationContext = ActiveSessionContext & {
  expectedToolRevision: number;
};

export type WorkspacePackageContext = WorkspaceContext & {
  expectedPackageRevision: number;
};

export type SessionPackageContext = NullableSessionContext & {
  expectedPackageRevision: number;
};

export type HostOnlyMethod =
  | "system.getStatus"
  | "system.shutdown"
  | "provider.list"
  | "provider.save"
  | "provider.remove"
  | "provider.fetchModels";
export type WorkspaceOnlyMethod =
  | "workspace.setCurrent"
  | "workspace.getCurrent"
  | "workspace.getTrust"
  | "workspace.searchFiles"
  | "workspace.setTrust"
  | "session.list"
  | "session.archive"
  | "session.restore"
  | "session.delete"
  | "session.cleanupArchived"
  | "session.getSnapshot"
  | "package.list"
  | "package.checkUpdates"
  | "piSettings.get";
export type NullableSessionMethod = "session.create" | "session.open" | "piSettings.patch";
export type ActiveSessionMethod =
  | "session.setName"
  | "session.reload"
  | "session.getEntries"
  | "session.getTree"
  | "session.getStats"
  | "session.getPromptTemplates"
  | "agent.prompt"
  | "agent.steer"
  | "agent.followUp"
  | "agent.abort"
  | "agent.clearQueue"
  | "agent.compact"
  | "agent.abortCompaction"
  | "agent.setAutoCompaction"
  | "agent.setAutoRetry"
  | "agent.abortRetry"
  | "agent.getTools"
  | "model.list"
  | "model.setCurrent"
  | "model.setThinkingLevel"
  | "extensionUi.respond";
export type ToolMutationMethod = "agent.setActiveTools";
export type SessionPackageMethod =
  | "package.install"
  | "package.remove"
  | "package.update"
  | "package.updateAll"
  | "package.setResourceEnabled"
  | "package.setResourceTypeEnabled"
  | "package.reloadResources"
  | "resource.setTopLevelEnabled";

export type HostRequestContext<M extends HostMethod> = M extends "system.hello"
  ? EmptyContext
  : M extends HostOnlyMethod
    ? HostContext
    : M extends WorkspaceOnlyMethod
      ? WorkspaceContext
      : M extends NullableSessionMethod
        ? NullableSessionContext
        : M extends ActiveSessionMethod
          ? ActiveSessionContext
          : M extends ToolMutationMethod
            ? ToolMutationContext
            : M extends "package.getResources"
              ? WorkspacePackageContext
              : M extends SessionPackageMethod
                ? SessionPackageContext
                : never;

/** Context scope for each method — used by runtime validators */
export type MethodContextScope =
  | "empty"
  | "host"
  | "workspace"
  | "nullableSession"
  | "activeSession"
  | "toolMutation"
  | "workspacePackage"
  | "sessionPackage";

export const METHOD_CONTEXT_SCOPE: Record<HostMethod, MethodContextScope> = {
  "system.hello": "empty",
  "system.getStatus": "host",
  "system.shutdown": "host",
  "workspace.setCurrent": "workspace",
  "workspace.getCurrent": "workspace",
  "workspace.getTrust": "workspace",
  "workspace.searchFiles": "workspace",
  "workspace.setTrust": "workspace",
  "session.list": "workspace",
  "session.create": "nullableSession",
  "session.open": "nullableSession",
  "session.reload": "activeSession",
  "session.archive": "workspace",
  "session.restore": "workspace",
  "session.delete": "workspace",
  "session.cleanupArchived": "workspace",
  "session.getSnapshot": "workspace",
  "session.setName": "activeSession",
  "session.getEntries": "activeSession",
  "session.getTree": "activeSession",
  "session.getStats": "activeSession",
  "session.getPromptTemplates": "activeSession",
  "agent.prompt": "activeSession",
  "agent.steer": "activeSession",
  "agent.followUp": "activeSession",
  "agent.abort": "activeSession",
  "agent.clearQueue": "activeSession",
  "agent.compact": "activeSession",
  "agent.abortCompaction": "activeSession",
  "agent.setAutoCompaction": "activeSession",
  "agent.setAutoRetry": "activeSession",
  "agent.abortRetry": "activeSession",
  "agent.getTools": "activeSession",
  "agent.setActiveTools": "toolMutation",
  "provider.list": "host",
  "provider.save": "host",
  "provider.remove": "host",
  "provider.fetchModels": "host",
  "model.list": "activeSession",
  "model.setCurrent": "activeSession",
  "model.setThinkingLevel": "activeSession",
  "package.list": "workspace",
  "package.install": "sessionPackage",
  "package.remove": "sessionPackage",
  "package.checkUpdates": "workspace",
  "package.update": "sessionPackage",
  "package.updateAll": "sessionPackage",
  "package.getResources": "workspacePackage",
  "package.setResourceEnabled": "sessionPackage",
  "package.setResourceTypeEnabled": "sessionPackage",
  "package.reloadResources": "sessionPackage",
  "resource.setTopLevelEnabled": "sessionPackage",
  "piSettings.get": "workspace",
  "piSettings.patch": "nullableSession",
  "extensionUi.respond": "activeSession",
};
