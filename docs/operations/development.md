# Development

## Prerequisites

- Node.js `>= 22.19.0` minimum; development and CI use the exact version pinned
  in `.node-version` / `.nvmrc`
- pnpm `9.x`
- Rust stable + [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) (for desktop)
- Windows 11 x64 or Apple Silicon macOS for source development

Windows desktop development requires Microsoft C++ Build Tools with the
**Desktop development with C++** workload and WebView2. macOS desktop
development requires Xcode Command Line Tools (`xcode-select --install`).
The repository does not currently claim Linux support.

## Toolchain setup

Use the pinned pnpm version (`9.15.0`). pnpm 11 ignores the
`patchedDependencies` location used by this repository and can install an
incorrect Pi SDK tree.

`fnm` plus Corepack can provide the pinned Node and pnpm versions. Run these
from the repository root so `.node-version` resolves.

PowerShell:

```powershell
winget install Schniz.fnm
fnm env --use-on-cd --shell powershell | Out-String | Invoke-Expression
fnm install (Get-Content .node-version)
fnm use (Get-Content .node-version)

npm install --global corepack@latest
corepack enable pnpm
corepack prepare pnpm@9.15.0 --activate
```

To load `fnm` automatically in future PowerShell sessions, add the `fnm env`
line to `$PROFILE`.

macOS:

```bash
brew install fnm
eval "$(fnm env --use-on-cd --shell zsh)"
fnm install "$(cat .node-version)"
fnm use "$(cat .node-version)"

npm install --global corepack@latest
corepack enable pnpm
corepack prepare pnpm@9.15.0 --activate
```

If the first Rust dependency download fails because crates.io is too slow,
retry with:

```bash
CARGO_HTTP_TIMEOUT=600 CARGO_HTTP_LOW_SPEED_LIMIT=1 CARGO_NET_RETRY=10 pnpm test:rust
```

## Install

```bash
pnpm install --frozen-lockfile
```

Lockfile: `pnpm-lock.yaml` (committed). The Pi SDK pins are the exact
`@earendil-works/pi-*` production dependencies in `packages/pi-host/package.json`;
release scripts derive and validate the installed SDK family from that manifest.

## SDK patch (pnpm patch)

`patches/@earendil-works__pi-coding-agent@0.82.1.patch` gives
`DefaultPackageManager` a `setOperationSignal()` hook and an optional `env`
constructor option. The signal is passed to both child-process paths so an
aborted package operation actually kills the npm or git child instead of
leaving it running and holding the graph lock. The `env` option is the
explicit PiDeck internal runtime environment (bundled Node/Git/npm PATH plus
copied user proxy/home/certificate variables). Upstream has neither hook.
`setOperationSignal` is declared as a **required** member of the
`PackageManager` interface, which makes a silently skipped
`pm.setOperationSignal?.(...)` a compile error rather than a no-op.
`DefaultResourceLoader` forwards the same optional `env` into the private
`DefaultPackageManager` it constructs, so implicit resource loading uses the
internal runtime too.

Both asynchronous command paths capture diagnostics and settle through the
SDK's `waitForChildProcess()`. That waiter observes process exit plus a short
stdio-idle grace, so a successful npm parent cannot leave package mutation
pending merely because a detached Windows descendant inherited its pipes.

The synchronous global-npm-root lookup cannot be interrupted — `spawnSync`
takes no signal — so the patch only makes it refuse to start a new child once
the operation is aborted. Every long-running operation (npm install, uninstall,
view; git clone, checkout, fetch, reset, clean) is on the cancellable async
path.

The 0.80.7 patch also preserved the SDK's extension module cache across cwd
changes and added a `preserveExtensionCache` reload option. Both are gone in
0.82.1: package reconcile now uses the official full reload, and every reload
re-imports extension modules. Re-evaluate the patch on every SDK upgrade;
consider proposing the cancellation hook upstream.

The same patch also gives Windows Agent Bash a last-resort absolute
`PIDECK_BUNDLED_BASH` (or `…/git/bin/bash.exe` derived from
`PIDECK_BUNDLED_GIT`) after user `shellPath` and system Git Bash/PATH
lookup fail, and makes `killProcessTree()` spawn
`%SystemRoot%\System32\taskkill.exe` with an `error` fallback so a user
PATH that omits System32 cannot terminate the Host.

The cancellation patch still cannot reach the private package manager's
in-flight children. Implicit resource loading therefore stays wrapped in
`withoutImplicitPackageInstall()` so those children are not started: see
"Implicit resource loading" below. The `env` option is independent of
cancellation — it only selects which Node/Git/npm the child would resolve.

## Implicit resource loading

`DefaultResourceLoader.reload()` resolves configured packages with no
`onMissing` handler, which makes the SDK install silently — a configured npm
package absent from disk (or whose installed version no longer satisfies its
range) triggers a real `npm install`, and an absent git package a real
`git clone`.

Workspace selection, the startup preload, and session create/open must all stay
offline, so they wrap the reload in `withoutImplicitPackageInstall()`
(`packages/pi-host/src/offline-package-resolution.ts`), which scopes the SDK's
`PI_OFFLINE` flag. Missing packages are skipped and reported instead of
fetched; the user installs them from the Packages page.

Package mutation reconcile is deliberately **not** wrapped: there, fetching is
the point. That reload remains uncancellable, bounded only by Host shutdown.

Do not set `PI_OFFLINE` globally — it would also disable the update-check
capability. The scoping is safe because every reload call site runs under
`serviceGraphLock`.

## PiDeck-owned agent data

PiDeck keeps its Host-owned persistent data under one namespace inside the Pi
agent directory:

```text
<agentDir>/pideck/
  DefaultProject/
  migration-backups/pideck-sdk-0.80.7-to-0.82.1/
  provider-journal/
  model-backups/
  session-archive/<encoded-cwd>/
```

Canonical Pi files such as `<agentDir>/models.json` and active Sessions under
`<agentDir>/sessions/<encoded-cwd>/` stay in their native locations. Before any
of those files are read at startup, the Host adopts data from the former
`backups/pideck-sdk-0.80.7-to-0.82.1`, `provider-journal`, root-level
`models-<timestamp>-<id>.bak`, and per-workspace `.archive` locations. The move
is restartable; a conflicting source and destination abort startup without
overwriting either copy.

On Desktop startup, an empty Workspace configuration creates
`<agentDir>/pideck/DefaultProject` with `0700` permissions and persists it as
both the recent Workspace and the first known Workspace. Any non-empty
`defaultWorkspace`, `lastWorkspace`, or `knownWorkspaces` setting suppresses
this fallback. `defaultWorkspace` itself is not set, so a Workspace the user
opens later becomes the normal restart target.

## Pre-migration backup

Before the 0.82.1 runtime first touches a real agent directory, the Host copies
the pre-migration user data to:

```text
<agentDir>/pideck/migration-backups/pideck-sdk-0.80.7-to-0.82.1/<timestamp>/
```

It holds `auth.json`, `models.json`, `models-store.json`, and `settings.json`
(each if present), plus `session-headers.jsonl` — one header line per session,
not conversation bodies. `manifest.json` records sizes and SHA-256 digests but
never file contents, so it is safe to attach to a bug report. The directory is
`0700` and the copies are forced to `0600` regardless of the source mode.

The backup is not deleted when the Host starts successfully. Migration is
declared complete only after every dependent path has succeeded at least once,
possibly across several runs: runtime creation, a local refresh, opening a
pre-existing session, a provider snapshot, and a clean shutdown. Progress lives
in `state.json` beside the backup; once `completedAt` is set the Host skips the
whole mechanism.

If the backup cannot be written, startup fails. Migrating user data that cannot
be rolled back is worse than refusing to start.

## Provider mutation journal

A provider change writes `models.json` and `auth.json`, which no single rename
can cover together. Before committing either, the pre-mutation bytes of both go
to `<agentDir>/pideck/provider-journal/<journalId>/`. The entry is removed only
after the whole mutation, including the local refresh and reconciliation, succeeds —
so an entry found at startup means exactly one thing: a mutation did not finish.

Startup restores both files from that entry before the runtime reads them. If
the restore cannot complete, the entry is kept and `modelConfigHealth` reports
`degraded` with the journal id and stage, because the Host genuinely does not
know whether provider configuration and credentials still agree. That state is
sticky for the process lifetime: only a restart that finds no journal clears it.

Backup files (or the explicit `auth.absent` marker) are fsynced before the
actionable journal record is published. Recovery accepts exactly one credential
backup state: either a readable `auth.json` backup or an empty `auth.absent`
marker. Missing, unreadable, malformed, or ambiguous backup state leaves both
live files untouched, keeps the journal, and reports degraded health. A
non-empty `auth.absent` file is treated as a malformed marker.

## Extension provider ownership

Extensions register model providers into the one shared `ModelRuntime`, whose
registry is process-wide, id-keyed, and never unregistered by the SDK — fine
for the upstream one-workspace CLI, a cross-workspace leak in a Host that
serves many. `extension-provider-ownership.ts` wraps the runtime's
registration methods and attributes every registration to an owner: the
workspace graph being built or bound (AsyncLocalStorage window), else the
active graph, else a permanent host owner.

Parking a workspace (`retainGraph`) suspends its solely-owned providers —
unregistered, effective configs saved on the graph; reactivation re-registers
them; disposal drops them. Providers registered by several live workspaces
stay until the last owner departs. Two rules matter when touching this code:
maintenance re-registration (`applyKnownThinkingProfiles`) must run inside
`runNeutral` so it never becomes a co-owner, and ownership is deliberately
workspace-granular — sessions within a workspace share its extensions, so a
per-session release would break parallel sessions. The leak proof and the
semantics live in `extension-provider-isolation.test.ts`; the end-to-end
A→B→A acceptance runs in `workspace-package.integration.test.ts`.

## Commands

| Command                                   | Purpose                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| `pnpm typecheck`                          | Typecheck protocol, pi-host, desktop                                      |
| `pnpm test`                               | Unit + host integration tests                                             |
| `pnpm build`                              | Build all JS packages                                                     |
| `pnpm verify:quick`                       | Docs + typecheck + unit/Host integration tests for local iteration        |
| `pnpm verify:p0`                          | Pull-request P0 gate: quick + production frontend build + Rust tests      |
| `pnpm package:release`                    | Build a native Windows x64 NSIS or macOS DMG development candidate        |
| `pnpm dev:host`                           | Run Pi Host (JSONL on stdio)                                              |
| `pnpm spike:sidecar`                      | M0 Extension load spike                                                   |
| `pnpm dev:desktop`                        | Vite UI only                                                              |
| `pnpm --filter @pideck/desktop tauri:dev` | Full desktop                                                              |
| `pnpm dev:fast`                           | Reuse a compiled debug binary for faster Windows iteration (Windows only) |

The weekly/manual `Extension compatibility latest audit` workflow checks the current
npm release of the representative v2 questionnaire package. It runs outside the
pull-request and `main` gates; per-commit compatibility uses the exact versions in the
lockfile plus the repository behavior-class fixture.

`verify:p0` is intentionally broader than the lightweight local gate, but it
is still not installer evidence. It has run successfully on Apple Silicon
macOS and is the tracked CI gate on Windows. See [P0 scope](./p0-scope.md).

The Rust gate uses the isolated
`apps/desktop/src-tauri/target/verify-rust` directory. This keeps P0
verification repeatable while a development build from the default target
directory is open.

## Temporary agent directory

All write tests **must** set:

```powershell
# PowerShell
$env:PI_CODING_AGENT_DIR = "$env:TEMP\pideck-test-agent"
```

Or pass `--agent-dir=<path>` to the host. Never point tests at real `~/.pi/agent` for mutations.

On macOS and other POSIX shells, use a temporary directory outside the real
agent data, for example:

```bash
export PI_CODING_AGENT_DIR="${TMPDIR:-/tmp}/pideck-test-agent"
```

## Manual host smoke

```powershell
$env:PI_CODING_AGENT_DIR = "$env:TEMP\pi-host-smoke"
pnpm --filter @pideck/pi-host exec tsx src/main.ts
# stdin:
# {"protocolVersion":1,"id":"1","method":"system.hello","context":{},"params":{"clientName":"cli","clientVersion":"0","protocolVersion":1}}
```

Use the equivalent `export PI_CODING_AGENT_DIR=...` syntax on macOS.

## Common issues

| Symptom                                     | Check                                                                                                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Spike fails on Extension load               | Node ≥22.19, SDK matches the Host manifest, fixture path exists                                                                                                    |
| Host fatal on start                         | `agentDir` writable; inspect stderr JSON logs                                                                                                                      |
| `flush stdin: 管道正在被关闭` / pipe closed | Fixed: Windows must not pass `\\?\` paths to Node. Rebuild Tauri (`tauri:dev` again) after pulling. Also run `pnpm build` first.                                   |
| Reveal/open path fails                      | Confirm the target still exists and the platform file manager is available. PiDeck uses Explorer on Windows, Finder (`open -R`) on macOS, and `xdg-open` on Linux. |
| STALE_REVISION everywhere                   | UI must update identity from each response                                                                                                                         |
| Tauri can't find host                       | Build `packages/pi-host` so `dist/main.js` exists                                                                                                                  |
