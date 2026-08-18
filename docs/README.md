# PiDeck — Documentation

> **Status:** the tracked P0 implementation requirements are source-ready, but
> no public-release claim has been accepted. Source development covers Windows
> and macOS; development-candidate packaging is automated for Windows x64 and
> both macOS architectures. [P0 scope and verification](./operations/p0-scope.md)
> is authoritative.

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
5. [Extension presentation](./architecture/extension-presentation.md)
6. [Packages & workspaces](./architecture/packages-workspaces.md)
7. [Pi settings files](./architecture/pi-settings.md)
8. [Commands, shortcuts, and context menus](./architecture/commands-and-menus.md)
9. [Source map](./architecture/source-map.md)
10. [P0 scope and verification](./operations/p0-scope.md)
11. [Development](./operations/development.md)
12. [Release](./operations/release.md)
13. [Remediation / completion report](./operations/remediation-report.md)

## Document index

| Document | Status | Description |
|---|---|---|
| [architecture/overview.md](./architecture/overview.md) | Current | Process topology, data flow, fact sources |
| [architecture/process-boundaries.md](./architecture/process-boundaries.md) | Current | Rust / Node / React ownership |
| [architecture/protocol.md](./architecture/protocol.md) | Current | Methods, events, identity, errors |
| [architecture/chat-runtime.md](./architecture/chat-runtime.md) | Current | Session, chat, tools, Extension UI |
| [architecture/extension-presentation.md](./architecture/extension-presentation.md) | Current | Cross-Extension transcript presentation and inline requests |
| [architecture/packages-workspaces.md](./architecture/packages-workspaces.md) | Current | Workspace loading, user-scope packages, catalog, resources |
| [architecture/commands-and-menus.md](./architecture/commands-and-menus.md) | Current | Command registry, keyboard dispatch, and context-menu ownership |
| [architecture/source-map.md](./architecture/source-map.md) | Current | Feature → source paths + gating scripts |
| [operations/p0-scope.md](./operations/p0-scope.md) | Authoritative | Product P0/P1/P2 scope, acceptance evidence, verification layers |
| [operations/p0-status.json](./operations/p0-status.json) | Machine-readable | Tracked implementation readiness and accepted-claim state |
| [operations/development.md](./operations/development.md) | Current | Install, dev, test, env vars |
| [operations/release.md](./operations/release.md) | Current | Current Windows/macOS packaging paths and public-release limitations |
| [operations/release-checklist.md](./operations/release-checklist.md) | Deferred | Checklist to restore near first public release |
| [operations/remediation-report.md](./operations/remediation-report.md) | Historical | Prior release-hardening status and evidence gaps |
| [history/2026-07-18-full-review.md](./history/2026-07-18-full-review.md) | Archived | Round-1 full project review |
| [history/2026-07-18-review-round2.md](./history/2026-07-18-review-round2.md) | Archived | Round-2 verification review (N1–N9) |
| [history/2026-07-18-remediation-todo.md](./history/2026-07-18-remediation-todo.md) | Historical | Review remediation record; current scope lives in `operations/p0-scope.md` |
| [history/2026-07-27-independent-review.md](./history/2026-07-27-independent-review.md) | Archived | Independent full-project reliability review (34 findings) |
| [history/2026-07-30-product-ux-review.md](./history/2026-07-30-product-ux-review.md) | Archived | Product / UX review: UI, Pi SDK coverage, interaction quality |
| [history/pi-web-p0-roadmap.md](./history/pi-web-p0-roadmap.md) | Historical | Point-in-time pi-web comparison; superseded as a P0 definition |
