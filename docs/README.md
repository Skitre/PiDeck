# Pi Desktop Manager — Documentation

> **Implementation status: P0 Not Complete**  
> Source remediation for R0–R8 is advanced; real desktop E2E, installed smoke, and clean-checkout evidence remain open.  
> Do **not** claim P0/M0–M6/release complete until clean-checkout `pnpm verify:release` exits 0 with a real commit SHA.

## Scope

This `docs/` tree describes the **current implementation** of Pi Desktop Manager on disk:

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
| [roadmap/pi-web-p0-roadmap.md](./roadmap/pi-web-p0-roadmap.md) | In progress | pi-web comparison, product priorities, and multi-Session P0 design |
