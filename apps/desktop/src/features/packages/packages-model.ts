import type {
  HostRequestParams,
  PackageRecord,
  ResourcePreferenceUpdate,
  ResourceRecord,
  ResourceType,
} from "@pideck/protocol";

export const PACKAGE_RESOURCE_TYPES: ResourceType[] = [
  "extension",
  "skill",
  "prompt",
  "theme",
];

export type PackageScopeFilter = "all" | "user" | "project";
export type ResourceTypeFilter = "all" | ResourceType;
export type ResourceOriginFilter = "all" | "package" | "standalone" | "runtime";
export type ResourceMode = "user" | "project";

export type InstalledFilters = {
  query: string;
  scope: PackageScopeFilter;
  type: ResourceTypeFilter;
};

export type ResourceFilters = {
  query: string;
  mode: ResourceMode;
  type: ResourceTypeFilter;
  origin: ResourceOriginFilter;
  packageId?: string;
};

export type ResourceListItem =
  | {
      kind: "package";
      id: string;
      package: PackageRecord;
      matchingResources: ResourceRecord[];
      resources: ResourceRecord[];
    }
  | {
      kind: "resource";
      id: string;
      resource: ResourceRecord;
    };

export const PACKAGE_LIST_PARAMS: HostRequestParams["package.list"] = {
  scope: "all",
  includeResources: true,
};

export type PackageUpdatePlan =
  | {
      method: "package.update";
      params: HostRequestParams["package.update"];
      packages: PackageRecord[];
      touchesProject: boolean;
    }
  | {
      method: "package.updateAll";
      params: HostRequestParams["package.updateAll"];
      packages: PackageRecord[];
      touchesProject: boolean;
    };

export function planPackageUpdate(
  packages: PackageRecord[],
  updateAll: boolean,
): PackageUpdatePlan | null {
  if (!packages.length) return null;
  const touchesProject = packages.some((item) => item.scope === "project");
  if (updateAll) {
    return {
      method: "package.updateAll",
      params: null,
      packages,
      touchesProject,
    };
  }
  return {
    method: "package.update",
    params: { packageId: packages[0].id },
    packages,
    touchesProject,
  };
}

function includesQuery(values: Array<string | undefined>, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return values.some((value) => value?.toLocaleLowerCase().includes(needle));
}

function packageContainsType(
  pkg: PackageRecord,
  resources: ResourceRecord[],
  type: ResourceType,
): boolean {
  const key = `${type}s` as "extensions" | "skills" | "prompts" | "themes";
  return (
    (pkg.resourceCounts?.[key] ?? 0) > 0 ||
    resources.some((resource) => resource.packageId === pkg.id && resource.type === type)
  );
}

export function filterInstalledPackages(
  packages: PackageRecord[],
  resources: ResourceRecord[],
  filters: InstalledFilters,
): PackageRecord[] {
  return packages.filter((pkg) => {
    if (filters.scope !== "all" && pkg.scope !== filters.scope) return false;
    if (
      filters.type !== "all" &&
      !packageContainsType(pkg, resources, filters.type)
    ) {
      return false;
    }
    return includesQuery(
      [pkg.displayName, pkg.description, pkg.source, pkg.identity, pkg.versionOrRef],
      filters.query,
    );
  });
}

function resourceOwner(
  resource: ResourceRecord,
  resourcesById: Map<string, ResourceRecord>,
): ResourceRecord | undefined {
  return resource.control.kind === "owner-extension"
    ? resourcesById.get(resource.control.ownerResourceId)
    : undefined;
}

function resourceBelongsToPackage(
  resource: ResourceRecord,
  packageId: string,
  resourcesById: Map<string, ResourceRecord>,
): boolean {
  if (resource.packageId === packageId) return true;
  return resourceOwner(resource, resourcesById)?.packageId === packageId;
}

export function filterResources(
  resources: ResourceRecord[],
  packages: PackageRecord[],
  filters: ResourceFilters,
): ResourceRecord[] {
  const resourcesById = new Map(resources.map((resource) => [resource.id, resource]));
  const packagesById = new Map(packages.map((pkg) => [pkg.id, pkg]));
  const typeOrder = new Map(PACKAGE_RESOURCE_TYPES.map((type, index) => [type, index]));

  return resources
    .filter((resource) => {
      const owner = resourceOwner(resource, resourcesById);
      const pkg = packagesById.get(resource.packageId ?? owner?.packageId ?? "");
      if (filters.mode === "user") {
        const effectiveScope = resource.scope === "temporary" ? owner?.scope : resource.scope;
        if (effectiveScope === "project") return false;
      }
      if (filters.mode === "project" && pkg?.effective === false) return false;
      if (filters.type !== "all" && resource.type !== filters.type) return false;
      const runtime = resource.scope === "temporary" || resource.origin === "extension";
      if (filters.origin === "package" && (runtime || resource.origin !== "package")) return false;
      if (filters.origin === "standalone" && (runtime || resource.origin !== "top-level")) return false;
      if (filters.origin === "runtime" && !runtime) return false;
      if (
        filters.packageId &&
        !resourceBelongsToPackage(resource, filters.packageId, resourcesById)
      ) {
        return false;
      }

      return includesQuery(
        [
          resource.name,
          resource.description,
          resource.path,
          resource.relativePath,
          resource.source,
          owner?.name,
          pkg?.displayName,
        ],
        filters.query,
      );
    })
    .sort((left, right) => {
      const typeDifference = (typeOrder.get(left.type) ?? 0) - (typeOrder.get(right.type) ?? 0);
      if (typeDifference !== 0) return typeDifference;
      const nameDifference = left.name.localeCompare(right.name, undefined, {
        sensitivity: "base",
      });
      if (nameDifference !== 0) return nameDifference;
      return left.path.localeCompare(right.path, undefined, { sensitivity: "base" });
    });
}

export function buildResourceListItems(
  resources: ResourceRecord[],
  packages: PackageRecord[],
  filters: ResourceFilters,
): ResourceListItem[] {
  const matching = filterResources(resources, packages, filters);
  const packagesById = new Map(packages.map((pkg) => [pkg.id, pkg]));
  const packageMatches = new Map<string, ResourceRecord[]>();
  const individualItems: ResourceListItem[] = [];

  for (const resource of matching) {
    const pkg = resource.packageId ? packagesById.get(resource.packageId) : undefined;
    if (resource.origin !== "package" || !pkg) {
      individualItems.push({ kind: "resource", id: resource.id, resource });
      continue;
    }
    const grouped = packageMatches.get(pkg.id);
    if (grouped) grouped.push(resource);
    else packageMatches.set(pkg.id, [resource]);
  }

  const modeResources = filterResources(resources, packages, {
    query: "",
    mode: filters.mode,
    type: "all",
    origin: "all",
  });
  const packageResources = new Map<string, ResourceRecord[]>();
  for (const resource of modeResources) {
    if (resource.origin !== "package" || !resource.packageId) continue;
    if (!packagesById.has(resource.packageId)) continue;
    const grouped = packageResources.get(resource.packageId);
    if (grouped) grouped.push(resource);
    else packageResources.set(resource.packageId, [resource]);
  }

  const packageItems = Array.from(
    packageMatches,
    ([packageId, matchingResources]): Extract<ResourceListItem, { kind: "package" }> => ({
      kind: "package",
      id: packageId,
      package: packagesById.get(packageId)!,
      matchingResources,
      resources: packageResources.get(packageId) ?? [],
    }),
  ).sort((left, right) =>
    left.package.displayName.localeCompare(right.package.displayName, undefined, {
      sensitivity: "base",
    }),
  );

  return [...packageItems, ...individualItems];
}

export function preferenceResourcesForListItems(
  items: ResourceListItem[],
): ResourceRecord[] {
  const resourcesById = new Map<string, ResourceRecord>();
  for (const item of items) {
    const itemResources = item.kind === "package" ? item.resources : [item.resource];
    for (const resource of itemResources) {
      if (!resourcesById.has(resource.id)) resourcesById.set(resource.id, resource);
    }
  }
  return Array.from(resourcesById.values());
}

export function resourcePreference(
  resource: ResourceRecord,
  mode: ResourceMode,
): "inherit" | "enabled" | "disabled" {
  if (mode === "project") return resource.preferences.project ?? "inherit";
  return resource.preferences.user ?? (resource.enabled ? "enabled" : "disabled");
}

export function canConfigureResource(
  resource: ResourceRecord,
  mode: ResourceMode,
): boolean {
  return (
    resource.control.kind === "preference" && resource.control.scopes.includes(mode)
  );
}

export function buildResourcePreferenceUpdate(
  resource: ResourceRecord,
  mode: ResourceMode,
  preference: "inherit" | "enabled" | "disabled",
): ResourcePreferenceUpdate | null {
  if (!canConfigureResource(resource, mode)) return null;
  if (mode === "user") {
    if (preference === "inherit") return null;
    return { resourceId: resource.id, targetScope: "user", preference };
  }
  return { resourceId: resource.id, targetScope: "project", preference };
}

export function buildResourcePreferenceUpdates(
  resources: ResourceRecord[],
  mode: ResourceMode,
  preference: "inherit" | "enabled" | "disabled",
): ResourcePreferenceUpdate[] {
  return resources.flatMap((resource) => {
    if (resourcePreference(resource, mode) === preference) return [];
    const update = buildResourcePreferenceUpdate(resource, mode, preference);
    return update ? [update] : [];
  });
}

function optimisticEnabled(
  resource: ResourceRecord,
  update: ResourcePreferenceUpdate,
): boolean {
  if (update.targetScope === "user") return update.preference === "enabled";
  if (update.preference === "enabled") return true;
  if (update.preference === "disabled") return false;
  if (resource.scope === "project") return true;
  return resource.preferences.user !== "disabled";
}

/**
 * Project the requested preference onto the visible inventory while the Host
 * reloads the Agent session. The next authoritative snapshot replaces this
 * projection, including any dynamic resources that were added or removed.
 */
export function applyOptimisticResourcePreferences(
  resources: ResourceRecord[],
  updates: ResourcePreferenceUpdate[],
): ResourceRecord[] {
  if (updates.length === 0) return resources;
  const byId = new Map(updates.map((update) => [update.resourceId, update]));
  return resources.map((resource) => {
    const direct = byId.get(resource.id);
    const ownerUpdate = resource.control.kind === "owner-extension"
      ? byId.get(resource.control.ownerResourceId)
      : undefined;
    const update = direct ?? ownerUpdate;
    if (!update) return resource;
    return {
      ...resource,
      enabled: optimisticEnabled(resource, update),
      ...(direct
        ? {
            preferences: {
              ...resource.preferences,
              [update.targetScope]: update.preference,
            },
          }
        : {}),
    };
  });
}

export function summarizeResources(resources: ResourceRecord[]): {
  total: number;
  enabled: number;
  disabled: number;
} {
  const enabled = resources.filter((resource) => resource.enabled).length;
  return { total: resources.length, enabled, disabled: resources.length - enabled };
}

export function hasActiveInstalledFilters(filters: InstalledFilters): boolean {
  return Boolean(filters.query.trim()) || filters.scope !== "all" || filters.type !== "all";
}

export function hasActiveResourceFilters(filters: ResourceFilters): boolean {
  return (
    Boolean(filters.query.trim()) ||
    filters.type !== "all" ||
    filters.origin !== "all" ||
    Boolean(filters.packageId)
  );
}
