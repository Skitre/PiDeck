import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

export function windowsTaskkillExecutable(source: NodeJS.ProcessEnv = process.env): string {
  const root = source.SystemRoot ?? source.SYSTEMROOT ?? "C:\\Windows";
  return join(root, "System32", "taskkill.exe");
}

export function terminateWindowsProcessTree(
  child: ChildProcess,
  taskkillExecutable = windowsTaskkillExecutable(),
): void {
  const pid = child.pid;
  if (!pid) return;
  const fallback = () => {
    try {
      child.kill();
    } catch {
      /* already dead */
    }
  };
  try {
    const killer = spawn(taskkillExecutable, ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      shell: false,
    });
    killer.once("error", fallback);
    killer.unref();
  } catch {
    fallback();
  }
}
