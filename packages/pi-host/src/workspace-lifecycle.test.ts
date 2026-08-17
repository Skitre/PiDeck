import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceLifecycle, workspaceIdentityKey } from "./workspace-lifecycle.js";
import type { SessionRuntimeCache } from "./session-runtime-cache.js";
import type { GraphFactoryDeps, WorkspaceGraph } from "./workspace-graph-types.js";

function lifecycle(
  platform?: NodeJS.Platform,
  cache: Partial<SessionRuntimeCache> = {},
  deps: Partial<GraphFactoryDeps> = {},
) {
  return new WorkspaceLifecycle(
    {
      deps: { agentDir: "C:/agent", ...deps } as GraphFactoryDeps,
      getGraph: () => null,
      setGraph: vi.fn(),
      getServer: () => null,
      onModelHealthChanged: vi.fn(),
      platform,
    },
    {
      graphHasBusySessions: () => false,
      ...cache,
    } as unknown as SessionRuntimeCache,
  );
}

describe("Workspace lifecycle", () => {
  it("preserves case-sensitive workspace identities on Unix-like platforms", () => {
    expect(workspaceIdentityKey("/repo/Foo", "linux")).not.toBe(
      workspaceIdentityKey("/repo/foo", "linux"),
    );
    expect(workspaceIdentityKey("/repo/Foo", "darwin")).not.toBe(
      workspaceIdentityKey("/repo/foo", "darwin"),
    );
  });

  it("normalizes separators and casing for Windows workspace identities", () => {
    expect(workspaceIdentityKey("C:\\Repos\\Alpha", "win32")).toBe(
      workspaceIdentityKey("c:/repos/ALPHA", "win32"),
    );
  });

  it("does not reactivate a retained graph with a different canonical identity", () => {
    const subject = lifecycle("linux");
    const retained = { canonicalCwd: "/repo/Foo" } as WorkspaceGraph;
    const internal = subject as unknown as {
      retainedGraphs: Map<string, WorkspaceGraph>;
      takeRetainedGraph: (canonicalCwd: string) => WorkspaceGraph | null;
    };
    internal.retainedGraphs.set(workspaceIdentityKey("/repo/foo", "linux"), retained);

    expect(internal.takeRetainedGraph("/repo/foo")).toBeNull();
    expect(internal.takeRetainedGraph("/repo/Foo")).toBeNull();
    expect(internal.retainedGraphs.get("/repo/foo")).toBe(retained);
  });

  it("retains differently-cased Unix Workspace graphs independently", () => {
    const subject = lifecycle("linux");
    const upper = { canonicalCwd: "/repo/Foo" } as WorkspaceGraph;
    const lower = { canonicalCwd: "/repo/foo" } as WorkspaceGraph;
    const internal = subject as unknown as {
      retainedGraphs: Map<string, WorkspaceGraph>;
      takeRetainedGraph: (canonicalCwd: string) => WorkspaceGraph | null;
    };
    internal.retainedGraphs.set(workspaceIdentityKey(upper.canonicalCwd, "linux"), upper);
    internal.retainedGraphs.set(workspaceIdentityKey(lower.canonicalCwd, "linux"), lower);

    expect(internal.takeRetainedGraph(upper.canonicalCwd)).toBe(upper);
    expect(internal.takeRetainedGraph(lower.canonicalCwd)).toBe(lower);
  });

  it("invalidates only the retained graph for the matching Workspace", async () => {
    const subject = lifecycle("linux");
    const target = { canonicalCwd: "/repo/target" } as WorkspaceGraph;
    const unrelated = { canonicalCwd: "/repo/unrelated" } as WorkspaceGraph;
    const internal = subject as unknown as {
      retainedGraphs: Map<string, WorkspaceGraph>;
    };
    internal.retainedGraphs.set(workspaceIdentityKey(target.canonicalCwd, "linux"), target);
    internal.retainedGraphs.set(workspaceIdentityKey(unrelated.canonicalCwd, "linux"), unrelated);
    const dispose = vi.spyOn(subject, "disposeGraph").mockResolvedValue();

    await subject.invalidateRetainedWorkspaceGraph(target.canonicalCwd);

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledWith(target);
    expect(internal.retainedGraphs.has(target.canonicalCwd)).toBe(false);
    expect(internal.retainedGraphs.get(unrelated.canonicalCwd)).toBe(unrelated);
  });

  it("canonicalizes an existing Workspace path", () => {
    const root = mkdtempSync(join(tmpdir(), "pideck-workspace-lifecycle-"));
    try {
      expect(lifecycle().canonicalizeCwd(root)).toBe(realpathSync(root));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a missing Workspace path without mutating state", () => {
    const root = mkdtempSync(join(tmpdir(), "pideck-workspace-lifecycle-"));
    const missing = join(root, "missing");
    try {
      let thrown: unknown;
      try {
        lifecycle().canonicalizeCwd(missing);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({
        code: "WORKSPACE_SWITCH_FAILED",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an existing file as a Workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "pideck-workspace-lifecycle-"));
    const file = join(root, "workspace.txt");
    writeFileSync(file, "not a directory");
    try {
      expect(() => lifecycle().canonicalizeCwd(file)).toThrowError(
        expect.objectContaining({ code: "WORKSPACE_NOT_DIRECTORY" }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts a symlink to a Workspace directory", () => {
    const root = mkdtempSync(join(tmpdir(), "pideck-workspace-lifecycle-"));
    const target = join(root, "target");
    const link = join(root, "link");
    try {
      mkdirSync(target);
      symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
      expect(lifecycle().canonicalizeCwd(link)).toBe(realpathSync(target));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("builds the public Workspace snapshot from lifecycle-owned fields", () => {
    const graph = {
      workspaceId: "workspace-id",
      cwd: "C:/workspace",
      canonicalCwd: "C:/workspace",
      revision: 4,
      servicesReady: true,
    } as WorkspaceGraph;

    expect(lifecycle().buildWorkspaceSnapshot(graph)).toEqual({
      id: "workspace-id",
      cwd: "C:/workspace",
      canonicalCwd: "C:/workspace",
      revision: 4,
      servicesReady: true,
    });
  });

  it("reports busy retained Workspaces without inspecting the current graph", () => {
    const busy = { canonicalCwd: "/repo/busy" } as WorkspaceGraph;
    const idle = { canonicalCwd: "/repo/idle" } as WorkspaceGraph;
    const subject = lifecycle("linux", {
      graphHasBusySessions: (graph) => graph === busy,
    });
    const internal = subject as unknown as {
      retainedGraphs: Map<string, WorkspaceGraph>;
    };
    internal.retainedGraphs.set(workspaceIdentityKey(idle.canonicalCwd, "linux"), idle);
    expect(subject.hasBusyRetainedSessions()).toBe(false);
    internal.retainedGraphs.set(workspaceIdentityKey(busy.canonicalCwd, "linux"), busy);
    expect(subject.hasBusyRetainedSessions()).toBe(true);
  });

  it("suspends a parked Workspace Provider after its last busy Session settles", () => {
    const suspendOwner = vi.fn(() => ({ snapshot: true }));
    const subject = lifecycle("linux", { graphHasBusySessions: () => false }, {
      providerOwnership: { suspendOwner },
    } as unknown as Partial<GraphFactoryDeps>);
    const graph = {
      canonicalCwd: "/repo/parked",
      providerOwner: { id: "owner-a" },
      suspendedProviders: undefined,
    } as unknown as WorkspaceGraph;
    const internal = subject as unknown as {
      retainedGraphs: Map<string, WorkspaceGraph>;
    };
    internal.retainedGraphs.set(workspaceIdentityKey(graph.canonicalCwd, "linux"), graph);

    subject.suspendIdleRetainedProviders(graph);

    expect(suspendOwner).toHaveBeenCalledWith(graph.providerOwner);
    expect(graph.suspendedProviders).toEqual({ snapshot: true });
  });
});
