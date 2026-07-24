import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ResourcePreferenceUpdate } from "@pideck/protocol";
import { applyResourcePreferences, createPackageHandlers } from "./package-controller.js";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";
import {
  buildPackageSnapshot,
  normalizePackageIdentity,
  type ResourceIdMap,
} from "./package-snapshot.js";
import type { PackageSource } from "./package-filters.js";

function managerFixture(options: { orphan?: boolean } = {}) {
  const globalPackages = options.orphan ? [] : ["npm:shared"];
  const projectPackages = [{
    source: "npm:shared",
    autoload: false,
    // Project deltas are applied in order, so the final exact override wins.
    skills: ["-skills/review/SKILL.md", "+skills/review/SKILL.md"],
  }];
  return {
    settings: {
      getGlobalSettings: () => ({ packages: globalPackages }),
      getProjectSettings: () => ({ packages: projectPackages }),
    },
    packageManager: {
      listConfiguredPackages: () => [
        ...globalPackages.map((source) => ({ source, scope: "user", filtered: false })),
        { source: "npm:shared", scope: "project", filtered: true },
      ],
      getInstalledPath: (_source: string, scope: string) => `C:/${scope}/shared`,
      resolve: async () => ({
        extensions: [],
        skills: [
          {
            path: "C:/user/shared/skills/review/SKILL.md",
            enabled: false,
            metadata: {
              source: "npm:shared",
              scope: "project",
              origin: "package",
              baseDir: "C:/user/shared",
            },
          },
        ],
        prompts: [],
        themes: [],
      }),
    },
  };
}

describe("unified package resources", () => {
  it("collapses a matched project delta onto its user package", async () => {
    const fixture = managerFixture();
    const snapshot = await buildPackageSnapshot({
      revision: 1,
      workspaceId: "workspace",
      scope: "all",
      packageManager: fixture.packageManager as never,
      settingsManager: fixture.settings as never,
      packageUpdateCheck: false,
      resourceIdMap: new Map(),
    });

    expect(snapshot.configured).toHaveLength(1);
    expect(snapshot.configured[0]).toMatchObject({
      scope: "user",
      identity: "npm:shared",
      projectOverride: { source: "npm:shared", overrideCount: 2 },
    });
    expect(snapshot.resources[0]).toMatchObject({
      packageId: snapshot.configured[0]!.id,
      name: "review",
      scope: "user",
      enabled: false,
      preferences: { user: "enabled", project: "enabled" },
      control: { kind: "preference", scopes: ["user", "project"] },
    });
    expect(snapshot.resources).toHaveLength(1);

    const userSnapshot = await buildPackageSnapshot({
      revision: 1,
      workspaceId: "workspace",
      scope: "user",
      packageManager: fixture.packageManager as never,
      settingsManager: fixture.settings as never,
      packageUpdateCheck: false,
      resourceIdMap: new Map(),
    });
    expect(userSnapshot.configured).toHaveLength(1);
    expect(userSnapshot.resources).toHaveLength(1);
    expect(userSnapshot.resources[0]).toMatchObject({
      id: snapshot.resources[0]!.id,
      packageId: userSnapshot.configured[0]!.id,
      scope: "user",
      enabled: false,
      preferences: { user: "enabled", project: "enabled" },
    });
  });

  it("warns when an autoload-false project package has no user base", async () => {
    const fixture = managerFixture({ orphan: true });
    const snapshot = await buildPackageSnapshot({
      revision: 1,
      workspaceId: "workspace",
      scope: "all",
      packageManager: fixture.packageManager as never,
      settingsManager: fixture.settings as never,
      packageUpdateCheck: false,
      resourceIdMap: new Map(),
    });

    expect(snapshot.configured).toHaveLength(1);
    expect(snapshot.configured[0]!.scope).toBe("project");
    expect(snapshot.diagnostics).toContainEqual(
      expect.objectContaining({ severity: "warning", source: "npm:shared" }),
    );
  });

  it("derives project preferences for project top-level resources", async () => {
    const path = "C:/workspace/.pi/prompts/review.md";
    const snapshot = await buildPackageSnapshot({
      revision: 1,
      workspaceId: "workspace",
      scope: "all",
      cwd: "C:/workspace",
      packageManager: {
        listConfiguredPackages: () => [],
        getInstalledPath: () => undefined,
        resolve: async () => ({
          extensions: [], skills: [], themes: [],
          prompts: [{
            path,
            enabled: false,
            metadata: {
              source: "local",
              scope: "project",
              origin: "top-level",
              baseDir: "C:/workspace/.pi",
            },
          }],
        }),
      } as never,
      settingsManager: {
        getGlobalSettings: () => ({}),
        getProjectSettings: () => ({ prompts: ["-prompts/review.md"] }),
      } as never,
      packageUpdateCheck: false,
      resourceIdMap: new Map(),
    });
    expect(snapshot.resources[0]).toMatchObject({
      scope: "project",
      enabled: false,
      preferences: { project: "disabled" },
    });
  });

  it("keeps shadowed global resources user-only in the independent projection", async () => {
    const root = mkdtempSync(join(tmpdir(), "pideck-host-shadowed-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "workspace");
    const packageRoot = join(root, "shared-package");
    mkdirSync(join(packageRoot, "skills", "review"), { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(
      join(packageRoot, "skills", "review", "SKILL.md"),
      "---\nname: review\ndescription: Review changes\n---\n",
    );
    try {
      const settingsManager = SettingsManager.inMemory(
        { packages: [packageRoot] },
        { projectTrusted: true },
      );
      settingsManager.setProjectPackages([packageRoot]);
      const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
      const snapshot = await buildPackageSnapshot({
        revision: 1,
        workspaceId: "workspace",
        scope: "all",
        cwd,
        agentDir,
        packageManager,
        settingsManager,
        packageUpdateCheck: false,
        resourceIdMap: new Map(),
      });
      const userPackage = snapshot.configured.find((pkg) => pkg.scope === "user")!;
      const projectPackage = snapshot.configured.find((pkg) => pkg.scope === "project")!;
      expect(snapshot.resources).toHaveLength(2);
      expect(snapshot.resources.find((resource) => resource.packageId === userPackage.id)).toMatchObject({
        scope: "user",
        control: { kind: "preference", scopes: ["user"] },
      });
      expect(snapshot.resources.find((resource) => resource.packageId === projectPackage.id)).toMatchObject({
        scope: "project",
        control: { kind: "preference", scopes: ["project"] },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("matches each local settings candidate against its own scope-relative path", async () => {
    const snapshot = await buildPackageSnapshot({
      revision: 1,
      workspaceId: "workspace",
      scope: "all",
      agentDir: "C:/agent",
      cwd: "C:/workspace",
      packageManager: {
        listConfiguredPackages: () => [{ source: "./b", scope: "user", filtered: false }],
        getInstalledPath: () => "C:/agent/b",
        resolve: async () => ({
          extensions: [], prompts: [], themes: [],
          skills: [{
            path: "C:/agent/b/skills/review/SKILL.md",
            enabled: true,
            metadata: {
              source: "./b",
              scope: "user",
              origin: "package",
              baseDir: "C:/agent/b",
            },
          }],
        }),
      } as never,
      settingsManager: {
        getGlobalSettings: () => ({
          packages: [{ source: "./a", skills: [] }, "./b"],
        }),
        getProjectSettings: () => ({}),
      } as never,
      packageUpdateCheck: false,
      resourceIdMap: new Map(),
    });
    expect(snapshot.resources[0]!.preferences.user).toBe("enabled");
  });

  it("links extension-discovered resources to their owner extension", async () => {
    const fixture = managerFixture();
    fixture.packageManager.resolve = vi.fn(async () => ({
      extensions: [{
        path: "C:/user/shared/extensions/owner.ts",
        enabled: true,
        metadata: {
          source: "npm:shared",
          scope: "user",
          origin: "package",
          baseDir: "C:/user/shared",
        },
      }],
      skills: [], prompts: [], themes: [],
    })) as never;
    const sourceInfo = {
      path: "C:/user/shared/extensions/owner.ts",
      source: "npm:shared",
      scope: "user",
      origin: "package",
      baseDir: "C:/user/shared",
    };
    const dynamicInfo = {
      path: "C:/runtime/review/SKILL.md",
      source: "extension:owner",
      scope: "temporary",
      origin: "top-level",
      baseDir: "C:/user/shared/extensions",
    };
    const loader = {
      getExtensions: () => ({
        extensions: [{
          path: sourceInfo.path,
          sourceInfo,
          handlers: new Map(), tools: new Map(), commands: new Map(), flags: new Map(), shortcuts: new Map(),
        }],
        errors: [],
      }),
      getSkills: () => ({
        skills: [{
          name: "review",
          description: "Review changes",
          filePath: dynamicInfo.path,
          sourceInfo: dynamicInfo,
          disableModelInvocation: true,
        }],
        diagnostics: [],
      }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
    };
    const snapshot = await buildPackageSnapshot({
      revision: 1,
      workspaceId: "workspace",
      scope: "all",
      packageManager: fixture.packageManager as never,
      settingsManager: fixture.settings as never,
      resourceLoader: loader as never,
      packageUpdateCheck: false,
      resourceIdMap: new Map(),
    });
    const owner = snapshot.resources.find((resource) => resource.type === "extension")!;
    const dynamic = snapshot.resources.find((resource) => resource.origin === "extension")!;
    expect(dynamic).toMatchObject({
      packageId: owner.packageId,
      manualOnly: true,
      control: { kind: "owner-extension", ownerResourceId: owner.id },
    });
  });

  it("disambiguates same-name extension owners by source baseDir and returns dynamic resources", async () => {
    const configured = ["npm:first", "npm:second"];
    const extension = (source: string, root: string) => ({
      path: `${root}/extensions/owner.ts`,
      enabled: true,
      metadata: { source, scope: "user", origin: "package", baseDir: root },
    });
    const extensionRuntime = (source: string, root: string) => ({
      path: `${root}/extensions/owner.ts`,
      sourceInfo: {
        path: `${root}/extensions/owner.ts`,
        source,
        scope: "user",
        origin: "package",
        baseDir: root,
      },
      handlers: new Map(), tools: new Map(), commands: new Map(), flags: new Map(), shortcuts: new Map(),
    });
    const snapshot = await buildPackageSnapshot({
      revision: 1,
      workspaceId: "workspace",
      scope: "all",
      packageManager: {
        listConfiguredPackages: () => configured.map((source) => ({ source, scope: "user", filtered: false })),
        getInstalledPath: (source: string) => source === "npm:first" ? "C:/first" : "C:/second",
        resolve: async () => ({
          extensions: [extension("npm:first", "C:/first"), extension("npm:second", "C:/second")],
          skills: [], prompts: [], themes: [],
        }),
      } as never,
      settingsManager: {
        getGlobalSettings: () => ({ packages: configured }),
        getProjectSettings: () => ({}),
      } as never,
      resourceLoader: {
        getExtensions: () => ({
          extensions: [
            extensionRuntime("npm:first", "C:/first"),
            extensionRuntime("npm:second", "C:/second"),
          ],
          errors: [],
        }),
        getSkills: () => ({
          skills: [{
            name: "runtime-review",
            description: "Runtime review",
            filePath: "C:/runtime/review/SKILL.md",
            sourceInfo: {
              path: "C:/runtime/review/SKILL.md",
              source: "extension:owner",
              scope: "temporary",
              origin: "top-level",
              baseDir: "C:/second/extensions",
            },
            disableModelInvocation: false,
          }],
          diagnostics: [],
        }),
        getPrompts: () => ({ prompts: [], diagnostics: [] }),
        getThemes: () => ({ themes: [], diagnostics: [] }),
      } as never,
      packageUpdateCheck: false,
      resourceIdMap: new Map(),
    });
    const second = snapshot.configured.find((pkg) => pkg.source === "npm:second")!;
    const secondOwner = snapshot.resources.find(
      (resource) => resource.packageId === second.id && resource.type === "extension",
    )!;
    const dynamic = snapshot.resources.find((resource) => resource.origin === "extension")!;
    expect(dynamic).toMatchObject({
      packageId: second.id,
      control: { kind: "owner-extension", ownerResourceId: secondOwner.id },
    });

    const factory = {
      checkIdentity: () => null,
      getGraph: () => ({ packageSnapshot: snapshot }),
    } as unknown as WorkspaceGraphFactory;
    const result = await createPackageHandlers(factory)["package.getResources"]!({
      id: "get-resources",
      context: {},
      params: { packageId: second.id },
    } as never);
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect((result.result as { resources: Array<{ id: string }> }).resources.map((item) => item.id))
        .toContain(dynamic.id);
    }
  });

  it("attributes collision diagnostics to both resource paths", async () => {
    const winnerPath = "C:/shared/skills/winner/SKILL.md";
    const loserPath = "C:/shared/skills/loser/SKILL.md";
    const sourceInfo = (path: string) => ({
      path,
      source: "npm:shared",
      scope: "user",
      origin: "package",
      baseDir: "C:/shared",
    });
    const snapshot = await buildPackageSnapshot({
      revision: 1,
      workspaceId: "workspace",
      scope: "all",
      packageManager: {
        listConfiguredPackages: () => [{
          source: "npm:shared",
          scope: "user",
          filtered: false,
          installedPath: "C:/shared",
        }],
        getInstalledPath: () => "C:/shared",
        resolve: async () => ({
          extensions: [], prompts: [], themes: [],
          skills: [winnerPath, loserPath].map((path) => ({
            path,
            enabled: true,
            metadata: sourceInfo(path),
          })),
        }),
      } as never,
      settingsManager: {
        getGlobalSettings: () => ({ packages: ["npm:shared"] }),
        getProjectSettings: () => ({}),
      } as never,
      resourceLoader: {
        getExtensions: () => ({ extensions: [], errors: [] }),
        getSkills: () => ({
          skills: [{
            name: "shared-name",
            description: "Winning skill",
            filePath: winnerPath,
            sourceInfo: sourceInfo(winnerPath),
            disableModelInvocation: false,
          }],
          diagnostics: [{
            type: "collision",
            message: "Skill name collision: shared-name",
            collision: {
              resourceType: "skill",
              name: "shared-name",
              winnerPath,
              loserPath,
            },
          }],
        }),
        getPrompts: () => ({ prompts: [], diagnostics: [] }),
        getThemes: () => ({ themes: [], diagnostics: [] }),
      } as never,
      packageUpdateCheck: false,
      resourceIdMap: new Map(),
    });

    expect(snapshot.resources).toHaveLength(2);
    for (const resource of snapshot.resources) {
      expect(resource.diagnostics).toContainEqual({
        severity: "warning",
        source: resource.path,
        message: "Skill name collision: shared-name",
      });
    }
  });

  it("reads disabled skill name and description from frontmatter", async () => {
    const root = mkdtempSync(join(tmpdir(), "pideck-host-disabled-skill-"));
    const skillPath = join(root, "skills", "folder-name", "SKILL.md");
    mkdirSync(join(root, "skills", "folder-name"), { recursive: true });
    writeFileSync(
      skillPath,
      "---\nname: frontmatter-name\ndescription: Disabled but described\n---\nBody\n",
    );
    try {
      const snapshot = await buildPackageSnapshot({
        revision: 1,
        workspaceId: "workspace",
        scope: "all",
        packageManager: {
          listConfiguredPackages: () => [{ source: root, scope: "user", filtered: true, installedPath: root }],
          getInstalledPath: () => root,
          resolve: async () => ({
            extensions: [], prompts: [], themes: [],
            skills: [{
              path: skillPath,
              enabled: false,
              metadata: { source: root, scope: "user", origin: "package", baseDir: root },
            }],
          }),
        } as never,
        settingsManager: {
          getGlobalSettings: () => ({ packages: [{ source: root, skills: [] }] }),
          getProjectSettings: () => ({}),
        } as never,
        packageUpdateCheck: false,
        resourceIdMap: new Map(),
      });
      expect(snapshot.resources[0]).toMatchObject({
        enabled: false,
        name: "frontmatter-name",
        description: "Disabled but described",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("warns for configured package sources that are missing", async () => {
    const snapshot = await buildPackageSnapshot({
      revision: 1,
      workspaceId: "workspace",
      scope: "all",
      packageManager: {
        listConfiguredPackages: () => [{ source: "npm:missing", scope: "user", filtered: false }],
        getInstalledPath: () => undefined,
        resolve: async () => ({ extensions: [], skills: [], prompts: [], themes: [] }),
      } as never,
      settingsManager: {
        getGlobalSettings: () => ({ packages: ["npm:missing"] }),
        getProjectSettings: () => ({}),
      } as never,
      packageUpdateCheck: false,
      resourceIdMap: new Map(),
    });
    expect(snapshot.diagnostics).toContainEqual({
      severity: "warning",
      source: "npm:missing",
      message: "Package is configured but its installed source is missing or unresolved.",
    });
  });
});

describe("resource preference batches", () => {
  function graphFixture() {
    const setPackages = vi.fn();
    const setProjectPackages = vi.fn();
    const map: ResourceIdMap = new Map([
      ["resource-1", {
        type: "skill",
        scope: "user",
        path: "C:/pkg/skills/review/SKILL.md",
        baseDir: "C:/pkg",
        relativePath: "skills/review/SKILL.md",
        origin: "package",
        packageSource: "npm:shared",
        packageScope: "user",
        packageIdentity: "npm:shared",
        configurableScopes: ["user", "project"],
      }],
    ]);
    return {
      setPackages,
      setProjectPackages,
      graph: {
        resourceIdMap: map,
        settingsManager: {
          getPackages: () => ["npm:shared", "npm:project-only"],
          getGlobalSettings: () => ({ packages: ["npm:shared"] as PackageSource[] }),
          getProjectSettings: () => ({ packages: [] as PackageSource[] }),
          setPackages,
          setProjectPackages,
        },
      },
    };
  }

  it("does not write any scope when validation of a later update fails", () => {
    const fixture = graphFixture();
    const updates: ResourcePreferenceUpdate[] = [
      { resourceId: "resource-1", targetScope: "user", preference: "disabled" },
      { resourceId: "missing", targetScope: "project", preference: "enabled" },
    ];
    expect(() => applyResourcePreferences(fixture.graph as never, updates)).toThrow("Resource not found");
    expect(fixture.setPackages).not.toHaveBeenCalled();
    expect(fixture.setProjectPackages).not.toHaveBeenCalled();
  });

  it("collapses the last pi-codex-goal user filter when enabling its prompt", () => {
    const fixture = graphFixture();
    fixture.graph.resourceIdMap.set("resource-1", {
      type: "prompt",
      scope: "user",
      path: "C:/agent/npm/node_modules/pi-codex-goal/prompts/create-goal.md",
      baseDir: "C:/agent/npm/node_modules/pi-codex-goal",
      relativePath: "prompts/create-goal.md",
      origin: "package",
      packageSource: "npm:pi-codex-goal",
      packageScope: "user",
      packageIdentity: "npm:pi-codex-goal",
      configurableScopes: ["user", "project"],
    });
    fixture.graph.settingsManager.getGlobalSettings = () => ({
      packages: [{
        source: "npm:pi-codex-goal",
        prompts: ["-prompts/create-goal.md"],
      }],
    });

    applyResourcePreferences(fixture.graph as never, [{
      resourceId: "resource-1",
      targetScope: "user",
      preference: "enabled",
    }]);

    expect(fixture.setPackages).toHaveBeenCalledTimes(1);
    expect(fixture.setPackages).toHaveBeenCalledWith(["npm:pi-codex-goal"]);
  });

  it("creates a project delta and replaces each affected scope once", () => {
    const fixture = graphFixture();
    applyResourcePreferences(fixture.graph as never, [
      { resourceId: "resource-1", targetScope: "user", preference: "disabled" },
      { resourceId: "resource-1", targetScope: "project", preference: "enabled" },
    ]);
    expect(fixture.setPackages).toHaveBeenCalledTimes(1);
    expect(fixture.setPackages.mock.calls[0]![0]).not.toContain("npm:project-only");
    expect(fixture.setProjectPackages).toHaveBeenCalledTimes(1);
    expect(fixture.setProjectPackages).toHaveBeenCalledWith([
      expect.objectContaining({
        source: "npm:shared",
        autoload: false,
        skills: ["+skills/review/SKILL.md"],
      }),
    ]);
  });

  it("removes exact project overrides and deletes an empty delta on inherit", () => {
    const fixture = graphFixture();
    fixture.graph.settingsManager.getProjectSettings = () => ({
      packages: [{
        source: "npm:shared",
        autoload: false,
        skills: [
          "!skills/review",
          "+skills/review",
          "-skills/review/SKILL.md",
        ],
      }],
    });

    applyResourcePreferences(fixture.graph as never, [
      { resourceId: "resource-1", targetScope: "project", preference: "inherit" },
    ]);

    expect(fixture.setProjectPackages).toHaveBeenCalledTimes(1);
    expect(fixture.setProjectPackages).toHaveBeenCalledWith([]);
  });
});

describe("package identity normalization", () => {
  it("uses SDK prefixes and scope-relative bases", () => {
    const agentDir = process.platform === "win32" ? "C:/agent" : "/agent";
    const cwd = process.platform === "win32" ? "C:/workspace" : "/workspace";
    const expectedAgentDir = process.platform === "win32" ? "c:/agent" : "/agent";
    const expectedCwd = process.platform === "win32" ? "c:/workspace" : "/workspace";

    expect(normalizePackageIdentity("npm:foo@1.2.3")).toEqual({
      identity: "npm:foo",
      kind: "npm",
    });
    expect(normalizePackageIdentity("git:git@github.com:owner/repo.git@main")).toEqual({
      identity: "git:github.com/owner/repo",
      kind: "git",
    });
    expect(normalizePackageIdentity("git:owner/repo")).toEqual({
      identity: "git:github.com/owner/repo",
      kind: "git",
    });
    expect(normalizePackageIdentity("git:github:owner/repo")).toEqual({
      identity: "git:github.com/owner/repo",
      kind: "git",
    });
    expect(normalizePackageIdentity("git@github.com:owner/repo.git").kind).toBe("local");
    expect(normalizePackageIdentity("git+https://github.com/owner/repo.git").kind).toBe("local");
    expect(normalizePackageIdentity("foo", {
      scope: "user",
      agentDir,
      cwd,
    })).toEqual({ identity: `local:${expectedAgentDir}/foo`, kind: "local" });
    const user = normalizePackageIdentity("./shared", {
      scope: "user",
      agentDir,
      cwd,
    });
    const project = normalizePackageIdentity("./shared", {
      scope: "project",
      agentDir,
      cwd,
    });
    expect(user.identity).toBe(`local:${expectedAgentDir}/shared`);
    expect(project.identity).toBe(`local:${expectedCwd}/.pi/shared`);
    expect(user.identity).not.toBe(project.identity);
  });
});
