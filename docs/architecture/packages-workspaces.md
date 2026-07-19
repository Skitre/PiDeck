# Packages & workspaces

## Workspace & trust

1. User picks directory → `workspace.setCurrent`.
2. If trust required and undecided → pending snapshot + Trust modal.
3. `workspace.setTrust` with `trustOnce` | `trust` | `deny` rebuilds graph.

`notRequired` does not allow first project-scope install without explicit trust.

## Package operations

All via Host + `DefaultPackageManager`:

- list / install / remove / update / updateAll
- `checkUpdates` only when `capabilities.packageUpdateCheck`
- resource enable (package origin) and top-level enable (no forged packageId)

Mutations:

- Rejected when Agent busy (`AGENT_BUSY`)
- Serialized under `serviceGraphLock` (`PACKAGE_MUTATION_BUSY` / `SERVICE_GRAPH_BUSY`)
- Reconcile: flush → drainErrors → list/resolve → optional session.reload
- Result status: `committed` | `partialFailure` | `failed`

## UI

Packages page: scope segmented control, install field, list with shadow/override cues, resource toggles, standalone resources section.
