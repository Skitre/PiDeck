# Packages & workspaces

## Workspace loading

1. User picks a directory through `workspace.setCurrent`.
2. Host canonicalizes the path and builds services with explicit `projectTrusted: true`.
3. Project extensions, skills, prompts, and themes become available immediately.

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

## UI

The Packages page provides scope filters, install source entry, configured
Package selection, resource toggles, standalone resources, update actions, and
explicit confirmation before a Project Package mutation can execute code.
