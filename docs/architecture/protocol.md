# Protocol

Transport: **JSONL** over stdin (requests) / stdout (responses + events). UTF-8. One JSON object per line. stderr = logs only.

Outbound backpressure (`packages/pi-host/src/outbound-queue.ts`): all output flows through one bounded queue that honors stream drain. Event sequences are normally allocated at write time; above a 1MB soft watermark, latest-wins events coalesce and terminal frames merge; above a 16MB hard cap, droppable events are shed and a sequence gap is forced deliberately so the client's gap detection triggers its standard rehydrate recovery. Responses are retained under queue pressure. The atomic recovery barrier is the one exception to write-time allocation: it seals all earlier live events with sequence numbers and prevents coalescing across the barrier before it captures the response watermark.

## Frame size contract

- `MAX_HOST_JSONL_FRAME_BYTES` is 32 MiB. It is the maximum UTF-8 byte length of one Host stdout JSON object **including its trailing newline**; JavaScript string length is not a valid substitute. Rust's `MAX_HOST_STDOUT_LINE_BYTES` mirrors this value.
- One `agent.prompt`, `agent.steer`, or `agent.followUp` request accepts at most four images and at most 5 MiB decoded-equivalent base64 data per image. These protocol constants are also used by Composer.
- A desktop Session projection is limited to 12 MiB, leaving room for the repeated top-level tool projection and other `system.rehydrate` state. When necessary the Host first omits the optional persisted `entries`/`leafId` copy, then replaces image blocks with text placeholders, then retains only a recent message suffix. If queue or tool metadata alone still exceeds the budget, it emits a minimal identity/revision projection with empty queue/tool details. The live SDK Session is never modified.
- Before writing, the Host replaces an oversized response body with a small `INTERNAL_ERROR` response carrying the original identity, request `id`, and `method`. An oversized event consumes its sequence and is dropped, so the next delivered event creates the normal rehydrate gap.
- Rust treats a still-oversized or version-skewed stdout line as a dropped frame: it drains through that line's newline with bounded memory and continues reading. It does not kill or restart a healthy Host for this condition.

## Identity & revisions

Every Host process has a new `hostInstanceId`. Monotonic:

- `workspaceRevision` — workspace graph replacement
- `sessionRevision` — session create/open/reload/dispose
- `packageRevision` — package snapshot publish
- `ToolSnapshot.revision` — within a session generation, starts at 1
- `QueueSnapshot.revision` — within one concrete AgentSession runtime, increments
  once per logical queue change

Frontend **must drop** events/responses with mismatched `hostInstanceId`. Stale expected identity returns `STALE_REVISION`.

Session-scoped method contexts distinguish the current foreground Session from a
specific Session target. `activeSession` methods must address the current Session.
`sessionTarget` is used by `agent.abort`, `agent.abortCompaction`,
`agent.abortRetry`, `extensionUi.respond`, `extensionUi.customInput`, and
`extensionUi.customResize`; it can address a foreground or retained background
Session. For Extension UI, the Host first validates the current Host/Workspace
generation, then requires the request context to exactly match the owner captured
for that Extension UI `requestId`. A mismatch returns `STALE_REVISION` without
resolving, closing, injecting input into, or resizing the legitimate request.
Session promotion migrates the request owner to the promoted Session revision.
Agent stop methods resolve the target runtime by `expectedSessionId` /
`expectedSessionRevision` after the same Host/Workspace check; a missing or
stale target returns `STALE_REVISION` and does not touch the foreground Session.

`extensionUi.configure` is Host-scoped and idempotently selects
`legacy-modal`, `auto`, or `inline-first`. Desktop also sends the persisted value as
an optional `system.hello` parameter; Host defaults independently to `legacy-modal`
and echoes the active value in `HostStatusSnapshot`.

The accepted, not-yet-implemented [Extension Deck](./extension-deck.md) delta
adds the bounded `extensionDialogPresentationOverrides` map to `system.hello`
and `extensionUi.configure`. That map changes Host routing only; it is not a
Desktop presentation override and does not contain other DesktopSettings.

Queue replacement and clearing additionally require `expectedRevision`. A mismatch
returns `STALE_REVISION` before the SDK queue is mutated. Queue snapshots in Session
snapshots, mutation responses, and `agent.queueChanged` all carry the same revision.
Clear/rebuild operations suppress intermediate SDK queue events and publish one
authoritative final snapshot.

## Methods (P0)

Implemented in `packages/protocol` + handlers in `packages/pi-host`:

- `system.hello` / `getStatus` / `rehydrate` / `shutdown`
- `workspace.setCurrent` / `getCurrent`
- `session.*` (list, create, open, snapshot, name, entries, tree, stats)
- `agent.*` (prompt, steer, followUp, abort, queue, compact, tools, …)
- `model.list` / `setCurrent` / `setThinkingLevel`
- `package.*` / `resource.setPreference` / `resource.setPreferences`
- `piSettings.get` / `patch`
- `extensionUi.configure` / `respond` / `customInput` / `customResize`

Desktop-only (Rust, not Host): `desktopSettings.get` / `patch`, `desktop.openPath`, and
`shell_terminal_create` / `write` / `resize` / `close`. The real Shell terminal uses
`portable-pty` plus a Tauri Channel directly between Rust and xterm.js; it intentionally
stays outside Host identity/revision epochs, so restarting Pi Host does not terminate it.

## Events

See `HOST_EVENT_NAMES` in `packages/protocol/src/events.ts`. Notable:

- `host.ready`, `host.statusChanged`, `host.fatal`
- `workspace.changed`
- `session.snapshot`, `agent.event`, `agent.toolsChanged`. Background runtimes
  emit `agent.event` with that Session's identity; they do not emit
  `session.snapshot` or `agent.toolsChanged`.
- `package.progress`, `package.snapshot`
- `extensionUi.request` / `extensionUi.closed` / `extensionUi.groupClosed` / status /
  widget / notification. A blocking
  request may carry a Host-generated `origin` identifying its Extension and tool,
  command, or event invocation without exposing local paths. The field remains optional
  so a new Desktop accepts legacy Host requests; a current Host emits explicit
  `{ invocationKind: "unknown" }` when no active invocation is attributable. Sanitized
  Extension metadata is retained as `presentationHint` / `riskHint`; Host publishes the
  authoritative `presentation`, `risk`, and `routeReason` after ownership and safety
  checks. A request
  is closed by Host with `{ requestId, reason }` when it is aborted, times out, is
  disposed, or becomes stale; Desktop removes the matching active or queued request
  idempotently.
  Trusted tool/command invocations may add a bounded, opaque `groupKey`. Request
  delivery opens or advances that group; Host publishes exactly one
  `{ groupKey, status }` close event when the invocation completes, fails, is cancelled,
  or becomes stale. Desktop never derives group completion from adjacent requests or
  transcript events.
- `extensionUi.customStarted` / `customFrame` / `customClosed` — ui.custom() panels: the host runs a real pi-tui TUI over a virtual terminal (`packages/pi-host/src/virtual-terminal.ts`) and streams its ANSI output as frames; the desktop renders them in an xterm.js dock panel and feeds keyboard input back via `extensionUi.customInput`

Extension Deck also adds optional trusted `origin` to status, widget, and
`customStarted` payloads plus optional `overlay` to `customStarted`. These are
backward-compatible event-field additions; exact ownership and fallback rules
live in [Extension Deck](./extension-deck.md#identity-and-protocol).

### Assistant message streaming

`agent.event` keeps `message_start.message` and `message_end.message` as the
authoritative Assistant message snapshots. Between those boundaries,
`message_update` carries only a compact `assistantMessageEvent`: text, thinking,
and tool-call start/delta/end variants plus stream lifecycle events. The Host
never forwards the SDK's cumulative `message` or `partial` snapshot on an
update.

Desktop buffers updates for one animation frame, concatenates only adjacent
deltas with the same Host/Workspace/Session/Package identity, run id, event
type, and content index, then applies each Session's frame to that Session's
transcript (the foreground Session or a live `transcriptDrafts` entry).
Start/end events and identity boundaries are never crossed. Streaming tool
arguments are parsed from their accumulated JSON text for live display; the
tool-call end and final message snapshot replace that transient state.

## Runtime validation

`parseHostRequest` in `packages/protocol/src/validate.ts` validates method, context scope (no extra keys), and params. Context scope map: `METHOD_CONTEXT_SCOPE`.

`workspace.setCurrent` returns `WORKSPACE_NOT_DIRECTORY` when the resolved path
exists but is not a directory. Missing, inaccessible, or otherwise unusable
Workspace paths return `WORKSPACE_SWITCH_FAILED`.

`agent.runNow` is a Host-owned active-Session transaction. It validates the queue
revision, parks the queue, settles the current run, starts the selected follow-up,
and restores the remaining items while the service graph is pinned. Its result
always includes the authoritative final queue plus `started`, `settled`,
`queueRestored`, and `partialFailure`. A selected item can be running even when
restoring later items fails, so callers must inspect these flags and the optional
embedded error instead of treating transport success as full transactional success.

## Atomic recovery

`system.rehydrate` returns one composite `{ watermark, host, workspace, session, tools, packages }` snapshot. The Host captures the graph state and queues the outbound sequence-barrier response in the same JavaScript turn, so the watermark is the exact boundary represented by the snapshot.

Before requesting it, the desktop opens a bounded same-Host event buffer. It installs the composite snapshot at the returned watermark, then replays buffered events with larger sequences through the normal reducer path. A buffer overflow or replay gap starts a fresh recovery rather than advancing state past an unapplied event.

## Timeouts (client guidance)

| Op | Timeout |
|---|---:|
| hello/status/list | 10s |
| rehydrate | 15s |
| session create | 30s |
| session open | 180s (includes blocking extension startup UI) |
| package mutation | Host: 10 min + 5s cancellation/reconcile; desktop: 10m15s |
| shutdown | Host cleanup: 8s; Rust force-kill boundary: 10s |
