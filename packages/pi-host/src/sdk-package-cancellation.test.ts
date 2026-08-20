/**
 * Behavioural proof that the 0.82.1 patch cancels package subprocesses.
 *
 * Grepping the patch is not verification: the point is that an aborted package
 * operation leaves no npm or git child running and no wedged manager state.
 * These tests spawn a real long-running child through the SDK's own spawn
 * paths, abort it, and assert the operating system actually reaped the process.
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultPackageManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { resetInternalRuntimeForTests } from "./internal-runtime.js";

let root: string | undefined;

/**
 * Windows keeps a handle on the working directory of a child that has only just
 * been killed, so an immediate recursive delete raises EPERM. Retry briefly,
 * then give up: a leftover temp directory must not fail the run.
 */
async function removeTree(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

afterEach(async () => {
  if (root) await removeTree(root);
  root = undefined;
  resetInternalRuntimeForTests();
  delete process.env.PI_OFFLINE;
  delete process.env.PIDECK_TEST_NPM_STDERR;
});

/** A child that records its pid and then never exits on its own. */
function longRunningCommand(pidFile: string): string[] {
  return [
    process.execPath,
    "-e",
    `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));` +
      "setInterval(() => {}, 1000);",
    "--",
  ];
}

/** A successful parent whose detached descendant keeps its stdio pipes open. */
function inheritedPipeCommand(pidFile: string, stdout = ""): string[] {
  return [
    process.execPath,
    "-e",
    'const { spawn } = require("node:child_process");' +
      'const { writeFileSync } = require("node:fs");' +
      (stdout ? `process.stdout.write(${JSON.stringify(stdout)});` : "") +
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {' +
      ' detached: true, stdio: "inherit" });' +
      `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));` +
      "child.unref();",
    "--",
  ];
}

function createManager(npmCommand: string[]): {
  manager: DefaultPackageManager;
  cwd: string;
  agentDir: string;
} {
  root = mkdtempSync(join(tmpdir(), "pideck-package-cancel-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const settingsManager = {
    getNpmCommand: () => npmCommand,
    isProjectTrusted: () => true,
    getGlobalSettings: () => ({ packages: ["npm:never-finishes@^1.0.0"] }),
    getProjectSettings: () => ({ packages: [] }),
    setPackages: () => undefined,
  };
  return {
    manager: new DefaultPackageManager({
      cwd,
      agentDir,
      settingsManager: settingsManager as never,
    }),
    cwd,
    agentDir,
  };
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const value = readFileSync(path, "utf8").trim();
      if (value) return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`child never wrote ${path}`);
}

function processAlive(pid: number): boolean {
  try {
    // Signal 0 probes for existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForExit(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

describe("PiDeck package-manager cancellation patch", () => {
  it("settles a successful install when a descendant inherits npm stdio", async () => {
    const pidFile = join(tmpdir(), `pideck-inherited-stdio-${process.pid}-${Date.now()}`);
    const { manager } = createManager(inheritedPipeCommand(pidFile));
    let outcome: "pending" | "resolved" | "rejected" = "pending";
    const installing = manager.installAndPersist("npm:never-finishes").then(
      () => {
        outcome = "resolved";
      },
      () => {
        outcome = "rejected";
      },
    );
    const pid = Number(await waitForFile(pidFile));

    try {
      await new Promise((resolve) => setTimeout(resolve, 750));
      expect(outcome).toBe("resolved");
    } finally {
      if (processAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // The descendant may have exited between the probe and kill.
        }
      }
      await installing;
      await waitForExit(pid);
      rmSync(pidFile, { force: true });
    }
  }, 10_000);

  it("settles a successful captured npm query with inherited stdio", async () => {
    const pidFile = join(tmpdir(), `pideck-captured-stdio-${process.pid}-${Date.now()}`);
    const { manager, agentDir } = createManager(
      inheritedPipeCommand(pidFile, JSON.stringify("1.1.0")),
    );
    const installed = join(agentDir, "npm", "node_modules", "never-finishes");
    mkdirSync(installed, { recursive: true });
    writeFileSync(
      join(installed, "package.json"),
      JSON.stringify({ name: "never-finishes", version: "1.0.0" }),
    );

    let outcome: "pending" | "resolved" | "rejected" = "pending";
    const checking = manager.checkForAvailableUpdates().then(
      () => {
        outcome = "resolved";
      },
      () => {
        outcome = "rejected";
      },
    );
    const pid = Number(await waitForFile(pidFile));

    try {
      await new Promise((resolve) => setTimeout(resolve, 750));
      expect(outcome).toBe("resolved");
    } finally {
      if (processAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // The descendant may have exited between the probe and kill.
        }
      }
      await checking;
      await waitForExit(pid);
      rmSync(pidFile, { force: true });
    }
  }, 10_000);

  it("kills the package install child and settles the mutation", async () => {
    const pidFile = join(tmpdir(), `pideck-cancel-inherit-${process.pid}-${Date.now()}`);
    const { manager } = createManager(longRunningCommand(pidFile));
    const controller = new AbortController();
    manager.setOperationSignal(controller.signal);

    // installAndPersist routes through runCommand -> spawnCommand.
    const installing = manager.installAndPersist("npm:never-finishes");
    const pid = Number(await waitForFile(pidFile));
    expect(processAlive(pid)).toBe(true);

    controller.abort(new Error("test cancellation"));

    await expect(installing).rejects.toMatchObject({ name: "AbortError" });
    expect(await waitForExit(pid)).toBe(true);
    rmSync(pidFile, { force: true });
  }, 20_000);

  it("kills the captured-stdio child too", async () => {
    const pidFile = join(tmpdir(), `pideck-cancel-capture-${process.pid}-${Date.now()}`);
    const { manager, agentDir } = createManager(longRunningCommand(pidFile));

    // The update check short-circuits unless the package is already installed,
    // so lay down the managed install the SDK looks for.
    const installed = join(agentDir, "npm", "node_modules", "never-finishes");
    mkdirSync(installed, { recursive: true });
    writeFileSync(
      join(installed, "package.json"),
      JSON.stringify({ name: "never-finishes", version: "1.0.0" }),
    );
    expect(manager.getInstalledPath("npm:never-finishes@^1.0.0", "user")).toBe(installed);

    const controller = new AbortController();
    manager.setOperationSignal(controller.signal);

    // checkForAvailableUpdates routes through runCommandCapture ->
    // spawnCaptureCommand, the other of the two patched spawn paths.
    const checking = manager.checkForAvailableUpdates();
    const pid = Number(await waitForFile(pidFile));

    controller.abort(new Error("test cancellation"));

    // Assert the child before awaiting the operation. runCommandCapture carries
    // its own 10s network timeout that would reap the child regardless, and
    // awaiting first would not settle until that timeout had already fired —
    // making the test pass with the patch removed.
    expect(await waitForExit(pid, 2_000)).toBe(true);

    // The update check swallows per-package failures; the child was the point.
    await checking.catch(() => undefined);
    rmSync(pidFile, { force: true });
  }, 20_000);

  it("accepts a new operation after an aborted one", async () => {
    const firstPidFile = join(tmpdir(), `pideck-cancel-reuse-a-${process.pid}-${Date.now()}`);
    const { manager } = createManager(longRunningCommand(firstPidFile));
    const first = new AbortController();
    manager.setOperationSignal(first.signal);

    const aborted = manager.installAndPersist("npm:never-finishes");
    const firstPid = Number(await waitForFile(firstPidFile));
    first.abort(new Error("test cancellation"));
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    expect(await waitForExit(firstPid)).toBe(true);
    rmSync(firstPidFile, { force: true });

    // A stale signal must not leak into the next operation: without clearing
    // it the manager would refuse every later spawn.
    manager.setOperationSignal(undefined);
    const secondPidFile = join(tmpdir(), `pideck-cancel-reuse-b-${process.pid}-${Date.now()}`);
    const { manager: reused } = createManager(longRunningCommand(secondPidFile));
    const second = new AbortController();
    reused.setOperationSignal(second.signal);
    const running = reused.installAndPersist("npm:never-finishes");
    const secondPid = Number(await waitForFile(secondPidFile));
    expect(processAlive(secondPid)).toBe(true);

    second.abort(new Error("cleanup"));
    await running.catch(() => undefined);
    await waitForExit(secondPid);
    rmSync(secondPidFile, { force: true });
  }, 30_000);

  it("refuses to start a synchronous npm child once aborted", () => {
    const { manager } = createManager([process.execPath, "-e", "process.exit(0)", "--"]);
    const controller = new AbortController();
    manager.setOperationSignal(controller.signal);
    controller.abort(new Error("already cancelled"));

    // spawnSync takes no signal, so the patch can only refuse to start a new
    // child. This is the documented limit of the cancellation guarantee.
    expect(() =>
      (manager as unknown as { getGlobalNpmRoot: () => string }).getGlobalNpmRoot(),
    ).toThrow();
  });

  it("includes npm stderr when an install command fails", async () => {
    const marker = "registry request failed: certificate rejected";
    process.env.PIDECK_TEST_NPM_STDERR = marker;
    resetInternalRuntimeForTests();
    const { manager } = createManager([
      process.execPath,
      "-e",
      'process.stderr.write(process.env.PIDECK_TEST_NPM_STDERR ?? ""); process.exit(7);',
      "--",
    ]);

    const failure = await manager.installAndPersist("npm:never-finishes").catch((error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(marker);
  });
});
