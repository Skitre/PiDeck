import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PI_SDK_PACKAGES,
  PRODUCT_VERSION_PATHS,
  assertPiPackageTree,
  assertProductVersionsEqual,
  assertReleaseProductionManifest,
  assertReleaseSdkEvidence,
  assertThirdPartyNotices,
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

test("requires THIRD_PARTY_NOTICES to name the verified Pi SDK family and pin", () => {
  const evidence = loadReleaseSdkEvidence(root);
  assertThirdPartyNotices(root, evidence.packages, evidence.sdkVersion);
});

test("requires every product version file to match the root package.json", () => {
  const version = assertProductVersionsEqual(root);
  assert.equal(typeof version, "string");
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.equal(PRODUCT_VERSION_PATHS.length, 7);
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

const TELEMETRY_PACKAGE = "@earendil-works/pi-telemetry";

function writeManifest(dir, name, version) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version }));
}

function fixturePackages(version) {
  return Object.fromEntries(PI_SDK_PACKAGES.map((name) => [name, version]));
}

function writeFamilyExceptTelemetry(hostRoot, version) {
  for (const packageName of PI_SDK_PACKAGES) {
    if (packageName === TELEMETRY_PACKAGE) continue;
    writeManifest(join(hostRoot, "node_modules", ...packageName.split("/")), packageName, version);
  }
}

test("resolves pi-telemetry through a reachable pi-ai node_modules link", () => {
  const hostRoot = mkdtempSync(join(tmpdir(), "pideck-sdk-tree-reachable-"));
  try {
    const version = "0.84.2";
    writeFamilyExceptTelemetry(hostRoot, version);
    writeManifest(
      join(
        hostRoot,
        "node_modules",
        "@earendil-works",
        "pi-ai",
        "node_modules",
        ...TELEMETRY_PACKAGE.split("/"),
      ),
      TELEMETRY_PACKAGE,
      version,
    );
    const versions = assertPiPackageTree(
      hostRoot,
      { packages: fixturePackages(version) },
      "reachable fixture",
    );
    assert.equal(versions[TELEMETRY_PACKAGE], version);
  } finally {
    rmSync(hostRoot, { recursive: true, force: true });
  }
});

test("rejects a pnpm store entry that is not reachable from Host dependencies", () => {
  const hostRoot = mkdtempSync(join(tmpdir(), "pideck-sdk-tree-orphan-"));
  try {
    const version = "0.84.2";
    writeFamilyExceptTelemetry(hostRoot, version);
    writeManifest(
      join(
        hostRoot,
        "node_modules",
        ".pnpm",
        "@earendil-works+pi-telemetry@0.84.2",
        "node_modules",
        ...TELEMETRY_PACKAGE.split("/"),
      ),
      TELEMETRY_PACKAGE,
      version,
    );
    assert.throws(
      () =>
        assertPiPackageTree(
          hostRoot,
          { packages: fixturePackages(version) },
          "orphan store fixture",
        ),
      /missing @earendil-works\/pi-telemetry/,
    );
  } finally {
    rmSync(hostRoot, { recursive: true, force: true });
  }
});
