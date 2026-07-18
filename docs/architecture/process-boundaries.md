# Process boundaries

## Rust / Tauri

**Owns**

- Window lifecycle
- `DesktopSettingsStore` (`desktop-settings.json` in app config dir)
- Spawning Node with `PI_CODING_AGENT_DIR` / `--agent-dir`
- stdin write, stdout line emit (`pi-host-stdout`), stderr log emit
- Forced kill after 10s shutdown timeout
- `desktop.openPath` / dialog folder picker

**Must not**

- Import or reimplement Pi Package install, filter, trust, or resource discovery
- Parse `pi list` text
- Read/write Pi `settings.json` as the product owner

## Node Pi Host

**Owns**

- All Pi SDK services listed in PROJECT_SPEC §4.5
- Trust gate before project resource load
- Package mutation reconcile (`flush` / `drainErrors` / list / resolve / reload)
- Extension UI request/response bridge
- ModelConfigHealth from `ModelRegistry.refresh()` / `getError()` only

**Must not**

- Mix logs into stdout (stderr only for logs)
- Create AgentSession before trust decision when resources require trust

## React

**Owns**

- UI state projections (Zustand)
- Typed `HostClient` requests/events
- Rendering transcript, packages, settings

**Must not**

- `import` from `@earendil-works/pi-coding-agent`
- Spawn `pi` CLI or npm/git for packages
- Directly read `~/.pi/agent`

## Trust-before-load

Order is fixed (PROJECT_SPEC §4.9):

1. Canonicalize cwd  
2. `ProjectTrustStore.get`  
3. `hasTrustRequiringProjectResources`  
4. If pending → no ResourceLoader/AgentSession; emit `workspace.trustRequired`  
5. Only after decision → `SettingsManager.create(..., { projectTrusted })` and full graph  

`notRequired` means no gate for load — it does **not** authorize first project Package install without explicit trust.
