# Progress Log

## Session: 2026-08-19

### Phase 1: Confirm Environment Ownership
- **Status:** complete

### Phase 2: Design the Environment Split
- **Status:** complete

### Phase 3: Implementation
- **Status:** complete
- Actions taken:
  - Removed Host PATH override from Tauri launch.
  - Pass `PIDECK_BUNDLED_GIT` as the stripped git.exe path.
  - Added `InternalRuntime` and wired it into GitService, DefaultPackageManager, and DefaultResourceLoader.
  - Extended the 0.82.1 SDK patch with optional `env`; refreshed lockfile patch hash.
  - Rebuilt `packages/pi-host/dist` and restaged sidecar resources.
- Files created/modified:
  - `apps/desktop/src-tauri/src/pi_host.rs`
  - `apps/desktop/src-tauri/src/pi_host_tests.rs`
  - `packages/pi-host/src/internal-runtime.ts`
  - `packages/pi-host/src/git-service.ts`
  - `packages/pi-host/src/main.ts`
  - `packages/pi-host/src/user-resource-cache.ts`
  - `packages/pi-host/src/workspace-lifecycle.ts`
  - `packages/pi-host/src/workspace-graph-factory.ts`
  - `packages/pi-host/src/package-snapshot.ts`
  - `patches/@earendil-works__pi-coding-agent@0.82.1.patch`
  - `pnpm-lock.yaml`
  - `scripts/release-runtime.lock.json`
  - `docs/operations/development.md`

### Phase 4: Test and Verify
- **Status:** complete except packaged Windows matrix
- Actions taken:
  - Added and ran Rust Host env tests (75 lib tests passed).
  - Added and ran internal-runtime, GitService, package-manager env, and Agent Bash tests.
  - Ran Host integration, user-resource-cache, package-resources, workspace-package, cancellation, and PI_OFFLINE tests.
  - Ran `pnpm smoke:staged-host` and `pnpm verify:release-metadata`.
  - Did not run a full packaged Windows installer with a mise-only user PATH.

### Phase 5: Documentation and Delivery
- **Status:** complete
- Actions taken:
  - Documented the Host vs internal-runtime boundary in `pi_host.rs`, `internal-runtime.ts`, and `docs/operations/development.md`.
  - Confirmed unrelated files (`ld-search.json`, `ld-zhipu.json`, `linux-do-0.2.0.md`, `xiaohongshu-0.2.0.txt`) were not changed.
  - No commit created.

## Test Results
| Test | Input | Expected | Actual | Status |
|------|-------|----------|--------|--------|
| Rust lib tests | `cargo test --lib` | pass | 77 passed | passed |
| internal-runtime.test.ts | isolated source env | distinct env, PATH replaced | 3 passed | passed |
| agent-bash-env.test.ts | marker PATH + bundled bash | env + getShellConfig fallback + spawn | 5 passed | passed |
| windows-process.test.ts | missing taskkill | fallback to child.kill | 3 passed | passed |
| sdk-package-internal-env.test.ts | shims on isolated PATH | async/capture/sync + ResourceLoader use internal env | 2 passed | passed |
| git-service.test.ts | isolated PATH + abs git + cancel | Git UI + no Host crash on cancel | 17 passed | passed |
| sdk-package-cancellation.test.ts | existing abort fixtures | still cancel | 7 passed | passed |
| offline-package-resolution.test.ts | PI_OFFLINE | still skip install | 5 passed | passed |
| host.integration.test.ts | temp agentDir | Host lifecycle | 6 passed | passed |
| user-resource-cache.test.ts | cache fixtures | cache still works | 8 passed | passed |
| package-resources.test.ts | package fixtures | 15 passed | 15 passed | passed |
| workspace-package.integration.test.ts | package + workspace | 14 passed | 14 passed | passed |
| pi-host typecheck/build | tsc | success | success | passed |
| eslint on changed Host files | changed TS | clean | clean | passed |
| smoke:staged-host | marker PATH + bundled Git/Bash | git ready + bashProbe ok | ok, gitStatus ready, bashProbe ok | passed |
| verify:release-metadata | lock + staged evidence | 19 passed | 19 passed | passed |
| validate:resources | staged git includes bash.exe | OK | errors=0 | passed |
| Packaged Windows mise-only PATH matrix | packaged app | Bash sees mise; Git/npm bundled | not run | pending |

## Error Log
| Timestamp | Error | Attempt | Resolution |
|-----------|-------|---------|------------|
| 2026-08-19 | Sidecar rejected stale SDK patch SHA | 1 | Re-pinned `sdkPatchSha256` and `pnpmLock.sha256`. |
| 2026-08-19 | Sidecar missing controlled Node | 2 | `pnpm package:sidecar:with-node` prepared runtime. |

## Session: 2026-08-19 review fixes

### Phase 6: Windows P1 merge blockers
- **Status:** complete except packaged Windows matrix
- Actions taken:
  - Pass `PIDECK_BUNDLED_BASH` from Rust; patch `getShellConfig` to use it after user/system discovery.
  - Use absolute `taskkill.exe` with an `error` fallback in GitService and the SDK `killProcessTree` path.
  - Rewrite staged smoke to a user-marker PATH plus explicit bundled Git/Bash descriptors.
  - Rebuilt Host, restaged sidecar, refreshed patch/lock hashes.
- Files created/modified:
  - `apps/desktop/src-tauri/src/pi_host.rs`
  - `apps/desktop/src-tauri/src/pi_host_tests.rs`
  - `packages/pi-host/src/internal-runtime.ts`
  - `packages/pi-host/src/windows-process.ts`
  - `packages/pi-host/src/git-service.ts`
  - `packages/pi-host/src/credential-config-value.ts`
  - `packages/pi-host/src/agent-bash-env.test.ts`
  - `patches/@earendil-works__pi-coding-agent@0.82.1.patch`
  - `pnpm-lock.yaml`
  - `scripts/release-runtime.lock.json`
  - `scripts/smoke-staged-host.mjs`
  - `docs/operations/development.md`

### Phase 8: Packaged Windows candidate
- **Status:** complete with residual signing-key failure
- Actions taken:
  - Ran `pnpm package:release`. Sidecar, resource validation, staged smoke, and packaged-runtime checks passed, including `git/bin/bash.exe`.
  - Tauri produced `PiDeck_0.2.0_x64-setup.exe` and `pideck.exe`, but exited 1 because `TAURI_SIGNING_PRIVATE_KEY` is unset. `package:release` therefore did not accept the installer.

### Phase 7: Portable Git must include bash.exe
- **Status:** complete
- Actions taken:
  - Added `bin/bash.exe` to Portable Git `expectedFiles`.
  - Resource layout, sidecar, resource manifest, and packaged-runtime checks now follow that lock list.
- Files created/modified:
  - `scripts/release-runtime.lock.json`
  - `scripts/release-resource-manifest.mjs`
  - `scripts/validate-resource-layout.mjs`
  - `scripts/package-release.mjs`
  - `scripts/package-release-sidecar.mjs`
  - `scripts/release-sdk-evidence.test.mjs`

### Phase 9: Verify packaged behavior
- **Status:** complete except GUI/mise install launch
- Actions taken:
  - Probed `target/release/resources` Host with a user-marker PATH and no Git on PATH.
  - Confirmed packaged zip SDK contains `bundledBashFallback` and absolute `taskkill`.
  - Confirmed `pideck.exe` contains `PIDECK_BUNDLED_GIT` and `PIDECK_BUNDLED_BASH`.
  - Re-ran Host env/Git tests (28) and Rust descriptor tests (4).

## 5-Question Reboot Check
| Question | Answer |
|----------|--------|
| Where am I? | Packaged Host/Git/Bash behavior verified; GUI install launch not run. |
| Where am I going? | Report verification results. |
| What's the goal? | Keep the user's environment primary while giving PiDeck internal children bundled runtime tools, and keep Agent Bash working on clean Windows. |
| What have I learned? | See `findings.md`. Host PATH no longer includes bundled Git, so SDK shell discovery and bare `taskkill` both need explicit fallbacks. |
| What have I done? | Fixed both P1s and the smoke false positive, rebuilt and restaged Host, re-ran the tests listed above. |

## Session: 2026-08-20 post-0.2.1 direction

### Phase 1: Restore context and name remaining work
- **Status:** complete
- Actions taken:
  - Confirmed repo/tag/release are at 0.2.1; environment-split work is closed as a product track.
  - Cross-checked P0/P1 docs and the July 30 UX review against 0.1.8–0.2.1 source and GitHub release notes.
  - Compared pinned SDK 0.82.1 with upstream 0.84.2.
  - Wrote a replacement `task_plan.md` and `findings.md` for the next-track decision.
- Files created/modified:
  - `task_plan.md`
  - `findings.md`
  - `progress.md`

## 5-Question Reboot Check
| Question | Answer |
|----------|--------|
| Where am I? | Direction discovery complete; waiting for the user to lock Track A or Track B. |
| Where am I going? | Implement 0.2.2 product slice or SDK 0.84.2 after the user chooses. |
| What's the goal? | Lock the next development track after 0.2.1. |
| What have I learned? | See `findings.md`. P1 docs are stale; the real fork is palette/tools vs SDK catch-up. |
| What have I done? | Audited 0.2.1, releases, remaining gaps, and upstream SDK changelog. |

## Session: 2026-08-20 SDK 0.84.2 audit

### Phase 1: Offline API audit
- **Status:** complete
- Actions taken:
  - Packed pi-ai / coding-agent / tui / agent-core 0.84.2 tarballs and recorded SHA-256.
  - Compared 0.84.2 `d.ts`/`js` with PiDeck call sites and the 0.82.1 dist patch.
  - Confirmed the patch must be rebased; TypeBox and ProviderHeaders are the main Host compile breaks.
- Files created/modified:
  - `task_plan.md`
  - `findings.md`
  - `progress.md`

## 5-Question Reboot Check
| Question | Answer |
|----------|--------|
| Where am I? | SDK 0.84.2 audit complete; workspace still on 0.82.1. |
| Where am I going? | Atomic bump + patch rebase after the user says to start. |
| What's the goal? | Upgrade Pi SDK to 0.84.2 without mixing UI work. |
| What have I learned? | See `findings.md`. |
| What have I done? | Offline pack and API/patch inventory. |

## Session: 2026-08-20 upgrade method

### Phase 1: Choose the method
- **Status:** complete
- Actions taken:
  - Rejected rebasing the full 0.82.1 dist patch (last upgrade's method).
  - Split work into Cut 1 (Host adapters on 0.82.1) and Cut 2 (atomic 0.84.2).
  - Wrote `docs/operations/pi-sdk-0.84.2-upgrade.md`.
- Files created/modified:
  - `docs/operations/pi-sdk-0.84.2-upgrade.md`
  - `task_plan.md`
  - `findings.md`
  - `progress.md`

## 5-Question Reboot Check
| Question | Answer |
|----------|--------|
| Where am I? | Method locked; waiting to start Cut 1. |
| Where am I going? | Host adapters on 0.82.1, then 0.84.2 with invocationRunner-only patch. |
| What's the goal? | Upgrade to 0.84.2 and stop paying full dist-patch rebase tax. |
| What have I learned? | See `findings.md` and `docs/operations/pi-sdk-0.84.2-upgrade.md`. |
| What have I done? | Replaced the rebase playbook with a two-cut plan. |

## Session: 2026-08-20 review packet

### Phase 4: Docs
- **Status:** in_progress (plan ready for external review; Cut 1 not started)
- Actions taken:
  - Rewrote `docs/operations/pi-sdk-0.84.2-upgrade.md` as a standalone review spec.
  - Retracted the claim that Host can wrap `node:child_process.spawn` to intercept SDK ESM `taskkill`.
  - Documented vitest `setupFiles`, `runCommandSync`, ResourceLoader private PM, `applyOverrides` vs `setShellPath`, and `setInternalRuntimeForTests`.
- Files created/modified:
  - `docs/operations/pi-sdk-0.84.2-upgrade.md`
  - `findings.md`
  - `task_plan.md`
  - `progress.md`

## 5-Question Reboot Check
| Question | Answer |
|----------|--------|
| Where am I? | Review packet written; waiting for another model / user to accept before Cut 1. |
| Where am I going? | Cut 1 on 0.82.1 after the plan is accepted. |
| What's the goal? | A plan another model can Accept / Accept with changes / Reject. |
| What have I learned? | Spawn wrapping is not ESM-safe; env hooks must cover sync spawn and ResourceLoader. |
| What have I done? | Expanded the upgrade doc into a reviewable spec. |

## Session: 2026-08-20 absorb Accept-with-changes review

### Phase 1: Choose the method
- **Status:** complete
- Actions taken:
  - Verified the three blockers against the 0.82.1 patch, Host call sites, and the 0.84.2 tarball (`sdk.js` null auto-select, `bindExtensions` ignoring `invocationRunner`, new `wrapper.js` skipping tools, PM `waitForChildProcess` / scoped `update`).
  - Rewrote `docs/operations/pi-sdk-0.84.2-upgrade.md` as the executable hybrid spec.
  - Did not start Cut 1 code.
- Files created/modified:
  - `docs/operations/pi-sdk-0.84.2-upgrade.md`
  - `findings.md`
  - `task_plan.md`
  - `progress.md`

## 5-Question Reboot Check
| Question | Answer |
|----------|--------|
| Where am I? | Review absorbed; plan is executable; code still on 0.82.1. |
| Where am I going? | Cut 1 T8/P6 when the user asks to implement, then the rest of one PR. |
| What's the goal? | Hybrid upgrade to 0.84.2 as PiDeck 0.2.2. |
| What have I learned? | sdk.js null, P8 wrapper/session bind, and full PM wait/signal/scope were the real blockers. |
| What have I done? | Folded Accept-with-changes into the spec. No implementation yet. |

## Session: 2026-08-20 second Accept-with-changes

### Phase 1: Choose the method
- **Status:** complete
- Actions taken:
  - Confirmed `verify:quick` → `verify:release-metadata` fails if patch/lock SHA drift.
  - Confirmed `extensionRunner.emit("model_select")` does not update `graph.sessionSnapshot`; Provider RPC returns `{ providerId, enabled }`.
  - Confirmed coding-agent exports are only `.` and `./rpc-entry`.
  - Listed seven 0.2.2 landing files including Cargo.lock `pideck`.
  - Updated the executable spec; still no Cut 1 code.
- Files created/modified:
  - `docs/operations/pi-sdk-0.84.2-upgrade.md`
  - `findings.md`
  - `task_plan.md`
  - `progress.md`

## 5-Question Reboot Check
| Question | Answer |
|----------|--------|
| Where am I? | Second review absorbed; plan is executable; code still on 0.82.1. |
| Where am I going? | Cut 1 T8/P6 when the user asks to implement. |
| What's the goal? | Hybrid upgrade to 0.84.2 as PiDeck 0.2.2. |
| What have I learned? | Independently-green commits must update evidence SHAs; snapshot publish is a Host emit path; PM spike has no SDK spawnProcess import. |
| What have I done? | Folded the four round-2 findings into the spec. |

## Session: 2026-08-20 Cut 1 T8/P6/P7

### Phase 2: Cut 1 Host migrations
- **Status:** T8/P6/P7 complete; P1–P3 not started (PM patch kept)
- Actions taken:
  - Added `PIDECK_NO_MODEL`, `clearSessionModel`, `publishIdleActiveSessionSnapshot`.
  - Factory passes the sentinel instead of `null`. Provider idle reconcile publishes `session.snapshot` without bumping revision.
  - Host `declare module` restores `opts.pideck` and `editor(..., opts?)`.
  - Dropped sdk `model: null`, `clearModel`/`NO_MODEL`, and pideck types from the 0.82.1 patch. Kept P8, PM, resource-loader, `shell.js`.
  - Re-pinned `sdkPatchSha256` and `pnpmLock.sha256`.
- Files created/modified:
  - `packages/pi-host/src/no-model.ts`
  - `packages/pi-host/src/no-model.test.ts`
  - `packages/pi-host/src/sdk-adapters/pi-coding-agent-pideck.d.ts`
  - `packages/pi-host/src/sdk-adapters/pi-coding-agent-pideck.test.ts`
  - `packages/pi-host/src/agent-session-factory.ts`
  - `packages/pi-host/src/agent-session-factory.test.ts`
  - `packages/pi-host/src/provider-controller.ts`
  - `packages/pi-host/src/provider-controller.test.ts`
  - `packages/pi-host/src/extension-ui-bridge.ts`
  - `patches/@earendil-works__pi-coding-agent@0.82.1.patch`
  - `pnpm-lock.yaml`
  - `scripts/release-runtime.lock.json`

## Test Results
| Test | Input | Expected | Actual | Status |
|------|-------|----------|--------|--------|
| no-model.test.ts | sentinel + snapshot publish | 5 passed | 5 passed | passed |
| agent-session-factory.test.ts | empty enabled list + settings flush | 6 passed | 6 passed | passed |
| provider-controller.test.ts | clear-model + session.snapshot | 50 passed | 50 passed | passed |
| extension-ui-bridge.test.ts | pideck + editor(opts) | 48 passed | 48 passed | passed |
| sdk-invocation-runner.test.ts | P8 still patched | 4 passed | 4 passed | passed |
| sdk-package-*.test.ts + bash + taskkill | leftover patch | 27 passed | 27 passed | passed |
| pi-host typecheck | tsc | success | success | passed |
| pi-host lint | eslint | clean | clean | passed |
| verify:release-metadata | new patch/lock SHAs | 22 passed | 22 passed | passed |

## 5-Question Reboot Check
| Question | Answer |
|----------|--------|
| Where am I? | Cut 1 T8/P6/P7 landed; SDK still 0.82.1; no commit. |
| Where am I going? | P1–P3 spike next, then Cut 2 freshness gate. |
| What's the goal? | Hybrid upgrade to 0.84.2 as PiDeck 0.2.2. |
| What have I learned? | Sentinel is accepted by Agent. Package-root `declare module` works; deep `types.ts` path does not. |
| What have I done? | Moved no-model + pideck types into Host and shrunk the 0.82.1 patch. |

## Session: 2026-08-20 Cut 1 P1–P3

### Phase 2: Cut 1 Host migrations
- **Status:** complete
- Actions taken:
  - Host `installPackageManagerAdapter()` replaces `setOperationSignal`, spawn/capture/run/sync, and scoped `update` on `DefaultPackageManager.prototype`.
  - Copied `waitForChildProcess` into Host; Windows spawn goes through `cross-spawn@7.0.6`.
  - vitest `setupFiles` + `main.ts` install the adapter without calling `getInternalRuntime()` at install time.
  - Tests use `setInternalRuntimeForTests` instead of constructor `env`.
  - Removed `package-manager` and `resource-loader` hunks from the 0.82.1 patch. Leftover: P8 + `shell.js`.
  - Re-pinned `sdkPatchSha256` and `pnpmLock.sha256`.
- Files created/modified:
  - `packages/pi-host/src/sdk-adapters/install-host-sdk-adapters.ts`
  - `packages/pi-host/src/sdk-adapters/package-manager-adapter.ts`
  - `packages/pi-host/src/sdk-adapters/spawn-process.ts`
  - `packages/pi-host/src/sdk-adapters/wait-for-child-process.ts`
  - `packages/pi-host/src/sdk-adapters/pi-coding-agent-package-manager.d.ts`
  - `packages/pi-host/src/internal-runtime.ts`
  - `packages/pi-host/package.json`
  - `packages/pi-host/vitest.config.ts`
  - `packages/pi-host/src/main.ts`
  - `patches/@earendil-works__pi-coding-agent@0.82.1.patch`
  - `pnpm-lock.yaml`
  - `scripts/release-runtime.lock.json`

## Test Results
| Test | Input | Expected | Actual | Status |
|------|-------|----------|--------|--------|
| sdk-package-internal-env.test.ts | isolated PATH / internal env | 2 passed | 2 passed | passed |
| sdk-package-cancellation.test.ts | abort + inherited stdio + stderr | 7 passed | 7 passed | passed |
| sdk-package-update-scope.test.ts | scoped update | 10 passed | 10 passed | passed |
| package-manager-adapter.test.ts | idempotent install | 1 passed | 1 passed | passed |
| user-resource-cache.test.ts | ResourceLoader without ctor env | 8 passed | 8 passed | passed |
| Cut 1 Host suite (factory/provider/bash/taskkill/invocation/no-model/adapters) | leftover P8 + shell | 75 passed | 75 passed | passed |
| pi-host typecheck | tsc after dropping PM types hunk | success | success | passed |
| pi-host lint + knip | cross-spawn + wait helper referenced | clean | clean | passed |
| verify:release-metadata | new patch/lock SHAs | 22 passed | 22 passed | passed |

## 5-Question Reboot Check
| Question | Answer |
|----------|--------|
| Where am I? | Cut 1 complete on 0.82.1; no commit. |
| Where am I going? | Cut 2 freshness gate, then atomic 0.84.2. |
| What's the goal? | Hybrid upgrade to 0.84.2 as PiDeck 0.2.2. |
| What have I learned? | Prototype replace + Host spawn/wait reproduces PM semantics. Augment `DefaultPackageManager` (class), not only `PackageManager`. |
| What have I done? | Moved PM/resource-loader out of the dist patch into Host. |

## Session: 2026-08-20 Cut 2

### Phase 3: Atomic 0.84.2 bump
- **Status:** complete except commit / PR
- Actions taken:
  - Freshness gate: six packages latest still 0.84.2, `gitHead` `914cf147`.
  - Bumped `pi-ai` / `pi-coding-agent` / `pi-tui` to 0.84.2; lock also has `pi-agent-core` / `pi-client` / `pi-protocol` 0.84.2. No mix.
  - Ported P8 onto 0.84.2 session/runner/types/index and rewrote wrapper `execute` to `invokeExtension`. Rebased `shell.js`.
  - Host: `typebox@1.3.7`, `TuiMainScreen` for widget/custom UI, ProviderHeaders nulls kept on SDK path and dropped for Host HTTP, OAuth refreshToken abort test.
  - Product 0.2.2 in seven files; `PI_SDK_PACKAGES` six entries; version-equality assert; evidence SHAs updated.
- Files created/modified:
  - `patches/@earendil-works__pi-coding-agent@0.84.2.patch`
  - `packages/pi-host/package.json`
  - `packages/pi-host/src/attachment-tool.ts`
  - `packages/pi-host/src/extension-ui-bridge.ts`
  - `packages/pi-host/src/provider-controller.ts`
  - `packages/pi-host/src/session-title.ts`
  - `packages/pi-host/src/oauth-refresh-compat.test.ts`
  - `scripts/release-sdk-evidence.mjs`
  - `scripts/release-runtime.lock.json`

## Test Results
| Test | Input | Expected | Actual | Status |
|------|-------|----------|--------|--------|
| verify:quick | 0.84.2 / 0.2.2 tree | pass | pass (Host 82 files / 750 tests) | passed |
| pnpm build | protocol + Host + desktop | success | success | passed |
| test:rust | Tauri lib tests | pass | 77 passed | passed |
| lint:rust | fmt --check + clippy -D warnings | clean | clean | passed |
| package:sidecar:with-node | frozen lock + 0.84.2 evidence | six Pi pkgs 0.84.2 | ok, Node 24.18.0 | passed |
| validate:resources | compacted zip layout | errors=0 | errors=0 | passed |
| smoke:staged-host | marker PATH + bundled Git/Bash | 0.84.2, git ready, bash ok | `sdkVersion 0.84.2`, `gitStatus ready`, `bashProbe ok`, exit 0 | passed |

## Session: 2026-08-20 pre-merge review findings

### Phase 5: Notices, P8 bind/reload test, arch docs
- **Status:** complete
- Actions taken:
  - Replaced coding-agent `0.80.7` notices with the six-package 0.84.2 family; `loadReleaseSdkEvidence` now asserts those names and the pin.
  - Added a real AgentSession test: `bindExtensions({ invocationRunner })` → emit → `reload()` new Runner → emit, asserting trusted `sourceInfo`.
  - Architecture docs no longer describe the current contract as SDK 0.82.1.
- Files created/modified:
  - `THIRD_PARTY_NOTICES.md`
  - `scripts/release-sdk-evidence.mjs`
  - `scripts/release-sdk-evidence.test.mjs`
  - `packages/pi-host/src/sdk-invocation-runner.test.ts`
  - `docs/architecture/chat-runtime.md`
  - `docs/architecture/extension-presentation.md`
  - `docs/architecture/source-map.md`

## Test Results
| Test | Input | Expected | Actual | Status |
|------|-------|----------|--------|--------|
| sdk-invocation-runner.test.ts | bind-only runner + reload | 5 passed | 5 passed | passed |
| release-sdk-evidence.test.mjs | six-package notices + pin | 7 passed | 7 passed | passed |
| verify:docs | markdown links | errors=0 | errors=0 | passed |
| pi-host lint | changed test | clean | clean | passed |

## 5-Question Reboot Check
| Question | Answer |
|----------|--------|
| Where am I? | Review P2/P3 addressed; no commit. |
| Where am I going? | Ordered commits when the user asks. |
| What's the goal? | Hybrid upgrade to 0.84.2 as PiDeck 0.2.2. |
| What have I learned? | Direct ExtensionRunner tests do not lock AgentSession bind/reload. Notices must follow PI_SDK_PACKAGES. |
| What have I done? | Notices family + evidence assert, AgentSession bind/reload test, architecture version wording. |

## Session: 2026-08-20 tools panel design

### Phase 1: Design how defaultTools / tool toggles should work
- **Status:** complete (design only; no code)
- Actions taken:
  - Confirmed protocol + Host `getTools`/`setActiveTools` already exist; desktop store is unused by UI.
  - Split live `setActiveTools` from SDK `defaultTools` (startup builtins only; no setter; project file unused because `projectTrusted: false`).
  - Rejected `CreateAgentSessionOptions.tools` as GUI persistence (allowlist locks the session).
  - Found `buildToolSnapshot` does not copy `sourceInfo.source`.
  - Recommended Composer popover + workspace DesktopSettings builtin preset; no `settings.json` write in v1.
- Files created/modified:
  - `task_plan.md` (replaced completed SDK bump plan)
  - `findings.md` (appended Tools panel section)

## Test Results
| Test | Input | Expected | Actual | Status |
|------|-------|----------|--------|--------|
| — | design only | — | — | skipped |

## 5-Question Reboot Check
| Question | Answer |
|----------|--------|
| Where am I? | Tools UI design written; not implemented. |
| Where am I going? | Implement when the user asks: Host source mapping, workspace preset apply, Composer popover. |
| What's the goal? | User-facing active-tool controls as 0.3.0; read-only sessions without a second protocol. |
| What have I learned? | `defaultTools` is not the switch. Snapshot `source` is empty. Allowlist option is a trap. |
| What have I done? | Locked the product split, UI surface, persistence, and non-goals in planning files. |

### Phase 1 follow-up: user said not worth building
- **Status:** complete — won't do
- Actions taken:
  - Agreed: do not ship Composer tools UI, workspace presets, or `defaultTools` productization.
  - Keep existing Host/protocol; do not delete `getTools`/`setActiveTools`.
  - Updated `task_plan.md` phases 2–5 to cancelled.
- Files created/modified:
  - `task_plan.md`
  - `findings.md` (product decision note)

## 5-Question Reboot Check
| Question | Answer |
|----------|--------|
| Where am I? | Tools UI cancelled. SDK 0.2.2 bump already shipped. |
| Where am I going? | Wait for the next product ask; do not start 0.3.0 on tools. |
| What's the goal? | Coding-agent defaults stay as they are. |
| What have I learned? | Existing RPC + a review bullet is not a user need. Persistence is the real cost. |
| What have I done? | Wrote the won't-do decision into the plan and findings. |

## Session: 2026-08-20 release v0.2.2

### Phase 1-2: Inventory and tag
- **Status:** complete
- Actions taken:
  - Confirmed `63e55f7` is 0.2.2; P0 run 32340188219 succeeded.
  - Installed GitHub CLI (not logged in; public Actions API used).
  - Created annotated tag `v0.2.2` and pushed it.
  - Release workflow run 32343537338 in progress (Windows, macOS arm64, macOS Intel).
- Files created/modified:
  - `task_plan.md` (rewritten for this release)

### Phase 3: Monitor CI
- **Status:** complete
- Release run 32343537338 succeeded in ~28m (all 3 platforms + Create draft release).
- Verified `gh release view v0.2.2`: `isDraft: true`, name `PiDeck v0.2.2`, assets include Win x64 setup, macOS arm64/x64 dmg + app.tar.gz + sigs, `latest.json`.
- Stopped CI watcher. Did not publish.

## 5-Question Reboot Check
| Question | Answer |
|----------|--------|
| Where am I? | v0.2.2 GitHub Release Draft exists and is verified. |
| Where am I going? | Goal complete. Publish only if the user asks. |
| What's the goal? | Draft success for v0.2.2. |
| What have I learned? | Drafts use an untagged GitHub URL until published. |
| What have I done? | Tagged, watched CI, verified draft assets, stopped watchers. |

## 5-Question Reboot Check
| Question | Answer |
|----------|--------|
| Where am I? | Release CI running for tag v0.2.2. |
| Where am I going? | Green `create-release` job and a GitHub Draft for v0.2.2. |
| What's the goal? | Release draft success, not publishing. |
| What have I learned? | P0 already green; previous v0.2.1 needed retries on Intel. |
| What have I done? | Tagged, pushed, armed CI watcher. |

## Session: 2026-08-21 next-track briefing

### Phase 1: Restore context
- **Status:** complete
- Actions taken:
  - Confirmed v0.2.2 draft goal is done; unpublished.
  - Confirmed Extension UI inventory docs are written but uncommitted.
  - User parked the Extension UI redo and cancelled tools UI / structure churn.
  - Rechecked July 30 UX holes: `commandContextActions`, `onError`, `AUTH_REQUIRED`, and `projectTrusted: false` already exist in source.
- Files created/modified:
  - `task_plan.md` (replaced completed release plan with next-track wait)
  - `progress.md`

## 5-Question Reboot Check
| Question | Answer |
|----------|--------|
| Where am I? | 0.2.2 shipped as draft; waiting for the next product slice. |
| Where am I going? | User picks: docs commit, palette, chat last-mile, or something else. |
| What's the goal? | Name remaining work without starting parked tracks. |
| What have I learned? | July 30 review is partly stale. Palette (`mod+K`) and Composer steer still missing. |
| What have I done? | Briefed remaining tracks; did not start implementation. |

## Session: 2026-08-21 Deck design

### Phase 1: Design the Extension UI rework end state
- **Status:** complete (design only; no implementation)
- Actions taken:
  - Full source re-read of chat/dock/extension-ui surfaces after the user
    rejected planning-file-driven suggestions and then rejected incremental
    patching of the Extension UI twice.
  - Confirmed constraints in source: no trusted origin on widget/status events;
    native webviews always above HTML; widget content session-scoped.
  - Locked decisions with the user: app-level pane primitive incl. builtins,
    main splits from the start, end-state design (not a first batch),
    notifications stay as they are.
  - Wrote `docs/architecture/deck.md`; added it to `docs/README.md` index;
    added superseded pointers in `extension-ui-surfaces.md` + zh-CN.
  - Rewrote `task_plan.md` for the Deck track; appended design facts here and
    to `findings.md`.
- Files created/modified:
  - `docs/architecture/deck.md` (new)
  - `docs/README.md`
  - `docs/architecture/extension-ui-surfaces.md`
  - `docs/architecture/extension-ui-surfaces.zh-CN.md`
  - `task_plan.md`
  - `findings.md`
  - `progress.md`

## 5-Question Reboot Check
| Question | Answer |
|----------|--------|
| Where am I? | Deck design accepted and documented; no code started. |
| Where am I going? | Batch 1 (Deck core standalone) when the user says start. |
| What's the goal? | Replace fixed verb→surface mapping with typed views + host renderers + user-arranged layout, absorbing builtins. |
| What have I learned? | See findings.md Deck section: origin protocol delta, native-webview z-order rules, workspace-scoped layout vs session-scoped content. |
| What have I done? | Wrote and indexed the design doc, updated both surfaces docs, rewrote the plan. |

## Session: 2026-08-21 pi-subagents walkthrough

### Phase 1 follow-up: validate the Deck design against pi-subagents
- **Status:** complete (analysis only; no code, no doc edits)
- Actions taken:
  - Read installed pi-subagents 0.50.0 source (~/.pi/agent/npm): render.ts rpc
    branch, async-status-snapshot encode, fleet.ts custom() + in-component
    stop-confirm, fleet-status.ts widget factory, extension/index.ts gating.
  - Confirmed activation profile under PiDeck: hasUI true so FleetView, fleet
    inspector, dialogs, status, notify all run; mode "rpc" switches the async
    widget to PI_SUBAGENT_ASYNC_JSON transport lines.
  - Verified desktop has no transport-widget filter (raw JSON renders today).
  - Verified registerShortcut has no Host consumer (ctrl+alt+f dead) and
    onTerminalInput is a no-op (widget keys dead); only /subagents-fleet opens
    the inspector.
  - Verified Esc inside xterm stays with the extension component (keymap .xterm
    gating on chat.stop).
  - Recorded verdict + two candidate design amendments in findings.md.
- Files created/modified:
  - `findings.md`
  - `progress.md`

## 5-Question Reboot Check
| Question | Answer |
|----------|--------|
| Where am I? | Deck design validated against pi-subagents; two amendments proposed, not yet folded into deck.md. |
| Where am I going? | User approves/rejects amendments (transport-renderer rule, overlay hint field), then Batch 1 when told. |
| What's the goal? | Confirm the Deck design adapts a real heavyweight extension without architectural change. |
| What have I learned? | Design holds; frictions are a raw transport widget (today's bug, amplified) and a missing overlay placement hint. |
| What have I done? | Source-level walkthrough of all seven pi-subagents surfaces mapped to Deck view types. |

## Session: 2026-08-22 Extension Deck implementation

### Phase 1: Reorient away from superseded Deck
- **Status:** complete
- Actions taken:
  - Confirmed no PiDeck `AGENTS.md`.
  - Rewrote `task_plan.md` to Extension Deck batches.
  - Marked `deck.md` findings as historical.

### Phase 2: Batch 1 — Contracts, identity, capabilities, settings
- **Status:** complete except local Rust linker gate
- Actions taken:
  - Protocol origin/overlay, hello/configure overrides, route reasons, settings types.
  - Host origin capture, blocking-dialog precedence, legacy-modal default.
  - Desktop `extensionUi` whitelist, app-store hydrate, observation, Settings UI, hello/configure projection.
  - Rust nested `extensionUi` sanitizer, patch allowlist, recovery tests.
- Files created/modified:
  - `packages/protocol/src/extension-ui-settings.ts` and tests
  - `packages/pi-host/src/extension-ui-bridge.ts`, `extension-ui-policy.ts`, `server.ts`
  - `apps/desktop/src/lib/desktop-settings.ts`, `extension-ui-observation.ts`, `extension-ui-presentation.ts`
  - `apps/desktop/src/features/settings/ExtensionUiSettingsSection.tsx`
  - `apps/desktop/src-tauri/src/extension_ui_settings.rs`, `desktop_settings.rs`

### Phase 3: Batch 2 — Composer anchors and Float layer
- **Status:** complete

### Phase 4: Batch 3 — RightDock Extensions area
- **Status:** complete except repo-wide verify:quick with Batch 4
- Actions taken:
  - Gate `extension-deck-v1` default on; exclusive `extensions` vs `extension:${requestId}` paths.
  - Legacy path ignores saved profiles and always opens per-request tabs.
  - Bounded primary/secondary groups, edge drop for secondary, no third group.
  - Overflow close hidden for the Extensions tab; no close button on that tab.
  - customClosed / content end hides the tab and keeps the global profile.
  - start/frame/input/resize/close stay requestId-keyed in both gate modes.

### Phase 5: Batch 4 — Blocking dialogs and native guard
- **Status:** complete

### Phase 6: Final acceptance
- **Status:** complete
- Commands:
  - `pnpm lint:rust` passed with VS 2022 Build Tools (2026-08-22 10:45Z)
  - `pnpm test:rust` passed — 84 lib tests (2026-08-22 10:46Z)
  - `pnpm verify:docs` — 126 links, 0 errors
  - `pnpm verify:quick` — protocol 533, host 761, desktop 879
  - `pnpm build` — protocol + host + desktop
- Closing work this session:
  - Settings “Forget UI settings” removes one Extension’s profile and observation row
  - Registered Extension surface commands (float focus, legal move, dock tabs/groups/split, family reset)
  - Acceptance criteria 1–18 audited against current tests/source
  - Did not commit or push
