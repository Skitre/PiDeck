import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UserResourceCache } from "./user-resource-cache.js";

type CacheState = {
  imports: number;
  factories: number;
  live: number;
  timers: ReturnType<typeof setInterval>[];
  versions: string[];
};

const roots: string[] = [];
const globalState = globalThis as typeof globalThis & Record<string, unknown>;

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeUserExtension(
  agentDir: string,
  options: { timed?: boolean; fileName?: string; version?: string; stateKey?: string } = {},
): { stateKey: string; extensionPath: string } {
  const stateKey =
    options.stateKey ??
    `__pideck_user_resource_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  if (!options.stateKey) {
    globalState[stateKey] = {
      imports: 0,
      factories: 0,
      live: 0,
      timers: [],
      versions: [],
    } satisfies CacheState;
  }
  const extensionPath = join(agentDir, options.fileName ?? "user-ext.js");
  const version = options.version ?? "v1";
  const lines = [
    `const state = globalThis[${JSON.stringify(stateKey)}];`,
    "state.imports += 1;",
    "export default function (pi) {",
    "  state.factories += 1;",
    "  state.live += 1;",
    `  state.versions.push(${JSON.stringify(version)});`,
  ];
  if (options.timed) {
    lines.push(
      "  const timer = setInterval(() => {}, 60_000);",
      "  timer.unref?.();",
      "  state.timers.push(timer);",
      "  const stop = () => {",
      "    clearInterval(timer);",
      "    const index = state.timers.indexOf(timer);",
      "    if (index >= 0) state.timers.splice(index, 1);",
      "    if (state.live > 0) state.live -= 1;",
      "  };",
      '  pi.on("session_shutdown", stop);',
    );
  }
  lines.push('  pi.on("session_start", async (_event, ctx) => { void ctx; });', "}");
  writeFileSync(extensionPath, lines.join("\n"));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [extensionPath] }));
  return { stateKey, extensionPath };
}

function writeGitPackageExtension(agentDir: string): {
  stateKey: string;
  extensionPath: string;
  packageRoot: string;
} {
  const packageRoot = join(agentDir, "git", "github.com", "owner", "repo");
  mkdirSync(join(packageRoot, "src"), { recursive: true });
  const { stateKey, extensionPath } = writeUserExtension(agentDir, {
    fileName: join("git", "github.com", "owner", "repo", "src", "index.js"),
  });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "pi-test-git-package",
      type: "module",
      pi: { extensions: ["./src/index.js"] },
    }),
  );
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ packages: ["git:github.com/owner/repo"] }),
  );
  return { stateKey, extensionPath, packageRoot };
}

function cacheState(stateKey: string): CacheState {
  return globalState[stateKey] as CacheState;
}

describe("UserResourceCache", () => {
  it("full-reloads user metadata once and mints a fresh runtime per workspace loader", async () => {
    const root = mkdtempSync(join(tmpdir(), "pideck-user-resource-"));
    roots.push(root);
    const agentDir = join(root, "agent");
    const workspaceA = join(root, "workspace-a");
    const workspaceB = join(root, "workspace-b");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(workspaceA, { recursive: true });
    mkdirSync(workspaceB, { recursive: true });
    writeFileSync(join(workspaceA, "AGENTS.md"), "workspace-a context");
    const { stateKey } = writeUserExtension(agentDir);

    const cache = new UserResourceCache(agentDir);
    const first = await cache.ensure();
    const second = await cache.ensure();
    expect(second).toBe(first);
    expect(cache.fullReloadCount).toBe(1);
    expect(first.extensions.errors).toEqual([]);
    expect(first.extensions.extensions).toHaveLength(0);
    expect(cacheState(stateKey)).toMatchObject({ imports: 0, factories: 0, live: 0 });

    const loaderA = await cache.createWorkspaceLoader({
      cwd: workspaceA,
      settingsManager: SettingsManager.create(workspaceA, agentDir, { projectTrusted: false }),
    });
    const loaderB = await cache.createWorkspaceLoader({
      cwd: workspaceB,
      settingsManager: SettingsManager.create(workspaceB, agentDir, { projectTrusted: false }),
    });
    expect(cache.fullReloadCount).toBe(1);
    expect(cacheState(stateKey)).toMatchObject({ imports: 1, factories: 2, live: 2 });
    const extA = loaderA.getExtensions();
    const extB = loaderB.getExtensions();
    expect(extA.extensions).toHaveLength(1);
    expect(extB.extensions).toHaveLength(1);
    expect(extA.extensions[0]).not.toBe(extB.extensions[0]);
    expect(extA.runtime).not.toBe(extB.runtime);
    expect(
      loaderA
        .getAgentsFiles()
        .agentsFiles.some((file) => file.content.includes("workspace-a context")),
    ).toBe(true);
    extA.runtime.invalidate("stale-a");
    expect(() => extA.runtime.assertActive()).toThrow(/stale-a/);
    expect(() => extB.runtime.assertActive()).not.toThrow();
  });

  it("does not leave a live warmup factory timer or listener", async () => {
    const root = mkdtempSync(join(tmpdir(), "pideck-user-resource-warmup-"));
    roots.push(root);
    const agentDir = join(root, "agent");
    const workspace = join(root, "workspace");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    const { stateKey } = writeUserExtension(agentDir, { timed: true });

    const cache = new UserResourceCache(agentDir);
    const warmed = await cache.ensure();
    expect(cacheState(stateKey)).toMatchObject({ factories: 0, live: 0, timers: [] });
    expect(() => warmed.extensions.runtime.assertActive()).toThrow();

    const loader = await cache.createWorkspaceLoader({
      cwd: workspace,
      settingsManager: SettingsManager.create(workspace, agentDir, { projectTrusted: false }),
    });
    const state = cacheState(stateKey);
    expect(state.factories).toBe(1);
    expect(state.live).toBe(1);
    expect(state.timers).toHaveLength(1);
    expect(() => loader.getExtensions().runtime.assertActive()).not.toThrow();
  });

  it("reloads user metadata after invalidate without running extension factories", async () => {
    const root = mkdtempSync(join(tmpdir(), "pideck-user-resource-invalidate-"));
    roots.push(root);
    const agentDir = join(root, "agent");
    mkdirSync(agentDir, { recursive: true });
    const { stateKey } = writeUserExtension(agentDir);

    const cache = new UserResourceCache(agentDir);
    await cache.ensure();
    expect(cache.fullReloadCount).toBe(1);
    await cache.invalidate();
    expect(cache.fullReloadCount).toBe(2);
    expect(cacheState(stateKey)).toMatchObject({ imports: 0, factories: 0, live: 0 });
  });

  it("remints the session-owned extension runtime after package settings change", async () => {
    const root = mkdtempSync(join(tmpdir(), "pideck-user-resource-refresh-"));
    roots.push(root);
    const agentDir = join(root, "agent");
    const workspace = join(root, "workspace");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    const first = writeUserExtension(agentDir, { fileName: "ext-a.js" });

    const cache = new UserResourceCache(agentDir);
    const loader = await cache.createWorkspaceLoader({
      cwd: workspace,
      settingsManager: SettingsManager.create(workspace, agentDir, { projectTrusted: false }),
    });
    const before = loader.getExtensions();
    expect(before.extensions).toHaveLength(1);
    expect(before.extensions[0]?.path).toContain("ext-a.js");

    const second = writeUserExtension(agentDir, { fileName: "ext-b.js" });
    await cache.invalidate();
    await loader.reload();
    expect(loader.getExtensions().extensions[0]?.path).toContain("ext-a.js");

    const refresh = await cache.prepareLoaderExtensionRefresh(loader);
    expect(refresh).not.toBeNull();
    refresh?.apply();
    await loader.reload();
    const after = loader.getExtensions();
    expect(after.extensions).toHaveLength(1);
    expect(after.extensions[0]?.path).toContain("ext-b.js");
    expect(() => before.runtime.assertActive()).not.toThrow();
    refresh?.commit();
    expect(() => before.runtime.assertActive()).toThrow(/user-resource-refresh/);
    expect(() => after.runtime.assertActive()).not.toThrow();
    expect(cacheState(first.stateKey).live).toBe(1);
    expect(cacheState(second.stateKey).live).toBe(1);
  });

  it("re-imports a same-path extension update instead of reusing the cached factory", async () => {
    const root = mkdtempSync(join(tmpdir(), "pideck-user-resource-same-path-"));
    roots.push(root);
    const agentDir = join(root, "agent");
    const workspace = join(root, "workspace");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    const first = writeUserExtension(agentDir, { version: "v1" });

    const cache = new UserResourceCache(agentDir);
    const loader = await cache.createWorkspaceLoader({
      cwd: workspace,
      settingsManager: SettingsManager.create(workspace, agentDir, { projectTrusted: false }),
    });
    expect(cacheState(first.stateKey).versions).toEqual(["v1"]);
    const before = loader.getExtensions();

    writeUserExtension(agentDir, {
      version: "v2",
      stateKey: first.stateKey,
      fileName: "user-ext.js",
    });
    await cache.invalidate();
    const refresh = await cache.prepareLoaderExtensionRefresh(loader);
    expect(refresh).not.toBeNull();
    refresh?.apply();
    expect(cacheState(first.stateKey).versions).toEqual(["v1", "v2"]);
    expect(() => before.runtime.assertActive()).not.toThrow();
    refresh?.commit();
    expect(() => before.runtime.assertActive()).toThrow(/user-resource-refresh/);
    expect(loader.getExtensions().extensions[0]?.path).toContain("user-ext.js");
  });

  it("does not stat a just-removed git clone while preparing the next bundle", async () => {
    const root = mkdtempSync(join(tmpdir(), "pideck-user-resource-git-remove-"));
    roots.push(root);
    const agentDir = join(root, "agent");
    const workspace = join(root, "workspace");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    const { packageRoot } = writeGitPackageExtension(agentDir);

    const cache = new UserResourceCache(agentDir);
    const loader = await cache.createWorkspaceLoader({
      cwd: workspace,
      settingsManager: SettingsManager.create(workspace, agentDir, { projectTrusted: false }),
    });
    expect(
      loader
        .getExtensions()
        .extensions.some(
          (ext) => ext.path.includes("owner\\repo") || ext.path.includes("owner/repo"),
        ),
    ).toBe(true);

    rmSync(packageRoot, { recursive: true, force: true });
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
    await cache.invalidate();
    const refresh = await cache.prepareLoaderExtensionRefresh(loader);
    expect(refresh).not.toBeNull();
    refresh?.apply();
    await loader.reload();
    expect(loader.getExtensions().extensions).toHaveLength(0);
    refresh?.commit();
  });

  it("keeps the previous bundle when minting the next runtime fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "pideck-user-resource-mint-fail-"));
    roots.push(root);
    const agentDir = join(root, "agent");
    const workspace = join(root, "workspace");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    writeUserExtension(agentDir);

    const cache = new UserResourceCache(agentDir);
    const loader = await cache.createWorkspaceLoader({
      cwd: workspace,
      settingsManager: SettingsManager.create(workspace, agentDir, { projectTrusted: false }),
    });
    const before = loader.getExtensions();
    const instantiate = vi
      .spyOn(
        UserResourceCache.prototype as unknown as {
          instantiateExtensions: () => Promise<unknown>;
        },
        "instantiateExtensions",
      )
      .mockRejectedValueOnce(new Error("mint failed"));

    await expect(cache.prepareLoaderExtensionRefresh(loader)).rejects.toThrow("mint failed");
    expect(loader.getExtensions()).toBe(before);
    expect(() => before.runtime.assertActive()).not.toThrow();
    instantiate.mockRestore();
  });

  it("rolls back an applied refresh and disposes the unused next runtime", async () => {
    const root = mkdtempSync(join(tmpdir(), "pideck-user-resource-rollback-"));
    roots.push(root);
    const agentDir = join(root, "agent");
    const workspace = join(root, "workspace");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    writeUserExtension(agentDir, { version: "v1" });

    const cache = new UserResourceCache(agentDir);
    const loader = await cache.createWorkspaceLoader({
      cwd: workspace,
      settingsManager: SettingsManager.create(workspace, agentDir, { projectTrusted: false }),
    });
    const before = loader.getExtensions();

    writeUserExtension(agentDir, { version: "v2", fileName: "user-ext.js" });
    await cache.invalidate();
    const refresh = await cache.prepareLoaderExtensionRefresh(loader);
    expect(refresh).not.toBeNull();
    refresh?.apply();
    await loader.reload();
    const next = loader.getExtensions();
    expect(next.runtime).not.toBe(before.runtime);

    refresh?.rollback();
    await loader.reload();
    expect(loader.getExtensions().runtime).toBe(before.runtime);
    expect(() => before.runtime.assertActive()).not.toThrow();
    expect(() => next.runtime.assertActive()).toThrow(/user-resource-refresh-rollback/);
  });
});
