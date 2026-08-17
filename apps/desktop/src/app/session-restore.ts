const STARTUP_RESTORE_REASONS = new Set(["host ready", "bootstrap hello"]);

export function shouldRestoreLastSession(args: {
  reason: string;
  restoreLastSession: boolean;
  lastSessionPath?: string | null;
  lastWorkspace?: string | null;
  currentWorkspacePath?: string | null;
  currentSessionPath?: string | null;
}): boolean {
  if (!args.restoreLastSession) return false;
  if (!STARTUP_RESTORE_REASONS.has(args.reason)) return false;
  if (!args.lastSessionPath) return false;
  if (args.currentSessionPath === args.lastSessionPath) return false;
  if (
    args.lastWorkspace &&
    args.currentWorkspacePath &&
    args.lastWorkspace !== args.currentWorkspacePath
  ) {
    return false;
  }
  return true;
}
