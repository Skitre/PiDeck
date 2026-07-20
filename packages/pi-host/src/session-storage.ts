import { join, resolve as pathResolve } from "node:path";

export function sessionStorageDirs(agentDir: string, cwd: string): {
  activeDir: string;
  archiveDir: string;
} {
  const resolvedCwd = pathResolve(cwd);
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const activeDir = join(pathResolve(agentDir), "sessions", safePath);
  return { activeDir, archiveDir: join(activeDir, ".archive") };
}
