/**
 * Centralized temp agentDir / workspace helpers for Host tests.
 * Always sets PI_CODING_AGENT_DIR explicitly; cleans up on success or failure.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type TempAgentLayout = {
  root: string;
  agentDir: string;
  projectDir: string;
  cleanup: () => void;
};

export function createTempAgentLayout(prefix = "pideck-test-"): TempAgentLayout {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const agentDir = join(root, "agent");
  const projectDir = join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(agentDir, "auth.json"), "{}");
  writeFileSync(join(agentDir, "models.json"), "{}");
  writeFileSync(join(agentDir, "settings.json"), "{}");
  return {
    root,
    agentDir,
    projectDir,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

/** Env for spawning Host: always pin PI_CODING_AGENT_DIR. */
export function hostEnv(agentDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
  };
}
