# Release (Windows 11 x64)

> **Deferred during initial development.** The automated release commands and
> workflows described below are not currently present. Use
> `pnpm package:release` for development installer candidates. Restore and
> revalidate this design near the first public release.

## Status

**P0 Not Complete.** The current definition is [P0 scope and verification](./p0-scope.md).
No current clean-checkout core evidence bundle has closed the gate.

Security history: the July 17, 2026 setup artifact with SHA-256 `b0cb4c51feee1df8c6f32c2a383193428fcd9a6da075be0d41ef5a652a0caba2` was quarantined — its outer PE was wrapped by the "Synaptics" EXE-infector worm that was active on the build machine (see `artifacts/security/INSTALLER_INCIDENT_2026-07-17.json`). The machine was disinfected on 2026-07-19; freshly built installers have since passed `windows-installer-integrity.mjs` cleanly in consecutive `package:release` runs. Evidence from the quarantined artifact remains invalid.

Remaining before P0 can be claimed:

1. Run the new settings durability and visible error-center source tests through
   `pnpm verify:p0`.
2. Produce one same-run `pnpm verify:release` core result with a real commit,
   `dirty:false`, `candidateBound:true`, and `p0Complete:true`.
3. Keep `pnpm verify:release:full` green before a release candidate that claims
   the expanded Package/Extension regression profile.
4. Add Authenticode signing and verification before public distribution; this
   depends on a code-signing certificate.

`pnpm spike:sidecar` and `pnpm smoke:release-host` are development diagnostics.
The full profile runs the M0 staged-Host proof in direct-only mode; its
core-superset full E2E supplies the packaged desktop Extension UI proof without
starting a separate M0 desktop process.

## Verification profiles

| Command | Purpose |
|---|---|
| `pnpm verify:quick` | Local docs, type, unit, and Host integration feedback |
| `pnpm verify:p0` | Pull-request source/core gate, including production build and Rust tests |
| `pnpm verify:release` | Core NSIS, deterministic chat/tool/abort/rehydrate E2E, installed smoke, provenance |
| `pnpm verify:release:full` | Core-superset flow plus direct M0 and expanded local/npm/git Package and Extension UI regression |

The release orchestrator writes `verify-release.json`. Core and full artifacts
carry an explicit `profile`; evidence from one profile cannot satisfy the
other profile's candidate binding.

Each gate writes to its own run directory, including mode-specific E2E JSON and
screenshots. Child output is streamed to the terminal and evidence log, a
30-second heartbeat reports elapsed time, and every expensive gate has a
bounded timeout. Full runs one candidate full desktop and one installed full
desktop; each full workflow includes the core chat/tool/abort/rehydrate steps.

## CI ownership

- `.github/workflows/p0.yml` runs `verify:p0` on GitHub-hosted Windows for PRs
  and `main`; it never receives release credentials.
- `.github/workflows/release.yml` runs core release verification manually or
  for `v*` tags in the protected `pideck-release` environment.
- `.github/workflows/nightly.yml` runs the full profile nightly.

Nightly uses the protected `pideck-release` runner label but does not enter the
manually approved release environment or receive release credentials. This
keeps scheduled regression unattended while tag/manual release jobs remain
approval-gated.

Release workflows require a self-hosted Windows x64 runner with the custom
label `pideck-release`. Use a disposable VM or restore a clean snapshot after
each run. Do not attach that label to a runner that executes untrusted PR code.

## Architecture

Release build ships:

1. Tauri app binary / NSIS primary installer
2. Controlled Node runtime (full distribution, not only `node.exe`) under app resources
3. Production-staged Pi Host with lockfile-derived `node_modules` (compacted to `node_modules.zip` + bootstrap) and SDK `0.80.7`
4. Pinned Portable Git for git Package sources

Staging is pinned by `scripts/release-runtime.lock.json`; `resources/pi-host/STAGING.json` records staging evidence per run.

## Build (candidate)

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm package:release   # stages runtime, builds Tauri release, NSIS installer, integrity checks
```

`package:release` prints elapsed time for each major stage. The staged Host's
`STAGING.json` also records `stageTimingsMs`. After pnpm dependencies are
hoisted as real top-level packages and import-probed, the redundant `.pnpm`
virtual store is removed before compression. Installer discovery is bounded
to Tauri's `bundle/nsis` and `bundle/msi` outputs rather than recursively
walking the release/resource tree. These optimizations do not weaken the
candidate hash, packaged-resource, installed-smoke, or E2E gates.

Inside `verify:release`, packaging reuses the JavaScript build produced by the
immediately preceding `verify:p0` only when the supplied commit equals a clean
HEAD and the required Protocol/Host outputs exist. Standalone packaging, a
run without that attestation performs the normal build; an attested commit
mismatch, dirty tree, or missing output fails closed instead of reusing stale
files.

Rust **debug** may fall back to monorepo `packages/pi-host/dist` and system Node.
**Release** builds must not fall back to monorepo/global Node; environment gaps fail closed.

## Smoke checklist

- [ ] App starts without global Node on PATH (bundled runtime)
- [ ] Host ready shows SDK `0.80.7`
- [ ] Fixture TS Extension handler runs under staged/release packaging
- [ ] Exit leaves no orphan Host processes
- [ ] Package install finds bundled npm/git strategy

The npm/git and Extension UI checks are full-profile requirements. The core
profile still validates the bundled runtime layout and a local Pi SDK chat/tool
path through the installed application.

## Logs / diagnostics

- Host structured logs: process stderr  
- Desktop: OS app log dir (Tauri)  

## Rollback

Keep previous installer. Agent data lives in user `agentDir` (not inside app bundle).
