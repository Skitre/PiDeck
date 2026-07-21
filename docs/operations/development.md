# Development

## Prerequisites

- Node.js `>= 22.19.0`
- pnpm `9.x`
- Rust stable + [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) (for desktop)
- Windows 11 x64 for P0 acceptance

## Install

```bash
cd PiDesktop
pnpm install
```

Lockfile: `pnpm-lock.yaml` (committed). SDK pin: `@earendil-works/pi-coding-agent@0.80.7`.

## SDK patch (pnpm patch)

`patches/@earendil-works__pi-coding-agent@0.80.7.patch` keeps the SDK's
extension module cache across cwd changes (upstream clears it on every
workspace switch). User-scope packages are identical for every workspace, so
their modules now load once per host process; with ~13 user packages this
takes a cold workspace build from ~2.5-3.2 s down to ~0.2 s. Extension
factories receive cwd at invocation, and package install/update still clears
the cache explicitly. Re-evaluate the patch on every SDK upgrade; consider
proposing it upstream.

## Commands

| Command | Purpose |
|---|---|
| `pnpm typecheck` | Typecheck protocol, pi-host, desktop |
| `pnpm test` | Unit + host integration tests |
| `pnpm build` | Build all JS packages |
| `pnpm verify:quick` | Docs + typecheck + unit/Host integration tests for local iteration |
| `pnpm verify:p0` | Pull-request P0 gate: quick + production frontend build + Rust tests |
| `pnpm package:release` | Build a development installer candidate |
| `pnpm dev:host` | Run Pi Host (JSONL on stdio) |
| `pnpm spike:sidecar` | M0 Extension load spike |
| `pnpm dev:desktop` | Vite UI only |
| `pnpm --filter @pideck/desktop tauri:dev` | Full desktop |

`verify:p0` is intentionally broader than the lightweight local gate, but it
is still not installer evidence. Release-grade automation is deferred during
initial development; see [P0 scope](./p0-scope.md).

The Rust gate uses the isolated
`apps/desktop/src-tauri/target/verify-rust` directory. This keeps P0
verification repeatable while a development build from the default target
directory is open.

## Temporary agent directory

All write tests **must** set:

```bash
# PowerShell
$env:PI_CODING_AGENT_DIR = "$env:TEMP\pideck-test-agent"
```

Or pass `--agent-dir=<path>` to the host. Never point tests at real `~/.pi/agent` for mutations.

## Manual host smoke

```bash
$env:PI_CODING_AGENT_DIR = "$env:TEMP\pi-host-smoke"
pnpm --filter @pideck/pi-host exec tsx src/main.ts
# stdin:
# {"protocolVersion":1,"id":"1","method":"system.hello","context":{},"params":{"clientName":"cli","clientVersion":"0","protocolVersion":1}}
```

## Common issues

| Symptom | Check |
|---|---|
| Spike fails on Extension load | Node ≥22.19, SDK 0.80.7, fixture path exists |
| Host fatal on start | `agentDir` writable; inspect stderr JSON logs |
| `flush stdin: 管道正在被关闭` / pipe closed | Fixed: Windows must not pass `\\?\` paths to Node. Rebuild Tauri (`tauri:dev` again) after pulling. Also run `pnpm build` first. |
| STALE_REVISION everywhere | UI must update identity from each response |
| Tauri can't find host | Build `packages/pi-host` so `dist/main.js` exists |
