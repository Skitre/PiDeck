# Process boundaries

## Rust / Tauri

**Owns**

- Window and desktop settings lifecycle.
- Spawning, monitoring, restarting, and shutting down the Node Pi Host.
- Platform process-tree containment for the Host and its ordinary descendants.
- The JSONL stdin/stdout bridge and bounded stderr forwarding.
- Native path opening and folder selection.

**Must not**

- Reimplement Pi Package install, filtering, or resource discovery.
- Parse `pi list` text or own Pi `settings.json`.

## Node Pi Host

**Owns**

- All Pi SDK services and cwd-bound workspace graphs.
- Immediate project resource loading after workspace selection.
- Package mutation reconciliation and Extension UI bridging.
- Provider/model health and Host identity revisions.

**Must not**

- Mix logs into stdout.
- Add a second workspace trust state machine outside the selected-workspace policy.

## Host process-tree lifecycle

Rust owns the complete Pi Host process tree, not only the direct Node process.
On Windows, the Host is assigned to a kill-on-close Job Object. On macOS and
Linux, Rust calls `setsid()` before exec so the Host leads an isolated Unix
session and process group; subprocesses inherit that group by default.

Normal app exit first sends the typed `system.shutdown` request and preserves
the Host's bounded graph-disposal window. After the direct Host exits or that
window expires, Rust sends `SIGTERM` to the group, waits 500 ms, and escalates
to group `SIGKILL`. Startup rollback, forced cleanup, unexpected Host exit, and
the manager's Drop fallback use immediate group `SIGKILL`. A shared one-owner
cleanup claim prevents the stdout crash monitor and manager from both signaling
a later-reused process-group id.

Extensions, tools, and SDK helpers may spawn ordinary child processes, but they
must not evade PiDeck ownership with detached mode, `setsid`, `setpgid`, or a
double-fork daemon. A deliberately detached process has left the Host lifecycle
contract and cannot be contained by either a Unix process group or ordinary
parent-death handling. As with all userspace Unix supervisors, an unrecoverable
`SIGKILL` of the Tauri process itself cannot run cleanup code; stdin EOF and the
Host's own shutdown handling remain defense in depth for that external case.

## React

**Owns**

- Zustand projections, typed Host requests/events, and all user-facing views.
- Package catalog browse and user-scope install, update, and remove confirmation.

**Must not**

- Import the Pi SDK, spawn package tooling, or directly read the agent directory.

## Workspace selection policy

The order is fixed:

1. Canonicalize cwd.
2. Create `SettingsManager` with explicit `projectTrusted: false`.
3. Apply the process-wide user/global Extension cache and create the cwd-bound AgentSession graph.
4. Publish one ready `workspace.changed` snapshot.

Selecting a workspace does not load or execute `<workspace>/.pi` packages or
extensions. User/global packages from `<agentDir>` are loaded once per Host
process and reused across Workspace switches.
