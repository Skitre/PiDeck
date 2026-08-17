/** All P0 Host methods — PROJECT_SPEC §7.3 */
export const HOST_METHODS = [
  "system.hello",
  "system.getStatus",
  "system.rehydrate",
  "system.shutdown",
  "workspace.setCurrent",
  "workspace.getCurrent",
  "workspace.searchFiles",
  "workspace.listDirectory",
  "workspace.setDirectoryWatches",
  "git.getStatus",
  "git.setWatching",
  "git.getDiff",
  "git.mutateHunk",
  "git.stage",
  "git.stageAll",
  "git.unstage",
  "git.unstageAll",
  "git.discard",
  "git.commit",
  "git.listBranches",
  "git.createBranch",
  "git.switchBranch",
  "git.listHistory",
  "git.getCommitDiff",
  "attachment.create",
  "attachment.createText",
  "attachment.get",
  "attachment.remove",
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
  "session.rename",
  "session.getEntries",
  "session.getTree",
  "session.getStats",
  "session.getForkPoints",
  "session.fork",
  "session.export",
  "session.usageReport",
  "session.searchAll",
  "session.getCommands",
  "agent.prompt",
  "agent.steer",
  "agent.followUp",
  "agent.abort",
  "agent.clearQueue",
  "agent.setQueue",
  "agent.runNow",
  "agent.compact",
  "agent.abortCompaction",
  "agent.navigateTree",
  "agent.setAutoCompaction",
  "agent.setAutoRetry",
  "agent.abortRetry",
  "agent.getTools",
  "agent.setActiveTools",
  "provider.list",
  "provider.setEnabled",
  "provider.save",
  "provider.remove",
  "provider.fetchModels",
  "provider.checkConnection",
  "provider.authStatus",
  "provider.loginStart",
  "provider.loginRespond",
  "provider.loginCancel",
  "provider.logout",
  "provider.builtinModels",
  "provider.setBuiltinModels",
  "model.list",
  "model.setCurrent",
  "model.setThinkingLevel",
  "package.list",
  "package.catalog",
  "package.install",
  "package.remove",
  "package.checkUpdates",
  "package.update",
  "package.updateAll",
  "package.getResources",
  "package.reloadResources",
  "resource.setPreference",
  "resource.setPreferences",
  "extensionUi.configure",
  "extensionUi.respond",
  "extensionUi.customInput",
  "extensionUi.customResize",
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

/** Identifies a concrete foreground or background Session generation. */
export type SessionTargetContext = ActiveSessionContext;

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
  | "system.rehydrate"
  | "system.shutdown"
  | "provider.list"
  | "provider.setEnabled"
  | "provider.save"
  | "provider.remove"
  | "provider.fetchModels"
  | "provider.checkConnection"
  | "provider.authStatus"
  | "provider.loginStart"
  | "provider.loginRespond"
  | "provider.loginCancel"
  | "provider.logout"
  | "provider.builtinModels"
  | "provider.setBuiltinModels"
  | "session.searchAll"
  | "package.catalog"
  | "extensionUi.configure";
export type WorkspaceOnlyMethod =
  | "workspace.setCurrent"
  | "workspace.getCurrent"
  | "workspace.searchFiles"
  | "workspace.listDirectory"
  | "workspace.setDirectoryWatches"
  | "git.getStatus"
  | "git.setWatching"
  | "git.getDiff"
  | "git.mutateHunk"
  | "git.stage"
  | "git.stageAll"
  | "git.unstage"
  | "git.unstageAll"
  | "git.discard"
  | "git.commit"
  | "git.listBranches"
  | "git.createBranch"
  | "git.switchBranch"
  | "git.listHistory"
  | "git.getCommitDiff"
  | "session.list"
  | "session.archive"
  | "session.restore"
  | "session.delete"
  | "session.cleanupArchived"
  | "session.getSnapshot"
  | "session.rename"
  | "session.usageReport"
  | "package.list"
  | "package.checkUpdates";
export type NullableSessionMethod = "session.create" | "session.open";
export type ActiveSessionMethod =
  | "attachment.create"
  | "attachment.createText"
  | "attachment.get"
  | "attachment.remove"
  | "session.setName"
  | "session.reload"
  | "session.getEntries"
  | "session.getTree"
  | "session.getStats"
  | "session.getForkPoints"
  | "session.fork"
  | "session.export"
  | "session.getCommands"
  | "agent.prompt"
  | "agent.steer"
  | "agent.followUp"
  | "agent.abort"
  | "agent.clearQueue"
  | "agent.setQueue"
  | "agent.runNow"
  | "agent.compact"
  | "agent.abortCompaction"
  | "agent.navigateTree"
  | "agent.setAutoCompaction"
  | "agent.setAutoRetry"
  | "agent.abortRetry"
  | "agent.getTools"
  | "model.list"
  | "model.setCurrent"
  | "model.setThinkingLevel";
export type SessionTargetMethod =
  "extensionUi.respond" | "extensionUi.customInput" | "extensionUi.customResize";
export type ToolMutationMethod = "agent.setActiveTools";
export type SessionPackageMethod =
  | "package.install"
  | "package.remove"
  | "package.update"
  | "package.updateAll"
  | "package.reloadResources"
  | "resource.setPreference"
  | "resource.setPreferences";

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
          : M extends SessionTargetMethod
            ? SessionTargetContext
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
  | "sessionTarget"
  | "toolMutation"
  | "workspacePackage"
  | "sessionPackage";

export const METHOD_CONTEXT_SCOPE: Record<HostMethod, MethodContextScope> = {
  "system.hello": "empty",
  "system.getStatus": "host",
  "system.rehydrate": "host",
  "system.shutdown": "host",
  "workspace.setCurrent": "workspace",
  "workspace.getCurrent": "workspace",
  "workspace.searchFiles": "workspace",
  "workspace.listDirectory": "workspace",
  "workspace.setDirectoryWatches": "workspace",
  "git.getStatus": "workspace",
  "git.setWatching": "workspace",
  "git.getDiff": "workspace",
  "git.mutateHunk": "workspace",
  "git.stage": "workspace",
  "git.stageAll": "workspace",
  "git.unstage": "workspace",
  "git.unstageAll": "workspace",
  "git.discard": "workspace",
  "git.commit": "workspace",
  "git.listBranches": "workspace",
  "git.createBranch": "workspace",
  "git.switchBranch": "workspace",
  "git.listHistory": "workspace",
  "git.getCommitDiff": "workspace",
  "attachment.create": "activeSession",
  "attachment.createText": "activeSession",
  "attachment.get": "activeSession",
  "attachment.remove": "activeSession",
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
  "session.rename": "workspace",
  "session.getEntries": "activeSession",
  "session.getTree": "activeSession",
  "session.getStats": "activeSession",
  "session.getForkPoints": "activeSession",
  "session.fork": "activeSession",
  "session.export": "activeSession",
  "session.usageReport": "workspace",
  "session.searchAll": "host",
  "session.getCommands": "activeSession",
  "agent.prompt": "activeSession",
  "agent.steer": "activeSession",
  "agent.followUp": "activeSession",
  "agent.abort": "sessionTarget",
  "agent.clearQueue": "activeSession",
  "agent.setQueue": "activeSession",
  "agent.runNow": "activeSession",
  "agent.compact": "activeSession",
  "agent.abortCompaction": "sessionTarget",
  "agent.navigateTree": "activeSession",
  "agent.setAutoCompaction": "activeSession",
  "agent.setAutoRetry": "activeSession",
  "agent.abortRetry": "sessionTarget",
  "agent.getTools": "activeSession",
  "agent.setActiveTools": "toolMutation",
  "provider.list": "host",
  "provider.setEnabled": "host",
  "provider.save": "host",
  "provider.remove": "host",
  "provider.fetchModels": "host",
  "provider.checkConnection": "host",
  "provider.authStatus": "host",
  "provider.loginStart": "host",
  "provider.loginRespond": "host",
  "provider.loginCancel": "host",
  "provider.logout": "host",
  "provider.builtinModels": "host",
  "provider.setBuiltinModels": "host",
  "model.list": "activeSession",
  "model.setCurrent": "activeSession",
  "model.setThinkingLevel": "activeSession",
  "package.list": "workspace",
  "package.catalog": "host",
  "package.install": "sessionPackage",
  "package.remove": "sessionPackage",
  "package.checkUpdates": "workspace",
  "package.update": "sessionPackage",
  "package.updateAll": "sessionPackage",
  "package.getResources": "workspacePackage",
  "package.reloadResources": "sessionPackage",
  "resource.setPreference": "sessionPackage",
  "resource.setPreferences": "sessionPackage",
  "extensionUi.configure": "host",
  "extensionUi.respond": "sessionTarget",
  "extensionUi.customInput": "sessionTarget",
  "extensionUi.customResize": "sessionTarget",
};
