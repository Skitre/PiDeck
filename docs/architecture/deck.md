# Deck — superseded whole-window pane workspace

> **Status: superseded historical alternative (2026-08-22). Do not
> implement.** Product review rejected this page's whole-window pane workspace,
> movable builtins, and session/workspace layout persistence. The accepted
> target is [Extension Deck](./extension-deck.md), which keeps Sidebar, Chat,
> RightDock, and builtin Dock tabs fixed and stores one global presentation
> profile per Extension. This page remains only as a record of the broader
> alternative.

## Why

Pi's contract is that Extensions declare semantic intent and the host owns the
pixels. The TUI is one **fixed projection** of that intent stream. PiDeck today
re-hardcodes a different fixed projection: each verb is welded to a single
surface (`setWidget` → composer drawer, `custom()` → dock tab, decisions →
inline card or modal). The Deck replaces the weld with a **recomposable
projection**:

- Every UI intent becomes a typed **view**.
- A view is painted by a host-owned **renderer** (one type may have several).
- Views mount into **panes**; panes live in a user-arranged layout of splits,
  tab groups, and floating panels.
- Defaults reproduce the TUI-faithful layout. Everything beyond the safety
  rails can be re-projected by the user and is remembered per project.

The second half of the design: **built-in panels and Extension views are the
same primitive.** Files, session tree, Git changes, terminals, and the session
list are views like any Extension widget — one layout system for the whole
window (the Obsidian workspace model). Extensions need zero changes and remain
unaware of any of this.

Naming: the system is called the **Deck** — the whole window's pane layout.
"Workspace" is taken (a project folder), "Dock" is the legacy right rail this
design absorbs. The app name finally earns itself.

## The end state in one scenario

`pi-subagents`, unmodified: its FleetView widget floats as an always-visible
HUD in the top-right corner, exactly where you left it last week in this
project. `/subagents-fleet` opens its `custom()` terminal centered as a large
overlay (the Extension signals `overlay: true`), beside or atop the chat as you
prefer, remembered across sessions. Its low-risk selects appear inline in the
chat flow as today — or, if you prefer, collect in a Requests pane you keep
docked bottom-left. A high-risk confirm still takes the modal layer and cannot
be re-routed. None of this required a line of code from the Extension.

## Vocabulary

| Term | Meaning |
| --- | --- |
| Deck | The window layout: three regions + float layer + modal layer, persisted per project workspace |
| Region | `left` / `main` / `right`. Left/right are collapsible; main is never empty |
| Container | A `split` (row/column, weighted) or `tabs` node inside a region's tree |
| Pane | Leaf node; hosts exactly one view |
| View | A typed, identity-keyed content unit — builtin or Extension |
| Renderer | Host-owned painter for a view type; registry allows several per type |
| Anchor | A named in-chrome slot inside a host view (e.g. the composer strips) |
| Layout memory | `ViewKey` → last home (container path or float rect), size, renderer |

## View model

A closed union. All rendering is host code; Extensions supply data only.

| View | Cardinality | Scope | Native | Float | Closable |
| --- | --- | --- | --- | --- | --- |
| `chat` | singleton | app | no | no | no |
| `sessions` | singleton | app | no | yes | yes |
| `files`, `sessionTree`, `gitChanges` | singleton each | workspace | no | yes | yes |
| `requests` | singleton | app | no | yes | yes |
| `shell:N` | many | workspace | no | yes | yes |
| `browser:N` | many (≤ 8) | workspace | **yes** | **no** | yes |
| `ext.widget` | per `origin:key` | session | no | yes | via SDK (`setWidget(key, undefined)`) |
| `ext.status` | singleton aggregate | session | no | yes | follows content |
| `ext.terminal` | ≤ 1 (`custom()`) | session | no | yes | via `done()` / cancel |
| `ext.decision` | ≤ 1 active + queue | request lifecycle | no | low-risk only | via respond/expiry |

Notifications are deliberately **not** views. `notify` is a transient signal
with no spatial identity; the toast stack and notification center are unchanged
by this design.

`chat` is a non-closable singleton: the session runtime is single-active
(hydration, event routing, Extension UI alignment all assume one current
session). The Deck tree places no structural restriction — a second chat pane
is expressible — but lifting the singleton is a session-runtime project, not a
layout project. See Non-goals.

### View identity

Layout memory needs a stable key:

- Singleton builtins use fixed ids (`chat`, `files`, `sessions`, …).
- Multi-instance builtins use an opaque stable instance id assigned and
  persisted by their owning runtime (`shell:<instanceId>`,
  `browser:<instanceId>`). An ordinal position such as `shell:3` is never an
  identity: closing or reordering siblings must not move layout memory to a
  different instance.
- Extension views: `ext:<originId>:<verb>[:<key>]`, where `originId` is the
  trusted opaque origin already used on decision requests. Key derivation uses
  stable package/provider identity and excludes invocation ids, request ids,
  epochs, and other per-run values.

**Protocol delta:** two optional fields, both emit-site additions with zero
breaking change.

1. **`origin`** (same shape as decision-request origin) on
   `extensionUi.widgetChanged` and `extensionUi.statusChanged`. Emitted in
   `publishWidget` / `setStatus` (`extension-ui-bridge.ts`), where binding
   identity and the invocationRunner's ambient invocation are in scope; fall
   back to package identity. Widgets/statuses replay from the bridge's
   replayable state on rehydrate, so origin rides recovery with no extra work.
   Events without origin (legacy) key on widget key alone — collision remains
   last-writer-wins.
2. **`overlay?: boolean`** on `extensionUi.customStarted`. Emitted where the
   VirtualTerminal opens; the Extension's `custom()` call already carries
   `overlay` in its opts. When true, default the terminal view to a centered
   float (TUI-faithful: the TUI shows it as a centered overlay); when false or
   absent, default to right-region tab (continuity with today's dock).
   User-moved layout memory overrides the default on re-entry.

### View instance lifecycle

The implementation keeps four concerns separate; no store object is allowed to
silently stand in for more than one of them:

| Concern | Lifetime | Responsibility |
| --- | --- | --- |
| View definition | app | type, capabilities, renderer list, default home, minimum size, instance cap and inactive policy |
| View instance | content owner | the currently live data and owner-specific close/end action |
| View placement | while mounted | exactly one anchor, pane, float, or Host-policy modal for a live `ViewKey` |
| View memory | workspace | last valid home, preferred size, renderer, and last-seen time; may outlive the instance |

A live `ViewKey` mounts at most once across regions, floats, anchors, and the
modal layer. Modal placement is selected by Host policy and is never a
remembered `ViewHome`. When an owner ends a view (`setWidget(key, undefined)`,
terminal `done()`, decision response/expiry, builtin close), the active
placement is removed and the tree is normalized, but its memory remains.
Reappearance resolves memory first and falls back to the view definition's
default home if the remembered container no longer exists or is no longer
legal.

User close is offered only when the view definition supplies an owner-correct
close action; removing a pane never merely hides a still-live Extension
request. Session switching atomically removes all session-scoped instances and
their active placements, normalizes once, and retains their workspace-scoped
memory. There are no persisted empty panes or placeholder tabs for absent
Extension content.

## Renderer registry

`(view type) → renderer list`, all host-implemented, chosen per view and
persisted in layout memory. Renderers declare minimum size and compact/full
form so containers can pick sensible defaults.

| View type | Renderers (initial) | Notes |
| --- | --- | --- |
| `ext.widget` | `strip` (bounded line rows, for anchors), `panel` (full text panel) | today's drawer content becomes `panel`; a temporary compatibility renderer hides content matching `^PI_SUBAGENT_.*_JSON:` (machine transport, RPC passthrough), fixing the pre-existing raw-line bug |
| `ext.terminal` | `xterm`; later `structured` | `structured` walks known `pi-tui` trees (`SettingsList`, `SelectList`, …) into native controls, unknown trees stay xterm — the dual path from the surfaces doc becomes a registry entry, not a special case |
| `ext.decision` | `card` | one implementation; the shell (inline / pane / float / modal) comes from placement |
| `ext.status` | `strip`, `list` | |
| builtins | their existing single renderers | |

## Placement space and defaults

**The default Deck preserves today's builtin window layout and chrome
pixel-for-pixel.** That is the compatibility acceptance property for chat,
sidebar, right-dock builtins, sizing, and region visibility. Extension UI has
one intentional default change: widgets move from PiDeck's popover drawer to
their TUI-faithful composer anchors. That change is tested against the placement
table below and is not treated as a visual regression.

| View | Default | Also valid |
| --- | --- | --- |
| `chat` | main | any position inside main splits |
| `sessions` | left region | tabs / splits / float |
| `files` / `sessionTree` / `gitChanges` | right-region tabs | anywhere incl. float |
| `shell` | right-region tabs | splits incl. main (beside chat) |
| `browser` | right-region tabs | splits only — native, never floats |
| `ext.widget` | anchored above/below composer per SDK placement hint, `strip` renderer | pane anywhere, float HUD, `panel` renderer |
| `ext.status` | anchored above composer (today's strip) | pane / float |
| `ext.terminal` | right-region tab (continuity) when `overlay` absent/false; **centered float** when `overlay: true` (TUI-faithful) | main split beside chat; user-moved position persists via layout memory |
| `ext.decision` (inline) | anchored in chat flow | requests pane, float — low-risk only |
| `ext.decision` (modal) | modal layer | — (not user-movable) |

Anchors: the chat pane exposes named slots (`aboveComposer`, `belowComposer`,
`requestFlow`). Anchored views get bounded height with an expand affordance;
"promote to pane/float" is the gesture that leaves the anchor, and layout
memory records it as a first-class anchor home. The SDK's `aboveEditor` /
`belowEditor` hint selects the default anchor — **TUI-faithful**: widgets sit
where the TUI puts them. The current popover drawer disappears; it was a
workaround, not a contract.

## Decisions and policy — what the Deck may not change

The Host stays authoritative for `presentation`, `risk`, and `routeReason` as
specified in [Extension presentation](./extension-presentation.md). Deck
mapping:

- `presentation: "modal"` → modal layer: focus-trapped, top of the z-ladder,
  **not** draggable, dockable, or re-routable. High-risk and session-lifecycle
  requests keep landing here by Host policy regardless of user layout.
- `presentation: "inline"` → chat `requestFlow` anchor by default. The user may
  re-home an origin's low-risk decisions to the `requests` pane or a float;
  the inline anchor then shows a one-line stub pointing at the live card.
- Layout memory for decisions keys on **origin**, never `requestId`.

Group continuity (one card shell across sequential questions), composer
blocking through group intervals, expiry-driven queue advance, ownership and
epoch guards, the respond lifecycle: unchanged verbatim. The Deck only decides
where the card mounts.

## Layout engine

Persisted shape (per project workspace):

```ts
type DeckNode = SplitNode | TabsNode | PaneNode;
type SplitNode = { kind: "split"; id: string; direction: "row" | "column"; children: DeckNode[]; sizes: number[] };
type TabsNode = { kind: "tabs"; id: string; children: PaneNode[]; activeId: string };
type PaneNode = { kind: "pane"; id: string; view: ViewKey; renderer?: RendererId };

type AnchorSlot = "aboveComposer" | "belowComposer" | "requestFlow";
type ViewHome =
  | { kind: "anchor"; host: "chat"; slot: AnchorSlot; order?: number; renderer?: RendererId }
  | { kind: "container"; containerId: string; index?: number; preferredSize?: Size; renderer?: RendererId }
  | { kind: "float"; rect: Rect; pinned?: boolean; renderer?: RendererId }
  | { kind: "default"; renderer?: RendererId };
type ViewMemory = { home: ViewHome; lastSeenAt?: number };

type DeckLayout = {
  version: 1;
  regions: { left: DeckNode | null; main: DeckNode; right: DeckNode | null };
  floats: Array<{ id: string; node: TabsNode | PaneNode; rect: Rect; pinned?: boolean }>;
  anchors: Record<AnchorSlot, ViewKey[]>; // live mounts only; absent views live in memory, not here
  memory: Record<string /* ViewKey */, ViewMemory>;
};
```

Homes refer to stable container ids, never structural array paths: normalization
may change paths at any time. If a referenced container disappears, placement
falls back to the view definition's default rather than recreating dead tree
structure.

Tree invariants are enforced by pure ops and again by the persistence validator:
no empty containers after a close (normalize collapses single-child
splits/tabs), split weights are finite and sum to 1, a tabs node keeps ≥ 1
child and names an existing active child, ids and live `ViewKey`s are unique,
and main contains the singleton chat. A native-backed view can never occur in a
float or anchor. Rects are clamped to the current viewport. Implementation
constants bound node count, nesting depth, float count, and serialized memory;
layouts beyond those bounds are corrupt input, not work for the renderer.

Interaction:

- **One command layer** owns all mutations (`moveView`, `splitPane`,
  `floatView`, `closeView`, `activateView`, `resizeContainer`). Pointer drag,
  menus, and keyboard bindings call the same pure operations and therefore
  share normalization, policy checks, and tests.

- **Drag** a pane tab → drop zones: tab-bar insert, pane edge N/S/E/W split,
  region edge, or detach to float (drop outside any zone).
- **Floats**: title-bar move, edge resize, viewport snapping, per-float
  z-order, optional pin.
- **Keyboard parity** for every gesture, registered in the existing command
  registry (a future command palette inherits them for free): focus next/prev
  pane, move view to region/float, split, close, resize; `dock.activate.N`
  generalizes to the focused tabs container; `mod+b` / `mod+j` become region
  toggles.
- **Focus**: one focused pane. Existing keymap semantics carry over unchanged —
  `.xterm` gating (`worksInTerminal`), `chat.stop` Escape via the
  `.chat-composer-input` selector, overlay blocking.
- **Panes stay mounted** while their instances are live in the tree; background
  tabs hide, never unmount. Renderer definitions declare an inactive policy and
  instance cap before migration. Browser instances retain the ≤ 8 cap and hide
  their native surface when inactive. Xterm renderers may pause painting but
  the Deck never suspends or kills a shell process implicitly; the shell owner
  remains responsible for its process budget and close semantics. Terminal
  scrollback and browser state survive tab switches, as today.
- **Accessibility** carries the repo's existing patterns: `tablist`/`tabpanel`
  roles, `role="separator"` resize handles with ARIA values, floats as labelled
  non-modal dialogs, focus restored to a neighbor on close, reduced-motion
  respected.

Persistence: `DeckLayout` lives in DesktopSettings per project workspace (same
store as recent locations), schema-versioned. Load validates version, node and
view uniqueness, active tab references, weights, bounds, legal placement, main
chat presence, and resource limits before any renderer mounts. Corrupt or
unknown versions reset to the default Deck (fail-safe, matching the
settings-recovery culture). The legacy `pideck.dock.width.v1` and sidebar/dock
open preferences are imported once.

**Content is session-scoped, layout is workspace-scoped**: widgets, statuses,
and the custom terminal clear on session switch (SDK semantics), but a
re-appearing `ViewKey` re-mounts at its remembered home and size. Absent
dynamic-view memory is bounded to 256 entries per workspace; overflow prunes
the least-recently-seen entries and never prunes live views or singleton
builtins.

Z-ladder: panes < float layer < modal layer and dialogs < toasts < context
menus.

## Native surfaces

Browser panes are Tauri child webviews and composite **above all HTML**. Rules:

1. Native-backed views live in tabs/splits only — never the float layer (a
   floating native surface would occlude every overlay).
2. The Deck registers live native rects as **exclusion zones**; float drag
   snaps out of intersection, with a visual hint during the drag.
3. The Deck owns a reference-counted **native occlusion guard**. The modal
   layer, Settings, and any HTML dialog that must cover a native rect acquire
   the guard; the first acquire hides native surfaces (`webview.hide()`), and
   only the final release restores currently visible browser panes. Nested or
   rapidly replaced dialogs therefore cannot reveal a webview early. This fixes
   the long-standing "browser covers modals" hole as a side effect of the Deck
   owning both layers.
4. OS-level extra windows stay out of scope. A float panel is the natural unit
   to eject later; nothing in this design depends on it.

## The cut line — invariants preserved

Everything below the view layer is untouched: Extension UI request ownership,
epoch and session alignment, decision groups and expiry, the respond lifecycle,
VirtualTerminal input/resize identity checks, Host routing policy including
`extensionDecisionPresentation` modes, and the provider/package/session
runtimes. Presentation v1 rows and renderer snapshots remain **transcript-owned**
— transcript rows are conversation, not panes. (A later "pop out from a
transcript anchor row" gesture is compatible but not designed here.) The
protocol delta is exactly the two optional fields above: `origin` on two
widget/status events, and `overlay` on `customStarted`.

## What gets deleted

- `ExtensionWidgetsPopover` and its anchor-geometry machinery
  (`calculateWidgetPopoverLayout` and friends).
- `ExtensionUiModal`'s bespoke shell (the modal layer hosts the decision
  `card`).
- `InlineExtensionUiRequest`'s bespoke mount (the `requestFlow` anchor hosts
  the same card).
- `RightDock` — component, `DockTabId`, width/open preferences (imported once).
- The `Sidebar` shell — the session list becomes the `sessions` view.
- Per-surface special cases in `App.tsx`.

Settings stays a full-window overlay page, not a pane, and acquires the Deck's
native occlusion guard while visible. `NavPage` shrinks to `chat` / `settings`.

## Build order

The end state above is reached in four independently green batches, beginning
with a preparatory vertical slice. Each passes `verify:quick`; incomplete UI
stays behind a feature flag, while every cutover batch is independently
shippable:

0. **Model and thin vertical slice.** Land stable `ViewKey`, definition /
   instance / placement / memory separation, `ViewHome`, the mutation command
   layer, tree normalization, and the persistence validator. Exercise them with
   chat, sessions, and one ordinary HTML builtin before rich gestures or
   Extension data. Tests cover close/reopen, missing remembered containers,
   duplicate rejection, corrupt recovery, and atomic session-scoped teardown.
1. **Deck core interactions.** Containers, drag-and-drop (hand-rolled
   on pointer events — no new UI dependency, consistent with the zero-library
   component culture), floats, keyboard parity, persistence, native-zone
   plumbing, and the native occlusion guard. No Extension data yet. Pointer and
   keyboard DOM tests assert the same command results.
2. **Extension views cut over,** family by family: widget → terminal →
   decision. Each family's legacy shell is deleted as it lands. The decision
   family keeps a one-release fallback to the legacy shells (same rollback
   culture as `legacy-modal`). The Host `origin` and `overlay` fields land
   first.
3. **Builtins migrate** (sessions, files, tree, changes, shells);
   `RightDock`/`Sidebar` are deleted; browser goes last under the native
   rules; the one-time preference import runs.

## Decisions recorded here (veto in review)

| Decision | Rationale |
| --- | --- |
| Chat pane is a non-closable singleton | Session runtime is single-active. The Deck leaves the multi-chat seam open; lifting it is a runtime project, not layout. |
| Definition, instance, placement, and memory are separate | Session-scoped content can disappear without leaving ghost panes, while workspace layout memory survives and can be validated independently. |
| Multi-instance ids are opaque and stable | Ordinal ids transfer remembered layout to the wrong shell/browser after close or reorder. |
| `requests` builtin pane | Gives re-homed low-risk decisions a dockable home; the inline anchor stays the default. |
| A reference-counted occlusion guard hides native webviews | The only sound fix for native-over-HTML overlays; reference counting preserves correctness across nested modals, dialogs, and Settings. |
| Anchors replace the widget drawer | TUI-faithful defaults; the drawer was a geometry workaround, not a contract. |
| Notifications stay out | Transient signal, no spatial identity (user decision, 2026-08-21). |
| Name "Deck" | "workspace" and "dock" are taken; the app name finally means something. |
| Widget transport filter is temporary compatibility policy | `^PI_SUBAGENT_.*_JSON:` content → non-visual renderer fixes the pre-existing PiDeck bug, but content sniffing is not a general renderer contract. Replace it later with explicit transport metadata or bridge-side suppression under a separately reviewed protocol change. |
| Terminal `overlay` hint in `customStarted` | TUI-faithful: `overlay: true` defaults to centered float, matching the TUI's centered overlay appearance (validated via pi-subagents fleet inspector, 2026-08-21). |

## Non-goals

- Extension-shipped HTML/CSS/React/components. Renderers are host-owned —
  that is Pi's contract, and this design changes *where* and *how*, never
  *who*.
- Inventing interactivity for widget **content**. Containers are interactive
  (drag, resize, place); widget content stays read-only. Real I/O remains
  dialogs, `custom()`, and commands.
- Multiple live chat sessions in one window (runtime capability, not layout —
  the seam is documented above).
- OS-level extra windows.
- Notification/toast redesign.
- Statically detecting "TUI-looking" packages; everything keys off verbs at
  call time.

## Implementation pointers (current code this design touches)

| Layer | Path | Fate |
| --- | --- | --- |
| Widget drawer | `apps/desktop/src/features/chat/ExtensionWidgets.tsx` | replaced by anchors + `ext.widget` views |
| Decision modal | `apps/desktop/src/features/chat/ExtensionUiModal.tsx` | shell replaced by modal layer |
| Inline decision | `apps/desktop/src/features/chat/InlineExtensionUiRequest.tsx` | replaced by `requestFlow` anchor |
| Right rail | `apps/desktop/src/components/RightDock.tsx` | absorbed by right region |
| Left rail | `apps/desktop/src/components/Sidebar.tsx` | becomes the `sessions` view |
| Extension UI state | `apps/desktop/src/lib/stores/extension-ui-state.ts`, `app-store.ts` | kept; views ingest from it |
| Host bridge (emit sites for `origin`) | `packages/pi-host/src/extension-ui-bridge.ts` | small addition |
| Routing policy | `packages/pi-host/src/extension-ui-policy.ts` | unchanged |
| Native webviews | `apps/desktop/src-tauri/src/browser_surface.rs` | exclusion zones + modal hide |
