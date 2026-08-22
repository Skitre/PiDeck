# Extension Presentation

PiDeck supports a declarative Extension Presentation v1 contract for custom
messages and blocking Extension UI requests. The contract carries semantics and
copy, not Extension-owned HTML, React components, CSS, colors, or executable
actions. The SDK verb map (`select`, `setWidget`, `custom()`, and the rest) lives
in [Extension UI surfaces](./extension-ui-surfaces.md).

> **Implementation status (2026-08-22):** Presentation v1 and the global Host
> routing modes are implemented. The per-Extension blocking-dialog override
> contract in “Host routing modes” is the accepted, not-yet-implemented
> [Extension Deck](./extension-deck.md) delta. It must land protocol-through-Host
> in one batch; Desktop-only routing is not an intermediate state.

## Custom messages

Put presentation metadata under `details.presentation`. This works with the
public SDK `sendMessage` shape and keeps the raw message available for agent
context and diagnostics.

```ts
await ctx.sendMessage({
  customType: "worker_progress",
  content: "Internal worker protocol payload",
  display: true,
  details: {
    presentation: {
      version: 1,
      extensionId: "worker-extension",
      sourceLabel: "Workers",
      audience: "user",
      kind: "progress",
      status: "running",
      correlationId: "run-42",
      groupKey: "run-42",
      title: "Reviewing the workspace",
      summary: "Two of four checks are complete.",
    },
  },
});
```

PiDeck also accepts `presentation` at the top level when a producer controls the
serialized message directly. `details.presentation` is the portable SDK path.

Presentation fields:

| Field              | Values / purpose                                                      |
| ------------------ | --------------------------------------------------------------------- |
| `version`          | Must be `1`                                                           |
| `extensionId`      | Stable Extension identifier                                           |
| `audience`         | `user` or `agent`                                                     |
| `kind`             | `activity`, `progress`, `decision`, `result`, or `warning`            |
| `correlationId`    | Stable identifier for this logical event or request                   |
| `sourceLabel`      | Optional user-facing Extension name                                   |
| `status`           | `pending`, `running`, `resolved`, `cancelled`, `expired`, or `failed` |
| `severity`         | `neutral`, `info`, `warning`, or `danger`                             |
| `groupKey`         | Optional identifier for related events                                |
| `title`, `summary` | Bounded plain text shown for `audience: "user"`                       |
| `actionRequestId`  | Reference to a live decision request; never executable by itself      |
| `technicalDetails` | JSON shown only after opening the Extension title row                 |

`display: false` always wins and keeps the message out of the transcript. For
`audience: "agent"`, PiDeck ignores presentation title and summary in the main
reading flow. Visible Extension activity is collected into the surrounding
assistant execution trace, so it does not create a second Pi avatar or usage
footer. Opening the trace reveals a quiet Agent coordination or Extension title
row; opening that row reveals raw content, custom type, and metadata without a
separate "Technical details" control.

A custom message with `kind: "decision"` is historical, read-only presentation.
Live controls must come from an Extension UI request so ownership, expiry, and
stale revision checks remain enforceable.

Unknown or invalid visible custom messages use a neutral, closed fallback. They
are not discarded, but they do not receive trusted semantic styling and remain
inside the same execution-trace flow.

### Registered message renderers

For existing Extensions that register a Pi message renderer, PiDeck projects the
renderer into a bounded, read-only transcript snapshot. Host renders both collapsed
and expanded modes at a fixed terminal width, removes terminal control sequences,
and sends plain text lines to Desktop. Declarative Presentation v1 remains the first
choice and takes precedence when both forms are available.

Renderer snapshots are refreshed when the Session changes and when Extension UI
activity indicates that in-process renderer state may have changed. This supports
the visible-anchor pattern used by commands such as `pi-subagents`'
`/subagents-doctor`, where a hidden final message updates the renderer state for an
earlier visible message. Desktop can expand differing full output but never executes
renderer-owned actions or accepts Extension HTML, CSS, or components. A missing or
failing renderer falls back to the neutral custom-message presentation.

Each renderer snapshot can also carry its position in the current context-message
projection. Desktop uses that position only for the live message tail, before the
next Session entry snapshot exposes the persisted entry ID. Persisted rows remain
keyed by entry ID, so repeated or parallel Extension messages are never matched by
content, timestamp, or private metadata.

## Blocking requests

Dialog options can suggest a surface with the PiDeck namespace. The value is a
hint; the Host resolves the final presentation under the configured rollout mode:

```ts
const approved = await ctx.ui.confirm(
  "Apply the generated migration?",
  "This changes the local database schema.",
  {
    timeout: 120_000,
    pideck: {
      presentation: "inline",
      sourceLabel: "Migration review",
      correlationId: "migration-42",
      risk: "high",
    },
  },
);
```

The timeout above is explicit. Omitting `timeout`, or passing `timeout: 0`, leaves the
request pending until it is answered, aborted, or closed by Session lifecycle cleanup;
PiDeck does not add a default timeout.

`sourceLabel` is Extension-controlled presentation copy, not identity. For standard
blocking requests, Host captures the active command, registered tool, or individual
event handler and attaches a trusted `origin`. Desktop displays the Host-derived
Extension name when available and uses `sourceLabel` only for legacy or unknown-origin
requests. Origin IDs are opaque hashes; absolute package and Extension paths are never
sent over the protocol. Trusted invocation kind participates in Host routing; package
names, titles, option labels, and `sourceLabel` do not.

The same `pideck` object is supported by `select`, `input`, and the optional
third argument added to `editor`. Supported fields are:

```ts
interface PiDeckExtensionUIDialogOptions {
  // Hints only; Host publishes the final presentation and risk.
  presentation?: "inline" | "modal";
  sourceLabel?: string;
  correlationId?: string;
  risk?: "normal" | "high";
  allowFreeform?: boolean;
  optionDetails?: Array<{
    id: string;
    description?: string;
    destructive?: boolean;
  }>;
}
```

Standard SDK select values are used as both IDs and labels. Option metadata is
merged only when `optionDetails.id` exactly matches a sanitized select value.
`destructive: true` raises effective risk and cannot be neutralized by
`risk: "normal"`.

```ts
await ctx.ui.select("Choose a cleanup mode", ["keep", "delete"], {
  pideck: {
    presentation: "inline",
    allowFreeform: true,
    optionDetails: [
      {
        id: "delete",
        description: "Remove generated files permanently",
        destructive: true,
      },
    ],
  },
});
```

PiDeck strips terminal controls, bounds presentation strings, ignores unknown
metadata, and emits only protocol-whitelisted fields. Other UI modes ignore the
optional `pideck` namespace. Extensions compiled against an unpatched upstream
declaration need the PiDeck type extension (or an equivalent local type
intersection) even though the runtime option is backward compatible.

### Host routing modes

`extensionDecisionPresentation` is a Desktop setting synchronized to Pi Host:

| Mode           | Behavior                                                                             |
| -------------- | ------------------------------------------------------------------------------------ |
| `legacy-modal` | Fail-safe Host fallback; requests without a per-Extension override use Modal         |
| `auto`         | New-install default; active ordinary tool/command requests use Inline when available |
| `inline-first` | Prefer Inline for other active origins after mandatory guards                        |

Only a Desktop settings store with no existing file starts in `auto`. Legacy settings
that predate the field and corrupt-settings recovery remain `legacy-modal`; Pi Host also
starts in `legacy-modal` until a Desktop handshake explicitly configures it. Existing
explicit user choices are preserved.

Extension Deck adds one Host-consumed, per-Extension override contract:

```ts
type ExtensionDialogPresentationPreference = "followHost" | "inline" | "modal";

type ExtensionDialogPresentationOverrides = Record<
  string, // trusted opaque ExtensionId
  ExtensionDialogPresentationPreference
>;

type ExtensionUiConfigureParams = {
  extensionDecisionPresentation: ExtensionDecisionPresentation;
  extensionDialogPresentationOverrides: ExtensionDialogPresentationOverrides;
};

type ExtensionUiConfigureResult = ExtensionUiConfigureParams;

type SystemHelloExtensionUiParams = {
  extensionDecisionPresentation?: ExtensionDecisionPresentation;
  extensionDialogPresentationOverrides?: ExtensionDialogPresentationOverrides;
};
```

Desktop derives this bounded map from the canonical global Extension profiles and
sends it in the initial `system.hello` when settings are available and with every later
`extensionUi.configure`; it does not send the rest of DesktopSettings. The configure
request replaces both Host values atomically and returns the accepted pair. Hello
omission retains the fail-safe values. Unknown preferences, unknown fields, empty IDs,
IDs longer than `MAX_EXTENSION_UI_EXTENSION_ID_LENGTH`, more than
`MAX_EXTENSION_UI_IDENTITIES` entries, or a map whose UTF-8 JSON encoding exceeds
`MAX_EXTENSION_UI_SETTINGS_BYTES` reject the request rather than being partially
accepted. These constants are shared with Extension Deck settings.
Until the first successful hello/configure handshake, Host uses `legacy-modal` and an
empty override map. An origin that is absent, `unknown`, or lacks a trusted
`extensionId` cannot match an override and follows the global policy.

Extension IDs are opaque and matched byte-for-byte after normal protocol string
validation; neither Desktop nor Host case-folds, path-normalizes, or reconstructs them.

Routing precedence is authoritative and must be implemented in Host in this order:

1. Resolve ownership. Stale owners cancel; background requests stay queued with their
   owning Session and never render in the active Session.
2. Apply mandatory guards. High-risk/destructive requests and Session lifecycle
   requests use Modal. If Inline is unavailable, the fallback is Modal. No Extension
   metadata or user preference may downgrade these outcomes.
3. For a normal request with a trusted Extension origin, apply its preference.
   `modal` selects Modal with `routeReason: "user-extension-modal"`; `inline` selects
   Inline with `routeReason: "user-extension-inline"`; `followHost` continues.
4. Apply the existing global-policy matrix: `legacy-modal` returns Modal;
   otherwise a sanitized Modal hint returns Modal, an Inline hint returns Inline,
   `auto` makes active tool/command origins Inline and other origins Modal, and
   `inline-first` makes the remaining active origins Inline. In this final tier an
   explicit Extension Modal hint is a default, not a safety lock, so a normal
   request's explicit user `inline` preference may override it.

For a background request, Host computes the eventual presentation with the same safety
and preference rules while retaining `background-session` as the queue reason. The
existing `presentationReason` carries the governing presentation reason. Desktop never
re-routes a Host-final Modal locally. Changing a preference affects subsequently routed
requests; an already-published blocking request stays in its Host-final surface until
settled.

Host risk is derived from trusted invocation metadata. A decision raised inside a
`tool_call` permission interceptor is high risk, as is the reserved future
`project_trust` path. Session lifecycle interceptors remain normal risk but are still
forced to Modal. Host risk cannot be lowered by Extension metadata; routing never
parses titles, option labels, commands, or package names to infer risk.

On the wire, `presentationHint` / `riskHint` preserve sanitized Extension metadata.
`presentation` / `risk` are the Host-final values consumed by Desktop, and
`routeReason` records the governing decision such as `active-tool`, `high-risk`,
`session-lifecycle`, `background-session`, `user-extension-inline`,
`user-extension-modal`, or `inline-unavailable`. Add the two `user-extension-*`
members to `ExtensionUiRouteReason`, its exact validators, and protocol coverage in the
same batch as the configure contract.

### Decision groups

Sequential blocking dialogs created by one trusted tool or command invocation share a
Host-generated `groupKey`. The key is a bounded hash over Host/Session identity,
trusted invocation metadata, and the Host invocation ID; raw provider call IDs and
local paths are not exposed. Event and unknown origins are not grouped automatically.

The first `extensionUi.request` implicitly opens the group. Later requests from the
same invocation reuse it, while parallel tool calls receive distinct keys. Host emits
`extensionUi.groupClosed` with `completed`, `failed`, `cancelled`, or `stale` only when
the invocation or binding lifecycle ends. Grouping does not change any individual
dialog Promise, response, timeout, or cancellation semantics.

Desktop keeps a redacted step summary containing only request ID, primitive kind, and
outcome. It does not retain selected values or freeform answer text in group state.
For Inline groups, the same card shell remains visible between sequential questions
and announces that the next question is pending.

## Waiting and large-decision UX

Desktop derives an expiry-aware `{ count, hasHighRisk }` summary from the active
request and Session queue. Background Session rows show that count inside their
existing switch target; the badge disappears on settlement or expiry and never
changes request ownership. The active Session composer remains editable so its draft
is preserved, but ordinary send is blocked through both a live request and the
between-question group interval. Focus returns only when the same Session's decision
group ends.

Select requests expose search once the list is materially long and use virtual rows
at 100 or more options. Filtering matches labels and descriptions, while responses
always return the original Host-published option ID. Empty results remain recoverable
through a clear-search action.

## Compatibility evidence

Compatibility is organized by behavior class rather than package popularity:

| Layer                     | Evidence                                                                                                                                                                                                                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contract fixture          | Real SDK loader coverage for subagent dialog/widget/custom/activity, permission and repository guards, planning select/editor, 150-option selection, persistent widgets, registered message renderer snapshots, provider-only registration, background ownership, and shutdown cleanup |
| Pinned published packages | Exact `@juicesharp/rpiv-ask-user-question` `2.1.0` RPC/group/envelope path and `1.20.0` custom-terminal fallback, both locked with registry integrity hashes                                                                                                                           |
| Scheduled latest audit    | Weekly/manual GitHub workflow replaces only the disposable v2 test alias with npm `latest`; it is separate from pull-request and `main` gates                                                                                                                                          |

Core routing contains no representative package-name branch. The published packages
are ecosystem evidence; the repository fixture remains the stable per-commit contract.

## Response lifecycle

- Inline and modal surfaces use the same `extensionUi.respond` RPC.
- Only one surface renders a request. New Host requests always carry final
  `presentation`; missing presentation from a legacy Host still means Modal.
- Controls disable while a response is in flight.
- A failed response stays open, announces a local error, and can be retried.
- Expiry removes only the matching active request and advances the same-Session
  queue once.
- A late response cannot dismiss a newer request because queue advancement is
  guarded by `requestId` and Host-side owner identity.

The compatibility adapter for `subagent_supervisor_request` maps old pi-subagents
messages to `audience: "agent"` activity without parsing their `Reply with:`
content. Durable changes to pi-subagents should emit Presentation v1 upstream;
PiDeck does not modify the globally installed Extension package.
