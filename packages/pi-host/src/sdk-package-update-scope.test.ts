import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DefaultPackageManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { updateAllUserScopedPackages, updatePackageInScope } from "./package-controller.js";

type UpdateTarget = {
  source: string;
  scope: "user" | "project";
};

let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function createManager(): {
  manager: DefaultPackageManager;
  selected: UpdateTarget[];
} {
  root = mkdtempSync(join(tmpdir(), "pideck-package-update-scope-"));
  const settingsManager = {
    getGlobalSettings: () => ({ packages: ["npm:shared-package@^1.0.0"] }),
    getProjectSettings: () => ({ packages: ["npm:shared-package@^2.0.0"] }),
  };
  const manager = new DefaultPackageManager({
    cwd: join(root, "workspace"),
    agentDir: join(root, "agent"),
    settingsManager: settingsManager as never,
  });
  const selected: UpdateTarget[] = [];
  const internals = manager as unknown as {
    updateConfiguredSources: (sources: UpdateTarget[]) => Promise<void>;
  };
  internals.updateConfiguredSources = async (sources) => {
    selected.push(...sources);
  };
  return { manager, selected };
}

describe("PiDeck package-manager scoped update patch", () => {
  it("updates only the user record for a user-scoped request", async () => {
    const { manager, selected } = createManager();

    await manager.update("npm:shared-package", { local: false });

    expect(selected).toEqual([{ source: "npm:shared-package@^1.0.0", scope: "user" }]);
  });

  it("updates only the project record for a project-scoped request", async () => {
    const { manager, selected } = createManager();

    await manager.update("npm:shared-package", { local: true });

    expect(selected).toEqual([{ source: "npm:shared-package@^2.0.0", scope: "project" }]);
  });

  it("keeps update-all behavior when no source is requested", async () => {
    const { manager, selected } = createManager();

    await manager.update();

    expect(selected).toEqual([
      { source: "npm:shared-package@^1.0.0", scope: "user" },
      { source: "npm:shared-package@^2.0.0", scope: "project" },
    ]);
  });
});

describe("Host package update scope", () => {
  it.each([
    { scope: "user" as const, local: false },
    { scope: "project" as const, local: true },
  ])("passes $scope locality to the SDK", async ({ scope, local }) => {
    const update = vi.fn().mockResolvedValue(undefined);

    await updatePackageInScope({ update } as never, { source: "npm:shared-package@^1.0.0", scope });

    expect(update).toHaveBeenCalledWith("npm:shared-package@^1.0.0", { local });
  });

  it("update-all only updates user-scoped records", async () => {
    const update = vi.fn().mockResolvedValue(undefined);

    await updateAllUserScopedPackages({ update } as never, [
      { source: "npm:user-one@^1.0.0", scope: "user" },
      { source: "npm:hidden-project@^2.0.0", scope: "project" },
      { source: "npm:user-two@^3.0.0", scope: "user" },
    ]);

    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenNthCalledWith(1, "npm:user-one@^1.0.0", { local: false });
    expect(update).toHaveBeenNthCalledWith(2, "npm:user-two@^3.0.0", { local: false });
    expect(update).not.toHaveBeenCalledWith("npm:hidden-project@^2.0.0", expect.anything());
    expect(update).not.toHaveBeenCalledWith();
  });

  it("does not rewrite npm sources to installedPath", async () => {
    const update = vi.fn().mockResolvedValue(undefined);

    await updatePackageInScope({ update } as never, {
      source: "npm:shared-package@^1.0.0",
      scope: "user",
      kind: "npm",
      installedPath: "/agent/npm/node_modules/shared-package",
    });

    expect(update).toHaveBeenCalledWith("npm:shared-package@^1.0.0", { local: false });
  });

  it("passes installedPath for a user-local package whose settings path is relative to agentDir", async () => {
    const update = vi.fn().mockResolvedValue(undefined);

    await updatePackageInScope({ update } as never, {
      source: "../ext-lifecycle-pkg",
      scope: "user",
      kind: "local",
      installedPath: "/var/folders/ext-lifecycle-pkg",
    });

    expect(update).toHaveBeenCalledWith("/var/folders/ext-lifecycle-pkg", { local: false });
  });

  it("update-all rewrites local packages even when kind is omitted", async () => {
    const update = vi.fn().mockResolvedValue(undefined);

    await updateAllUserScopedPackages({ update } as never, [
      {
        source: "../ext-lifecycle-pkg",
        scope: "user",
        installedPath: "/var/folders/ext-lifecycle-pkg",
      },
    ]);

    expect(update).toHaveBeenCalledWith("/var/folders/ext-lifecycle-pkg", { local: false });
  });
});

describe("SDK local package update identity", () => {
  it("matches a user-local package stored relative to agentDir, not workspace cwd", async () => {
    root = mkdtempSync(join(tmpdir(), "pideck-package-update-local-"));
    const agentDir = join(root, "agent");
    const workspace = join(root, "workspace", "nested");
    const pkg = join(root, "pkg");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "local-pkg", version: "1.0.0" }),
    );

    const relativeSource = relative(agentDir, pkg);
    const manager = new DefaultPackageManager({
      cwd: workspace,
      agentDir,
      settingsManager: {
        getGlobalSettings: () => ({ packages: [relativeSource] }),
        getProjectSettings: () => ({ packages: [] }),
      } as never,
    });

    await expect(manager.update(relativeSource, { local: false })).rejects.toThrow(
      /No matching package found/,
    );

    await expect(
      updatePackageInScope(manager, {
        source: relativeSource,
        scope: "user",
        kind: "local",
        installedPath: pkg,
      }),
    ).resolves.toBeUndefined();
  });
});
