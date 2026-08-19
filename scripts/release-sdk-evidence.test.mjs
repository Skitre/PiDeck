import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PI_SDK_PACKAGES,
  assertPiPackageTree,
  assertReleaseProductionManifest,
  assertReleaseSdkEvidence,
  deriveReleaseProductionDependencies,
  loadReleaseSdkEvidence,
} from "./release-sdk-evidence.mjs";
import { releaseRuntimeImportSpecifiers } from "./release-runtime-imports.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("derives complete SDK evidence from the Host manifest and pnpm lock", () => {
  const evidence = loadReleaseSdkEvidence(root);
  assert.deepEqual(Object.keys(evidence.packages), PI_SDK_PACKAGES);
  assert.equal(evidence.packages[evidence.sdkPackage], evidence.sdkVersion);
  assert.match(evidence.patch.sha256, /^[a-f0-9]{64}$/);
  assert.match(evidence.pnpmLock.sha256, /^[a-f0-9]{64}$/);
  assertPiPackageTree(join(root, "packages/pi-host"), evidence, "workspace dependency tree");
});

test("derives the release manifest from every Host production dependency", () => {
  const evidence = loadReleaseSdkEvidence(root);
  const protocolVersion = JSON.parse(
    readFileSync(join(root, "packages/protocol/package.json"), "utf8"),
  ).version;
  const dependencies = deriveReleaseProductionDependencies(evidence, {
    "@pideck/protocol": protocolVersion,
  });
  assert.deepEqual(
    Object.keys(dependencies),
    Object.keys(evidence.hostManifest.productionDependencies),
  );
  assertReleaseProductionManifest({ dependencies }, evidence, {
    "@pideck/protocol": protocolVersion,
  });
});

test("probes Node-safe runtime entries for every Host production dependency", () => {
  const evidence = loadReleaseSdkEvidence(root);
  const dependencyNames = Object.keys(evidence.hostManifest.productionDependencies);
  const specifiers = releaseRuntimeImportSpecifiers(evidence.hostManifest.productionDependencies);

  assert.equal(specifiers.length, dependencyNames.length);
  assert.deepEqual(
    specifiers,
    dependencyNames.map((name) =>
      name === "pdfjs-dist" ? "pdfjs-dist/legacy/build/pdf.mjs" : name,
    ),
  );
  assert.ok(!specifiers.includes("pdfjs-dist"));
});

test("requires bundled bash.exe in the Portable Git runtime contract", () => {
  const runtimeLock = JSON.parse(
    readFileSync(join(root, "scripts/release-runtime.lock.json"), "utf8"),
  );
  assert.deepEqual(runtimeLock.git.portable.expectedFiles, [
    "cmd/git.exe",
    "bin/git.exe",
    "bin/bash.exe",
  ]);
});

test("rejects drifted runtime-lock and staged evidence", () => {
  const evidence = loadReleaseSdkEvidence(root);
  const drifted = structuredClone(evidence);
  drifted.packages[PI_SDK_PACKAGES[0]] = "0.0.0";
  assert.throws(() => assertReleaseSdkEvidence(drifted, evidence), /SDK evidence mismatch/);

  const runtimeLock = JSON.parse(
    readFileSync(join(root, "scripts/release-runtime.lock.json"), "utf8"),
  );
  runtimeLock.pnpmLock.sha256 = "0".repeat(64);
  assert.throws(
    () => loadReleaseSdkEvidence(root, runtimeLock),
    /pnpm-lock\.yaml SHA-256 mismatch/,
  );

  const patchLock = JSON.parse(
    readFileSync(join(root, "scripts/release-runtime.lock.json"), "utf8"),
  );
  patchLock.hostProductionDeps.sdkPatchSha256 = "0".repeat(64);
  assert.throws(() => loadReleaseSdkEvidence(root, patchLock), /SDK patch SHA-256 mismatch/);
});
