# Chat runtime

## Status

**Implemented:** Session list/create/open, prompt/follow-up/abort, Settings choice of follow-up vs steer while a turn is running (default follow-up), manual/auto compaction controls, model/thinking selectors, transcript rendering, tool cards, Extension UI modal, and AUTH_REQUIRED banner.

## Session

- Listed only for current workspace cwd (`session.list`). The list includes a
  Session once it has started (first message or a live run), even if the JSONL
  file is not on disk yet. A blank unused create stays off the list.
- `session.open` accepts a live background Runtime in this workspace, or a path
  from `session.list`. Other paths are rejected (must switch workspace first).
- React owns a normalized, workspace-scoped Session Catalog. Page navigation does not clear it.
- Active Pi snapshots project `running`, `queued`, `idle`, `error`, or `inactive` state into the Catalog.
- Composer drafts are keyed by Session id, so switching pages or Sessions does not discard input.
- Host exposes one foreground AgentSession plus retained background runtimes. A workspace may keep at most five live AgentSessions (the foreground plus up to four background runtimes). Opening or creating another new runtime returns `SESSION_LIMIT`.
- Switching away from a busy Session parks it; idle Sessions are disposed. A settled background runtime emits `session.runtimeChanged` (`idle`) and is then released. The Session file remains the durable transcript.
- Background runtimes also emit `agent.event` with that Session's identity. They still do not emit `session.snapshot`. Desktop keeps a live `transcriptDrafts` entry per Session id (at most five, matching live runtimes). Switching back promotes the Host runtime and applies the Host snapshot only for revision, tools, and idle flags; the live `messages`/`entries`/`leafId` projection and `startedAt` come from the draft so the timer and Transcript tree stay continuous. After settle, the draft is dropped and reopen loads the Session file.
- Rehydrate after queue shed or Host reconnect restores only the foreground snapshot. Background drafts are discarded; switching back then uses the Host snapshot (timer and Transcript may reset).
- The sidebar shows a running indicator for live background Sessions, and the same green dot on any Workspace that still has a live Session. Stop, prompt, follow-up, and steer require the Session to be foreground.
- Final AgentSession disposal must emit `session_shutdown` before `AgentSession.dispose()`. Extensions use that event to release timers, watchers, and other work that captures the current extension context.
- Opening a still-running background Session promotes the existing Runtime, assigns a new Session revision, rebuilds the foreground snapshot, and migrates Extension UI identity without restarting the turn.
- `session.list` includes `runtimeState` and `sessionRevision`, allowing a reconnecting UI to rebuild the runtime status of foreground and retained background Sessions.
- Switching workspace parks the outgoing graph (including live Sessions) and keeps `agent.event` flowing under that graph's identity. `emitForIdentity` allows those parked runtime events (`agent.event`, `session.runtimeChanged`, `session.infoChanged`, `agent.queueChanged`) and drops other mismatched identities without throwing, so a mid-turn switch does not abort the SDK prompt or quiesce the Host. A busy parked graph keeps its model providers registered so the turn is not cut off. Coming back reactivates that graph. Package mutations on the current Workspace still return `AGENT_BUSY` while that Workspace has a live Session. If five other Workspaces are already running, a further switch returns `AGENT_BUSY`. Desktop does not project parked Sessions into the new Workspace's catalog, and it defers `session.list` / `session.open` until the switch lock is released.

## Agent commands

| UI action                                       | Method                                                                                             |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Send (idle)                                     | `agent.prompt`                                                                                     |
| Send (busy)                                     | `agent.followUp` or `agent.steer`, from Settings → General (`busySendBehavior`, default follow-up) |
| Stop                                            | `agent.abort`                                                                                      |
| Stop (compacting)                               | `agent.abortCompaction`                                                                            |
| Stop (retrying)                                 | `agent.abortRetry`                                                                                 |
| `/compact [instructions]` or Compact now        | `agent.compact`                                                                                    |
| Auto-compaction switch                          | `agent.setAutoCompaction`                                                                          |
| `/session` stats dialog                         | `session.getStats`                                                                                 |
| `/tree` dock panel                              | `session.getTree` / `agent.navigateTree`                                                           |
| `/fork` selector or tree fork button            | `session.getForkPoints` / `session.fork`                                                           |
| `/export [html\|jsonl]` or stats-dialog buttons | `session.export`                                                                                   |
| Tools panel                                     | `agent.getTools` / `agent.setActiveTools`                                                          |

Tool Result `addedToolNames` → Host publishes full `agent.toolsChanged` (no client-side tool schema invention).

The Composer's `/` completion merges `session.getCommands` (prompt templates,
extension commands, skills) with PiDeck's built-in commands
(`features/chat/builtin-commands.ts`, currently `/compact`, `/session`,
`/tree`, `/fork`, and `/export`). A
draft matching a built-in command runs locally instead of being sent to the
model; unknown `/name` text still goes to the model unchanged. Manual
compaction requires an idle agent and shares the per-session operation lock
with `agent.prompt`. The context-usage ring in the Composer opens a panel with
the usage breakdown, a Compact now action, and the auto-compaction switch.
`/session` opens a dialog with message, token, and cost aggregates from
`session.getStats`, which the Host builds from `AgentSession.getSessionStats()`
(whole-history aggregates, including compacted-away entries). `/tree` opens the
Tree page in the right dock: it renders `session.getTree` as conversation
turns only — tool results, model changes, and other bookkeeping entries are
collapsed, with hidden branch labels carried to their first visible
descendant and the current marker on the deepest visible row of the leaf
path. Clicking an entry calls `agent.navigateTree` (always
`summarize: false` — navigation is local, no LLM call), which shares the
per-session operation lock, requires an idle agent, and returns the rebuilt
snapshot plus optional `editorText` restored into the Composer draft. The
panel refetches on session identity changes, busy edges, navigation, and
manual refresh — never per streamed message, because every stable read
briefly takes the service graph lock. Tree, fork, and model-list requests
retry transient retryable failures (`SERVICE_GRAPH_BUSY`) through
`lib/bridge/request-retry.ts`.
`/fork` (also available as an inline button on the tree panel's user rows)
picks a user message from `session.getForkPoints`; `session.fork` then writes
a branched session file via `SessionManager.createBranchedSession` before that
message and reuses the standard `session.open` flow to switch to it, returning
the new snapshot plus the message text for the Composer draft.
`session.fork` also accepts `position: "at"`, which keeps history through the
given entry: each settled assistant turn in the transcript shows a fork
button (left of Copy) targeting the turn's last persisted entry
(`TranscriptRow.sourceEndId`). A fork of a named session is displayed as
`Fork · <source name>` (written into the forked file via
`appendSessionInfo`); unnamed sources stay unnamed so automatic titling
still runs. The tree panel groups a linear run of
assistant entries (tool-call segments) into one turn row whose navigation
target is the run's last entry; branch points break the run. Turns render as
a commit graph: filled dots are user turns, hollow dots assistant turns, the
current path is a continuous accent rail, and each concurrent branch gets its
own lane so fork connectors never overlap another branch's chain
(`flattenSessionTree` returns the lane layout). `/export` (idle-only) picks a
target through the native save dialog, `session.export` runs the SDK's
`exportToHtml` / `exportToJsonl`, and the desktop reveals the written file via
`desktop_open_path`; the Host advertises this as the `sessionExport`
capability. Unlike the CLI,
PiDeck does not emit `session_before_fork` to extensions, and the forked
session starts through the normal open path rather than a `session_start`
with reason `fork`. Forking before the first message is not supported.

## Queue transactions

- Queue state is a per-AgentSession `QueueSnapshot` with a monotonic revision.
- Edit, reorder, delete, and clear requests use compare-and-swap against the last
  rendered revision. A stale request is rejected without clearing the live queue.
- The Host suppresses the SDK's intermediate clear/re-add events and publishes one
  final `agent.queueChanged` snapshot for each logical transaction.
- Run Now is one `agent.runNow` RPC pinned to the originating Session. The Host parks
  the queue, aborts and settles the active run when necessary, starts the selected
  follow-up, then restores the remaining queue before responding.
- Queue text and queued image attachments are restored together. If an SDK enqueue
  fails, the response exposes the final queue and explicit restoration/partial-failure
  flags; the desktop never assumes the pre-request queue still exists.

## Extension UI

**Binding (current patched SDK):** Host calls only public

```ts
await session.bindExtensions({
  uiContext,
  mode: "rpc",
  invocationRunner,
});
```

`uiContext` implements the public `ExtensionUIContext` surface. Blocking dialogs,
`notify`, `setStatus`, `setWidget`, and `custom()` are wired; TUI chrome such as
`setFooter` / `setHeader` / `setEditorComponent` is a no-op. The Host never
touches private SDK setters. The full verb map is
[Extension UI surfaces](./extension-ui-surfaces.md).

The narrow SDK patch invokes `invocationRunner` around each registered tool and each
individual Extension event handler. PiDeck stores the resulting trusted `SourceInfo`
context in AsyncLocalStorage; slash commands reuse the same context with their resolved
command `sourceInfo`. The binding is reapplied before `session_start` on SDK reload.
Only a bounded opaque Extension ID, display name, source kind, and invocation metadata
reach Desktop; absolute Extension paths remain Host-local.

Blocking: select / confirm / input / editor via `extensionUi.request` + `extensionUi.respond`.  
Non-blocking: status, widget, notify.  
Cancel / timeout / session dispose → `undefined` (or confirm false).

Only a finite positive dialog timeout starts a Host timer and produces `timeoutMs` on
the request; an omitted timeout or `timeout: 0` remains pending until response, abort,
or lifecycle cleanup. Host-initiated termination emits `extensionUi.closed` with reason
`aborted`, `timed-out`, `disposed`, or `stale`. Desktop removes that request by ID from
the active slot or queue, so duplicate and late closes cannot dismiss unrelated work.

Blocking request presentation is Host-authoritative. Desktop persists
`extensionDecisionPresentation` and synchronizes it on `system.hello` plus the
Host-scoped `extensionUi.configure` method:

- `legacy-modal` is the fail-safe Host/migration default and immediate rollback; every request is Modal.
- `auto` is the new-install Desktop default and keeps ordinary active tool/command requests Inline when the surface is ready.
- `inline-first` also prefers Inline for other active origins after mandatory guards.

Those bullets describe the current implementation. The accepted
[Extension Deck](./extension-deck.md) target adds a global per-Extension
Follow Host / Inline / Modal preference, still resolved by Host after mandatory
ownership, risk, lifecycle, and surface-availability guards. Until that batch
lands, `legacy-modal` continues to mean every request is Modal.

An absent Desktop settings file opts into `auto`; a legacy file missing the field,
corrupt-settings recovery, or a Host without the Desktop handshake remains
`legacy-modal`. Trusted `tool_call` permission interceptors are Host-high-risk and
cannot be downgraded by Extension hints.

Stale owners are cancelled, background owners remain queued on their captured Session,
and high-risk, destructive, lifecycle, candidate, or unavailable-surface requests remain
Modal. Extension `opts.pideck.presentation` and `risk` values are hints and cannot lower a
Host safety decision. Custom transcript messages can
declare Extension Presentation v1 under `details.presentation`; agent-audience
coordination and other visible Extension activity join the assistant's execution
trace instead of splitting the conversation. Opening the trace reveals a quiet
Extension title row; opening that row reveals raw protocol and metadata. See
[Extension presentation](./extension-presentation.md) and
[Extension UI surfaces](./extension-ui-surfaces.md).

One tool or command invocation can issue multiple blocking dialogs. Host assigns the
requests one redacted `groupKey` and closes the group at the invocation boundary;
parallel invocations remain separate. Desktop keeps the existing Session FIFO request
queue and layers group state beside it, retaining only step kind/outcome metadata. An
Inline group therefore stays mounted across `select -> input` transitions without
storing or replaying the user's answer content.

Desktop derives per-Session waiting counts from the active request plus queue and
expires sidebar badges without synthesizing Host responses. The composer remains
editable but cannot submit during the active request or group waiting interval; its
draft survives and focus returns only for the same Session after settlement. Select
lists add filtering for long sets and virtualize at 100 options while returning the
original option ID.

Blocking requests and custom panels retain the Session identity captured by their
Host event, so a running background Session remains interactive without becoming
the RPC's active Session. Response, input, and resize RPCs use the `sessionTarget`
scope and must match the owner bound to their `requestId`; a foreign or stale call
has no side effects. When a background Runtime is promoted, the Host migrates the
dialog and custom-panel owners to the new Session revision. The desktop follows
that revision only when the foreground snapshot is for the same Session id, and
otherwise keeps the captured background target.

## Copy / keyboard

- Explicit Copy button copies full message.
- Standard `Ctrl+C` / `Ctrl+X` / `Ctrl+V` remain browser/WebView defaults (not overridden).
