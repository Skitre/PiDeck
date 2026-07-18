# Pi Desktop Manager

Windows-first desktop GUI for [@earendil-works/pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).

> **Status: P0 Not Complete** — implementation and real desktop/installer gates are in progress.  
> Evidence: [`docs/operations/remediation-report.md`](./docs/operations/remediation-report.md) · `artifacts/p0/<run-id>/verify-p0.json`.  
> Do **not** claim P0/M0–M6/release complete until clean-checkout `pnpm verify:release` exits 0 with a real commit SHA.

Pi Desktop Manager visualizes Agent sessions, thinking, tool calls, and Package management (Extensions, Skills, Prompts, Themes) using the official Pi SDK as the single source of truth.

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
pnpm --filter @pi-desktop/desktop run tauri:dev
```

### Verify

```bash
# Day-to-day lightweight checks (doc links + typecheck + unit/integration tests)
pnpm verify:p0

# Full production-grade release gate — run before any release.
# See docs/operations/release-checklist.md for the complete procedure.
pnpm verify:release
```

## Workspace layout

| Path | Role |
|---|---|
| `apps/desktop` | React/Vite UI + Tauri 2 host |
| `packages/protocol` | Cross-process typed protocol schemas |
| `packages/pi-host` | Node Pi Host sidecar (SDK owner) |
| `docs/` | Current implementation documentation |
| `test-fixtures/` | Packages and extensions for tests |
| `scripts/` | verify / release / smoke / evidence tooling |
| `artifacts/p0/` | Generated evidence runs (gitignored content) |

## Documentation

Start at [docs/README.md](./docs/README.md). Completion tracking: [docs/operations/remediation-report.md](./docs/operations/remediation-report.md).

## License

MIT — see [LICENSE](./LICENSE) and [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
