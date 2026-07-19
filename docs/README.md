# PiDeck — Documentation

> **Implementation status: P0 Not Complete**  
> Source remediation for R0–R8 is advanced; real desktop E2E, installed smoke, and clean-checkout evidence remain open.  
> Do **not** claim P0/M0–M6/release complete until clean-checkout `pnpm verify:release` exits 0 with a real commit SHA.

## Scope

This `docs/` tree describes the **current implementation** of PiDeck on disk:

- Process topology (Rust desktop host, Node Pi Host, React UI)
- Protocol methods/events and identity/revision rules
- Chat, Packages, workspace trust, and settings ownership
- Development and Windows release operations
- Source map from features to real files

Landed behavior updates these pages in the same change.

## Suggested reading order

1. [Architecture overview](./architecture/overview.md)
2. [Process boundaries](./architecture/process-boundaries.md)
3. [Protocol](./architecture/protocol.md)
4. [Chat runtime](./features/chat-runtime.md)
5. [Packages & workspaces](./features/packages-workspaces.md)
6. [Development](./operations/development.md)
7. [Release](./operations/release.md)
8. [Source map](./reference/source-map.md)
9. [Remediation / completion report](./operations/remediation-report.md)
10. [pi-web comparison and P0 roadmap](./roadmap/pi-web-p0-roadmap.md)

## Document index

| Document | Status | Description |
|---|---|---|
| [architecture/overview.md](./architecture/overview.md) | Partial | Process topology, data flow, fact sources |
| [architecture/process-boundaries.md](./architecture/process-boundaries.md) | Partial | Rust / Node / React ownership |
| [architecture/protocol.md](./architecture/protocol.md) | Partial | Methods, events, identity, errors |
| [features/chat-runtime.md](./features/chat-runtime.md) | Partial | Session, chat, tools, Extension UI |
| [features/packages-workspaces.md](./features/packages-workspaces.md) | Partial | Trust, packages, resources |
| [operations/development.md](./operations/development.md) | Current | Install, dev, test, env vars |
| [operations/release.md](./operations/release.md) | In progress | Windows NSIS primary installer + smoke |
| [operations/release-checklist.md](./operations/release-checklist.md) | Current | Pre-release production-grade verification checklist (`verify:release`) |
| [operations/remediation-report.md](./operations/remediation-report.md) | Current | Stage status and residual blockers |
| [reference/source-map.md](./reference/source-map.md) | Current | Feature → source paths |
| [reviews/2026-07-18-full-review.md](./reviews/2026-07-18-full-review.md) | Archived | Round-1 full project review |
| [reviews/2026-07-18-review-round2.md](./reviews/2026-07-18-review-round2.md) | Archived | Round-2 verification review (N1–N9) |
| [reviews/2026-07-18-remediation-todo.md](./reviews/2026-07-18-remediation-todo.md) | Living | Review remediation tracker (updated as items land) |
| [roadmap/pi-web-p0-roadmap.md](./roadmap/pi-web-p0-roadmap.md) | In progress | pi-web comparison, product priorities, and multi-Session P0 design |
