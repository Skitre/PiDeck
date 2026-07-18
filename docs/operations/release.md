# Release (Windows 11 x64)

## Status

**Not Complete. Security hold.** The July 17, 2026 setup artifact with SHA-256 `b0cb4c51feee1df8c6f32c2a383193428fcd9a6da075be0d41ef5a652a0caba2` was quarantined because its outer PE was not the generated NSIS image and contained rejected injector indicators. All release and installed-smoke evidence from that artifact is invalid. Rebuild only on a clean, reprovisioned Windows host; see `artifacts/security/INSTALLER_INCIDENT_2026-07-17.json`.  
Source staging (controlled Node/npm, Portable Git, NSIS pipeline, real desktop E2E/installed smoke scripts) exists; P0/M6 remains open until a clean-checkout same-run `pnpm verify:release` records a real commit SHA and fresh installer/E2E/smoke artifacts.  
`pnpm spike:sidecar` and `pnpm smoke:release-host` are **development diagnostics**, not sole M0/M6 acceptance.  
M0 hard gate: `pnpm verify:m0-release-extension` (R1). Full release: `pnpm package:release` + `pnpm smoke:release` (R8).

## Architecture

Release build should ship:

1. Tauri app binary / primary installer  
2. Controlled Node runtime (full distribution, not only `node.exe`) under app resources  
3. Production-staged Pi Host with lockfile-derived `node_modules` and SDK `0.80.7`  
4. Portable Git or documented offline git strategy for git Package sources  

## Current staging (interim)

```bash
pnpm install
pnpm build
pnpm package:sidecar:with-node   # interim; R1 replaces execPath copy with runtime lock
pnpm smoke:release-host          # hello only
# R1+:
# pnpm verify:m0-release-extension
```

Rust **debug** may fall back to monorepo `packages/pi-host/dist` and system Node.  
**Release** builds must not fall back to monorepo/global Node (R3/R8).

## Build (candidate)

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm package:sidecar:with-node
pnpm --filter @pi-desktop/desktop tauri:build
```

Primary installer target is documented in R8; WiX/NSIS environment gaps must fail closed with residual risk, not claim complete.

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
