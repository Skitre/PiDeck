# Extension UI surfaces

[English](./extension-ui-surfaces.md) | [简体中文](./extension-ui-surfaces.zh-CN.md)

This page inventories the Pi coding-agent **Extension UI verbs** (SDK 0.84.2) and
how PiDeck maps them today. It is the companion to
[Extension presentation](./extension-presentation.md), which covers the
declarative Presentation v1 contract, inline vs modal routing, and renderer
snapshots. Session identity, queues, and groups remain in
[Chat runtime](./chat-runtime.md).

This is not an implementation plan. A later Host-owned component library would
still start from these verbs.

## How to classify an Extension's UI

Classify **at call time** by the method the Extension invokes, not by scanning
its package for TUI look-alikes.

- `ctx.hasUI` is true in TUI and RPC (and in PiDeck). Dialogs and notifications
  are available.
- `ctx.mode === "tui"` is what the SDK documents as the guard for real terminal
  surfaces (`custom()`, widget factories, footer/header factories, live
  `onTerminalInput`).
- `ui.custom()` is opaque: the factory returns a `@earendil-works/pi-tui`
  component tree. The Host cannot tell a `SettingsList` from a handwritten
  `render()` without walking the live tree after construction.
- PiDeck is an **in-process Host**, not the SDK's JSON stdin/stdout RPC client.
  Binding uses `AgentSession.bindExtensions({ uiContext, mode: "rpc" })` in
  `packages/pi-host/src/extension-ui-bridge.ts`. Extensions therefore see
  `mode: "rpc"`, while the Host still implements `custom()` and widget factories
  with a VirtualTerminal. Do not assume SDK RPC-mode behavior (RPC drops
  factories and returns `undefined` from `custom()`).

## Verb inventory

Source of truth: `ExtensionUIContext` in `@earendil-works/pi-coding-agent`
(`dist/core/extensions/types.d.ts`). Dialog options are `signal` and `timeout`.
PiDeck additionally accepts an optional `pideck` hint on blocking dialogs
(presentation, risk, labels). Timeouts: `select` / `input` / `editor` resolve
`undefined`; `confirm` resolves `false`.

Status key:

- **Wired** — Host emits protocol events; Desktop has a surface.
- **Snapshot** — rendered to plain text / xterm frames; not a native control.
- **No-op** — accepted, ignored, or a stub return. Never touches private SDK
  setters.

### Blocking dialogs

These are structured. A Host-owned component library can map them without
inspecting a TUI tree. Upstream RPC treats the same four as request/response
dialogs.

| Method | TUI | Returns | PiDeck |
| --- | --- | --- | --- |
| `select(title, options, opts?)` | Focused list | `string \| undefined` | Inline card or modal |
| `confirm(title, message, opts?)` | Yes / no | `boolean` | Same |
| `input(title, placeholder?, opts?)` | Single-line field | `string \| undefined` | Same |
| `editor(title, prefill?)` | Multi-line editor | `string \| undefined` | Same (`pideck` hint still applied) |

Routing (`legacy-modal` / `auto` / `inline-first`), high-risk → modal, and
invocation origin are Host-authoritative. See
[Extension presentation](./extension-presentation.md).

### Fire-and-forget chrome

| Method | TUI | SDK RPC | PiDeck |
| --- | --- | --- | --- |
| `notify(message, info\|warning\|error)` | Toast-like notice | Event | Notification center |
| `setStatus(key, text\|undefined)` | Footer status slots | Event | Status strip |
| `setWidget(key, string[] \| factory, { placement? })` | Persistent strip above or below the editor (default `aboveEditor`) | String arrays only; factories dropped | Widget drawer; factories become **read-only** snapshots |
| `setTitle(title)` | Terminal / tab title | Event | **No-op** |

TUI string widgets are capped at **10 lines**
(`InteractiveMode.MAX_WIDGET_LINES`). PiDeck preserves `belowEditor` on the
event and treats any other placement as the default (above) slot.

### Streaming loader

All four are TUI loader chrome. SDK RPC and PiDeck are **no-ops**.

| Method | TUI |
| --- | --- |
| `setWorkingMessage(message?)` | Streaming loader copy |
| `setWorkingVisible(visible)` | Show / hide the loader row |
| `setWorkingIndicator(options?)` | Spinner frames |
| `setHiddenThinkingLabel(label?)` | Label for hidden thinking blocks |

### `custom(factory, options?)`

Replaces the editor (or shows an overlay) until the factory calls `done(result)`.
Options: `overlay`, `overlayOptions`, `onHandle`. The factory receives
`(tui, theme, keybindings, done)` and typically composes `@earendil-works/pi-tui`
primitives (`SelectList`, `SettingsList`, `Input`, `Editor`, `Loader` /
`CancellableLoader`, `Markdown`, `ScrollView`, `Box`, `HStack` / `VStack`,
`Text`, `TruncatedText`, `Image`, `Spacer`).

| Host | Behavior |
| --- | --- |
| TUI | Focused component; `handleInput` works |
| SDK RPC | Returns `undefined`; no frames |
| PiDeck | VirtualTerminal + xterm via `extensionUi.customFrame`; keyboard/resize forwarded to that session's custom request |

### Editor and TUI chrome

Mostly TUI-only. PiDeck stubs them so Extensions do not crash.

| Method | TUI | PiDeck |
| --- | --- | --- |
| `onTerminalInput(handler)` | stdin listeners **before** the focused component; `{ consume: true }` steals keys | Empty unsubscribe |
| `pasteToEditor` / `setEditorText` / `getEditorText` | Composer | No-op / `""` |
| `addAutocompleteProvider` | Stacks on the built-in provider | No-op |
| `setEditorComponent` / `getEditorComponent` | Replace the core editor | No-op / `undefined` |
| `setFooter` / `setHeader` | Replace TUI chrome | No-op |
| `theme` / `getAllThemes` / `getTheme` / `setTheme` | Live theme | Stub theme `pideck-stub`; `setTheme` returns `{ success: false }` |
| `getToolsExpanded` / `setToolsExpanded` | Tool-output expansion in the TUI transcript | Always `false` / no-op |

### Not `ctx.ui`, but it still changes pixels

| API | Role | PiDeck |
| --- | --- | --- |
| `pi.registerMessageRenderer` | Custom transcript body for a message type | Host renders collapsed/expanded **plain-text snapshots**; no Extension HTML |
| `pi.registerEntryRenderer` | Session-entry rendering | Same snapshot path where wired |
| `pi.registerMarkdownTransformer` | Markdown rewrite | Not a Desktop-owned HTML renderer |
| `pi.sendMessage` | Custom transcript messages | Presentation v1 when present; otherwise fallback / activity row |
| `pi.registerCommand` / `pi.registerShortcut` | Slash commands and keybindings | Command registry; see [Commands and menus](./commands-and-menus.md) |

`display: false` messages stay out of the reading flow. Combined with a
registered renderer they implement the **visible-anchor** pattern (a later
hidden message updates the renderer state for an earlier visible one).

## Input routing and `setWidget`

A widget is a **display slot**, not a focused control.

Pi TUI keyboard dispatch (`@earendil-works/pi-tui` `tui.js`):

1. `inputListeners` (this is `onTerminalInput`) run first. A listener may
   `{ consume: true }` or rewrite `data`.
2. Remaining input goes to `focusedComponent.handleInput`.

Interactive mode keeps focus on the **editor** unless a dialog or `custom()`
steals it. Widgets are `addChild`'d into `widgetContainerAbove` /
`widgetContainerBelow`. The TUI **never** `setFocus` on a widget, so a factory
`handleInput` is effectively dead.

RPC is narrower still: fire-and-forget string lines, no factories, no reply.

PiDeck factory widgets render into a VirtualTerminal whose `onData` is ignored.
The drawer shows a snapshot; it cannot type, focus, or act as a mini TUI.

| Want | API |
| --- | --- |
| Persistent summary | `setWidget` |
| Steal a few keys while idle | TUI: `onTerminalInput` / `registerShortcut`, then re-`setWidget` |
| Real I/O (lists, confirm, typing) | `custom` / `select` / `confirm` / `input` / `editor` |

Do not treat a widget as a draggable interactive TUI surface.

## Where PiDeck puts these verbs today

| Verb class | Desktop surface |
| --- | --- |
| Blocking dialogs | Inline request card in chat, or `ExtensionUiModal` |
| `notify` | Notification center |
| `setStatus` | Chat status strip |
| `setWidget` | Composer widget drawer (`ExtensionWidgets.tsx`); partitioned `aboveEditor` / `belowEditor` |
| `custom()` | xterm custom panel bound to the request's Session identity |
| Custom messages / renderers | Transcript: Presentation v1, execution-trace activity, or renderer snapshots |
| `setTitle`, loader APIs, editor chrome, `onTerminalInput` | Unused |

Background Sessions keep the Host identity captured on the request. Response,
input, and resize RPCs must match that owner.

## Case study: `pi-subagents`

Published **`npm:pi-subagents`** (user-scope Extension) is not SDK-builtin.
SDK `examples/extensions/subagent/` is a thinner `registerTool` + `exec` spawn
plus `ui.confirm` for project agents. Do not mix the two.

The published package is the fullest real-world use of the verbs above:

| Feature | API | TUI |
| --- | --- | --- |
| FleetView | `setWidget`, default `belowEditor` | Compact under-editor summary. Arrow-key browsing is **not** widget focus; it uses `onTerminalInput` / shortcuts, then redraws the widget |
| Fleet inspector | `ui.custom()` (`/subagents-fleet`, also a shortcut) | Focused TUI: select child, transcript, steer, confirm stop |
| Doctor | `registerMessageRenderer` + `sendMessage` | Visible message; a **hidden** follow-up (`display: false`) updates the same renderer |
| Supervisor prompt | `sendMessage` `customType: "subagent_supervisor_request"` | Agent-protocol text in the transcript, not a clickable control |
| Slash results | custom type + renderer | Transcript |
| Stop picker / confirm | `select` / `confirm` | Dialogs |
| Edit agent prompt | `editor` | Dialog |
| Failed / paused complete | `notify` | Success stays quiet |
| RPC hosts | widgets whose lines start `PI_SUBAGENT_*_JSON:` | Transport for RPC clients; **do not** render those lines as user widgets |

PiDeck today has **no FleetView and no fleet inspector**. Transcript coverage:

- Legacy `subagent_supervisor_request` → Presentation v1 `audience: "agent"`
  activity in the execution trace. Do **not** parse `Reply with:`.
- Doctor-style hidden-message renderer snapshots; Desktop matches the live tail
  by `messageIndex`, persisted rows by entry ID.
- The extension-compat matrix mimics a subset of verbs; it is not the published
  package.

Subagents remain an **SDK non-goal** for PiDeck product scope (see
`docs/history/2026-07-30-product-ux-review.md`). Compatibility is
transcript-and-dialog fidelity, not cloning the TUI fleet UI.

## Notes for the Host-owned mapping

> **Accepted target (2026-08-22):** [Extension Deck](./extension-deck.md)
> defines the implementation contract for Host-owned Extension surfaces and
> global per-Extension presentation settings. The broader
> [Deck](./deck.md) pane-workspace proposal is superseded and must not be
> implemented. The notes below are kept for the original reasoning.

If PiDeck later redraws Extension UI “the Pi way” (Host-owned components, not
Extension-shipped HTML/React):

1. Map **verbs → components**, then a **placement registry** (inline card, modal,
   status, widget drawer, custom panel, later in-window overlay). One TUI verb
   can land in more than one PiDeck slot.
2. Keep Presentation v1, inline/modal policy, invocation origin, and high-risk →
   modal.
3. Keep `custom()` on a dual path: optional walk of the live `pi-tui` tree for
   known components (`SettingsList`, `SelectList`, …); otherwise keep xterm.
4. Prefer **in-window overlay** before OS-level extra windows. Desktop already
   has native child webviews for HTML-ish modals (`browser_surface`).
   Out-of-window floating is desktop-native, not a TUI verb.
5. Do not invent interactivity for `setWidget`. If a dashboard needs keys, that
   is `onTerminalInput` / a command in TUI, and a Host control (button, shortcut)
   in PiDeck — not a focused widget.

Suggested order of work, if taken up: verbs → components → placement registry →
`custom()` dual path → in-window float → OS windows last.

## Non-goals (current)

- Shipping a Composer **tools panel** for `defaultTools` / `agent.getTools` /
  `agent.setActiveTools`. Protocol methods can stay; the panel is not part of
  this surface map.
- Executing Extension HTML, CSS, or React in the transcript or widget drawer.
- Treating widget factories as mini interactive TUIs or draggable TUI windows.
- Statically detecting “this package looks like a TUI”.
- Productizing FleetView / fleet inspector as first-party PiDeck chrome.

## Implementation pointers

| Layer | Path |
| --- | --- |
| SDK types | `@earendil-works/pi-coding-agent` `ExtensionUIContext` |
| TUI widgets / focus | `interactive-mode.js` `setExtensionWidget`, `renderWidgetContainer` |
| TUI input | `pi-tui` `tui.js` listeners then `focusedComponent` |
| Host bridge | `packages/pi-host/src/extension-ui-bridge.ts` |
| Routing policy | `packages/pi-host/src/extension-ui-policy.ts` |
| Desktop widgets | `apps/desktop/src/features/chat/ExtensionWidgets.tsx` |
| Desktop modal | `apps/desktop/src/features/chat/ExtensionUiModal.tsx` |
| Supervisor adapter | `apps/desktop/src/features/chat/transcript-model.ts` |
