# PiDeck

Windows-first desktop GUI for [@earendil-works/pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).

> **Status: P0 Not Complete.** The authoritative scope is
> [`docs/operations/p0-scope.md`](./docs/operations/p0-scope.md).
> Tracked implementation/claim state is in
> [`docs/operations/p0-status.json`](./docs/operations/p0-status.json).
> Release-grade automation is deferred during initial development.
> `pnpm verify:p0` is the current source gate; `pnpm package:release` creates
> a development installer candidate without making a release-readiness claim.

PiDeck visualizes Agent sessions, thinking, tool calls, and Package management (Extensions, Skills, Prompts, Themes) using the official Pi SDK as the single source of truth.

## Requirements

- Node.js `>= 22.19.0`
- pnpm `9.x`
- Rust stable + Tauri 2 prerequisites (for desktop packaging)
- Windows 11 x64 (P0 target)

## Quick start

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

### Develop

```bash
# Node Pi Host only (JSONL stdin/stdout)
pnpm dev:host

# Desktop UI (Vite)
pnpm dev:desktop

# Full desktop (Tauri + Host)
pnpm --filter @pideck/desktop run tauri:dev
```

### Verify

```bash
# Day-to-day lightweight checks
pnpm verify:quick

# Pull-request P0 source/core gate (quick + build + Rust tests)
pnpm verify:p0

# Build a development installer candidate
pnpm package:release
```

## Workspace layout

| Path | Role |
|---|---|
| `apps/desktop` | React/Vite UI + Tauri 2 host |
| `packages/protocol` | Cross-process typed protocol schemas |
| `packages/pi-host` | Node Pi Host sidecar (SDK owner) |
| `docs/` | Current implementation documentation |
| `test-fixtures/` | Packages and extensions for tests |
| `scripts/` | Development verification and packaging tooling |

## Documentation

Start at [docs/README.md](./docs/README.md). Completion tracking: [docs/operations/remediation-report.md](./docs/operations/remediation-report.md).

## License

MIT — see [LICENSE](./LICENSE) and [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
