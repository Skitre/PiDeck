import { describe, expect, it } from "vitest";
import type { PackageRecord, ResourceRecord } from "@pideck/protocol";
import {
  PACKAGE_LIST_PARAMS,
  applyOptimisticResourcePreferences,
  buildResourceListItems,
  buildResourcePreferenceUpdate,
  buildResourcePreferenceUpdates,
  canConfigureResource,
  filterInstalledPackages,
  filterResources,
  hasActiveInstalledFilters,
  hasActiveResourceFilters,
  planPackageUpdate,
  preferenceResourcesForListItems,
  resourcePreference,
  summarizeResources,
} from "./packages-model";

function pkg(overrides: Partial<PackageRecord> = {}): PackageRecord {
  return {
    id: "package:user:tools",
    identity: "npm:tools",
    source: "npm:tools",
    kind: "npm",
    scope: "user",
    filtered: false,
    installed: true,
    displayName: "Tools",
    effective: true,
    resourceCounts: {
      extensions: 1,
      skills: 1,
      prompts: 0,
      themes: 0,
      enabled: 2,
      disabled: 0,
    },
    resourceCountsState: "resolvedEffective",
    ...overrides,
  };
}

function resource(overrides: Partial<ResourceRecord> = {}): ResourceRecord {
  return {
    id: "resource:extension:tools",
    type: "extension",
    name: "Tools extension",
    path: "C:/agent/extensions/tools.ts",
    scope: "user",
    origin: "package",
    source: "npm:tools",
    packageId: "package:user:tools",
    enabled: true,
    preferences: { user: "enabled", project: "inherit" },
    control: { kind: "preference", scopes: ["user", "project"] },
    diagnostics: [],
    ...overrides,
  };
}

describe("Package view models", () => {
  it("plans all-scope loading and exact update protocol payloads", () => {
    const userPackage = pkg();
    const projectPackage = pkg({
      id: "package:project:tools",
      scope: "project",
    });

    expect(PACKAGE_LIST_PARAMS).toEqual({ scope: "all", includeResources: true });
    expect(planPackageUpdate([userPackage, projectPackage], true)).toEqual({
      method: "package.updateAll",
      params: null,
      packages: [userPackage, projectPackage],
      touchesProject: true,
    });
    expect(planPackageUpdate([userPackage], false)).toEqual({
      method: "package.update",
      params: { packageId: userPackage.id },
      packages: [userPackage],
      touchesProject: false,
    });
    expect(planPackageUpdate([], true)).toBeNull();
  });

  it("combines installed search, scope, and contains filters", () => {
    const packages = [
      pkg(),
      pkg({
        id: "package:project:theme",
        identity: "local:theme",
        displayName: "Workspace theme",
        source: "./theme",
        kind: "local",
        scope: "project",
        resourceCounts: {
          extensions: 0,
          skills: 0,
          prompts: 0,
          themes: 1,
          enabled: 1,
          disabled: 0,
        },
      }),
    ];
    expect(
      filterInstalledPackages(packages, [], {
        query: "workspace",
        scope: "project",
        type: "theme",
      }).map((item) => item.id),
    ).toEqual(["package:project:theme"]);
    expect(
      filterInstalledPackages(packages, [], {
        query: "",
        scope: "all",
        type: "skill",
      }).map((item) => item.id),
    ).toEqual(["package:user:tools"]);
  });

  it("shows inherited user resources in Project mode and resolves runtime owners", () => {
    const owner = resource();
    const runtimeSkill = resource({
      id: "resource:runtime:review",
      type: "skill",
      name: "Review",
      description: "Review a change",
      path: "runtime://review/SKILL.md",
      scope: "temporary",
      origin: "extension",
      packageId: undefined,
      control: { kind: "owner-extension", ownerResourceId: owner.id },
      manualOnly: true,
    });
    const projectResource = resource({
      id: "resource:project:prompt",
      type: "prompt",
      name: "Project prompt",
      scope: "project",
    });
    const standaloneResource = resource({
      id: "resource:standalone:theme",
      type: "theme",
      name: "Standalone theme",
      scope: "user",
      origin: "top-level",
      packageId: undefined,
    });
    const resources = [projectResource, runtimeSkill, owner, standaloneResource];

    expect(
      filterResources(resources, [pkg()], {
        query: "review a change",
        mode: "project",
        type: "all",
        origin: "all",
        packageId: "package:user:tools",
      }).map((item) => item.id),
    ).toEqual([runtimeSkill.id]);
    expect(
      filterResources(resources, [pkg()], {
        query: "",
        mode: "user",
        type: "theme",
        origin: "standalone",
      }).map((item) => item.id),
    ).toEqual([standaloneResource.id]);
    expect(
      filterResources(resources, [pkg()], {
        query: "",
        mode: "user",
        type: "all",
        origin: "all",
      }).map((item) => item.id),
    ).toEqual([owner.id, runtimeSkill.id, standaloneResource.id]);
    expect(
      filterResources(resources, [pkg()], {
        query: "",
        mode: "project",
        type: "skill",
        origin: "runtime",
      }).map((item) => item.id),
    ).toEqual([runtimeSkill.id]);
  });

  it("keeps replaced package resources in User mode but excludes them from Project mode", () => {
    const replacedPackage = pkg({
      id: "package:user:replaced",
      effective: false,
      shadowedByPackageId: "package:project:replacement",
    });
    const owner = resource({
      id: "resource:extension:replaced",
      packageId: replacedPackage.id,
    });
    const dynamic = resource({
      id: "resource:runtime:replaced",
      type: "skill",
      scope: "temporary",
      origin: "extension",
      packageId: undefined,
      control: { kind: "owner-extension", ownerResourceId: owner.id },
    });

    expect(
      filterResources([owner, dynamic], [replacedPackage], {
        query: "",
        mode: "user",
        type: "all",
        origin: "all",
      }).map((item) => item.id),
    ).toEqual([owner.id, dynamic.id]);
    expect(
      filterResources([owner, dynamic], [replacedPackage], {
        query: "",
        mode: "project",
        type: "all",
        origin: "all",
      }),
    ).toEqual([]);
  });

  it("groups matching package resources without narrowing the package preference set", () => {
    const extension = resource();
    const prompt = resource({
      id: "resource:prompt:tools",
      type: "prompt",
      name: "Tools prompt",
    });

    const items = buildResourceListItems([prompt, extension], [pkg()], {
      query: "",
      mode: "user",
      type: "extension",
      origin: "all",
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "package",
      id: "package:user:tools",
      matchingResources: [{ id: extension.id }],
      resources: [{ id: extension.id }, { id: prompt.id }],
    });
  });

  it("matches package resources by package name and sorts package rows first", () => {
    const alphaPackage = pkg({
      id: "package:user:alpha",
      displayName: "Alpha utilities",
    });
    const toolsResource = resource({ name: "Unrelated extension" });
    const alphaResource = resource({
      id: "resource:extension:alpha",
      name: "Another extension",
      packageId: alphaPackage.id,
    });
    const standalone = resource({
      id: "resource:extension:standalone",
      name: "Alpha standalone",
      origin: "top-level",
      packageId: undefined,
    });

    const items = buildResourceListItems(
      [standalone, toolsResource, alphaResource],
      [pkg(), alphaPackage],
      { query: "utilities", mode: "user", type: "all", origin: "all" },
    );

    expect(items.map((item) => item.id)).toEqual([alphaPackage.id]);
    expect(items[0]).toMatchObject({
      kind: "package",
      matchingResources: [{ id: alphaResource.id }],
    });

    const allItems = buildResourceListItems(
      [standalone, toolsResource, alphaResource],
      [pkg(), alphaPackage],
      { query: "", mode: "user", type: "all", origin: "all" },
    );
    expect(allItems.map((item) => item.id)).toEqual([
      alphaPackage.id,
      "package:user:tools",
      standalone.id,
    ]);
  });

  it("keeps standalone, runtime, and orphaned package resources as individual rows", () => {
    const owner = resource();
    const standalone = resource({
      id: "resource:standalone:skill",
      type: "skill",
      origin: "top-level",
      packageId: undefined,
    });
    const runtime = resource({
      id: "resource:runtime:skill",
      type: "skill",
      scope: "temporary",
      origin: "extension",
      packageId: undefined,
      control: { kind: "owner-extension", ownerResourceId: owner.id },
    });
    const orphan = resource({
      id: "resource:orphan:prompt",
      type: "prompt",
      packageId: "package:user:missing",
    });

    const items = buildResourceListItems([runtime, orphan, standalone], [pkg()], {
      query: "",
      mode: "user",
      type: "all",
      origin: "all",
    });

    expect(items).toHaveLength(3);
    expect(items.every((item) => item.kind === "resource")).toBe(true);
    expect(items.map((item) => item.id)).toEqual([runtime.id, standalone.id, orphan.id]);
  });

  it("uses current-mode eligibility for package members", () => {
    const replacedPackage = pkg({ effective: false });
    const userResource = resource();
    const projectResource = resource({
      id: "resource:prompt:project",
      type: "prompt",
      scope: "project",
    });

    const userItems = buildResourceListItems(
      [projectResource, userResource],
      [replacedPackage],
      { query: "", mode: "user", type: "extension", origin: "all" },
    );
    expect(userItems).toHaveLength(1);
    expect(userItems[0]).toMatchObject({
      kind: "package",
      resources: [{ id: userResource.id }],
    });

    expect(
      buildResourceListItems([projectResource, userResource], [replacedPackage], {
        query: "",
        mode: "project",
        type: "all",
        origin: "all",
      }),
    ).toEqual([]);
  });

  it("deduplicates preference resources across list items", () => {
    const extension = resource();
    const items = buildResourceListItems([extension, extension], [pkg()], {
      query: "",
      mode: "user",
      type: "all",
      origin: "all",
    });

    expect(items).toHaveLength(1);
    expect(preferenceResourcesForListItems(items)).toEqual([extension]);
  });

  it("derives preferences, configurability, and mixed summaries", () => {
    const enabled = resource();
    const disabled = resource({
      id: "resource:skill:disabled",
      type: "skill",
      enabled: false,
      preferences: { user: "disabled", project: "enabled" },
    });
    const runtime = resource({
      id: "resource:runtime",
      control: { kind: "read-only", reason: "Runtime-owned" },
    });

    expect(resourcePreference(disabled, "user")).toBe("disabled");
    expect(resourcePreference(disabled, "project")).toBe("enabled");
    expect(canConfigureResource(enabled, "project")).toBe(true);
    expect(canConfigureResource(runtime, "project")).toBe(false);
    expect(summarizeResources([enabled, disabled])).toEqual({
      total: 2,
      enabled: 1,
      disabled: 1,
    });
  });

  it("builds valid single and batch preference requests", () => {
    const configurable = resource({
      id: "resource:skill:configurable",
      type: "skill",
      preferences: { user: "disabled", project: "enabled" },
      enabled: false,
    });
    const alreadyInherited = resource({
      id: "resource:prompt:inherited",
      type: "prompt",
      preferences: { user: "enabled", project: "inherit" },
    });
    const userOnly = resource({
      id: "resource:theme:user-only",
      type: "theme",
      control: { kind: "preference", scopes: ["user"] },
      preferences: { user: "enabled", project: "enabled" },
    });
    const dynamic = resource({
      id: "resource:dynamic:read-only",
      control: { kind: "owner-extension", ownerResourceId: configurable.id },
    });

    expect(buildResourcePreferenceUpdate(configurable, "project", "inherit")).toEqual({
      resourceId: configurable.id,
      targetScope: "project",
      preference: "inherit",
    });
    expect(buildResourcePreferenceUpdate(configurable, "user", "inherit")).toBeNull();
    expect(buildResourcePreferenceUpdate(dynamic, "user", "enabled")).toBeNull();
    expect(
      buildResourcePreferenceUpdates(
        [configurable, alreadyInherited, userOnly, dynamic],
        "project",
        "inherit",
      ),
    ).toEqual([
      {
        resourceId: configurable.id,
        targetScope: "project",
        preference: "inherit",
      },
    ]);
  });

  it("projects a pending package preference onto direct and extension-owned resources", () => {
    const owner = resource({
      id: "resource:extension:owner",
      enabled: true,
      preferences: { user: "enabled", project: "inherit" },
    });
    const dynamic = resource({
      id: "resource:runtime:owned",
      type: "skill",
      scope: "temporary",
      origin: "extension",
      packageId: "package:user:tools",
      control: { kind: "owner-extension", ownerResourceId: owner.id },
    });
    const prompt = resource({
      id: "resource:prompt:owned",
      type: "prompt",
      enabled: false,
      preferences: { user: "disabled", project: "inherit" },
    });

    const projected = applyOptimisticResourcePreferences([owner, dynamic, prompt], [
      { resourceId: owner.id, targetScope: "user", preference: "disabled" },
      { resourceId: prompt.id, targetScope: "user", preference: "enabled" },
    ]);

    expect(projected.map((item) => item.enabled)).toEqual([false, false, true]);
    expect(projected[0]?.preferences.user).toBe("disabled");
    expect(projected[2]?.preferences.user).toBe("enabled");
  });

  it("detects active filters without treating view mode as a filter", () => {
    expect(
      hasActiveInstalledFilters({ query: "", scope: "all", type: "all" }),
    ).toBe(false);
    expect(
      hasActiveInstalledFilters({ query: " tools ", scope: "all", type: "all" }),
    ).toBe(true);
    expect(
      hasActiveResourceFilters({
        query: "",
        mode: "project",
        type: "all",
        origin: "all",
      }),
    ).toBe(false);
    expect(
      hasActiveResourceFilters({
        query: "",
        mode: "user",
        type: "skill",
        origin: "runtime",
        packageId: "package:user:tools",
      }),
    ).toBe(true);
  });
});
