# P0 Remediation / Completion Report

> **Status: P0 Not Complete**  
> R0–R8: source remediation advanced; gates not yet closed on a clean-checkout, commit-bound `pnpm verify:release`  
> M0–M6 / Windows primary installer: **Not Complete** until fresh same-run evidence exists  
>
> Do not claim release-ready without a same-run `pnpm verify:release` evidence directory that records a real commit SHA and `dirty:false`.

## Stage status (authoritative)

| Stage | Status | Notes |
|---|---|---|
| R0 | Partial | Docs no longer claim false completion; residual evidence gaps remain |
| R1 | Source ready | Frozen lock staging, compacted zip, controlled Node/npm, pinned Portable Git |
| R2 | Source ready | Deep method/event runtime schemas + HostClient parse |
| R3 | Source ready | Shutdown-after-cleanup, auto-restart epoch, reap tests |
| R4 | Source ready | Candidate-commit session/workspace + serviceGraphLock |
| R5/R6 | Source ready | Package disk fingerprint + Extension real loader path |
| R7 | Source ready | Epoch/rehydrate/sequence watermark + pending reject |
| R8 | In progress | Real Tauri WebView2 E2E + NSIS installer + installed-app smoke; gate defects found 2026-07-19 (confirm-dialog revision race, e2e window locator, smoke npm probe) are fixed but await a full-run pass |
| P0 / M0–M6 | **Not Complete** | No accepted clean-checkout `verify:release` with current scripts |

## C6 Extension proof (B-EXT-RUNTIME-01 / B-EXT-01)

- Integration test: `packages/pi-host/src/extension-ui.integration.test.ts`
- Path: `DefaultResourceLoader` (fixture under agentDir) → `createAgentSession` → `bindExtensions({ uiContext, mode: "rpc" })` → public `session.extensionRunner.emit({ type: "session_start", reason: "reload" })` → fixture handler writes marker via `ctx.ui`
- No manual fixture `import()` / direct handler invocation as success path
- `createExtensionUiContext` returns a fully typed `ExtensionUIContext` object (no whole-object `as unknown as ExtensionUIContext`)

## Evidence rejected or invalidated

The July 17, 2026 installer with SHA-256 `b0cb4c51feee1df8c6f32c2a383193428fcd9a6da075be0d41ef5a652a0caba2` is quarantined under `artifacts/security/quarantine/`. Its outer PE failed NSIS/product integrity checks: it was wrapped by the "Synaptics" EXE-infector worm active on the build machine at the time. The machine was disinfected on 2026-07-19; subsequent `package:release` runs (2026-07-19) produced installers that pass `windows-installer-integrity.mjs` cleanly. `PACKAGE_RELEASE.json` and the release manifest are fail-closed; no result from the quarantined installer can close P0. See `artifacts/security/INSTALLER_INCIDENT_2026-07-17.json`.

The following artifacts predate the current real desktop E2E / Portable Git / fail-closed smoke rewrites and must not close P0:

- `artifacts/p0/2026-07-17T05-04-59-814Z_nogit_verify-p0/` (`commit:null`, `nogit`)
- `artifacts/p0/2026-07-17T05-51-04-286Z_nogit_verify-p0/`
- `artifacts/p0/e2e-latest/e2e-results.json` with mode `host-driven-desktop-smoke`
- `artifacts/p0/release-latest/installed-smoke.json` with the retired `ETIMEDOUT` schema

## Gate commands

```text
pnpm verify:docs
pnpm typecheck && pnpm build && pnpm test
pnpm test:rust
pnpm package:release
pnpm verify:m0-release-extension
pnpm test:e2e
pnpm smoke:release
pnpm verify:release
```

## Residual blockers (blocking)

Progress note (2026-07-19): the repository now exists (github.com/Skitre/PiDeck, clean tree runs recorded); post-disinfection `verify:release` runs reached green through docs, typecheck, build, test, rust, and `package:release` (installer passes integrity). The runs failed at m0/e2e/smoke on gate defects that are now fixed in source: the project-trust confirm dialog was closed by trust-transition revision bumps before it could render, the e2e window-attach locator depended on Settings being open, and the smoke npm probe crashed spawning `npm.cmd` without a shell.

1. One complete same-run `pnpm verify:release` exiting 0 with commit SHA + `dirty:false`, producing fresh installer/E2E/smoke evidence under `artifacts/p0/<run-id>/`.
2. Expand real-window E2E coverage toward trust/chat/Extension/npm-git/crash workflows.
