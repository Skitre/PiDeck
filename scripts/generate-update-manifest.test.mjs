import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  aggregateRelease,
  buildUpdateManifest,
  normalizedReleaseNames,
} from "./generate-update-manifest.mjs";
import {
  releaseRuntimeTargetKey,
  resolveReleaseRuntimeTarget,
  stagedNpmProbe,
  updaterPlatformKey,
} from "./release-runtime-target.mjs";

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

const base = {
  tag: "v0.1.1",
  version: "0.1.1",
  repo: "Skitre/PiDeck",
  publishedAt: "2026-08-01T00:00:00.000Z",
};

test("builds a cross-platform static updater manifest", () => {
  const manifest = buildUpdateManifest({
    ...base,
    artifacts: [
      {
        updaterPlatform: "windows-x86_64",
        updaterName: "PiDeck_0.1.1_x64-setup.exe",
        signature: "windows-signature",
      },
      {
        updaterPlatform: "darwin-aarch64",
        updaterName: "PiDeck_0.1.1_aarch64.app.tar.gz",
        signature: "arm-signature",
      },
      {
        updaterPlatform: "darwin-x86_64",
        updaterName: "PiDeck_0.1.1_x64.app.tar.gz",
        signature: "intel-signature",
      },
    ],
  });
  assert.deepEqual(manifest, {
    version: "0.1.1",
    pub_date: "2026-08-01T00:00:00.000Z",
    platforms: {
      "windows-x86_64": {
        signature: "windows-signature",
        url: "https://github.com/Skitre/PiDeck/releases/download/v0.1.1/PiDeck_0.1.1_x64-setup.exe",
      },
      "darwin-aarch64": {
        signature: "arm-signature",
        url: "https://github.com/Skitre/PiDeck/releases/download/v0.1.1/PiDeck_0.1.1_aarch64.app.tar.gz",
      },
      "darwin-x86_64": {
        signature: "intel-signature",
        url: "https://github.com/Skitre/PiDeck/releases/download/v0.1.1/PiDeck_0.1.1_x64.app.tar.gz",
      },
    },
  });
});

test("normalizes macOS artifact names so architectures cannot collide", () => {
  assert.deepEqual(
    normalizedReleaseNames({
      version: "0.1.1",
      platform: "darwin",
      arch: "arm64",
      primaryName: "PiDeck.dmg",
    }),
    {
      primary: "PiDeck_0.1.1_aarch64.dmg",
      updater: "PiDeck_0.1.1_aarch64.app.tar.gz",
    },
  );
  assert.deepEqual(
    normalizedReleaseNames({
      version: "0.1.1",
      platform: "darwin",
      arch: "x64",
      primaryName: "PiDeck.dmg",
    }),
    {
      primary: "PiDeck_0.1.1_x64.dmg",
      updater: "PiDeck_0.1.1_x64.app.tar.gz",
    },
  );
});

test("maps every supported runtime target to the matching updater platform", () => {
  const lock = {
    node: { version: "24.18.0" },
    git: { portable: { version: "2.51.0" } },
    targets: {
      "darwin-arm64": {
        platform: "darwin",
        arch: "arm64",
        node: { version: "24.18.0" },
        git: { strategy: "system-required" },
      },
      "darwin-x64": {
        platform: "darwin",
        arch: "x64",
        node: { version: "24.18.0" },
        git: { strategy: "system-required" },
      },
    },
  };
  assert.equal(releaseRuntimeTargetKey("win32", "x64"), "win32-x64");
  assert.equal(resolveReleaseRuntimeTarget(lock, "win32", "x64").stagedNodeExecutable, "node.exe");
  assert.equal(updaterPlatformKey("win32", "x64"), "windows-x86_64");
  assert.equal(resolveReleaseRuntimeTarget(lock, "darwin", "arm64").stagedNodeExecutable, "node");
  assert.equal(updaterPlatformKey("darwin", "arm64"), "darwin-aarch64");
  assert.equal(resolveReleaseRuntimeTarget(lock, "darwin", "x64").stagedNpmExecutable, "npm");
  assert.equal(updaterPlatformKey("darwin", "x64"), "darwin-x86_64");
  assert.throws(
    () => releaseRuntimeTargetKey("linux", "x64"),
    /unsupported release runtime target/,
  );
});

test("probes Windows npm through staged Node instead of spawning npm.cmd", () => {
  const runtimeTarget = resolveReleaseRuntimeTarget(
    { node: { version: "24.18.0" }, git: { portable: {} } },
    "win32",
    "x64",
  );
  const probe = stagedNpmProbe(runtimeTarget, "C:\\pideck\\node");
  assert.match(probe.executable, /node\.exe$/u);
  assert.match(probe.args[0], /node_modules[/\\]npm[/\\]bin[/\\]npm-cli\.js$/u);
  assert.equal(probe.args[1], "--version");
  assert.notEqual(probe.executable, "npm.cmd");
});

test("refuses mismatched tags, duplicate platforms, and empty signatures", () => {
  const artifact = {
    updaterPlatform: "windows-x86_64",
    updaterName: "PiDeck.exe",
    signature: "signature",
  };
  assert.throws(
    () => buildUpdateManifest({ ...base, tag: "v0.2.0", artifacts: [artifact] }),
    /does not match the packaged app version/,
  );
  assert.throws(
    () => buildUpdateManifest({ ...base, tag: "v0.2.0", version: "0.2.1", artifacts: [artifact] }),
    /does not match the packaged app version/,
  );
  const accepted = buildUpdateManifest({
    ...base,
    tag: "v0.2.1",
    version: "0.2.1",
    artifacts: [artifact],
  });
  assert.equal(accepted.version, "0.2.1");
  assert.match(accepted.platforms["windows-x86_64"].url, /releases\/download\/v0\.2\.1\//);
  assert.throws(
    () => buildUpdateManifest({ ...base, artifacts: [artifact, artifact] }),
    /duplicate updater platform/,
  );
  assert.throws(
    () => buildUpdateManifest({ ...base, artifacts: [{ ...artifact, signature: " " }] }),
    /signature is empty/,
  );
});

test("aggregates isolated platform artifacts without overwriting assets", () => {
  const root = mkdtempSync(join(tmpdir(), "pideck-release-aggregate-"));
  try {
    const input = join(root, "input");
    const output = join(root, "output");
    const fixtures = [
      {
        updaterPlatform: "windows-x86_64",
        platform: "win32",
        arch: "x64",
        primaryName: "PiDeck_0.1.1_x64-setup.exe",
        updaterName: "PiDeck_0.1.1_x64-setup.exe",
      },
      {
        updaterPlatform: "darwin-aarch64",
        platform: "darwin",
        arch: "arm64",
        primaryName: "PiDeck_0.1.1_aarch64.dmg",
        updaterName: "PiDeck_0.1.1_aarch64.app.tar.gz",
      },
    ];
    for (const fixture of fixtures) {
      const directory = join(input, fixture.updaterPlatform);
      mkdirSync(directory, { recursive: true });
      const primaryContent = `primary:${fixture.updaterPlatform}`;
      const updaterContent =
        fixture.primaryName === fixture.updaterName
          ? primaryContent
          : `updater:${fixture.updaterPlatform}`;
      writeFileSync(join(directory, fixture.primaryName), primaryContent);
      if (fixture.primaryName !== fixture.updaterName) {
        writeFileSync(join(directory, fixture.updaterName), updaterContent);
      }
      const signatureName = `${fixture.updaterName}.sig`;
      const packageManifestName = `installer-manifest-${fixture.updaterPlatform}.json`;
      const signatureContent = `signature:${fixture.updaterPlatform}`;
      const packageManifestContent = "{}\n";
      writeFileSync(join(directory, signatureName), signatureContent);
      writeFileSync(join(directory, packageManifestName), packageManifestContent);
      const descriptorName = `release-platform-${fixture.updaterPlatform}.json`;
      writeFileSync(
        join(directory, descriptorName),
        JSON.stringify({
          schemaVersion: 1,
          tag: "v0.1.1",
          version: "0.1.1",
          ...fixture,
          primarySha256: sha256(primaryContent),
          updaterSha256: sha256(updaterContent),
          signatureName,
          signatureSha256: sha256(signatureContent),
          signature: signatureContent,
          packageManifestName,
          packageManifestSha256: sha256(packageManifestContent),
        }),
      );
    }

    const result = aggregateRelease({
      inputDir: input,
      outputDir: output,
      tag: "v0.1.1",
      repo: "Skitre/PiDeck",
      publishedAt: base.publishedAt,
    });
    assert.deepEqual(Object.keys(result.manifest.platforms).sort(), [
      "darwin-aarch64",
      "windows-x86_64",
    ]);
    assert.equal(
      JSON.parse(readFileSync(join(output, "installer-manifest.json"), "utf8")).version,
      "0.1.1",
    );
    for (const fixture of fixtures) {
      assert.equal(
        readFileSync(join(output, fixture.primaryName), "utf8"),
        `primary:${fixture.updaterPlatform}`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
