# Protocol

Transport: **JSONL** over stdin (requests) / stdout (responses + events). UTF-8. One JSON object per line. stderr = logs only.

## Identity & revisions

Every Host process has a new `hostInstanceId`. Monotonic:

- `workspaceRevision` — workspace graph replace / trust rebuild  
- `sessionRevision` — session create/open/reload/dispose  
- `packageRevision` — package snapshot publish  
- `ToolSnapshot.revision` — within a session generation, starts at 1  

Frontend **must drop** events/responses with mismatched `hostInstanceId`. Stale expected identity returns `STALE_REVISION`.

## Methods (P0)

Implemented in `packages/protocol` + handlers in `packages/pi-host`:

- `system.hello` / `getStatus` / `shutdown`
- `workspace.setCurrent` / `getCurrent` / `getTrust` / `setTrust`
- `session.*` (list, create, open, snapshot, name, entries, tree, stats)
- `agent.*` (prompt, steer, followUp, abort, queue, compact, tools, …)
- `model.list` / `setCurrent` / `setThinkingLevel`
- `package.*` / `resource.setTopLevelEnabled`
- `piSettings.get` / `patch`
- `extensionUi.respond`

Desktop-only (Rust, not Host): `desktopSettings.get` / `patch`, `desktop.openPath`.

## Events

See `HOST_EVENT_NAMES` in `packages/protocol/src/events.ts`. Notable:

- `host.ready`, `host.statusChanged`, `host.fatal`
- `workspace.changed`, `workspace.trustRequired`
- `session.snapshot`, `agent.event`, `agent.toolsChanged`
- `package.progress`, `package.snapshot`
- `extensionUi.request` / status / widget / notification

## Runtime validation

`parseHostRequest` in `packages/protocol/src/validate.ts` validates method, context scope (no extra keys), and params. Context scope map: `METHOD_CONTEXT_SCOPE`.

## Timeouts (client guidance)

| Op | Timeout |
|---|---:|
| hello/status/list | 10s |
| session open/create | 30s |
| package install/update | 10 min |
| shutdown | 10s then Rust force-kill |
