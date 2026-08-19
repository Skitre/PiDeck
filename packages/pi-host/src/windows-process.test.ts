import { spawn } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { terminateWindowsProcessTree, windowsTaskkillExecutable } from "./windows-process.js";

describe("windows process helpers", () => {
  it("resolves taskkill through SystemRoot\\System32", () => {
    expect(
      windowsTaskkillExecutable({
        SystemRoot: "D:\\Windows",
        PATH: join("C:", "no-system32"),
      }),
    ).toBe(join("D:", "Windows", "System32", "taskkill.exe"));
  });

  it("does not throw when the child has no pid", () => {
    expect(() => terminateWindowsProcessTree({ pid: undefined } as never)).not.toThrow();
  });

  it("falls back to child.kill when taskkill cannot be spawned", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 50)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    try {
      terminateWindowsProcessTree(child, join("C:", "missing-windows-root", "taskkill.exe"));
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("child was not killed after taskkill fallback")),
          5_000,
        );
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    } finally {
      try {
        child.kill();
      } catch {
        /* already dead */
      }
    }
  });
});
