# Findings: Pi SDK 0.84.2 upgrade audit

## Requirements
- User asked how to upgrade from pinned `0.82.1` to upstream `0.84.2`.
- Do not install 0.84.2 into the workspace until the bump is intentional and atomic.
- Preserve the 0.82.1 playbook: no mixed SDK versions on `main`, no hitchhiking toolchain upgrades.

## Research Findings

### Tarball hashes (npm pack, 2026-08-20)
Recorded in `%TEMP%\pideck-sdk-0842`. Re-hash before the real bump; npm tarballs can be republished.

```
0262785a76b0eb2eec596cd8a7ab2ee23eef89d2ef1bb1211c4f0a1944dacf41  earendil-works-pi-ai-0.84.2.tgz
95b899cd7b1a0c1f0174c7bf33ab427435e3553a7d1f4756661aa9c7f1a68ffa  earendil-works-pi-coding-agent-0.84.2.tgz
3abec26d852a9574fd341b8b4984277fc76dabb57a0360df4c19cc1fc0df993e  earendil-works-pi-tui-0.84.2.tgz
565b5d2c6f6c09ff69d915d28692a15d72dedc43a7dbe41fb422bb4bfad3bdcf  earendil-works-pi-agent-core-0.84.2.tgz
```

coding-agent `engines.node` is still `>=22.19.0`. Direct deps add `@earendil-works/pi-client` and `@earendil-works/pi-protocol` (not `@pideck/protocol`) at `^0.84.2`. TypeBox moves from `@sinclair/typebox` to the `typebox` 1.3.7 package.

### Breaking changes that actually hit PiDeck

| Change | Hits PiDeck? | Notes |
|--------|--------------|-------|
| JSON/RPC `message_update` drops cumulative `message` and `partial` | Low | Host listens to in-process `AgentSession`, not JSON mode. `pi-ai` `AssistantMessageEvent` still has `partial`. Host `event-normalize.ts` already keeps only `assistantMessageEvent` and still reads `partial` for `toolcall_start`. JSON helper `toJsonEvent` is unused. |
| `ProviderHeaders` = `Record<string, string \| null>` | Yes | SDK surfaces keep null sentinels. Host-built HTTP headers drop nulls via `stringRecord()`. `providerHeadersToRecord` is not a public pi-ai export. |
| `ModelRegistry.refresh()` now takes `ModelsRefreshOptions` and returns `ModelsRefreshResult` | Comment-only | Host already calls `ModelRuntime.refresh({ allowNetwork: false })`. Keep that helper; do not switch back to the registry. `ModelsRefreshOptions` also gained `providers?: readonly string[]`. |
| `setRuntimeApiKey` auth options | No | PiDeck does not call it. |
| TypeBox 1.3.7 / package `typebox` | Yes | `attachment-tool.ts` is the only Host import of `@sinclair/typebox`. `defineTool` parameters are `TSchema` from `typebox`. |
| Config-form OAuth `refreshToken(credentials, signal)` | Required search | Host has no first-party callback today. Still search Host, fixtures, and test extensions; add a runtime compat test. Compile-green is not enough. |
| Handwritten `Provider.refreshModels` `context.store` → `context.stored`/`publish` | Unlikely | Host uses `createProvider` / ModelRuntime, not a handwritten native `refreshModels`. |
| pi-agent-core v4 Session/SessionRepo | Unlikely | Host uses coding-agent `SessionManager`, not pi-agent-core repos. Confirm no deep imports. |
| `StopReason` adds `pending` and `deferred` | Small | `done.reason` is already any string in the normalizer. `done` union now includes `deferred`. Protocol does not enum-check assistant stop reasons. |

### Surfaces that did not change enough to drop the dist patch

Confirmed absent from 0.84.2 `d.ts`/`js`:

- `AgentSession.clearModel()`
- `ExtensionBindings.invocationRunner` / `ExtensionRunner.setInvocationRunner`
- `PackageManager.setOperationSignal`
- `update(source, { local })`
- `PackageManagerOptions.env` / `DefaultResourceLoaderOptions.env`
- `getShellConfig` bundled-bash fallback
- `killProcessTree` still `spawn("taskkill")` with no `error` listener

`wrapper.js` was rewritten (tool wrapping only, direct `execute()`). Re-port invocation wrapping onto the new wrapper; do not apply the 0.82.1 hunk. Also patch `AgentSession.bindExtensions` / `_applyExtensionBindings` so `invocationRunner` survives reload.

`package-manager.js` `spawnCommand` still uses `getEnv()` → `process.env` in the unpatched SDK. Cut 1 Host adapter now replaces spawn/capture/sync/update on the prototype and injects `getInternalRuntime().env`.

`CreateAgentSessionOptions.model` is `Model | undefined` again; empty values call `findInitialModel()`. The 0.82.1 sdk.js `model: null` hunk is product-critical.

### Review 2026-08-20 (Accept with changes)
Static review of the repo, current patch, and official 0.84.2 tarball. Six packages' `dist-tags.latest` were 0.84.2; Git tag and npm `gitHead` pointed at `914cf147`. No files were modified and no workspace tests were run in that review.

Blockers folded into `docs/operations/pi-sdk-0.84.2-upgrade.md`:

1. **T8 / `model: null`.** Plan had described `sdk.{js,d.ts}` as type re-exports. The patch actually disables auto-selection; Host depends on it (`agent-session-factory.ts`). Use a Host `PIDECK_NO_MODEL` sentinel for create + clear; keep empty-enabled-list tests.
2. **P8 scope.** Cannot be `runner.js` only. Need agent-session bind/reload, runner events, and a rewritten wrapper for Extension tools (`sdk-invocation-runner.test.ts`).
3. **P1–P3.** Three spawn wrappers miss signal consumption, scoped `update`, `waitForChildProcess`, and stderr. Timebox a full spike or keep a minimal `package-manager.js` patch.

Also: keep P4+P5 in `shell.js`; one PR; six-package evidence list; product 0.2.2; Cut 2 freshness gate; OAuth `refreshToken` is a required search including fixtures.

### New optional APIs we can ignore in the first bump
- `PromptOptions.expandPromptTemplates` (default true)
- `CreateModelRuntimeOptions.signal` / `refreshOnCreate`
- `defaultTools` setting (product follow-up, not required to compile)
- Baseten / Qwen Individual providers (catalog, not Host code)
- `@earendil-works/pi-coding-agent/client` remote session APIs

### Current patch file list (0.84.2)
Residual is **by behavior**: invocation ownership (session+runner+wrapper+types) and `shell.js`. PM/resource-loader stayed out after the Cut 1 spike. `sdk.js` stayed out; T8 sentinel was not falsified.

Current 0.84.2 files (`patches/@earendil-works__pi-coding-agent@0.84.2.patch`):

1. `dist/core/agent-session.d.ts` + `.js` — invocation bind / reload (P8)
2. `dist/core/extensions/{index,runner,types}.d.ts` + `runner.js` — invocation events (P8)
3. `dist/core/extensions/wrapper.js` — rewritten tool `invokeExtension` on the 0.84.2 execute wrapper
4. `dist/index.d.ts` — export invocation types (P8)
5. `dist/utils/shell.js` — bundled bash + absolute `taskkill` (P4+P5)

`package-manager` and `resource-loader` hunks stayed out. Host `installPackageManagerAdapter()` replaces spawn/wait/signal/scoped `update` and reads `getInternalRuntime().env`.

`sdk.{js,d.ts}` is gone from the 0.82.1 patch. T8 sentinel was not falsified: `createHostAgentSession` with `PIDECK_NO_MODEL` constructs a real AgentSession (`unknown`/`unknown`) and does not persist that pair as `settings.json` defaults.

### Better method than the 0.82.1 playbook
Last upgrade was an API replacement (AuthStorage → CredentialStore, new ModelRuntime). This one is a patch-rebase tax plus two type breaks. Copying the 6-PR dist rebase would keep the expensive part.

Chosen method after review (see `docs/operations/pi-sdk-0.84.2-upgrade.md`):

1. Two cuts in **one PR**. Cut 1 on 0.82.1 is independently testable; do not merge it to `main` alone.
2. Move T8 (`model: null` → sentinel), P6 (`clearModel`), and P7 (pideck UI types) into Host.
3. P1–P3: timebox a complete PM-adapter spike; if it cannot reproduce wait/signal/scope, keep the minimal `package-manager.js` patch.
4. Keep P4+P5 in `shell.js`. Keep P8 as session bind + runner events + rewritten wrapper + type exports.
5. Atomic 0.84.2 bump with a freshness gate. Skip 0.83.0. Product version 0.2.2.

### Cut 1 traps found while writing the review packet
- Host tests have no vitest `setupFiles`; adapters installed only in `main.ts` will not run in unit tests.
- `runCommandSync` still calls `getEnv()` directly; wrapping only `spawnCommand` is insufficient (`sdk-package-internal-env.test.ts`).
- 0.84.2 `ResourceLoader` still `new DefaultPackageManager` without `env`. Prototype hooks must read `getInternalRuntime()`.
- Tests pass constructor `env` today; that option dies when the patch hunk is removed. Need `setInternalRuntimeForTests`.
- `SettingsManager.applyOverrides` is non-persisting and `getShellPath()` reads merged `this.settings` — valid for bundled bash. `setShellPath` persists and must not be used.
- Unconditional `shellPath` override would skip SDK Program Files Git discovery.
- Review: Cut 1 commits that change the patch or `pnpm-lock.yaml` must update `scripts/release-runtime.lock.json` (`sdkPatchSha256`, `pnpmLock.sha256`) in the same commit. `verify:quick` includes `verify:release-metadata`. Cut 2 overwrites those SHAs with the final 0.84.2 values. The PR still merges once.
- Review: after `clearSessionModel`, `reconcileIdleActiveSessionModel` must `buildSessionSnapshot`, assign `graph.sessionSnapshot`, and `server.emit("session.snapshot")` with unchanged revision.
- Review: PM spike success is Host `cross-spawn@7.0.6` plus a copied wait helper. There is no legal import of SDK `spawnProcess`.
- Review: product 0.2.2 lands in seven files plus a version-equality assert in `release-sdk-evidence.mjs`.

Product version for this PR is **0.2.2**. Do not ship `defaultTools` UI in the same change.

## Technical Decisions
| Decision | Rationale |
|----------|-----------|
| Audit via `npm pack`, not `pnpm add` | Keeps the 0.2.1 lock frozen until Cut 2. |
| Hybrid Cut 1 then Cut 2 in one PR | Bisectable Host migrations. Each commit that changes the patch/lock updates evidence SHAs; `main` only sees the final 0.84.2 pin because the PR merges once. |
| Sentinel instead of `model: null` | 0.84.2 auto-selects on empty model; PiDeck must not resurrect disabled Providers. |
| Dist patch for invocation ownership (session+runner+wrapper) | Per-handler and per-tool `sourceInfo` is not a public 0.84.2 hook. |
| PM adapters only if a timebox spike reproduces wait/signal/scope | Three spawn wrappers are not the current patch. |
| Migrate only `attachment-tool.ts` to `typebox` | Protocol does not depend on TypeBox; no need to rewrite `@pideck/protocol`. |
| `PI_SDK_PACKAGES` has seven entries | `pi-client` / `pi-protocol` are runtime protocol boundaries; `pi-telemetry` is pulled by `pi-ai` / `pi-agent-core`. |

## Issues Encountered
| Issue | Resolution |
|-------|------------|
| Extracting both tarballs into one `package/` overwrote coding-agent with pi-ai | Extract to sibling directories. |
| 0.84.0 changelog overstates in-process `message_update` breakage | JSON/RPC helper strips `partial`; AgentSession events still carry it. |
| `declare module` on `.../dist/core/extensions/types.ts` did not merge | Augment the package root `@earendil-works/pi-coding-agent`. `editor` merge is an overload; Host impl must type the third arg as optional. |
| `publishIdleActiveSessionSnapshot` copies current thinkingLevel | Tests that expect `"off"` must call `clearSessionModel` first. |

## Resources
- `%TEMP%\pideck-sdk-0842\coding-agent\package\dist`
- `%TEMP%\pideck-sdk-0842\pi-ai\package\dist`
- `docs/operations/pi-sdk-0.82.1-handoff.md`
- `docs/operations/pi-sdk-0.82.1-api-notes.md`
- `patches/@earendil-works__pi-coding-agent@0.84.2.patch`

### Cut 2 gate (2026-08-20)
`verify:quick`, `pnpm build`, `pnpm test:rust` (77), `pnpm lint:rust`, `package:sidecar:with-node`, `validate:resources`, and `smoke:staged-host` all passed on 0.84.2 / 0.2.2. Staged evidence: six Pi packages `0.84.2`, `bashProbe ok`, `gitStatus ready`, Host exit 0. Working tree is still uncommitted.

### Pre-merge review (2026-08-20)
External review: no blocking logic errors; two P2s before merge.

1. `THIRD_PARTY_NOTICES.md` still named coding-agent `0.80.7`. Updated to the six-package 0.84.2 family; `verify:release-metadata` now requires those names and the pin.
2. `sdk-invocation-runner.test.ts` constructed `ExtensionRunner` and called `setInvocationRunner` directly, so bind/reload patch hunks were untested. New AgentSession test binds only `invocationRunner`, reloads, and asserts trusted `sourceInfo` on the replacement runner.
3. P3: `chat-runtime.md` / `extension-presentation.md` no longer pin 0.82.1.
4. Follow-up: Knip unused `assertThirdPartyNotices` export — tests now import it. `pi-telemetry@0.84.2` added to `PI_SDK_PACKAGES`, evidence tree lookup (reachable `node_modules` links only), notices, and freshness list. Store-only orphans fail a negative fixture.

---

## Tools panel / defaultTools (design, 2026-08-20)

User asked how to productize tool toggles after the 0.84.2 bump. Not implemented.

### Two different APIs (do not collapse)

| | Live active tools | SDK `defaultTools` |
|---|-------------------|-------------------|
| What | Names currently on `agent.state.tools` | Initial **built-in** selection at `createAgentSession` |
| Mutate | `AgentSession.setActiveToolsByName` → Host `agent.setActiveTools` | `settings.json`; `SettingsManager.getDefaultTools()` only, **no setter** |
| Extensions | Can be turned off | Stay enabled (`includeAllExtensionTools: true`) |
| Scope | This AgentSession / runtime | Global `~/.pideck/agent/settings.json`. Project `.pi/settings.json` is **not** loaded (`projectTrusted: false`) |
| Survive idle dispose | No, unless Host re-applies something on recreate | Yes, for the next create’s builtins |

SDK `CreateAgentSessionOptions.tools` is a **strict allowlist** stored as `_allowedToolNames`. Do not use it for the GUI: later `setActiveTools` cannot enable names outside the list, and registry refresh re-adds every allowed name.

Built-in registry is seven tools (`read|bash|edit|write|grep|find|ls`). Default active is four (`read|bash|edit|write`). `grep`/`find`/`ls` exist but start off. Read-only preset should turn those three on when bash/edit/write go off.

### Already in PiDeck

- Protocol: `agent.getTools`, `agent.setActiveTools` (`{ names }`), event `agent.toolsChanged`, CAS `expectedToolRevision`.
- Host: idle + graph lock + session op lock; always unions `read_attachment`; publishes snapshot + event.
- Desktop: `store.tools` + `classifyToolSnapshot` (apply/drop/recover). **No UI calls the methods.**
- Docs already list a Tools panel in `chat-runtime.md`. UX review 2026-07-30: frontend zero-consumption.

### Host bug that blocks grouping

`getAllTools()` returns `{ name, description, parameters, promptGuidelines, sourceInfo }`. `buildToolSnapshot` reads `sourceLabel` / `source` / `source.kind`, so `SerializableToolInfo.source` is typically **undefined**. Builtins are `sourceInfo.source === "builtin"`. Fix mapping before the popover groups by source.

### CLI analog

Official example `examples/extensions/tools.ts`: `/tools` TUI SettingsList, persist via session custom entry `tools-config`. Requires TUI. PiDeck should ship a first-party `/tools` builtin (same pattern as `/session`) so that extension never has to run.

### Persistence recommendation (v1)

Workspace builtin preset in `DesktopSettings` (Full / Read-only / All-seven / Custom names). Host applies with `setActiveToolsByName` **after** create. Do not write `defaultTools` in v1 (no public setter; would fight workspace preset; CLI users can still open `settings.json` from Settings → General).

### Product decision (2026-08-20): do not ship

User: the panel is not worth building. Agreed.

Why the earlier design over-weighted it: UX review listed a hole, SDK 0.84.2 added `defaultTools`, and Host RPC already existed — that looks like “just consume it.” The real product is a coding agent with bash/edit/write on. A trustworthy read-only mode needs persistence, busy/CAS, source grouping, and pinned `read_attachment`; that is a feature, not a missing button.

Leave protocol/Host in place (snapshots, context-usage tokens, `addedToolNames`). Do not add UI, workspace presets, `/tools`, or a `defaultTools` settings page. Do not hitchhike the `source` mapping. Revisit only if a concrete user repeatedly needs “this repo must not bash.”

---

## Deck design (Extension UI rework, 2026-08-21) — HISTORICAL

**Historical.** `docs/architecture/deck.md` is a superseded whole-window pane
workspace alternative. The accepted target is
`docs/architecture/extension-deck.md`. Do not implement movable builtins,
session/workspace layouts, or absorbing Sidebar/RightDock.

Accepted target design was first written to `docs/architecture/deck.md`. Design only; no
implementation. User rejected patching the existing shells twice — the goal is
the end state, not a first batch.

### Locked product decisions
- App-level pane primitive: builtins (sessions/files/tree/changes/shells/browser)
  and Extension views are the same leaf type; `RightDock` and `Sidebar` get
  absorbed. Main-area splits in scope from day one.
- Views: `chat` (non-closable singleton), builtins, `ext.widget` (per
  origin:key), `ext.status`, `ext.terminal` (≤1), `ext.decision`. Notifications
  stay out (user decision) — toast stack unchanged.
- Renderer registry per view type; the `custom()` dual path (structured walk of
  known pi-tui trees vs xterm) becomes a registry entry.
- Default Deck reproduces today's window pixel-for-pixel; that is the cutover
  acceptance property.

### Facts dug out of source that shaped the design
- `extensionUi.widgetChanged` / `statusChanged` carry no trusted origin
  (`dto-validate.ts` exact-keys: widget/key/placement, text/key). Emit sites are
  `publishWidget` / `setStatus` in `extension-ui-bridge.ts`, where binding
  identity and the invocationRunner ambient invocation are in scope. Adding
  optional `origin` there is the ONLY protocol delta. Widgets/statuses replay
  from bridge state on rehydrate, so origin rides recovery for free.
- Native browser webviews (`browser_surface.rs`, child `Webview` map on the
  main window) composite above ALL HTML. Deck rules: native views never float;
  live native rects are float-drag exclusion zones; the modal layer hides
  native surfaces (`webview.hide()`) — fixes browser-over-modal as a side
  effect.
- Widget/status/terminal content is session-scoped (store clears on session
  switch); layout memory must be workspace-scoped, keyed by
  `ext:<originId>:<verb>[:<key>]`. Origin-less legacy events key on widget key
  alone, last-writer-wins.
- High-risk / session-lifecycle decisions stay modal by Host policy regardless
  of user layout; low-risk inline decisions may be re-homed (requests pane /
  float), keyed by origin, never requestId.
- What gets deleted: `ExtensionWidgetsPopover` + anchor geometry,
  `ExtensionUiModal` shell, `InlineExtensionUiRequest` mount, `RightDock` +
  `DockTabId`, `Sidebar` shell. What must not change: request ownership,
  epochs, decision groups, expiry queue advance, respond lifecycle,
  VirtualTerminal input/resize identity checks, routing policy.

### Build order (each batch green + shippable)
1. Deck core standalone (tree ops, DnD on pointer events, floats, keyboard,
   persistence, native zones) — heaviest, ~transcript-pipeline scale.
2. Extension views cut over (widget → terminal → decision; origin fields first;
   decision keeps a one-release legacy fallback).
3. Builtins migrate; browser last; one-time import of dock width/open prefs.

### pi-subagents compatibility walkthrough (2026-08-21)

Walked pi-subagents 0.50.0 (installed at ~/.pi/agent/npm) against the Deck
design. PiDeck reports `hasUI: true, mode: "rpc"`; the extension gates features
on `hasUI` (so everything activates) but branches its async-jobs widget on
`mode === "rpc"`.

Surface inventory → Deck mapping:

| Surface | Fact | Deck fit |
|---|---|---|
| FleetView table | `setWidget("subagent-fleet-status", factory, placement belowEditor)`, on by default | `ext.widget`, anchored default, promotable to float HUD — the original user scenario. Clears while inspector open and restores after; layout memory re-mounts it correctly |
| Async transport widget | rpc branch emits `["PI_SUBAGENT_ASYNC_JSON:{...}"]` (`shared/types.ts:2082` WIDGET_KEY "subagent-async"; encode at `async-status-snapshot.ts:275`) | **Finding 1**: PiDeck renders this raw today (no desktop filter exists despite the surfaces doc saying don't). Deck amplifies it (anchored strip default). Fix seam: renderer-selection rule classifying machine-transport content into a non-visual renderer — registry entry, not core routing. Info not lost (FleetView shows the same jobs) |
| Fleet inspector | `ui.custom<undefined>()` `fleet.ts:1288`, `overlay:true anchor:center width:95%`, guard `hasUI` only; stop-confirm drawn inside the component (`stopConfirming`, fleet.ts:710/863) | Opens in PiDeck (xterm, keyboard forwarded). Deck: `ext.terminal`, floatable/splittable. **Finding 2**: overlay hint suggests centered-float default; needs optional `overlay?: boolean` on the customOpened event (2nd protocol delta, user to approve) |
| Dialogs | select/confirm/input/editor across stop picker, admin flows, watchdog | `ext.decision`; command-origin groups give multi-step admin flows one card shell; event-origin watchdog confirms stay single |
| Status | `setStatus("subagent-slash", ...)` | `ext.status` |
| Doctor / supervisor | renderer + hidden message; customType adapter | transcript-owned; Deck leaves untouched |
| notify | failure/pause | out of Deck (user decision) |

**Finding 3 (pre-existing, not Deck's fault):** inspector entry channels
narrow in PiDeck — widget arrow keys dead (`onTerminalInput` no-op),
`ctrl+alt+f` dead (`registerShortcut` has zero Host consumers; only
`session.getCommands` surfaces commands). Only `/subagents-fleet` works.
Deck's pane-command seam could later host per-view actions.

Input-routing detail verified: Esc inside the xterm fleet panel stays with the
extension component (`chat.stop` lacks `worksInTerminal`, keymap gates `.xterm`
targets), so the in-component confirm flow is not shadowed.

**Verdict: the design holds.** Every surface maps to an existing view type;
both real frictions land on seams the design already has (renderer selection,
one optional event field). No architectural change required. Amendments 1–2
await user approval before editing deck.md.

---

## Extension Deck (accepted target, 2026-08-22)

Authoritative design: `docs/architecture/extension-deck.md`.
`docs/architecture/deck.md` is historical and must not be implemented.

Batch 1 source facts used for the vertical contract:

- Widget/status/custom events now carry optional trusted `origin` (same union as
  `ExtensionUiRequest.origin`). `customStarted` also copies `overlay?: boolean`.
- Host captures origin at `setWidget` / `setStatus` / `custom()` time, not at
  deferred render or replay. Clear reuses the saved live-key origin.
- Production `getTrustedPackageOrigin` stays unset: the shared UI context cannot
  know a package without guessing from keys/titles/paths.
- Host default before hello/configure is `legacy-modal` + empty override map.
- Configure overrides are optional on the wire so old Desktop stays valid;
  omitted overrides keep the current map; `{}` replaces atomically.
- `HostStatusSnapshot` does not grow an overrides field (old Desktop exact-key
  `host.statusChanged` / hello result).
- Desktop observes trusted-origin events only; first Extension/family pair
  writes once; replay/clear do not write or delete observations.
- Desktop projects only `extensionDecisionPresentation` + dialog overrides to
  Host. Float/Dock/capabilities stay in `DesktopSettings.extensionUi`.
- Rust `extensionUi` deserializes through a sanitizer that cannot fail the
  parent `DesktopSettings` parse. Unknown version resets only the nested field.

Batch 3/4 leftovers (not product-scope cuts):

- `extension-deck-v1` rollback path is intentionally kept for one release.
- Production `getTrustedPackageOrigin` remains unset; unknown origins render
  with defaults and cannot create profiles.
- `dock.secondaryEnabled` is persisted but live layout uses each slot's
  `home.group`; the flag is not a third layout engine.
- Float display names fall back to the raw `extensionId` until
  `rememberExtensionDisplayName` has seen a trusted origin.
- Host `oauth-refresh-compat` can EPERM-rename `auth.json` under parallel
  Windows load; isolated reruns pass. Not part of Extension Deck.

### Acceptance audit (2026-08-22, current tree)

| # | Result | Evidence |
|---|---|---|
| 1 | pass | `ExtensionDock.dom.test.tsx` hides `Extensions` with no docked content |
| 2 | pass | Builtin RightDock/Sidebar/Chat commands unchanged; Files never enter Extension groups |
| 3 | pass | `extension-ui-resolver.test.ts` + `[data-widget-popover]` absent; popover component removed |
| 4 | pass | `ExtensionUiSettingsSection.dom.test.tsx` observed families + legal options + empty hint |
| 5 | pass | Widget persist without Host configure; blocking `extensionUi.configure`; published request stays inline |
| 6 | pass | Float drag/pin Undo toast “Applies to all sessions”; `extension-ui-profile.test.ts` |
| 7 | pass | Session switch hides content and leaves the saved family home |
| 8 | pass | Empty dock/float/anchors unmount; custom/dialogs have no hidden home |
| 9 | pass | Two-group cap + edge drop; no third group; no Files in groups |
| 10 | pass | `extension-ui-policy.test.ts` high-risk/lifecycle stay modal |
| 11 | pass | `browser-occlusion` refcount + float `excludeBrowserRect`; Web stays a builtin tab |
| 12 | pass | Rust nested sanitizer + protocol sanitize; parent DesktopSettings not quarantined |
| 13 | pass | `extension-ui-observation.test.ts` replay/clear do not write again |
| 14 | pass | Host `user-extension-*` reasons; inline preference cannot override mandatory modal |
| 15 | pass | Gate off = legacy request tabs; gate on = one `extensions` tab; rollback keeps builtin prefs |
| 16 | pass | `FAMILY_PRESENTATION_CHOICES.blockingDialog` is followHost/inline/modal |
| 17 | pass | Status choices are above-composer / Dock / hidden |
| 18 | pass | Observation maps only widget/status/custom/request |
