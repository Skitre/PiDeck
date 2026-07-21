# Process boundaries

## Rust / Tauri

**Owns**

- Window and desktop settings lifecycle.
- Spawning, monitoring, restarting, and shutting down the Node Pi Host.
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

## React

**Owns**

- Zustand projections, typed Host requests/events, and all user-facing views.
- Explicit confirmation before Project Package mutations.

**Must not**

- Import the Pi SDK, spawn package tooling, or directly read the agent directory.

## Workspace selection policy

The order is fixed:

1. Canonicalize cwd.
2. Create `SettingsManager` with explicit `projectTrusted: true`.
3. Load project resources and create the cwd-bound AgentSession graph.
4. Publish one ready `workspace.changed` snapshot.

Selecting or restoring a workspace authorizes its existing `.pi` project
resources to load. There is no persistent workspace trust store, pending state,
or deny action. Existing `.pi/extensions` may execute local code immediately.
