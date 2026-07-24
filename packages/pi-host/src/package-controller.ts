import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import {
  createHostError,
  type PackageMutationResult,
  type PackageSnapshot,
  type PackageUpdateSummary,
  type ResourcePreferenceUpdate,
} from "@pideck/protocol";
import type { MethodHandler } from "./server.js";
import type { WorkspaceGraph, WorkspaceGraphFactory } from "./workspace-graph-factory.js";
import {
  buildPackageSnapshot,
  normalizePackageIdentity,
  type ResourceIdMap,
} from "./package-snapshot.js";
import { buildSessionSnapshot } from "./session-snapshot.js";
import {
  matchesResourcePattern,
  setPackageResourceFilter,
  setTopLevelPathEnabled,
  resourceTypeToSettingsKey,
  type PackageSource,
  type PackageSourceObject,
} from "./package-filters.js";
import { logger } from "./logger.js";

export const PACKAGE_MUTATION_TIMEOUT_MS = 10 * 60 * 1000;

export async function waitForPackageMutation<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    timer.unref?.();
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve({ timedOut: false, value });
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Fingerprint real package directories so an SDK throw after a partial write
 * cannot be mistaken for a no-op. This is reconciliation evidence only; SDK
 * resolve output remains the source of truth for resources shown to the UI.
 */
async function capturePackageDiskFingerprint(
  g: WorkspaceGraph,
  agentDir: string,
): Promise<string> {
  const packageManager = g.packageManager;
  if (!packageManager) return "packageManager:null";

  const roots = new Set<string>([
    join(agentDir, "packages"),
    join(agentDir, "npm"),
    join(agentDir, "git"),
    join(g.canonicalCwd, ".pi", "packages"),
    join(g.canonicalCwd, ".pi", "npm"),
    join(g.canonicalCwd, ".pi", "git"),
  ]);
  try {
    const configured = packageManager.listConfiguredPackages();
    for (const item of configured) {
      const installedPath =
        item.installedPath ?? packageManager.getInstalledPath(item.source, item.scope);
      if (installedPath) roots.add(installedPath);
    }
  } catch {
    roots.add("configured:error");
  }

  const hash = createHash("sha256");
  const visit = (root: string, path: string): void => {
    const label = relative(root, path).replace(/\\/g, "/") || ".";
    if (!existsSync(path)) {
      hash.update(`missing:${path}\n`);
      return;
    }
    const stat = lstatSync(path);
    hash.update(`${label}|${stat.mode}|${stat.size}|${Math.trunc(stat.mtimeMs)}\n`);
    if (!stat.isDirectory()) return;
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      visit(root, join(path, entry.name));
    }
  };

  for (const root of [...roots].sort()) {
    if (root === "configured:error") {
      hash.update("configured:error\n");
    } else {
      visit(root, root);
    }
  }
  return hash.digest("hex");
}

/**
 * Single choke point: graph flag → returned/emitted PackageSnapshot.
 * Every mutation exit path that returns a packageSnapshot must call this
 * after any resourceReloadRequired / reconcile mutations on `g`.
 */
function finalizePackageSnapshot(
  g: WorkspaceGraph,
  packageSnapshot: PackageSnapshot,
  mutationMeta?: {
    operationId: string;
    status: "running" | "partialFailure";
    reconcileRequired: boolean;
  },
): PackageSnapshot {
  const finalized: PackageSnapshot = {
    ...packageSnapshot,
    resourceReloadRequired: g.resourceReloadRequired === true,
  };
  if (mutationMeta) {
    finalized.mutation = {
      operationId: mutationMeta.operationId,
      status: mutationMeta.status,
      reconcileRequired: mutationMeta.reconcileRequired,
    };
  } else {
    delete finalized.mutation;
  }
  g.packageSnapshot = finalized;
  return finalized;
}

export function mapPackageUpdates(
  configured: PackageSnapshot["configured"],
  updates: Array<{ source: string; scope: string }>,
  requestedPackageId?: string,
): PackageUpdateSummary[] {
  const configuredByIdentityScope = new Map(
    configured.map((pkg) => [`${pkg.scope}::${pkg.identity}`, pkg] as const),
  );
  const summaries: PackageUpdateSummary[] = [];
  for (const update of updates) {
    const scope = update.scope === "project" ? "project" : "user";
    const identity = normalizePackageIdentity(update.source).identity;
    const pkg = configuredByIdentityScope.get(`${scope}::${identity}`);
    if (!pkg || (requestedPackageId && pkg.id !== requestedPackageId)) continue;
    summaries.push({
      packageId: pkg.id,
      source: update.source,
      current: undefined,
      available: undefined,
    });
  }
  return summaries;
}

export function createPackageHandlers(
  factory: WorkspaceGraphFactory,
): Partial<Record<string, MethodHandler>> {
  return {
    "package.list": async (ctx) => {
      const server = factory.getServer();
      if (!server) {
        return { error: createHostError("HOST_NOT_READY", "Server not bound") };
      }
      const params = ctx.params as {
        scope: "user" | "project" | "all";
        includeResources?: boolean;
      };
      const { withStableGraphRead } = await import("./stable-graph-read.js");
      const out = await withStableGraphRead({
        requestId: ctx.id,
        identity: server.identity,
        serviceGraphLock: server.serviceGraphLock,
        precheck: () => factory.checkIdentity(ctx.context, { requireWorkspace: true }),
        run: async () => {
          const g = factory.getGraph();
          if (!g?.packageManager || !g.settingsManager) {
            throw new Error("Workspace services not ready");
          }
          // Reads are scoped projections only. Canonical all-scope graph state and
          // its resource ID map change exclusively during graph publication/mutation.
          const projectionResourceIds: ResourceIdMap = new Map();
          return buildPackageSnapshot({
            revision: server.identity.packageRevision,
            workspaceId: g.workspaceId,
            scope: params.scope,
            packageManager: g.packageManager,
            settingsManager: g.settingsManager,
            resourceLoader: g.resourceLoader,
            cwd: g.canonicalCwd,
            agentDir: factory.deps.agentDir,
            packageUpdateCheck: factory.deps.packageUpdateCheck,
            resourceIdMap: projectionResourceIds,
            resourceReloadRequired: g.resourceReloadRequired,
          });
        },
      });
      if (!out.ok) return { error: out.error, identity: out.identity };
      return { result: out.result, identity: out.identity };
    },

    "package.checkUpdates": async (ctx) => {
      const server = factory.getServer();
      if (!server) {
        return { error: createHostError("HOST_NOT_READY", "Server not bound") };
      }
      const { withStableGraphRead } = await import("./stable-graph-read.js");
      const out = await withStableGraphRead({
        requestId: ctx.id,
        identity: server.identity,
        serviceGraphLock: server.serviceGraphLock,
        precheck: () => factory.checkIdentity(ctx.context, { requireWorkspace: true }),
        run: async () => {
          const g = factory.getGraph();
          if (!g?.packageManager) {
            throw new Error("Workspace services not ready");
          }
          if (!factory.deps.packageUpdateCheck) {
            return { supported: false, updates: [] as Array<{ packageId: string; source: string }> };
          }
          const pm = g.packageManager as {
            checkForAvailableUpdates?: () => Promise<
              Array<{ source: string; displayName: string; type: string; scope: string }>
            >;
          };
          const params = (ctx.params ?? {}) as { packageId?: string };
          const updates = (await pm.checkForAvailableUpdates?.()) ?? [];
          return {
            supported: true,
            updates: mapPackageUpdates(
              g.packageSnapshot?.configured ?? [],
              updates,
              params.packageId,
            ),
          };
        },
      });
      if (!out.ok) return { error: out.error, identity: out.identity };
      return { result: out.result, identity: out.identity };
    },

    "package.install": async (ctx) => mutatePackage(factory, ctx, "install"),
    "package.remove": async (ctx) => mutatePackage(factory, ctx, "remove"),
    "package.update": async (ctx) => mutatePackage(factory, ctx, "update"),
    "package.updateAll": async (ctx) => mutatePackage(factory, ctx, "updateAll"),
    "package.reloadResources": async (ctx) => mutatePackage(factory, ctx, "reload"),
    "resource.setPreference": async (ctx) => mutatePackage(factory, ctx, "setPreferences"),
    "resource.setPreferences": async (ctx) => mutatePackage(factory, ctx, "setPreferences"),

    "package.getResources": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, {
        requireWorkspace: true,
        requirePackage: true,
      });
      if (stale) return { error: stale };
      const g = factory.getGraph();
      if (!g?.packageSnapshot) {
        return { error: createHostError("PACKAGE_NOT_FOUND", "No package snapshot") };
      }
      const params = ctx.params as { packageId: string };
      const pkg = g.packageSnapshot.configured.find((p) => p.id === params.packageId);
      if (!pkg) {
        return { error: createHostError("PACKAGE_NOT_FOUND", "Package not found") };
      }
      const resources = g.packageSnapshot.resources.filter(
        (r) => r.packageId === params.packageId,
      );
      return { result: { package: pkg, resources } };
    },
  };
}

export type MutateKind =
  | "install"
  | "remove"
  | "update"
  | "updateAll"
  | "setPreferences"
  | "reload";

export function packageMutationMayChangeDisk(kind: MutateKind): boolean {
  return kind === "install" || kind === "remove" || kind === "update" || kind === "updateAll";
}

async function mutatePackage(
  factory: WorkspaceGraphFactory,
  ctx: {
    id: string;
    params: unknown;
    context: Record<string, unknown>;
  },
  kind: MutateKind,
): Promise<{ result: unknown } | { error: ReturnType<typeof createHostError> }> {
  const operation = mutatePackageUnderLock(factory, ctx, kind);
  const outcome = await waitForPackageMutation(operation, PACKAGE_MUTATION_TIMEOUT_MS);
  if (!outcome.timedOut) return outcome.value;

  const server = factory.getServer();
  const operationId = server?.serviceGraphLock.getOwner()?.operationId;
  const message = `Package ${kind} timed out after ${PACKAGE_MUTATION_TIMEOUT_MS}ms; restart the Host before retrying`;
  logger.error(message, { kind, operationId: operationId ?? null });
  if (server && operationId) {
    server.emit("package.progress", {
      operationId,
      type: "error",
      action: kind,
      source: "*",
      message,
    });
  }
  return {
    error: createHostError("HOST_RESTART_REQUIRED", message, {
      retryable: true,
      details: {
        kind,
        operationId: operationId ?? null,
        timeoutMs: PACKAGE_MUTATION_TIMEOUT_MS,
      },
    }),
  };
}

async function mutatePackageUnderLock(
  factory: WorkspaceGraphFactory,
  ctx: {
    id: string;
    params: unknown;
    context: Record<string, unknown>;
  },
  kind: MutateKind,
): Promise<{ result: unknown } | { error: ReturnType<typeof createHostError> }> {
  const stale = factory.checkIdentity(ctx.context, {
    requireWorkspace: true,
    allowNullSession: true,
    requirePackage: true,
  });
  if (stale) return { error: stale };

  const g = factory.getGraph();
  const server = factory.getServer();
  if (!g?.packageManager || !g.settingsManager || !server) {
    return { error: createHostError("AGENT_NOT_READY", "Workspace services not ready") };
  }

  if (factory.hasBusySessions()) {
    return {
      error: createHostError("AGENT_BUSY", "Stop the agent before modifying packages", {
        retryable: true,
      }),
    };
  }

  const operationId = randomUUID();
  if (
    !server.serviceGraphLock.tryAcquire({
      operationKind:
        kind === "reload"
          ? "package.reload"
          : kind === "setPreferences"
            ? "resource.setPreferences"
            : "package.mutation",
      requestId: ctx.id,
      operationId,
    })
  ) {
    return {
      error: createHostError("PACKAGE_MUTATION_BUSY", "Another package operation is running", {
        retryable: true,
        details: {
          operationKind: server.serviceGraphLock.getOwner()?.operationKind ?? null,
        },
      }),
    };
  }

  server.setPhase("packageBusy");

  // Capture before snapshot for disk-aware reconcile (B-PKG-DISK-01)
  const trackPackageDisk = packageMutationMayChangeDisk(kind);
  let beforeConfigured: string | undefined;
  let beforeDiskFingerprint: string | undefined;
  try {
    beforeConfigured = JSON.stringify(g.packageManager.listConfiguredPackages());
  } catch {
    beforeConfigured = undefined;
  }
  if (trackPackageDisk) {
    try {
      beforeDiskFingerprint = await capturePackageDiskFingerprint(g, factory.deps.agentDir);
    } catch {
      beforeDiskFingerprint = undefined;
    }
  }

  let mutationError: Error | null = null;
  let changed = false;

  try {
    // re-check identity under lock
    const stale2 = factory.checkIdentity(ctx.context, {
      requireWorkspace: true,
      allowNullSession: true,
      requirePackage: true,
    });
    if (stale2) return { error: stale2 };
    if (factory.hasBusySessions()) {
      return {
        error: createHostError("AGENT_BUSY", "Stop the agent before modifying packages", {
          retryable: true,
        }),
      };
    }

    // Cached runtimes own resource loaders and extension/model state from
    // before this mutation. Drop Session and Workspace caches together.
    await factory.invalidateRetainedRuntimeCaches?.();

    try {
      await runMutation(factory, g, kind, ctx.params, operationId);
      changed = true;
    } catch (err) {
      mutationError = err instanceof Error ? err : new Error(String(err));
      logger.warn("Package mutation threw", { kind, error: mutationError.message });
    }

    // Reconcile: flush + drainErrors + list + resolve
    let flushError: Error | null = null;
    let reconcileError: Error | null = null;
    let afterConfigured = beforeConfigured;

    try {
      await g.settingsManager.flush();
      const errors = g.settingsManager.drainErrors();
      if (errors?.length) {
        flushError = new Error(
          errors.map((e) => e.error?.message ?? String(e.error ?? e)).join("; "),
        );
      }
    } catch (err) {
      flushError = err instanceof Error ? err : new Error(String(err));
    }

    let afterDiskFingerprint = beforeDiskFingerprint;
    try {
      afterConfigured = JSON.stringify(g.packageManager.listConfiguredPackages());
    } catch (err) {
      reconcileError = err instanceof Error ? err : new Error(String(err));
    }
    if (trackPackageDisk) {
      try {
        afterDiskFingerprint = await capturePackageDiskFingerprint(g, factory.deps.agentDir);
      } catch (err) {
        reconcileError = err instanceof Error ? err : new Error(String(err));
      }
    }

    if (beforeConfigured !== afterConfigured) {
      changed = true;
    }
    // Disk fingerprint catches path/resource mutations that leave configured JSON equal
    const diskChanged =
      beforeDiskFingerprint !== undefined &&
      afterDiskFingerprint !== undefined &&
      beforeDiskFingerprint !== afterDiskFingerprint;
    if (diskChanged) {
      changed = true;
    }

    if (mutationError && !changed && !flushError && !reconcileError) {
      const coded = mutationError as Error & { code?: string };
      if (coded.code === "RESOURCE_NOT_FOUND") {
        return {
          error: createHostError("RESOURCE_NOT_FOUND", mutationError.message),
        };
      }
      if (coded.code === "RESOURCE_NOT_CONFIGURABLE") {
        return {
          error: createHostError("RESOURCE_NOT_CONFIGURABLE", mutationError.message),
        };
      }
      return {
        error: createHostError(
          kind === "install"
            ? "PACKAGE_INSTALL_FAILED"
            : kind === "remove"
              ? "PACKAGE_REMOVE_FAILED"
              : kind === "update" || kind === "updateAll"
                ? "PACKAGE_UPDATE_FAILED"
                : "PACKAGE_PARTIAL_FAILURE",
          mutationError.message,
        ),
      };
    }

    const rev = server.identity.bumpPackageRevision();
    let status: PackageMutationResult["status"] = "committed";
    const warnings: PackageMutationResult["warnings"] = [];
    let reconcileRequired = false;
    let sessionSnap = g.sessionSnapshot ?? undefined;
    let sessionChanged = false;

    // Partial mutation: SDK threw after disk/configured already diverged
    if (mutationError && changed) {
      status = "partialFailure";
      reconcileRequired = true;
      g.resourceReloadRequired = true;
    }

    if (mutationError || flushError) {
      status = "partialFailure";
      reconcileRequired = true;
      g.resourceReloadRequired = true;
      warnings.push(
        createHostError(
          "PACKAGE_PARTIAL_FAILURE",
          mutationError?.message ?? flushError?.message ?? "Partial failure",
          {
            details: {
              mutationError: mutationError?.message ?? null,
              flushError: flushError?.message ?? null,
              reconcileError: null,
            },
          },
        ),
      );
    }

    // ResourceLoader is the authoritative metadata source. Reload it before
    // constructing the final package snapshot for every clean mutation.
    if (status === "committed") {
      try {
        if (g.agentSession) {
          await g.agentSession.reload(
            kind === "setPreferences" ? { preserveExtensionCache: true } : undefined,
          );
          const sessionRevision = server.identity.bumpSessionRevision();
          g.toolRevision = 1;
          sessionSnap = buildSessionSnapshot({
            session: g.agentSession,
            sessionManager: g.sessionManager!,
            cwd: g.canonicalCwd,
            sessionId: server.identity.sessionId ?? "",
            revision: sessionRevision,
            workspaceId: g.workspaceId,
            toolRevision: 1,
          });
          g.sessionSnapshot = sessionSnap;
          sessionChanged = true;
        } else if (g.resourceLoader) {
          await g.resourceLoader.reload();
        } else {
          throw new Error("Resource loader unavailable");
        }
        g.resourceReloadRequired = false;
      } catch (err) {
        status = "partialFailure";
        reconcileRequired = true;
        g.resourceReloadRequired = true;
        warnings.push(
          createHostError(
            "RESOURCE_RELOAD_FAILED",
            err instanceof Error ? err.message : "Reload failed",
          ),
        );
      }
    }

    let packageSnapshot: PackageSnapshot;
    try {
      packageSnapshot = await buildPackageSnapshot({
        revision: rev,
        workspaceId: g.workspaceId,
        scope: "all",
        packageManager: g.packageManager,
        settingsManager: g.settingsManager,
        resourceLoader: g.resourceLoader,
        cwd: g.canonicalCwd,
        agentDir: factory.deps.agentDir,
        packageUpdateCheck: factory.deps.packageUpdateCheck,
        resourceIdMap: g.resourceIdMap,
        resourceReloadRequired: g.resourceReloadRequired,
      });
    } catch (err) {
      reconcileError = err instanceof Error ? err : new Error(String(err));
      status = "partialFailure";
      reconcileRequired = true;
      g.resourceReloadRequired = true;
      warnings.push(createHostError("PACKAGE_RESOLVE_FAILED", reconcileError.message));
      packageSnapshot = g.packageSnapshot
        ? { ...g.packageSnapshot, revision: rev, resourceReloadRequired: true }
        : {
            revision: rev,
            workspaceId: g.workspaceId,
            scope: "all",
            configured: [],
            resources: [],
            updateCheck: { supported: factory.deps.packageUpdateCheck },
            diagnostics: [],
            resourceReloadRequired: true,
          };
    }

    // Sync graph.resourceReloadRequired (and mutation meta) into snapshot
    // AFTER reload/reconcile branches may have flipped the graph flag.
    packageSnapshot = finalizePackageSnapshot(
      g,
      packageSnapshot,
      reconcileRequired
        ? {
            operationId,
            status: "partialFailure",
            reconcileRequired: true,
          }
        : undefined,
    );

    server.emit("package.snapshot", packageSnapshot);
    if (sessionChanged && sessionSnap) {
      server.emit("session.snapshot", sessionSnap);
      server.emit("agent.toolsChanged", sessionSnap.tools);
    }

    const result: PackageMutationResult = {
      operationId,
      status,
      packageSnapshot,
      session: sessionSnap,
      warnings,
      reconcileRequired,
    };
    return { result };
  } finally {
    server.serviceGraphLock.release(ctx.id);
    if (server.getPhase() === "packageBusy") {
      server.setPhase("ready");
    }
  }
}

function clonePackageSources(sources: PackageSource[]): PackageSource[] {
  return sources.map((source) => {
    if (typeof source === "string") return source;
    return Object.fromEntries(
      Object.entries(source).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]),
    ) as PackageSourceObject;
  });
}

function packageSourceIdentity(source: PackageSource): string {
  return normalizePackageIdentity(typeof source === "string" ? source : source.source).identity;
}

function stripExactPreference(patterns: string[], relativePath: string): string[] {
  const rel = relativePath.replace(/\\/g, "/");
  return patterns.filter((pattern) => {
    if (!/^[!+-]/.test(pattern)) return true;
    return !matchesResourcePattern(rel, pattern.slice(1), true);
  });
}

function updatePackagePreference(
  sources: PackageSource[],
  identity: string,
  fallbackSource: string,
  type: "extension" | "skill" | "prompt" | "theme",
  relativePath: string,
  preference: "inherit" | "enabled" | "disabled",
  createProjectDelta: boolean,
): PackageSource[] {
  let index = sources.findIndex((source) => {
    const value = typeof source === "string" ? source : source.source;
    return value === fallbackSource || packageSourceIdentity(source) === identity;
  });
  if (index < 0) {
    if (!createProjectDelta || preference === "inherit") return sources;
    sources = [...sources, { source: fallbackSource, autoload: false }];
    index = sources.length - 1;
  }
  const current = sources[index]!;
  if (preference === "inherit" && typeof current === "string") return sources;
  if (preference === "enabled" && typeof current === "string") return sources;
  let object: PackageSourceObject =
    typeof current === "string" ? { source: current } : { ...current };
  const key = resourceTypeToSettingsKey(type);

  if (preference === "inherit") {
    const existing = object[key];
    if (!existing) return sources;
    if (existing) {
      const next = stripExactPreference(existing, relativePath);
      if (next.length > 0) object[key] = next;
      else delete object[key];
    }
  } else if (object.autoload === false) {
    const rel = relativePath.replace(/\\/g, "/");
    const existing = stripExactPreference(object[key] ?? [], rel);
    object[key] = [...existing, `${preference === "enabled" ? "+" : "-"}${rel}`];
  } else {
    const one = [object] as PackageSource[];
    const updated = setPackageResourceFilter(
      one,
      object.source,
      type,
      relativePath,
      preference === "enabled",
    )[0]!;
    if (typeof updated === "string") {
      sources[index] = updated;
      return sources;
    }
    object = updated;
  }

  const hasResourceFields = ["extensions", "skills", "prompts", "themes"].some(
    (field) => object[field] !== undefined,
  );
  if (!hasResourceFields) {
    if (object.autoload === false) {
      return [...sources.slice(0, index), ...sources.slice(index + 1)];
    }
    sources[index] = object.source;
    return sources;
  }
  sources[index] = object;
  return sources;
}

function setSettingsPaths(
  sm: NonNullable<WorkspaceGraph["settingsManager"]>,
  scope: "user" | "project",
  key: "extensions" | "skills" | "prompts" | "themes",
  paths: string[],
): void {
  if (scope === "project") {
    const setter =
      key === "extensions"
        ? sm.setProjectExtensionPaths.bind(sm)
        : key === "skills"
          ? sm.setProjectSkillPaths.bind(sm)
          : key === "prompts"
            ? sm.setProjectPromptTemplatePaths.bind(sm)
            : sm.setProjectThemePaths.bind(sm);
    setter(paths);
    return;
  }
  const setter =
    key === "extensions"
      ? sm.setExtensionPaths.bind(sm)
      : key === "skills"
        ? sm.setSkillPaths.bind(sm)
        : key === "prompts"
          ? sm.setPromptTemplatePaths.bind(sm)
          : sm.setThemePaths.bind(sm);
  setter(paths);
}

export function applyResourcePreferences(
  g: WorkspaceGraph,
  updates: ResourcePreferenceUpdate[],
): void {
  const sm = g.settingsManager!;
  const resolved = updates.map((update) => {
    const metadata = g.resourceIdMap.get(update.resourceId);
    if (!metadata) {
      throw Object.assign(new Error(`Resource not found: ${update.resourceId}`), {
        code: "RESOURCE_NOT_FOUND",
      });
    }
    if (!metadata.configurableScopes.includes(update.targetScope)) {
      throw Object.assign(
        new Error(`Resource ${update.resourceId} cannot be configured at ${update.targetScope} scope`),
        { code: "RESOURCE_NOT_CONFIGURABLE" },
      );
    }
    return { update, metadata };
  });

  let userPackages = clonePackageSources(
    ((sm.getGlobalSettings().packages ?? []) as PackageSource[]),
  );
  let projectPackages = clonePackageSources(
    ((sm.getProjectSettings().packages ?? []) as PackageSource[]),
  );
  let userPackagesChanged = false;
  let projectPackagesChanged = false;
  const pathChanges = new Map<
    string,
    { scope: "user" | "project"; key: "extensions" | "skills" | "prompts" | "themes"; paths: string[] }
  >();

  for (const { update, metadata } of resolved) {
    if (metadata.origin === "package") {
      if (!metadata.packageIdentity || !metadata.packageSource || !metadata.packageScope) {
        throw Object.assign(new Error("Package resource metadata is incomplete"), {
          code: "RESOURCE_NOT_CONFIGURABLE",
        });
      }
      if (update.targetScope === "user") {
        userPackages = updatePackagePreference(
          userPackages,
          metadata.packageIdentity,
          metadata.packageSource,
          metadata.type,
          metadata.relativePath,
          update.preference,
          false,
        );
        userPackagesChanged = true;
      } else {
        projectPackages = updatePackagePreference(
          projectPackages,
          metadata.packageIdentity,
          metadata.projectOverrideSource ?? metadata.packageSource,
          metadata.type,
          metadata.relativePath,
          update.preference,
          metadata.packageScope === "user",
        );
        projectPackagesChanged = true;
      }
      continue;
    }
    if (metadata.origin !== "top-level") {
      throw Object.assign(new Error("Extension-owned resources are read-only"), {
        code: "RESOURCE_NOT_CONFIGURABLE",
      });
    }
    const key = resourceTypeToSettingsKey(metadata.type);
    const changeKey = `${update.targetScope}:${key}`;
    const existing = pathChanges.get(changeKey);
    const settings = update.targetScope === "project" ? sm.getProjectSettings() : sm.getGlobalSettings();
    let paths = existing?.paths ?? ([...(settings[key] ?? [])] as string[]);
    if (update.targetScope === "project" && metadata.scope === "user") {
      const pattern = metadata.path.replace(/\\/g, "/");
      const candidates = new Set([
        pattern,
        metadata.relativePath.replace(/\\/g, "/"),
        relative(join(g.canonicalCwd, ".pi"), metadata.path).replace(/\\/g, "/"),
      ]);
      paths = paths.filter((entry) => {
        const target = /^[!+-]/.test(entry) ? entry.slice(1) : entry;
        return !candidates.has(target);
      });
      if (update.preference !== "inherit") {
        if (!paths.includes(pattern)) paths.push(pattern);
        paths.push(`${update.preference === "enabled" ? "+" : "-"}${pattern}`);
      }
    } else {
      paths = update.preference === "inherit"
        ? stripExactPreference(paths, metadata.relativePath)
        : setTopLevelPathEnabled(paths, metadata.relativePath, update.preference === "enabled");
    }
    pathChanges.set(changeKey, { scope: update.targetScope, key, paths });
  }

  // Validation and transformation happen above. Each affected settings field is
  // replaced once, avoiding observable partially-applied batches in memory.
  if (userPackagesChanged) sm.setPackages(userPackages as never);
  if (projectPackagesChanged) sm.setProjectPackages(projectPackages as never);
  for (const change of pathChanges.values()) {
    setSettingsPaths(sm, change.scope, change.key, change.paths);
  }
}

async function runMutation(
  factory: WorkspaceGraphFactory,
  g: NonNullable<ReturnType<WorkspaceGraphFactory["getGraph"]>>,
  kind: MutateKind,
  params: unknown,
  operationId: string,
): Promise<void> {
  const server = factory.getServer()!;
  const pm = g.packageManager!;
  const sm = g.settingsManager!;

  const emitProgress = (type: "start" | "progress" | "complete" | "error", action: string, source: string, message?: string) => {
    server.emit("package.progress", {
      operationId,
      type,
      action,
      source,
      message,
    });
  };

  pm.setProgressCallback((ev) => {
    emitProgress(
      ev.type === "start" || ev.type === "progress" || ev.type === "complete" || ev.type === "error"
        ? ev.type
        : "progress",
      ev.action,
      ev.source,
      ev.message,
    );
  });

  try {
    switch (kind) {
      case "install": {
        const p = params as { source: string; scope: "user" | "project" };
        emitProgress("start", "install", p.source);
        await pm.installAndPersist(p.source, { local: p.scope === "project" });
        emitProgress("complete", "install", p.source);
        break;
      }
      case "remove": {
        const p = params as { packageId: string };
        const rec = g.packageSnapshot?.configured.find((c) => c.id === p.packageId);
        if (!rec) throw new Error("Package not found");
        emitProgress("start", "remove", rec.source);
        // Project-local settings store paths relative to `<workspace>/.pi`, while
        // the SDK matches remove inputs relative to the process cwd. Use the
        // already-resolved local path so both sides identify the same package.
        const source = rec.kind === "local" && rec.installedPath ? rec.installedPath : rec.source;
        const ok = await pm.removeAndPersist(source, { local: rec.scope === "project" });
        if (!ok) throw new Error("Package not found in configuration");
        emitProgress("complete", "remove", rec.source);
        break;
      }
      case "update": {
        const p = params as { packageId: string };
        const rec = g.packageSnapshot?.configured.find((c) => c.id === p.packageId);
        if (!rec) throw new Error("Package not found");
        emitProgress("start", "update", rec.source);
        await pm.update(rec.source);
        emitProgress("complete", "update", rec.source);
        break;
      }
      case "updateAll": {
        emitProgress("start", "update", "*");
        await pm.update();
        emitProgress("complete", "update", "*");
        break;
      }
      case "setPreferences": {
        const updates = Array.isArray(params)
          ? params as ResourcePreferenceUpdate[]
          : (params as { updates?: ResourcePreferenceUpdate[] }).updates ?? [params as ResourcePreferenceUpdate];
        applyResourcePreferences(g, updates);
        break;
      }
      case "reload": {
        // Reload ownership is handled after reconciliation so the shared loader
        // is invoked exactly once through AgentSession when a session exists.
        break;
      }
    }
  } finally {
    pm.setProgressCallback(undefined);
  }
}
