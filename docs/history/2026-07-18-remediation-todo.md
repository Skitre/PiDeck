# 2026-07-18 Review Remediation TODO

Source: [Full review](./2026-07-18-full-review.md) · Second-round verification: [Round 2 review](./2026-07-18-review-round2.md)

This list uses verified scope and severity rather than copying the review labels verbatim.

## P0 - Runtime correctness

- [x] Stop holding the Rust host mutex across the 180 s startup ready-wait. (2026-07-18, round 2 N4: `start()` split into `begin_start` → `PendingStart::wait_ready` (unlocked) → `complete_start` with a child-generation supersede guard; all three flows go through `pi_host::start_unlocked`. IPC commands and app exit no longer block on a hung sidecar startup.)
- [x] Dispose native Tauri event listeners when the transport is torn down. (2026-07-18, round 2 N5: `HostTransport.dispose()` calls the stored unlisten handles; `HostClient.attach/detach` dispose the old transport; App bootstrap disposes instead of attaching after unmount. Regression tests cover detach and replacement.)

- [x] Exit the Host when stdin closes and add process-level guards. (2026-07-18, from [round 2 review](./2026-07-18-review-round2.md) N1: `server.requestShutdown` on stdin end/close + SIGINT/SIGTERM; `unhandledRejection` logged without crashing, `uncaughtException` exits 1 for shell restart. Integration test: host exits 0 on stdin EOF.)
- [x] Make `agent.compact` mutually exclusive with `agent.prompt`. (2026-07-18, from round 2 review N2: compact now takes the per-session operation lock + `isIdle` guard; the global `agentOperationLock` is no longer acquired anywhere and busy-guards check the per-session lock. Regression tests cover both directions.)
- [x] Preserve sibling tool-call parts when one execution is updated.
  - Acceptance: a regression test covers two `toolCall` parts in one tool message.
- [x] Stabilize session-bound handlers that cross `await` (`agent.steer`, `agent.followUp`, `agent.abort`).
  - Acceptance: an interleaving session replacement cannot mutate or publish state for the wrong session.
- [x] Coordinate Host shutdown with service-graph mutations.
  - Acceptance: shutdown cannot dispose the graph while a package/session mutation owns the graph lock.
- [x] Catch failures from the detached prompt task at its outer boundary.
  - Acceptance: title/refinement or cleanup failures are logged and do not become unhandled rejections.
- [x] Reject or queue `extensionUi.request` events that do not belong to the active session.
  - Acceptance: a background-session request cannot replace the foreground modal state.

## P1 - Contract and process hardening

- [x] Validate nested agent content and compaction payload fields against their TypeScript contracts.
- [x] Add adversarial result/event payload tests.
- [x] Bound JSONL line size and surface stdout/stderr read failures.
- [x] Add a server-side timeout for package mutations.
- [x] Put the Windows Host process tree in a Job Object.

## Release gates

- [x] Recover the original Git history; do not create a provenance-free replacement baseline. (Resolved 2026-07-18: confirmed with the owner that no prior repository ever existed — the round-1 assumption of lost history was wrong. A fresh baseline was created intentionally and pushed to github.com/Skitre/PiDeck.)
- [x] Recover the three referenced `spec/` contracts or replace their references with maintained documents. (Resolved 2026-07-18: `spec/` intentionally removed; all references cleaned from README, docs, and scripts.)
- [x] Regenerate runtime lock/staging metadata after `pnpm-lock.yaml` is stable. (2026-07-18: `release-runtime.lock.json` re-pinned to the current lock hash; stale root `runtime-manifest.json` removed. `resources/pi-host/STAGING.json` still records the old hash until the next `pnpm package:sidecar` run regenerates it.)
- [x] Restrict `desktop_open_path` to approved local roots and remove unused shell permissions. (2026-07-18: command now validates absolute existing local paths only — directories open, files are revealed via `explorer /select,` and never executed; UNC/relative/non-existent paths rejected, incl. symlinks resolving to network paths. `shell:allow-open` turned out to be USED by markdown/search link opening, so it was scoped to `http(s)://**` URLs instead of removed. 5 Rust unit tests added.)
- [x] Enable a production CSP. (2026-07-18: `tauri.conf.json` sets a strict CSP — `default-src 'self'`, `script-src 'self' 'wasm-unsafe-eval'` (shiki), inline styles allowed for React/shiki style attributes, `connect-src` limited to Tauri IPC, `object-src 'none'`, `frame-src 'none'`. `devCsp: null` keeps Vite HMR working in dev.)
- [ ] Add Authenticode signing and signature verification to the release workflow.
- [x] Complete third-party notices for bundled Node.js, npm, Portable Git, and Tauri. (2026-07-18: `THIRD_PARTY_NOTICES.md` now covers all bundled runtimes incl. GPLv2 source-availability notice for Portable Git, pointing at the pinned tag in `release-runtime.lock.json`.)

## Maintenance

- [ ] Split `workspace-graph-factory.ts` by trust, session, package, and extension ownership.
- [ ] Virtualize or window long transcript and session lists. (2026-07-19 partial: `reuseStableRows` + memoized rows make the stable transcript prefix skip re-render during streaming; true virtualization still open.)
- [ ] Make packaged dependency archives reproducible.
- [ ] Align E2E PATH isolation with release smoke tests.
- [ ] Mount or delete the unused `TitleBar.tsx` component (never imported; its "PiDeck" text was the e2e attach anchor until 2026-07-19).

## 2026-07-19 — release-gate defects found by the first post-disinfection full runs

- [x] Project-trust confirm dialog closed before rendering. A trust decision rebuilds the workspace service graph, so workspace/session revisions advance right after the `workspace.setTrust` reply; the authorization-guard effect in `PackagesPage` treated that as an identity change and cleared the "Confirm executable code" gate. Fix: re-capture the authorization while workspace identity and trust decision are unchanged; still close on real identity/trust flips; confirm click re-validates. (commit cf5899c)
- [x] `smoke:release` crashed probing npm: Node rejects spawning `npm.cmd` with `shell:false` (EINVAL). Probe now goes through `cmd.exe /d /s /c` with null-guarded stdout. (commit cf5899c)
- [x] E2E window-attach waited for exact text "PiDeck", which only renders in the unmounted `TitleBar.tsx` or with Settings open — timing-dependent. Anchor changed to the always-rendered "Pi Agent" sidebar brand. (commit ff30f0c)
- [ ] Re-run `pnpm verify:release` end-to-end to validate the three fixes (interrupted 2026-07-19 by owner request after docs/typecheck/build/test/rust went green; `package:release` + integrity had passed in the two prior runs).
