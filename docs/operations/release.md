# Release (Windows 11 x64)

## Status

**Not Complete — one full green `pnpm verify:release` still outstanding.**

Security history: the July 17, 2026 setup artifact with SHA-256 `b0cb4c51feee1df8c6f32c2a383193428fcd9a6da075be0d41ef5a652a0caba2` was quarantined — its outer PE was wrapped by the "Synaptics" EXE-infector worm that was active on the build machine (see `artifacts/security/INSTALLER_INCIDENT_2026-07-17.json`). The machine was disinfected on 2026-07-19; freshly built installers have since passed `windows-installer-integrity.mjs` cleanly in consecutive `package:release` runs. Evidence from the quarantined artifact remains invalid.

Remaining before release can be claimed:

1. A same-run `pnpm verify:release` that exits 0 end-to-end (docs → typecheck → build → test → rust → package:release → m0 → e2e → smoke:release → git metadata → candidate binding) with a real commit SHA and `dirty:false`. As of 2026-07-19 the first five gates and `package:release` are green; m0/e2e/smoke gate defects found on 2026-07-19 are fixed (confirm-dialog revision race, e2e window locator, smoke npm probe) but not yet validated by a complete run.
2. Authenticode signing (blocked on a code-signing certificate).

`pnpm spike:sidecar` and `pnpm smoke:release-host` are **development diagnostics**, not sole M0/M6 acceptance.
M0 hard gate: `pnpm verify:m0-release-extension`. Full release: `pnpm verify:release` per [release-checklist.md](./release-checklist.md).

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

Rust **debug** may fall back to monorepo `packages/pi-host/dist` and system Node.
**Release** builds must not fall back to monorepo/global Node; environment gaps fail closed.

## Smoke checklist

- [ ] App starts without global Node on PATH (bundled runtime)
- [ ] Host ready shows SDK `0.80.7`
- [ ] Fixture TS Extension handler runs under staged/release packaging
- [ ] Exit leaves no orphan Host processes
- [ ] Package install finds bundled npm/git strategy

## Logs / diagnostics

- Host structured logs: process stderr  
- Desktop: OS app log dir (Tauri)  

## Rollback

Keep previous installer. Agent data lives in user `agentDir` (not inside app bundle).
