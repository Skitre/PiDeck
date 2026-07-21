# P0 Scope and Verification

This document is the authoritative definition of PiDeck P0. Historical
roadmaps and remediation notes describe how the project reached this point;
they do not redefine the current release boundary.

[`p0-status.json`](./p0-status.json) is the tracked machine-readable companion.
It distinguishes implementation readiness from an accepted release claim;
ignored local artifacts cannot authorize documentation completion language.

## Product objective

P0 proves that a Windows user can install PiDeck, choose a local
workspace, complete a deterministic Pi Agent turn, recover the conversation
after a Host restart, and uninstall without leaving runtime processes behind.

Selecting a workspace authorizes its project resources. PiDeck immediately
loads them with `projectTrusted: true`; existing `.pi/extensions` may execute
local code. There is no pending, deny, or per-workspace trust state.

## P0 requirements

| Area | Required behavior | Acceptance evidence |
|---|---|---|
| Desktop lifecycle | Tauri starts and exits; bundled Host starts, shuts down, and receives one bounded automatic restart after an unexpected exit | Rust lifecycle tests plus installed-app smoke and orphan audit |
| Workspace selection | Cwd is canonicalized and immediately receives a ready cwd-bound graph with project resources enabled | Host workspace integration tests and core desktop workspace bootstrap |
| Settings durability | Desktop settings use versioned, recoverable, atomic persistence; corrupt input is surfaced rather than silently discarded | Rust corruption/recovery and atomic-write tests |
| Session lifecycle | Create, persist, open, and rehydrate the active Session without cross-Session identity leakage | Host integration tests and core desktop rehydrate step |
| Core chat | `prompt`, streaming transcript updates, one real tool call/result, and `abort` settle through the public Pi SDK path | Deterministic faux-provider core WebView2 E2E |
| Recovery | Sequence gaps fail closed; Host restart restores workspace, Session, transcript, tools, and package snapshots | Frontend epoch tests and core desktop restart/rehydrate step |
| Error visibility | Host, Session, Provider, Package, and Extension failures are visibly actionable and remain inspectable | Desktop notification/error-center component tests and E2E |
| Package safety | Local Package install/remove, explicit Project Package executable-code confirmation, resource enable/disable, reconcile, and reload are safe | Host Package integration tests; full release regression for the complete UI matrix |

During the initial development phase, P0 source readiness means every row has
implementation evidence and `pnpm verify:p0` exits 0. Installer provenance and
public-release acceptance are deferred until release automation is restored.

## P1

P1 capabilities may ship, but they do not block the first core release:

- concurrent background Session runtimes and detailed per-Session activity history;
- npm and Git Package source matrix, Package update previews, and operation history;
- Extension `ui.custom()` terminal and native Windows completion notifications;
- Shell terminal, command palette, configurable shortcuts, and rapid Session switching;
- Provider connectivity diagnostics, model discovery refinements, and OAuth;
- usage/cost reporting, long-list tuning, and workspace file indexing.

These paths remain covered by unit and integration tests where applicable.

## P2

- signed automatic update channels with rollback;
- stable desktop Extension contribution APIs;
- Git status/diff/worktree workflows and large-workspace incremental indexing;
- tracked subsessions, multi-project supervision, and remote machines.

## Verification layers

| Command | Trigger | Contract |
|---|---|---|
| `pnpm verify:quick` | Local development | Docs, typecheck, unit and Host integration tests |
| `pnpm verify:p0` | Pull request and `main` | Quick gate, production frontend build, Rust tests |

> 发布级验证（verify:release / verify:release:full）在开发初期暂不启用，
> 打包直接使用 `pnpm package:release`。接近首次公开发布时恢复自动化验证。

`verify:p0` is a source/core quality gate, not proof that an installer is
releasable. `package:release` produces a development candidate without making
a release-readiness claim.

## External release condition

Before public distribution, restore automated release verification and add
Authenticode signing, timestamping, and signature verification before final
hashes are accepted.
