# Packages & workspaces

## Workspace loading

Before the native Desktop starts Pi Host, it guarantees one usable Workspace
for a genuinely empty first-run configuration. It creates
`<agentDir>/pideck/DefaultProject`, records it in `lastWorkspace` and
`knownWorkspaces`, and passes it through the normal Host preload path. Existing
Workspace configuration always wins, and standalone Host processes retain the
`waitingForWorkspace` state until given an explicit cwd.

1. Desktop supplies a startup cwd, or the user picks one through `workspace.setCurrent`.
   On first launch the Host preloads that cwd and, when Restore last session is
   on, reopens `lastSessionPath` (or the most recent Session in that workspace)
   instead of creating an empty one. Sidebar rows are listed, not opened.
2. Host canonicalizes the path and builds services with explicit `projectTrusted: false`.
3. Only user/global packages from `<agentDir>` are loaded. Host loads that
   set once per process and injects it into each Workspace graph; switching
   Workspace does not re-import extensions. `<workspace>/.pi` packages and
   extensions are not loaded.

Workspace canonicalization follows symlinks and rejects existing non-directory
paths with `WORKSPACE_NOT_DIRECTORY`. The canonical path is also the retained
graph identity: Linux and macOS preserve case, while Windows normalizes path
separators and compares without case. A retained graph is rechecked against the
requested canonical identity before reactivation. Switching away from a
Workspace that still has a live Session parks that graph, keeps its agent
subscriptions, and leaves its model providers registered so the turn can
finish; coming back reactivates it instead of rebuilding. Idle retained
graphs still suspend their providers and are discarded when their disk
fingerprint changes.

The desktop persists the Host-returned `canonicalCwd` and uses exact string
identity for recent Workspace entries. It does not infer platform path
semantics or lowercase paths in React.

PiDeck does not trust or execute project-local extensions. Selecting a
Workspace does not run `<workspace>/.pi/extensions`. Package install, remove,
update, and resource preferences are user-scope only; `scope: "project"` is
rejected as `INVALID_REQUEST`. Existing `<workspace>/.pi` directories are left
on disk.

## Package operations

All operations go through Pi Host and `DefaultPackageManager`:

- list / install / remove / update / updateAll;
- `checkUpdates` only when `capabilities.packageUpdateCheck` is true;
- package resource enable/disable and standalone top-level resource enable/disable.

Mutations are rejected while the Agent is busy, serialized under
`serviceGraphLock`, reconciled through settings flush/list/resolve/reload, and
return `committed`, `partialFailure`, or `failed` status.

Each mutation is registered as an owned Host operation. Its `AbortSignal`
reaches the npm/git subprocesses used by `DefaultPackageManager`. At the
10-minute Host deadline, Pi Host cancels the subprocess and allows up to 5
seconds for the mutation's reconciliation and lock release. If cancellation
does not complete, the Host enters quiescing and requests a process restart
rather than allowing an unowned mutation to continue.

Shutdown rejects new work, cancels the active graph operation, waits to own
`serviceGraphLock`, and disposes the graph exactly once. The complete Host
cleanup has an 8-second budget inside the Rust supervisor's 10-second
force-kill boundary. `system.shutdown` reports acceptance only after cleanup
completes successfully.

## UI

The Packages page has three tabs: Installed, Resources, and Market. Install,
update, remove, and resource preference mutations are user-scope only.

Installed provides install source entry, configured Package selection, and
update actions. Resources lists package-owned and standalone resources with
enable/disable toggles. Install, update, and remove all confirm through the
shared review dialog (`components/Dialog.tsx`); removal uses the danger tone.
Update all shows the known update count and is disabled when a completed
check found none; the progress strip reports human-readable states,
auto-clears after completion, and can be dismissed.

Market loads Host `package.catalog` the first time the tab is opened. Host
scrapes one `https://pi.dev/packages` page per request (`?page=`, `name`,
`type`, `sort`; 50 cards per page; there is no public JSON API yet) and
caches that page for 10 minutes. An unfiltered first page with no cards is
`CATALOG_UNAVAILABLE`; a filtered miss is an empty page. Desktop search,
type, and sort are forwarded to Host, and Next/Previous fetch the next
page. Install from a card uses the same review dialog
as Installed, with `source: "npm:<name>"` and `scope: "user"`. Cards show
author, monthly downloads, and published date when present, and link out to
the pi.dev detail page, npm, and GitHub.
