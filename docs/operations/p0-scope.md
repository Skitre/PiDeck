# P0 Scope and Verification

This document is the authoritative definition of PiDeck P0. Historical
roadmaps and remediation notes describe how the project reached this point;
they do not redefine the current release boundary.

[`p0-status.json`](./p0-status.json) is the tracked machine-readable companion.
It distinguishes implementation readiness from an accepted release claim;
ignored local artifacts cannot authorize documentation completion language.

## Product objective and platform boundary

PiDeck's desktop workflows are not Windows-specific. Source development and
early testing cover Windows 11 x64 and Apple Silicon macOS. The first installer
acceptance scope is narrower: it proves that a Windows user can install PiDeck,
choose a local workspace, complete a deterministic Pi Agent turn, recover the
conversation after a Host restart, and uninstall without leaving runtime
processes behind.

That Windows acceptance scope is not PiDeck's product-platform identity.
Automated development-candidate packaging now covers Windows x64 plus macOS
arm64 and x64. Windows produces an NSIS candidate with bundled Node and Portable
Git; macOS produces an app bundle and DMG with bundled Node and the system Git.
The first accepted-installer scope remains Windows x64. macOS Developer ID
signing, notarization, installed acceptance, and public-release support remain
outside the current P0 release claim.

PiDeck loads only user/global packages from the agent directory. Selecting a
workspace does not run `<workspace>/.pi/extensions`. Host constructs
`SettingsManager` with `projectTrusted: false`. There is no pending, deny, or
per-workspace trust prompt because project-local packages are not loaded.

## P0 requirements

| Area | Required behavior | Acceptance evidence |
|---|---|---|
| Desktop lifecycle | Tauri starts and exits; bundled Host starts, shuts down, and receives one bounded automatic restart after an unexpected exit | Rust lifecycle tests plus installed-app smoke and orphan audit |
| Workspace selection | Cwd is canonicalized and immediately receives a ready cwd-bound graph with user-scope packages; project-local packages are not loaded | Host workspace integration tests and core desktop workspace bootstrap |
| Settings durability | Desktop settings use versioned, recoverable, atomic persistence; corrupt input is surfaced rather than silently discarded | Rust corruption/recovery and atomic-write tests |
| Session lifecycle | Create, persist, open, and rehydrate the active Session without cross-Session identity leakage | Host integration tests and core desktop rehydrate step |
| Core chat | `prompt`, streaming transcript updates, one real tool call/result, and `abort` settle through the public Pi SDK path | Deterministic faux-provider core WebView2 E2E |
| Recovery | Sequence gaps fail closed; Host restart restores workspace, Session, transcript, tools, and package snapshots | Frontend epoch tests and core desktop restart/rehydrate step |
| Error visibility | Host, Session, Provider, Package, and Extension failures are visibly actionable and remain inspectable | Desktop notification/error-center component tests and E2E |
| Package safety | Local user-scope Package install/remove, resource enable/disable, reconcile, and reload are safe | Host Package integration tests; full release regression for the complete UI matrix |

Rust lifecycle evidence is platform-specific but shares one ownership goal:
Windows tests exercise kill-on-close Job Object behavior, while macOS/Linux
tests assert an isolated Host session/process group and verify that graceful
shutdown, forced cleanup, and Host crash all terminate a spawned descendant.
This broadens source evidence without changing the Windows-only first-installer
acceptance boundary above.

P0 source readiness means every row has implementation evidence and
`pnpm verify:p0` exits 0. This source gate can run on both development
platforms, although the tracked GitHub Actions job currently runs on Windows.
Installer provenance and public-release acceptance remain separate.

## Capabilities shipped beyond core P0

The current application also ships several capabilities that do not gate the
first accepted installer:

- npm and Git Package sources, update workflows, and per-resource controls;
- Extension `ui.custom()` terminals and in-app Extension notifications;
- a workspace shell terminal, configurable shortcuts, and rapid Session switching;
- Provider connection checks, model discovery, OAuth, and usage/cost reporting;
- a workspace file tree, embedded Dock browser, and Git status/diff/hunk workflows.

These shipped paths remain covered by unit and integration tests where
applicable.

## P1 backlog

The remaining near-term product work does not block the first core release:

- detailed per-Session activity history;
- richer Package update previews and operation history;
- a command palette and user-facing active-tool controls;
- native background completion notifications;
- transcript search, edit/resend, and regenerate workflows;
- long-list tuning and large-workspace incremental indexing.

## P2

- platform-signed public release channels, installed acceptance, and rollback;
- stable desktop Extension contribution APIs;
- Git worktree and remote synchronization workflows;
- tracked subsessions, multi-project supervision, and remote machines.

## Verification layers

| Command | Trigger | Contract |
|---|---|---|
| `pnpm verify:quick` | Local development | Docs, typecheck, unit and Host integration tests |
| `pnpm verify:p0` | Pull request and `main` | Quick gate, production frontend build, Rust tests |
| `extension-compat-latest.yml` | Weekly or manual | Non-gating audit of upstream Extension package drift |

> Candidate packaging is automated for Windows x64 and both macOS architectures.
> Native development candidates use `pnpm package:release`; public-release
> acceptance still requires platform signing and human installation tests.

`verify:p0` is a source/core quality gate, not proof that an installer is
releasable. `package:release` produces a development candidate without making
a release-readiness claim.

## External release condition

Before public distribution, add Windows Authenticode signing and require the
macOS Developer ID/notarization secrets. Verify both platform signatures before
final hashes are accepted.
