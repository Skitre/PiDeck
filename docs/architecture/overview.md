# Architecture overview

## Process topology

```text
┌─────────────────────────────────────────────────────────┐
│  Tauri / Rust (apps/desktop/src-tauri)                  │
│  - Window, DesktopSettingsStore                         │
│  - Spawn/monitor Node Pi Host                           │
│  - JSONL stdin/stdout bridge → frontend events          │
└──────────────────────────┬──────────────────────────────┘
                           │ JSONL
┌──────────────────────────▼──────────────────────────────┐
│  Node Pi Host (packages/pi-host)                        │
│  - system / workspace / session / agent / model         │
│  - package / resource / piSettings / extensionUi        │
│  - @earendil-works/pi-coding-agent@0.84.2               │
└──────────────────────────▲──────────────────────────────┘
                           │ typed protocol (via Rust)
┌──────────────────────────┴──────────────────────────────┐
│  React UI (apps/desktop/src)                            │
│  - Chat / Packages / Settings pages                     │
│  - Zustand stores + HostClient                          │
└─────────────────────────────────────────────────────────┘
```

## Workspace service graph

When a workspace is selected, Host immediately creates a **cwd-bound** graph:

- `SettingsManager` (explicit `projectTrusted: false`)
- `DefaultPackageManager`
- `DefaultResourceLoader`
- `SessionManager`
- `AgentSession` (via `createAgentSession`)

Switching workspace **retains** the outgoing idle graph in an LRU pool (max 5)
and reactivates it in milliseconds on return (stable workspace id, advancing
revisions); graphs that cannot be safely parked and LRU
eviction dispose and rebuild the graph under `serviceGraphLock`.

## Fact sources

| Concern | Owner |
|---|---|
| Messages / tools / compaction | AgentSession |
| Sessions on disk | SessionManager |
| Packages | DefaultPackageManager + SettingsManager |
| Workspace selection policy | Pi Host (`projectTrusted: false`; user/global packages only) |
| Desktop theme, agentDir bootstrap | Rust DesktopSettingsStore |
| Protocol validation | packages/protocol |

## Data flow (chat)

1. User sends message in Composer → `agent.prompt` request with identity context.
2. Host validates revision, acquires the per-session operation lock (`factory.getSessionOperationLock`), calls `AgentSession.prompt`.
3. Host emits compact `agent.event` Assistant deltas between authoritative message start/end snapshots; on tool `addedToolNames`, it emits full `agent.toolsChanged`.
4. UI reducers apply matching host/workspace/session events in animation-frame batches and reconcile the final snapshot.
