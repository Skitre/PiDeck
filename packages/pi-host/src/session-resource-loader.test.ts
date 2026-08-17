import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionResourceLoader } from "./session-lifecycle.js";
import { UserResourceCache } from "./user-resource-cache.js";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";
import type { WorkspaceGraph } from "./workspace-graph-types.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("createSessionResourceLoader", () => {
  it("mints a session-owned loader without a second user full-reload", async () => {
    const root = mkdtempSync(join(tmpdir(), "pideck-session-loader-"));
    roots.push(root);
    const agentDir = join(root, "agent");
    const cwd = join(root, "workspace");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const cache = new UserResourceCache(agentDir);
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
    const resourceLoader = await cache.createWorkspaceLoader({ cwd, settingsManager });
    const factory = { userResourceCache: cache } as WorkspaceGraphFactory;
    const graph = {
      canonicalCwd: cwd,
      settingsManager,
      resourceLoader,
      resourceReloadRequired: false,
    } as WorkspaceGraph;

    const next = await createSessionResourceLoader(factory, graph);
    expect(next).not.toBe(resourceLoader);
    expect(graph.resourceLoader).toBe(resourceLoader);
    expect(graph.resourceReloadRequired).toBe(false);
    expect(cache.fullReloadCount).toBe(1);
  });

  it("invalidates the user cache and replaces the loader when a reload is required", async () => {
    const root = mkdtempSync(join(tmpdir(), "pideck-session-loader-reload-"));
    roots.push(root);
    const agentDir = join(root, "agent");
    const cwd = join(root, "workspace");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const cache = new UserResourceCache(agentDir);
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
    const resourceLoader = await cache.createWorkspaceLoader({ cwd, settingsManager });
    const factory = { userResourceCache: cache } as WorkspaceGraphFactory;
    const graph = {
      canonicalCwd: cwd,
      settingsManager,
      resourceLoader,
      resourceReloadRequired: true,
    } as WorkspaceGraph;

    const replaced = await createSessionResourceLoader(factory, graph);
    expect(replaced).not.toBe(resourceLoader);
    expect(graph.resourceLoader).toBe(resourceLoader);
    expect(graph.resourceReloadRequired).toBe(true);
    expect(cache.fullReloadCount).toBe(2);
  });
});
