import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Tauri rebuilds these during `cargo test`; they are not source revisions. */
const GENERATED_PATH_PREFIXES = ["apps/desktop/src-tauri/gen/"];

export function currentSourceCommit() {
  const head = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    shell: false,
    encoding: "utf8",
  });
  return head.status === 0 ? head.stdout.trim() || null : null;
}

export function unexpectedSourceChanges(porcelain) {
  if (typeof porcelain !== "string" || porcelain.trim() === "") return [];
  return porcelain
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => {
      const rawPath = line.length >= 3 ? line.slice(3) : line;
      const unquoted = rawPath.replace(/^"(.*)"$/u, "$1").replaceAll("\\", "/");
      const path = unquoted.includes(" -> ")
        ? unquoted.slice(unquoted.lastIndexOf(" -> ") + 4)
        : unquoted;
      return !GENERATED_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
    });
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
  const headCommit = head.status === 0 ? head.stdout.trim() : "";
  const dirty =
    status.status === 0 ? unexpectedSourceChanges(status.stdout) : ["<git status failed>"];
  const missingOutputs = requiredBuildOutputs.filter((file) => !existsSync(file));
  if (
    head.status !== 0 ||
    headCommit !== expected ||
    dirty.length > 0 ||
    missingOutputs.length > 0
  ) {
    throw new Error(
      [
        "PIDECK_VERIFIED_SOURCE_COMMIT does not match a clean HEAD with required build outputs",
        `expected ${expected}`,
        `HEAD ${headCommit || "<unavailable>"}`,
        dirty.length > 0 ? `source changes:\n${dirty.join("\n")}` : null,
        missingOutputs.length > 0 ? `missing ${missingOutputs.join(", ")}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return expected;
}
