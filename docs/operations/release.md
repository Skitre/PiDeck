# Release and Packaging

PiDeck does not currently provide a certified public installer. Source
development and release packaging are separate support levels:

| Platform | Source development | Development package | Public release |
|---|---|---|---|
| Windows 11 x64 | Supported | NSIS candidate | Not yet signed or accepted |
| Apple Silicon / Intel macOS | Supported for early testing | DMG candidate | Requires Developer ID + notarization |

The tracked implementation requirements in
[`p0-status.json`](./p0-status.json) are implemented, but `claimStatus` remains
`not-complete`. A passing `pnpm verify:p0` establishes source readiness; it is
not installer or release evidence.

## Windows Development Candidate

Run the following on Windows 11 x64:

```powershell
pnpm install --frozen-lockfile
pnpm package:release
```

`package:release` prepares and validates the bundled runtime, builds the
frontend and Tauri application, creates an NSIS installer, and applies the
repository's Windows installer-integrity checks. It writes candidate evidence
under `artifacts/p0/release-latest/`.

The candidate contains:

1. The Tauri desktop application and NSIS installer.
2. A pinned Windows x64 Node.js distribution.
3. The production Pi Host and Pi SDK dependency tree.
4. Pinned Portable Git for Git-based Package sources.

The exact runtime inputs are pinned by
[`scripts/release-runtime.lock.json`](../../scripts/release-runtime.lock.json).
The Pi SDK version is not duplicated in that runtime lock. It is derived from
the exact production dependencies in
[`packages/pi-host/package.json`](../../packages/pi-host/package.json), then
checked against `pnpm-lock.yaml`, the deployed dependency tree, and the staged
tree. `STAGING.json` and `RELEASE_RESOURCES.json` retain the four Pi package
versions together with the SDK patch and pnpm-lock SHA-256 values.
The runtime lock also pins native macOS arm64 and x64 Node distributions. macOS
uses the system Git executable and records its version as release evidence.

## Source Verification

Use the same source gates on Windows and macOS:

```bash
pnpm verify:quick
pnpm verify:p0
```

`verify:quick` checks documentation, types, and JavaScript/TypeScript tests.
`verify:p0` also builds the production frontend and runs Rust tests. GitHub
Actions currently runs `verify:p0` on `windows-2022`; Apple Silicon macOS has
also passed the command locally.

These commands do not install, sign, launch, or uninstall a packaged
candidate. They therefore cannot authorize a public-release claim.

## macOS Development Candidate

macOS can run the complete development application and build a native candidate with:

```bash
pnpm build
pnpm --filter @pideck/desktop run tauri:dev
pnpm package:release
```

`package:release` stages a pinned architecture-matched Node runtime, validates
the packaged Host, builds an app bundle and DMG, verifies the app signature and
DMG, and binds the `.app.tar.gz` updater artifact to its updater signature.

Without `APPLE_SIGNING_IDENTITY`, the command uses an ad-hoc signature. This is
appropriate only for a Draft Release or direct testing and can require manual
approval in macOS Privacy & Security. A public macOS release requires a
Developer ID Application certificate plus notarization credentials.

The tag-triggered release workflow builds Windows x64, macOS arm64, and macOS
x64 independently. It aggregates their accepted assets into one `latest.json`
and one GitHub Draft Release. The Apple credential set is all-or-nothing:
`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`,
`APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`, and `KEYCHAIN_PASSWORD`.

## Tracked Draft-Release Workflow

`.github/workflows/release.yml` checks out the release tag and records
`git rev-parse HEAD`. The Windows job runs `pnpm verify:p0` on that
revision (the same source gate as pull-request CI). macOS jobs run
`pnpm verify:quick && pnpm build`; they do not rerun the Windows-oriented
Rust lane. `cargo test` may rewrite tracked Tauri files under
`apps/desktop/src-tauri/gen/`; the workflow restores those files, and
`package:release` also ignores that generated prefix when checking that
the checkout still matches the recorded commit.
Then `pnpm package:release` runs with `PIDECK_VERIFIED_SOURCE_COMMIT` set
to the same HEAD. It fails closed if HEAD does not match, unexpected
source files changed, or the JavaScript build outputs are missing. The
resulting `PACKAGE_RELEASE.json` records `sourceCommit` and
`reusedSourceBuildCommit`.

This automation produces development candidates; it does not publish a
supported release and does not replace the installed-app smoke, signature
verification, or human acceptance requirements below.

## Public Release Requirements

Before publishing any installer as a supported release:

- Build from a clean, identified commit with locked dependencies.
- Run the source gate on that exact revision.
- Produce platform-native packaging and installed-app smoke evidence.
- Verify startup without global Node or Git dependencies and audit orphan
  processes after exit and uninstall.
- Sign and timestamp the installer, then verify the signature before accepting
  final hashes.
- Archive the evidence and update `p0-status.json` only after human acceptance.

For Windows, this requires Authenticode signing in addition to the current
integrity checks. For macOS, candidate packaging is implemented, but a public
release still requires Developer ID signing, notarization, and human install/
update acceptance on both architectures.

The deferred production checklist is preserved in
[release-checklist.md](./release-checklist.md). Historical hardening evidence
and invalidated candidates remain documented in
[remediation-report.md](./remediation-report.md); those records do not describe
the current command surface.

## Rollback and User Data

Keep the previously accepted installer when testing an update. PiDeck user data
lives in the configured Pi agent directory, not inside the application bundle.
Packaging and uninstall tests must never use a real user data directory.
