# PiDeck — Documentation

> **Implementation status: P0 Not Complete.**
> [P0 scope and verification](./operations/p0-scope.md) is authoritative.
> Release-grade automation is deferred during initial development. The current
> automated boundary is `pnpm verify:p0`; `pnpm package:release` produces a
> development candidate. Authenticode remains required for public distribution.

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
7. [P0 scope and verification](./operations/p0-scope.md)
8. [Development](./operations/development.md)
9. [Release](./operations/release.md)
10. [Remediation / completion report](./operations/remediation-report.md)

## Document index

| Document | Status | Description |
|---|---|---|
| [architecture/overview.md](./architecture/overview.md) | Current | Process topology, data flow, fact sources |
| [architecture/process-boundaries.md](./architecture/process-boundaries.md) | Current | Rust / Node / React ownership |
| [architecture/protocol.md](./architecture/protocol.md) | Current | Methods, events, identity, errors |
| [architecture/chat-runtime.md](./architecture/chat-runtime.md) | Current | Session, chat, tools, Extension UI |
| [architecture/packages-workspaces.md](./architecture/packages-workspaces.md) | Current | Workspace loading, packages, resources |
| [architecture/source-map.md](./architecture/source-map.md) | Current | Feature → source paths + gating scripts |
| [operations/p0-scope.md](./operations/p0-scope.md) | Authoritative | Product P0/P1/P2 scope, acceptance evidence, verification layers |
| [operations/p0-status.json](./operations/p0-status.json) | Machine-readable | Tracked implementation readiness and accepted-claim state |
| [operations/development.md](./operations/development.md) | Current | Install, dev, test, env vars |
| [operations/release.md](./operations/release.md) | Deferred | Future Windows NSIS release-verification design |
| [operations/release-checklist.md](./operations/release-checklist.md) | Deferred | Checklist to restore near first public release |
| [operations/remediation-report.md](./operations/remediation-report.md) | Historical | Prior release-hardening status and evidence gaps |
| [history/2026-07-18-full-review.md](./history/2026-07-18-full-review.md) | Archived | Round-1 full project review |
| [history/2026-07-18-review-round2.md](./history/2026-07-18-review-round2.md) | Archived | Round-2 verification review (N1–N9) |
| [history/2026-07-18-remediation-todo.md](./history/2026-07-18-remediation-todo.md) | Historical | Review remediation record; current scope lives in `operations/p0-scope.md` |
| [history/pi-web-p0-roadmap.md](./history/pi-web-p0-roadmap.md) | Historical | Point-in-time pi-web comparison; superseded as a P0 definition |
