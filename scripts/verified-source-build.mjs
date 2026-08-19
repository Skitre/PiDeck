import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function currentSourceCommit() {
  const head = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    shell: false,
    encoding: "utf8",
  });
  return head.status === 0 ? head.stdout.trim() || null : null;
}

export function verifiedSourceBuildCommit() {
  const expected = process.env.PIDECK_VERIFIED_SOURCE_COMMIT?.trim();
  if (!expected) return null;
  const head = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    shell: false,
    encoding: "utf8",
  });
  const status = spawnSync("git", ["status", "--porcelain"], {
    cwd: root,
    shell: false,
    encoding: "utf8",
  });
  const requiredBuildOutputs = [
    join(root, "packages", "protocol", "dist", "index.js"),
    join(root, "packages", "pi-host", "dist", "main.js"),
  ];
  if (
    head.status !== 0 ||
    head.stdout.trim() !== expected ||
    status.status !== 0 ||
    status.stdout.trim() !== "" ||
    !requiredBuildOutputs.every(existsSync)
  ) {
    throw new Error(
      "PIDECK_VERIFIED_SOURCE_COMMIT does not match a clean HEAD with required build outputs",
    );
  }
  return expected;
}
