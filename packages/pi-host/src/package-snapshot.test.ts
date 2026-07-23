import { describe, expect, it, vi } from "vitest";
import type { PackageSnapshot } from "@pideck/protocol";
import { createPackageHandlers, mapPackageUpdates } from "./package-controller.js";
import { buildPackageSnapshot, type ResourceIdMap } from "./package-snapshot.js";
import { IdentityState } from "./identity.js";
import { TryMutex } from "./locks.js";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";

function packageManagerFixture() {
  const configured = [
    { source: "npm:shared", scope: "user", filtered: false, installedPath: "C:/user/shared" },
    { source: "npm:shared", scope: "project", filtered: false, installedPath: "C:/project/shared" },
  ];
  const resource = (
    path: string,
    origin: "package" | "top-level",
    scope: "user" | "project",
  ) => ({
    path,
    enabled: true,
    metadata: {
      origin,
      scope,
      source: origin === "package" ? "npm:shared" : path,
      baseDir: path.replace(/\/[^/]+$/, ""),
    },
  });
  return {
    listConfiguredPackages: vi.fn(() => configured),
    getInstalledPath: vi.fn(() => undefined),
    resolve: vi.fn(async () => ({
      extensions: [
        resource("C:/user/shared/extensions/user.ts", "package", "user"),
        resource("C:/project/shared/extensions/project.ts", "package", "project"),
        resource("C:/user/top/user.ts", "top-level", "user"),
        resource("C:/project/top/project.ts", "top-level", "project"),
      ],
      skills: [],
      prompts: [],
      themes: [],
    })),
  };
}

const settingsManager = {};

async function build(scope: "user" | "project" | "all", resourceIdMap = new Map()) {
  return buildPackageSnapshot({
    revision: 7,
    workspaceId: "w1",
    scope,
    packageManager: packageManagerFixture() as never,
    settingsManager: settingsManager as never,
    packageUpdateCheck: true,
    resourceIdMap: resourceIdMap as ResourceIdMap,
  });
}

describe("Package snapshot projections", () => {
  it("filters configured packages and resources consistently by scope", async () => {
    const user = await build("user");
    expect(user.configured).toHaveLength(1);
    expect(user.configured[0]!.scope).toBe("user");
    const packageResources = user.resources.filter((resource) => resource.origin === "package");
    const topLevelResources = user.resources.filter((resource) => resource.origin === "top-level");
    expect(packageResources).toHaveLength(1);
    expect(packageResources[0]!.scope).toBe("user");
    expect(packageResources[0]!.packageId).toBe(user.configured[0]!.id);
    expect(topLevelResources).toHaveLength(1);
    expect(topLevelResources[0]!.scope).toBe("user");
  });

  it("package.list leaves the canonical all-scope snapshot and resource map unchanged", async () => {
    const canonical = (await build("all")) as PackageSnapshot;
    const canonicalMap: ResourceIdMap = new Map([
      [
        "canonical",
        {
          type: "extension",
          scope: "user",
          path: "C:/canonical.ts",
          relativePath: "canonical.ts",
          origin: "top-level",
          configurableScopes: ["user"],
        },
      ],
    ]);
    const graph = {
      workspaceId: "w1",
      packageManager: packageManagerFixture(),
      settingsManager,
      packageSnapshot: canonical,
      resourceIdMap: canonicalMap,
      resourceReloadRequired: false,
    };
    const server = {
      identity: new IdentityState(),
      serviceGraphLock: new TryMutex(),
    };
    const factory = {
      getServer: () => server,
      getGraph: () => graph,
      checkIdentity: () => null,
      deps: { packageUpdateCheck: true },
    } as unknown as WorkspaceGraphFactory;

    const out = await createPackageHandlers(factory)["package.list"]!({
      id: "list-user",
      context: {},
      params: { scope: "user", includeResources: true },
    } as never);

    expect("error" in out).toBe(false);
    expect(graph.packageSnapshot).toBe(canonical);
    expect(graph.resourceIdMap).toBe(canonicalMap);
    expect([...graph.resourceIdMap.keys()]).toEqual(["canonical"]);
  });
});

describe("mapPackageUpdates", () => {
  it("returns stable IDs, preserves scope, and honors a targeted package ID", async () => {
    const snapshot = await build("all");
    const user = snapshot.configured.find((pkg) => pkg.scope === "user")!;
    const project = snapshot.configured.find((pkg) => pkg.scope === "project")!;
    const updates = [
      { source: "npm:shared", scope: "user" },
      { source: "npm:shared", scope: "project" },
    ];

    expect(mapPackageUpdates(snapshot.configured, updates).map((item) => item.packageId)).toEqual([
      user.id,
      project.id,
    ]);
    expect(mapPackageUpdates(snapshot.configured, updates, project.id)).toEqual([
      expect.objectContaining({ packageId: project.id, source: "npm:shared" }),
    ]);
  });
});
