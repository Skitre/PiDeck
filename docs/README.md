# PiDeck — Documentation

> **Implementation status: P0 Not Complete**  
> Source remediation is advanced; one complete green `pnpm verify:release` (and Authenticode signing) remain open.  
> Do **not** claim P0/M0–M6/release complete until clean-checkout `pnpm verify:release` exits 0 with a real commit SHA.

## Layout

Three folders:

- **[architecture/](./architecture/)** — how the system works: process topology, protocol, chat/packages runtime, source map
- **[operations/](./operations/)** — how to develop and release: dev setup, release pipeline, pre-release checklist, completion report
- **[history/](./history/)** — point-in-time records: project reviews, remediation tracker, roadmap

Landed behavior updates these pages in the same change.

## Suggested reading order

1. [Architecture overview](./architecture/overview.md)
2. [Process boundaries](./architecture/process-boundaries.md)
3. [Protocol](./architecture/protocol.md)
4. [Chat runtime](./architecture/chat-runtime.md)
5. [Packages & workspaces](./architecture/packages-workspaces.md)
6. [Source map](./architecture/source-map.md)
7. [Development](./operations/development.md)
8. [Release](./operations/release.md)
9. [Remediation / completion report](./operations/remediation-report.md)

## Document index

| Document | Status | Description |
|---|---|---|
| [architecture/overview.md](./architecture/overview.md) | Current | Process topology, data flow, fact sources |
| [architecture/process-boundaries.md](./architecture/process-boundaries.md) | Current | Rust / Node / React ownership |
| [architecture/protocol.md](./architecture/protocol.md) | Current | Methods, events, identity, errors |
| [architecture/chat-runtime.md](./architecture/chat-runtime.md) | Current | Session, chat, tools, Extension UI |
| [architecture/packages-workspaces.md](./architecture/packages-workspaces.md) | Current | Trust, packages, resources |
| [architecture/source-map.md](./architecture/source-map.md) | Current | Feature → source paths + gating scripts |
| [operations/development.md](./operations/development.md) | Current | Install, dev, test, env vars |
| [operations/release.md](./operations/release.md) | In progress | Windows NSIS release pipeline + status |
| [operations/release-checklist.md](./operations/release-checklist.md) | Current | Pre-release production-grade verification checklist (`verify:release`) |
| [operations/remediation-report.md](./operations/remediation-report.md) | Current | Stage status and residual blockers |
| [history/2026-07-18-full-review.md](./history/2026-07-18-full-review.md) | Archived | Round-1 full project review |
| [history/2026-07-18-review-round2.md](./history/2026-07-18-review-round2.md) | Archived | Round-2 verification review (N1–N9) |
| [history/2026-07-18-remediation-todo.md](./history/2026-07-18-remediation-todo.md) | Living | Review remediation tracker (updated as items land) |
| [history/pi-web-p0-roadmap.md](./history/pi-web-p0-roadmap.md) | In progress | pi-web comparison, product priorities, and multi-Session P0 design |
