# Source map

Paths are relative to `PiDesktop/`. **Only paths that exist on disk** are listed.  
Layers map to implementation paths. Current development verification follows
`docs/operations/p0-scope.md`; release-grade automation is deferred.

## Packages

| Feature | Source | Tests |
|---|---|---|
| Protocol types / validation | `packages/protocol/src/` | `validate.test.ts`, `protocol-coverage.test.ts` |
| Error codes | `packages/protocol/src/errors.ts` | via validate tests |
| Method context scopes | `packages/protocol/src/methods.ts` | coverage in validate.test.ts |
| Contracts maps | `packages/protocol/src/contracts.ts` | protocol-coverage + deep validateSuccessResult/EventPayload |
| Pi Host entry | `packages/pi-host/src/main.ts` | `host.integration.test.ts`, `workspace-package.integration.test.ts` |
| Protocol server | `packages/pi-host/src/server.ts` | integration (shutdown after cleanup) |
| Workspace graph factory | `packages/pi-host/src/workspace-graph-factory.ts` | integration (candidate-commit, immediate project-resource load) |
| Workspace graph types | `packages/pi-host/src/workspace-graph-types.ts` | via factory tests |
| Session lifecycle ops | `packages/pi-host/src/session-lifecycle.ts` | `session-file-lifecycle`, session-controller integration |
| Package filters | `packages/pi-host/src/package-filters.ts` | `package-filters.test.ts` |
| Package controller | `packages/pi-host/src/package-controller.ts` | integration + disk fingerprint + resource-reload-required |
| Agent controller | `packages/pi-host/src/agent-controller.ts` | integration |
| Extension UI bridge | `packages/pi-host/src/extension-ui-bridge.ts` | `extension-ui-bridge.test.ts` + integration |
| Extension UI fixture integration | `packages/pi-host/src/extension-ui.integration.test.ts` | real DefaultResourceLoader path |
| Temp agent helpers | `packages/pi-host/src/test-helpers/temp-agent.ts` | used by integration tests |
| Sidecar spike (dev diag) | `packages/pi-host/src/spike/sidecar-extension-spike.ts` | `pnpm spike:sidecar` |
| Stable graph read | `packages/pi-host/src/stable-graph-read.ts` | `stable-graph-read.test.ts` |
| Model health | `packages/pi-host/src/model-health.ts` | via host |
| Tools refresh | `packages/pi-host/src/tools-refresh.ts` | `tools-refresh.test.ts` |
| Event normalize | `packages/pi-host/src/event-normalize.ts` | `event-normalize.test.ts` |
| Transcript reducer | `apps/desktop/src/lib/chat/transcript-reducer.ts` | `transcript-reducer.test.ts` |
| Release stage | `scripts/package-release-sidecar.mjs` | frozen deploy + hoist + compact zip |
| Doc link check | `scripts/verify-doc-links.mjs` | `pnpm verify:docs` |

## Desktop UI

| Feature | Source | Tests |
|---|---|---|
| App shell | `apps/desktop/src/app/App.tsx` | epoch/rehydrate store tests |
| Host client | `apps/desktop/src/lib/bridge/host-client.ts` | `host-client.test.ts` (deep parse) |
| Tauri transport | `apps/desktop/src/lib/bridge/tauri-transport.ts` | — |
| Stores / epoch | `apps/desktop/src/lib/stores/` | `app-store.test.ts`, `epoch-store.test.ts` |
| Session Catalog / runtime projection | `apps/desktop/src/lib/stores/session-catalog.ts` | `session-catalog.test.ts`, `app-store.test.ts` |
| Chat | `apps/desktop/src/features/chat/` | `transcript-model.test.ts` (row build + stable-row reuse) |
| Packages | `apps/desktop/src/features/packages/PackagesPage.tsx` | atomic mutation apply |
| Settings | `apps/desktop/src/features/settings/SettingsPage.tsx` | — |
| Global notification/error center | `apps/desktop/src/components/NotificationCenter.tsx` | `NotificationCenter.test.tsx` |

## Rust

| Feature | Source | Tests |
|---|---|---|
| Entry | `apps/desktop/src-tauri/src/main.rs`, `lib.rs` | via cargo |
| Desktop settings | `apps/desktop/src-tauri/src/desktop_settings.rs` | versioning, migration, corruption recovery, atomic replace unit tests |
| Host process | `apps/desktop/src-tauri/src/pi_host.rs` | `pi_host_tests.rs` (auto-restart, reap) |
| Commands | `apps/desktop/src-tauri/src/commands.rs` | open-path validation unit tests |

## Verification and packaging

| Feature | Source | Command |
|---|---|---|
| Quick source gate | root `package.json` | `pnpm verify:quick` |
| P0 pull-request gate | root `package.json` | `pnpm verify:p0` |
| Tracked P0 implementation state | `docs/operations/p0-status.json` | `pnpm verify:docs` |
| Release packaging + integrity | `scripts/package-release.mjs`, `scripts/windows-installer-integrity.mjs` | `pnpm package:release` |
| Pull-request CI | `.github/workflows/p0.yml` | `pnpm verify:p0` |
