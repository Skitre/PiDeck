import { createHash } from "node:crypto";
import { basename, relative } from "node:path";
import type {
  DefaultPackageManager,
  SettingsManager,
  ResolvedResource,
} from "@earendil-works/pi-coding-agent";
import type {
  PackageRecord,
  PackageResource,
  PackageSnapshot,
  TopLevelResource,
} from "@pideck/protocol";

export type ResourceIdMap = Map<
  string,
  {
    type: "extension" | "skill" | "prompt" | "theme";
    scope: "user" | "project" | "temporary";
    path: string;
    baseDir?: string;
    origin: "package" | "top-level";
    packageSource?: string;
    packageScope?: "user" | "project";
  }
>;

function packageId(source: string, scope: string): string {
  const h = createHash("sha256").update(`${scope}::${source}`).digest("hex").slice(0, 12);
  return `pkg_${scope}_${h}`;
}

function resourceId(
  origin: string,
  type: string,
  path: string,
  packageIdOrScope: string,
): string {
  const h = createHash("sha256")
    .update(`${origin}|${type}|${packageIdOrScope}|${path}`)
    .digest("hex")
    .slice(0, 16);
  return `res_${h}`;
}

function detectKind(source: string): "npm" | "git" | "local" {
  if (source.startsWith("npm:") || (!source.includes(":") && !source.includes("/") && !source.includes("\\") && !source.startsWith("."))) {
    if (source.startsWith("git:") || source.includes("github.com") || source.startsWith("git@")) {
      return "git";
    }
    if (source.startsWith("npm:")) return "npm";
    // bare package name
    if (!/[\\/]/.test(source) && !source.startsWith(".")) return "npm";
  }
  if (
    source.startsWith("git:") ||
    source.includes("github.com") ||
    source.startsWith("git@") ||
    source.startsWith("https://") ||
    source.startsWith("ssh://")
  ) {
    return "git";
  }
  return "local";
}

function displayName(source: string): string {
  if (source.startsWith("npm:")) return source.slice(4);
  const base = basename(source.replace(/\\/g, "/"));
  return base || source;
}

function normalizedScope(scope: "user" | "project" | "temporary"): "user" | "project" {
  return scope === "project" ? "project" : "user";
}

function includesScope(
  requested: "user" | "project" | "all",
  actual: "user" | "project" | "temporary",
): boolean {
  return requested === "all" || requested === normalizedScope(actual);
}

export async function buildPackageSnapshot(args: {
  revision: number;
  workspaceId: string;
  scope: "user" | "project" | "all";
  packageManager: DefaultPackageManager;
  settingsManager: SettingsManager;
  packageUpdateCheck: boolean;
  resourceIdMap: ResourceIdMap;
  updatesCache?: Map<string, boolean>;
  resourceReloadRequired?: boolean;
}): Promise<PackageSnapshot> {
  const { packageManager, resourceIdMap } = args;
  resourceIdMap.clear();

  let configured = packageManager.listConfiguredPackages();
  if (args.scope === "user") configured = configured.filter((c) => c.scope === "user");
  if (args.scope === "project") configured = configured.filter((c) => c.scope === "project");

  const resolved = await packageManager.resolve(async () => "skip");

  // Index resolved package resources by source+scope
  const resourcesBySource = new Map<string, ResolvedResource[]>();
  const allResolved: Array<{ type: "extension" | "skill" | "prompt" | "theme"; r: ResolvedResource }> =
    [];

  for (const type of ["extensions", "skills", "prompts", "themes"] as const) {
    const list = resolved[type];
    const resourceType =
      type === "extensions"
        ? "extension"
        : type === "skills"
          ? "skill"
          : type === "prompts"
            ? "prompt"
            : "theme";
    for (const r of list) {
      if (!includesScope(args.scope, r.metadata.scope)) continue;
      allResolved.push({ type: resourceType, r });
      if (r.metadata.origin === "package") {
        const key = `${r.metadata.scope}::${r.metadata.source}`;
        const arr = resourcesBySource.get(key) ?? [];
        arr.push(r);
        resourcesBySource.set(key, arr);
      }
    }
  }

  // Build configured records with override relationships
  const byIdentity = new Map<string, typeof configured>();
  for (const c of configured) {
    const key = c.source;
    const arr = byIdentity.get(key) ?? [];
    arr.push(c);
    byIdentity.set(key, arr);
  }

  const records: PackageRecord[] = configured.map((c) => {
    const id = packageId(c.source, c.scope);
    const installedPath =
      c.installedPath ?? packageManager.getInstalledPath(c.source, c.scope);
    const same = byIdentity.get(c.source) ?? [c];
    const hasProject = same.some((x) => x.scope === "project");
    const hasUser = same.some((x) => x.scope === "user");

    let effective = true;
    let shadowedByPackageId: string | undefined;
    let overridesPackageId: string | undefined;

    if (hasProject && hasUser) {
      if (c.scope === "user") {
        effective = false;
        shadowedByPackageId = packageId(c.source, "project");
      } else {
        effective = true;
        overridesPackageId = packageId(c.source, "user");
      }
    }

    const key = `${c.scope}::${c.source}`;
    const resList = resourcesBySource.get(key) ?? [];
    let resourceCounts: PackageRecord["resourceCounts"] = null;
    let resourceCountsState: PackageRecord["resourceCountsState"] = "unknownShadowed";

    if (effective) {
      const counts = { extensions: 0, skills: 0, prompts: 0, themes: 0, enabled: 0, disabled: 0 };
      for (const r of resList) {
        // type inferred from which list — recount from allResolved
      }
      for (const { type, r } of allResolved) {
        if (r.metadata.origin !== "package") continue;
        if (r.metadata.source !== c.source || r.metadata.scope !== c.scope) continue;
        if (type === "extension") counts.extensions++;
        if (type === "skill") counts.skills++;
        if (type === "prompt") counts.prompts++;
        if (type === "theme") counts.themes++;
        if (r.enabled) counts.enabled++;
        else counts.disabled++;
      }
      resourceCounts = counts;
      resourceCountsState = "resolvedEffective";
    }

    return {
      id,
      source: c.source,
      kind: detectKind(c.source),
      scope: c.scope,
      filtered: c.filtered,
      installed: Boolean(installedPath),
      installedPath: installedPath ?? undefined,
      displayName: displayName(c.source),
      updateAvailable: args.updatesCache?.get(c.source),
      effective,
      shadowedByPackageId,
      overridesPackageId,
      resourceCounts,
      resourceCountsState,
    };
  });

  const packageResources: PackageResource[] = [];
  const topLevelResources: TopLevelResource[] = [];
  const configuredIds = new Set(records.map((record) => record.id));

  for (const { type, r } of allResolved) {
    if (r.metadata.origin === "package") {
      const pkgId = packageId(r.metadata.source, normalizedScope(r.metadata.scope));
      if (!configuredIds.has(pkgId)) continue;
      const id = resourceId("package", type, r.path, pkgId);
      packageResources.push({
        id,
        packageId: pkgId,
        type,
        name: basename(r.path),
        path: r.path,
        relativePath: r.metadata.baseDir
          ? relative(r.metadata.baseDir, r.path).replace(/\\/g, "/")
          : undefined,
        enabled: r.enabled,
        scope: r.metadata.scope,
        origin: "package",
      });
      resourceIdMap.set(id, {
        type,
        scope: r.metadata.scope,
        path: r.path,
        baseDir: r.metadata.baseDir,
        origin: "package",
        packageSource: r.metadata.source,
        packageScope: r.metadata.scope === "temporary" ? "user" : r.metadata.scope,
      });
    } else {
      const scope = r.metadata.scope === "temporary" ? "user" : r.metadata.scope;
      const id = resourceId("top-level", type, r.path, scope);
      topLevelResources.push({
        id,
        type,
        name: basename(r.path),
        path: r.path,
        enabled: r.enabled,
        scope,
        source: r.metadata.baseDir ? "auto" : "local",
        origin: "top-level",
      });
      resourceIdMap.set(id, {
        type,
        scope: r.metadata.scope,
        path: r.path,
        baseDir: r.metadata.baseDir,
        origin: "top-level",
      });
    }
  }

  return {
    revision: args.revision,
    workspaceId: args.workspaceId,
    scope: args.scope,
    configured: records,
    packageResources,
    topLevelResources,
    updateCheck: {
      supported: args.packageUpdateCheck,
    },
    diagnostics: [],
    resourceReloadRequired: args.resourceReloadRequired === true,
  };
}
