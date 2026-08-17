# Packages & workspaces

## Workspace loading

Before the native Desktop starts Pi Host, it guarantees one usable Workspace
for a genuinely empty first-run configuration. It creates
`<agentDir>/pideck/DefaultProject`, records it in `lastWorkspace` and
`knownWorkspaces`, and passes it through the normal Host preload path. Existing
Workspace configuration always wins, and standalone Host processes retain the
`waitingForWorkspace` state until given an explicit cwd.

1. Desktop supplies a startup cwd, or the user picks one through `workspace.setCurrent`.
2. Host canonicalizes the path and builds services with explicit `projectTrusted: true`.
3. Project extensions, skills, prompts, and themes become available immediately.

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

The selected workspace is trusted by definition. Existing project extensions
can execute local code as soon as the workspace opens. Project-scope Package
mutations retain a separate executable-code confirmation in the desktop UI.

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

The Packages page provides scope filters, install source entry, configured
Package selection, resource toggles, standalone resources, update actions, and
explicit confirmation before a Project Package mutation can execute code.
Install, update, and remove all confirm through the shared review dialog
(`components/Dialog.tsx`); removal uses the danger tone and captures the
project authorization up front, so a project-scoped removal needs exactly one
dialog. Update all shows the known update count and is disabled when a
completed check found none; the progress strip reports human-readable states,
auto-clears after completion, and can be dismissed.
