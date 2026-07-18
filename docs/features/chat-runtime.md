# Chat runtime

## Status

**Partial / implemented:** Session list/create/open, prompt/steer/follow-up/abort, model/thinking selectors, transcript rendering, tool cards, Extension UI modal, AUTH_REQUIRED banner.

## Session

- Listed only for current workspace cwd (`session.list`).
- `session.open` rejects paths not in that list (must switch workspace first).
- React owns a normalized, workspace-scoped Session Catalog. Page navigation does not clear it.
- Active Pi snapshots project `running`, `queued`, `idle`, `error`, or `inactive` state into the Catalog.
- Composer drafts are keyed by Session id, so switching pages or Sessions does not discard input.
- Host exposes one foreground AgentSession plus retained background runtimes. Switching away from a running Session keeps it alive; switching away from an idle Session disposes it.
- Background runtimes publish Session status but not Transcript deltas into the foreground projection. They are disposed after settling and can then be reopened from Pi's Session file.
- Opening a still-running background Session promotes the existing Runtime, assigns a new Session revision, rebuilds the foreground snapshot, and migrates Extension UI identity without restarting the turn.
- Reconnect-time discovery of retained runtimes remains P0.2 work in the [pi-web comparison and P0 roadmap](../roadmap/pi-web-p0-roadmap.md).

## Agent commands

| UI action | Method |
|---|---|
| Send (idle) | `agent.prompt` |
| Send (busy) | `agent.steer` or `agent.followUp` |
| Stop | `agent.abort` |
| Tools panel | `agent.getTools` / `agent.setActiveTools` |

Tool Result `addedToolNames` → Host publishes full `agent.toolsChanged` (no client-side tool schema invention).

## Extension UI

**Binding (SDK 0.80.7):** Host calls only public

```ts
await session.bindExtensions({ uiContext, mode: "rpc" });
```

`uiContext` implements positional `ExtensionUIContext` APIs (`select(title, options)`, `confirm(title, message)`, `input`, `editor`, `notify`, `setStatus`, `setWidget`). TUI-only methods (custom editor/footer/header factories) are no-op or throw a clear unsupported error — they never access private setters.

Blocking: select / confirm / input / editor via `extensionUi.request` + `extensionUi.respond`.  
Non-blocking: status, widget, notify.  
Cancel / timeout / session dispose → `undefined` (or confirm false).

## Copy / keyboard

- Explicit Copy button copies full message.
- Standard `Ctrl+C` / `Ctrl+X` / `Ctrl+V` remain browser/WebView defaults (not overridden).
