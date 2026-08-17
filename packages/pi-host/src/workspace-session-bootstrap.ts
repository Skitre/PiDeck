import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { logger } from "./logger.js";

export type WorkspaceSessionBootstrap = {
  sessionPath?: string;
  continueRecent?: boolean;
};

export function sessionPathsEqual(left: string | undefined, right: string): boolean {
  if (!left) return false;
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  return process.platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

/**
 * Startup preload should reopen the last Session instead of minting an empty
 * one. Interactive workspace switches keep creating a fresh Session.
 *
 * `SessionManager.open(path, undefined, cwdOverride)` does not check the file
 * header cwd, so a stale lastSessionPath from another Workspace must be
 * rejected the same way interactive `session.open` does: only paths returned
 * by `SessionManager.list(canonicalCwd)` are eligible.
 */
export async function createWorkspaceSessionManager(
  canonicalCwd: string,
  bootstrap: WorkspaceSessionBootstrap = {},
): Promise<SessionManager> {
  if (bootstrap.sessionPath) {
    try {
      if (existsSync(bootstrap.sessionPath)) {
        const listed = await SessionManager.list(canonicalCwd);
        const match = listed.find((session) =>
          sessionPathsEqual(session.path, bootstrap.sessionPath!),
        );
        if (match) {
          return SessionManager.open(bootstrap.sessionPath, undefined, canonicalCwd);
        }
        logger.warn("preload session path is not in the current workspace", {
          sessionPath: bootstrap.sessionPath,
        });
      } else {
        logger.warn("preload session path is missing", { sessionPath: bootstrap.sessionPath });
      }
    } catch (err) {
      logger.warn("preload session open failed", {
        sessionPath: bootstrap.sessionPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (bootstrap.continueRecent) {
    return SessionManager.continueRecent(canonicalCwd);
  }
  return SessionManager.create(canonicalCwd);
}
