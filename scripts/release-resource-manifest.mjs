import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertReleaseProductionManifest,
  assertReleaseSdkEvidence,
  loadReleaseSdkEvidence,
} from "./release-sdk-evidence.mjs";
import { resolveReleaseRuntimeTarget } from "./release-runtime-target.mjs";

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function criticalReleaseResourcePaths(runtimeTarget) {
  const platformResources = [
    `node/${runtimeTarget.stagedNodeExecutable}`,
    `node/${runtimeTarget.stagedNpmExecutable}`,
    "node/RUNTIME.json",
    "git/RUNTIME.json",
  ];
  if (runtimeTarget.platform === "win32") {
    const portableGitFiles = runtimeTarget.git?.portable?.expectedFiles ?? [];
    if (portableGitFiles.length === 0) {
      throw new Error("release-runtime lock portable Git expectedFiles is empty");
    }
    platformResources.push(
      "node/node_modules/npm/package.json",
      ...portableGitFiles.map((file) => `git/${file}`),
    );
  } else {
    platformResources.push("node/lib/node_modules/npm/package.json");
  }
  return [
    ...platformResources,
    "pi-host/main.js",
    "pi-host/host-main.js",
    "pi-host/package.json",
    "pi-host/STAGING.json",
    "pi-host/node_modules.zip",
    "pi-host/NODE_MODULES_LINKS.json",
    "pi-host/NODE_MODULES_GRAPH.json",
    "pi-host/portable-node-modules.mjs",
    "pi-host/pi-host-bootstrap-runtime.mjs",
  ];
}

export function writeReleaseResourceManifest(root, resourceDir) {
  const runtimeLock = JSON.parse(
    readFileSync(join(root, "scripts/release-runtime.lock.json"), "utf8"),
  );
  const runtimeTarget = resolveReleaseRuntimeTarget(runtimeLock);
  const sdkEvidence = loadReleaseSdkEvidence(root, runtimeLock);
  const staging = JSON.parse(readFileSync(join(resourceDir, "pi-host", "STAGING.json"), "utf8"));
  assertReleaseSdkEvidence(staging.sdkEvidence, sdkEvidence, "STAGING SDK evidence");
  const protocolVersion = JSON.parse(
    readFileSync(join(root, "packages/protocol/package.json"), "utf8"),
  ).version;
  const releaseHostManifest = JSON.parse(
    readFileSync(join(resourceDir, "pi-host/package.json"), "utf8"),
  );
  assertReleaseProductionManifest(
    releaseHostManifest,
    sdkEvidence,
    { "@pideck/protocol": protocolVersion },
    "staged release Host manifest",
  );
  const files = criticalReleaseResourcePaths(runtimeTarget).map((relativePath) => {
    const path = join(resourceDir, ...relativePath.split("/"));
    if (!existsSync(path)) throw new Error(`critical release resource missing: ${relativePath}`);
    const stat = statSync(path);
    return { path: relativePath, sha256: sha256File(path), size: stat.size };
  });
  const gitRuntime = JSON.parse(readFileSync(join(resourceDir, "git/RUNTIME.json"), "utf8"));
  const manifest = {
    schemaVersion: 5,
    generatedAt: new Date().toISOString(),
    runtimeTarget: runtimeTarget.key,
    sdkVersion: sdkEvidence.sdkVersion,
    sdkEvidence,
    nodeVersion: runtimeTarget.node.version,
    nodeArchiveSha256: runtimeTarget.node.sha256,
    gitStrategy: runtimeTarget.git.strategy,
    gitVersion: gitRuntime.gitVersion ?? null,
    gitArchiveSha256: gitRuntime.archiveSha256 ?? null,
    pnpmLockSha256: runtimeLock.pnpmLock.sha256,
    files,
  };
  const path = join(resourceDir, "pi-host/RELEASE_RESOURCES.json");
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return { path, manifest, sha256: sha256File(path) };
}
