# Source map

Paths are relative to the PiDeck repository root. **Only paths that exist on
disk** are listed. Layers map to implementation paths. Source verification and
the current Windows development-candidate boundary follow
`docs/operations/p0-scope.md`.

## Packages

| Feature | Source | Tests |
|---|---|---|
| Protocol types / validation | `packages/protocol/src/` | `validate.test.ts`, `protocol-coverage.test.ts` |
| Error codes | `packages/protocol/src/errors.ts` | via validate tests |
| Method context scopes | `packages/protocol/src/methods.ts` | coverage in validate.test.ts |
| Contracts maps | `packages/protocol/src/contracts.ts` | protocol-coverage + deep validateSuccessResult/EventPayload |
| Pi Host entry | `packages/pi-host/src/main.ts` | `host.integration.test.ts`, `workspace-package.integration.test.ts` |
| Protocol server | `packages/pi-host/src/server.ts` | integration (shutdown after cleanup) |
| Workspace graph facade | `packages/pi-host/src/workspace-graph-factory.ts` | `workspace-graph-runtime.test.ts` (facade and cross-module transactions) |
| Workspace graph types | `packages/pi-host/src/workspace-graph-types.ts` | via factory tests |
| Workspace lifecycle / retained graphs | `packages/pi-host/src/workspace-lifecycle.ts` | `workspace-lifecycle.test.ts`, retained Workspace runtime regressions |
| Session runtime cache / retained sessions | `packages/pi-host/src/session-runtime-cache.ts` | `session-runtime-cache.test.ts`, multi-Session runtime regressions |
| Session lifecycle ops | `packages/pi-host/src/session-lifecycle.ts` | `session-file-lifecycle`, session-controller integration |
| Package filters | `packages/pi-host/src/package-filters.ts` | `package-filters.test.ts` |
| Package controller | `packages/pi-host/src/package-controller.ts` | integration + disk fingerprint + resource-reload-required |
| Package catalog | `packages/pi-host/src/package-catalog.ts` | `package-catalog.test.ts` |
| Agent controller | `packages/pi-host/src/agent-controller.ts` | integration |
| Extension invocation provenance | `packages/pi-host/src/extension-invocation-context.ts` + pinned SDK patch | `extension-command-context.test.ts`, `sdk-invocation-runner.test.ts` |
| Extension UI routing policy | `packages/pi-host/src/extension-ui-policy.ts` | `extension-ui-policy.test.ts` decision/risk/ownership matrix |
| Extension UI decision groups | `packages/pi-host/src/extension-ui-groups.ts` | `extension-ui-groups.test.ts` key/lifecycle/concurrency matrix |
| Extension UI bridge | `packages/pi-host/src/extension-ui-bridge.ts` | `extension-ui-bridge.test.ts` + integration |
| Extension UI lifecycle helpers | `packages/pi-host/src/extension-ui-lifecycle.ts` | `extension-ui-lifecycle.test.ts`; thin binding/activation/slot cleanup wrapper, while the bridge owns pending RPC and UI state |
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
| Stores / epoch / decision groups | `apps/desktop/src/lib/stores/` | `app-store.test.ts` (redacted group transitions), `epoch-store.test.ts` |
| Session Catalog / runtime projection | `apps/desktop/src/lib/stores/session-catalog.ts` | `session-catalog.test.ts`, `app-store.test.ts` |
| Chat | `apps/desktop/src/features/chat/` | `transcript-model.test.ts` (row build + stable-row reuse), `ExtensionPresentation.dom.test.tsx` (group continuity, Composer blocking/focus, large-option search/virtualization) |
| Packages | `apps/desktop/src/features/packages/PackagesPage.tsx` | `PackagesPage.dom.test.tsx` (mutation apply, market tab), `packages-model.test.ts` |
| Settings | `apps/desktop/src/features/settings/` | `SettingsPage.dom.test.tsx` (nav dirty guard, routing mode sync/rollback, Host split), `ProvidersSettings.dom.test.tsx` (dirty tracking, key-removal safety, number fields), `HostSettings.dom.test.tsx` (capabilities, restart confirm, agent-dir change) |
| Shared confirm dialog | `apps/desktop/src/components/Dialog.tsx` (tones: default/warning/danger) | `Dialog.dom.test.tsx` (Escape containment, focus) |
| Shared UI controls | `apps/desktop/src/components/Switch.tsx`, `SectionHeader.tsx` | via settings/packages DOM tests |
| i18n (en/zh catalogs, language setting) | `apps/desktop/src/lib/i18n/` | `i18n.test.ts` (locale resolution, interpolation, zh coverage); language switch in `SettingsPage.dom.test.tsx` |
| Global notification/error center | `apps/desktop/src/components/NotificationCenter.tsx` | `NotificationCenter.test.tsx` |

## Rust

| Feature | Source | Tests |
|---|---|---|
| Entry | `apps/desktop/src-tauri/src/main.rs`, `lib.rs` | via cargo |
| Desktop settings | `apps/desktop/src-tauri/src/desktop_settings.rs` | versioning, routing-mode default/validation, migration, corruption recovery, atomic replace unit tests |
| Host process | `apps/desktop/src-tauri/src/pi_host.rs` | `pi_host_tests.rs` (auto-restart, direct reap, Windows Job Object, Unix session/group descendant cleanup) |
| Commands | `apps/desktop/src-tauri/src/commands.rs` | open-path validation unit tests |

## Verification and packaging

| Feature | Source | Command |
|---|---|---|
| Quick source gate | root `package.json` | `pnpm verify:quick` |
| P0 pull-request gate | root `package.json` | `pnpm verify:p0` |
| Tracked P0 implementation state | `docs/operations/p0-status.json` | `pnpm verify:docs` |
| Native candidate packaging + integrity | `scripts/package-release.mjs`, `scripts/package-release-macos.mjs`, `scripts/windows-installer-integrity.mjs` | `pnpm package:release` |
| Cross-platform release aggregation | `scripts/generate-update-manifest.mjs`, `.github/workflows/release.yml` | tag-triggered Draft Release |
| Pull-request CI | `.github/workflows/p0.yml` | `pnpm verify:p0` |
| Extension compatibility fixtures | `test-fixtures/pi-packages/extension-compat-matrix/`, `packages/pi-host/src/extension-compatibility-matrix.test.ts`, `real-extension-compatibility.test.ts` | behavior-class matrix plus exact published-package aliases |
| Scheduled latest Extension audit | `.github/workflows/extension-compat-latest.yml` | weekly/manual, independent of PR and `main` gates |
