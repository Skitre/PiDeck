# P0 Remediation / Completion Report

> **Historical release-hardening record.** Release-grade automation is deferred
> during initial development, and commands described below are not currently
> available. Current scope lives in [P0 scope and verification](./p0-scope.md).

> **Status: P0 Not Complete**  
> Current scope: [P0 scope and verification](./p0-scope.md)
> Core and full release profiles and P0 implementation rows are source-ready,
> but current same-run verification evidence is not closed.
>
> Do not claim P0 without same-run core `verify-release.json` evidence with a
> real commit, `dirty:false`, `candidateBound:true`, and `p0Complete:true`.

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
| R8 | In progress | Profile-aware core/full WebView2 E2E + NSIS + installed smoke are in source; current-commit release evidence remains outstanding |
| P0 core | **Not Complete** | Source implementation is ready; exact-revision source gate and core release evidence remain outstanding |
| Full regression | **Not Complete** | No accepted current-commit `verify:release:full` evidence bundle |

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
pnpm verify:quick
pnpm verify:p0
pnpm verify:release
pnpm verify:release:full
```

Release packaging now records per-stage timings, avoids duplicate CI staging,
removes the redundant pnpm virtual store after verified hoisting, and limits
installer discovery to Tauri bundle directories. Runtime import probes plus
Host/core/full desktop gates remain authoritative after this optimization.
The release orchestrator also reuses the immediately preceding `verify:p0`
JavaScript build only when it is bound to the same clean commit.

The full profile is now a true core superset and uses two desktop launches:
one build-tree candidate and one installed candidate. M0 retains its distinct
staged-Host handler proof in direct-only mode. Per-gate result directories,
streamed logs, heartbeat output, timeouts, failure cleanup evidence, and
candidate-scoped process audits make long runs inspectable without weakening
the candidate boundary.

## Current verification state (2026-07-21)

Evidence completed before the workspace policy change remains useful as
historical diagnostics but cannot close the current source revision:

- the pre-policy `pnpm verify:p0` passed with Protocol 284, Desktop 167, Pi Host
  133, and Rust 29 tests;
- deterministic core desktop E2E passed in 51.6 s;
- M0 direct staged-Host proof passed in 59.2 s;
- a pre-policy-change candidate was packaged successfully (EXE
  `3a350eb245700728838502fb814d41fe200df4193a9afa3ab61a234c31e6ac53`,
  installer `c76aa73a4d4cb2fa64067b9e1bce8d84c0cefa21b8b843d657f92bb7bb18d371`).

That candidate's full E2E failed after the core path because the former trust
event exposed Project Package confirmation before `workspace.setTrust`
released `serviceGraphLock`, producing `SERVICE_GRAPH_BUSY`. The product now
defines workspace selection itself as authorization: trust protocol methods,
events, Host store/branches, desktop UI, and full-E2E trust steps have been
removed. Project Package mutations still require an executable-code
confirmation. An initial post-policy `pnpm verify:p0` passed in 110.4 s with
Protocol 276, Desktop 164, Pi Host 133, and Rust 29 tests. The final removal of
the vestigial `projectTrust` capability and trust-named test fixtures happened
after that run, so it is diagnostic evidence rather than an exact-revision
gate. A new source verification, packaged candidate, and release verification
run are still required.

Still outstanding after the workspace policy change:

- current exact-revision `pnpm verify:p0`;
- a newly packaged candidate followed by current M0/core/full desktop checks;
- installed `smoke:release:core` / `smoke:release:full`;
- clean-checkout `verify:release` / `verify:release:full`.

No full E2E result has yet exited 0 end to end.

## Residual blockers (blocking)

Historical note: 2026-07-19 runs proved packaging integrity but failed the then-current M0/E2E/smoke chain. Those defects were fixed, but the old artifacts do not satisfy the redefined profile-aware gates.

1. Build and verify the new core candidate, then run current HEAD through
   clean-checkout `pnpm verify:release` and accept only same-run evidence.
2. Run `pnpm verify:release:full` on the protected/nightly Windows runner.
3. Add Authenticode signing and verification when a certificate is available.
