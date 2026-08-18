/**
 * R6: agent.prompt blocked while resourceReloadRequired until
 * package.reloadResources success path clears the flag.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { createTestModelServices } from "./test-helpers/model-runtime.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentHandlers } from "./agent-controller.js";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";
import {
  createPackageHandlers,
  gitInstallSuffixFromMissingPath,
  isMissingPathError,
  isUninstalledPackageMissingPathError,
  missingPathFromError,
  npmPackageNameFromMissingPath,
} from "./package-controller.js";
import { createSessionHandlers } from "./session-controller.js";
import { logger } from "./logger.js";
import { GraphOperationRegistry } from "./operation-lifecycle.js";
import { UserResourceCache } from "./user-resource-cache.js";

function mockFactory(opts: {
  resourceReloadRequired: boolean;
  graphBusy?: boolean;
  graphBusyAfterAgentAcquire?: boolean;
  agentBusy?: boolean;
}): WorkspaceGraphFactory {
  const globalSettings = {
    packages: [] as unknown[],
    extensions: [] as string[],
  };
  const projectSettings = {
    packages: [] as unknown[],
    extensions: [] as string[],
  };
  const g = {
    resourceReloadRequired: opts.resourceReloadRequired,
    agentSession: {
      reload: vi.fn(async () => {}),
      isIdle: true,
      isCompacting: false,
      isRetrying: false,
      prompt: vi.fn(async () => {}),
      compact: vi.fn(async (instructions?: string) => ({ summary: instructions ?? "default" })),
      model: undefined,
      thinkingLevel: "off",
      autoCompactionEnabled: false,
      autoRetryEnabled: false,
      steeringMode: "all" as const,
      followUpMode: "all" as const,
      sessionId: "s1",
      sessionFile: "/tmp/s1.jsonl",
      sessionName: "test",
      setSessionName: vi.fn((name: string) => {
        g.agentSession.sessionName = name;
      }),
      setModel: vi.fn(async () => {}),
      messages: [] as unknown[],
      getAvailableThinkingLevels: () => ["off"],
      getSteeringMessages: () => [] as string[],
      getFollowUpMessages: () => [] as string[],
      getAllTools: () => [] as Array<{ name: string }>,
      getActiveToolNames: () => [] as string[],
      setActiveToolsByName: vi.fn(),
    },
    sessionManager: {},
    sessionSnapshot: null as null | object,
    toolRevision: 1,
    workspaceId: "w1",
    canonicalCwd: "/tmp",
    packageManager: {
      listConfiguredPackages: () => [],
      resolve: async () => ({
        extensions: [],
        skills: [],
        prompts: [],
        themes: [],
      }),
      setProgressCallback: () => {},
      removeAndPersist: vi.fn(async () => true),
      removeSourceFromSettings: vi.fn(() => false),
      getInstalledPath: () => undefined,
    },
    settingsManager: {
      flush: async () => {},
      drainErrors: () => [],
      getGlobalSettings: () => globalSettings,
      getProjectSettings: () => projectSettings,
      setExtensionPaths: vi.fn((paths: string[]) => {
        globalSettings.extensions = paths;
      }),
      setProjectExtensionPaths: vi.fn((paths: string[]) => {
        projectSettings.extensions = paths;
      }),
    },
    resourceIdMap: new Map(),
    resourceLoader: {
      reload: vi.fn(async () => {}),
    },
    extensionUiUpdateIdentity: vi.fn(),
    packageSnapshot: {
      revision: 1,
      workspaceId: "w1",
      scope: "all" as const,
      configured: [],
      resources: [],
      updateCheck: { supported: false },
      diagnostics: [],
      resourceReloadRequired: opts.resourceReloadRequired,
    },
  };

  const identity = {
    hostInstanceId: "h1",
    workspaceId: "w1",
    workspaceRevision: 1,
    sessionId: "s1",
    sessionRevision: 1,
    packageRevision: 1,
    snapshot: () => ({
      hostInstanceId: "h1",
      workspaceId: "w1",
      workspaceRevision: 1,
      sessionId: "s1",
      sessionRevision: identity.sessionRevision,
      packageRevision: identity.packageRevision,
    }),
    bumpSessionRevision: () => {
      identity.sessionRevision += 1;
      return identity.sessionRevision;
    },
    bumpPackageRevision: () => {
      identity.packageRevision += 1;
      return identity.packageRevision;
    },
  };

  let phase = "ready";
  let graphHeldChecks = 0;
  const sessionOperationLock = {
    tryAcquire: () => opts.agentBusy !== true,
    release: vi.fn(),
    isHeld: () => opts.agentBusy === true,
  };
  const server = {
    identity,
    graphOperations: new GraphOperationRegistry(),
    serviceGraphLock: {
      isHeld: () => {
        graphHeldChecks += 1;
        return (
          opts.graphBusy === true ||
          (opts.graphBusyAfterAgentAcquire === true && graphHeldChecks > 1)
        );
      },
      getOwner: () => null,
      tryAcquire: () => true,
      release: () => {},
    },
    emit: () => {},
    getIdentity: () => identity.snapshot(),
    setPhase: (p: string) => {
      phase = p;
    },
    getPhase: () => phase,
    requestShutdown: vi.fn(async () => {}),
  };

  return {
    checkIdentity: () => null,
    getGraph: () => g,
    getServer: () => server,
    getSessionOperationLock: () => sessionOperationLock,
    hasBusySessions: () => opts.agentBusy === true || !g.agentSession.isIdle,
    hasBusyRetainedSessions: () => false,
    hasRunningSessions: () => opts.agentBusy === true || !g.agentSession.isIdle,
    setSessionRunId: () => {},
    clearSessionRunId: () => {},
    invalidateRetainedRuntimeCaches: vi.fn(async () => {}),
    setActiveSessionName: vi.fn((name: string) => {
      g.agentSession.setSessionName(name);
      const snapshot = { sessionId: "s1", name };
      g.sessionSnapshot = snapshot;
      return snapshot;
    }),
    setSessionRuntimeName: vi.fn(
      (session: { setSessionName: (name: string) => void }, name: string) => {
        session.setSessionName(name);
        const snapshot = { sessionId: "s1", name };
        g.sessionSnapshot = snapshot;
        return snapshot;
      },
    ),
    refineActiveSessionName: vi.fn(async () => {}),
    deps: {
      agentDir: "C:\\nonexistent\\pi-agent",
      packageUpdateCheck: false,
      refreshModelHealth: () => {},
      getModelConfigHealth: () => ({
        state: "ok" as const,
        source: "ModelRegistry.getError" as const,
      }),
      modelRegistry: { getAll: () => [] },
    },
    onModelHealthChanged: () => {},
  } as unknown as WorkspaceGraphFactory;
}

const promptCtx = {
  id: "req-prompt",
  context: {
    expectedHostInstanceId: "h1",
    expectedWorkspaceId: "w1",
    expectedWorkspaceRevision: 1,
    expectedSessionId: "s1",
    expectedSessionRevision: 1,
  },
  params: { text: "hello" },
};

const reloadCtx = {
  id: "req-reload",
  context: {
    expectedHostInstanceId: "h1",
    expectedWorkspaceId: "w1",
    expectedWorkspaceRevision: 1,
    expectedSessionId: "s1",
    expectedSessionRevision: 1,
    expectedPackageRevision: 1,
  },
  params: null,
};

const preferenceCtx = {
  ...reloadCtx,
  id: "req-resource-preference",
  params: {
    resourceId: "resource-extension",
    targetScope: "user",
    preference: "disabled",
  },
};

describe("isMissingPathError", () => {
  const deletedPackageError = new Error(
    "ENOENT: no such file or directory, stat 'C:\\Users\\Admin\\.pi\\agent\\npm\\node_modules\\pi-markdown-preview\\index.ts'",
  );

  it("recognizes Node ENOENT codes and messages", () => {
    expect(isMissingPathError(Object.assign(new Error("gone"), { code: "ENOENT" }))).toBe(true);
    expect(isMissingPathError(deletedPackageError)).toBe(true);
    expect(isMissingPathError(new Error("PACKAGE_REMOVE_FAILED"))).toBe(false);
  });

  it("only treats ENOENT for an uninstalled npm package path as ignorable", () => {
    expect(missingPathFromError(deletedPackageError)).toBe(
      "C:\\Users\\Admin\\.pi\\agent\\npm\\node_modules\\pi-markdown-preview\\index.ts",
    );
    expect(npmPackageNameFromMissingPath(missingPathFromError(deletedPackageError)!)).toBe(
      "pi-markdown-preview",
    );
    expect(isUninstalledPackageMissingPathError(deletedPackageError, [])).toBe(true);
    expect(
      isUninstalledPackageMissingPathError(deletedPackageError, ["git:github.com/owner/repo"]),
    ).toBe(true);
    expect(
      isUninstalledPackageMissingPathError(deletedPackageError, ["npm:pi-markdown-preview"]),
    ).toBe(false);
    expect(
      isUninstalledPackageMissingPathError(
        new Error(
          "ENOENT: no such file or directory, stat 'C:\\Users\\Admin\\.pi\\agent\\settings.json'",
        ),
        [],
      ),
    ).toBe(false);
  });

  it("only treats ENOENT for an uninstalled git package path as ignorable", () => {
    const deletedGitError = new Error(
      "ENOENT: no such file or directory, stat 'C:\\Users\\Admin\\.pi\\agent\\git\\github.com\\owner\\repo\\index.ts'",
    );
    expect(gitInstallSuffixFromMissingPath(missingPathFromError(deletedGitError)!)).toBe(
      "github.com/owner/repo/index.ts",
    );
    expect(isUninstalledPackageMissingPathError(deletedGitError, [])).toBe(true);
    expect(
      isUninstalledPackageMissingPathError(deletedGitError, ["npm:pi-markdown-preview"]),
    ).toBe(true);
    expect(
      isUninstalledPackageMissingPathError(deletedGitError, ["git:github.com/owner/repo"]),
    ).toBe(false);
    expect(isUninstalledPackageMissingPathError(deletedGitError, ["git:owner/repo"])).toBe(false);
    expect(
      isUninstalledPackageMissingPathError(deletedGitError, ["https://github.com/owner/repo"]),
    ).toBe(false);
    expect(
      isUninstalledPackageMissingPathError(deletedGitError, ["git:github.com/owner/other"]),
    ).toBe(true);
    expect(
      isUninstalledPackageMissingPathError(
        new Error(
          "ENOENT: no such file or directory, stat 'C:\\Users\\Admin\\.pi\\agent\\git\\github.com\\owner\\repo-extra\\index.ts'",
        ),
        ["git:github.com/owner/repo"],
      ),
    ).toBe(true);
    expect(
      gitInstallSuffixFromMissingPath("C:\\Program Files\\Git\\usr\\bin\\git.exe"),
    ).toBeNull();
    expect(
      isUninstalledPackageMissingPathError(
        new Error(
          "ENOENT: no such file or directory, stat 'C:\\Program Files\\Git\\usr\\bin\\git.exe'",
        ),
        [],
      ),
    ).toBe(false);
    expect(
      gitInstallSuffixFromMissingPath(
        "C:\\Users\\Admin\\.pi\\agent\\npm\\node_modules\\pi-markdown-preview\\vendor\\git\\github.com\\owner\\repo\\index.ts",
      ),
    ).toBeNull();
    expect(
      isUninstalledPackageMissingPathError(
        new Error(
          "ENOENT: no such file or directory, stat 'C:\\Users\\Admin\\.pi\\agent\\npm\\node_modules\\pi-markdown-preview\\vendor\\git\\github.com\\owner\\repo\\index.ts'",
        ),
        ["npm:pi-markdown-preview"],
      ),
    ).toBe(false);
    expect(
      gitInstallSuffixFromMissingPath(
        "C:\\Users\\Admin\\.pi\\agent\\git\\github.com\\owner\\repo\\npm\\node_modules\\dep\\index.ts",
      ),
    ).toBe("github.com/owner/repo/npm/node_modules/dep/index.ts");
    expect(
      isUninstalledPackageMissingPathError(
        new Error(
          "ENOENT: no such file or directory, stat 'C:\\Users\\Admin\\.pi\\agent\\git\\github.com\\owner\\repo\\npm\\node_modules\\dep\\index.ts'",
        ),
        [],
      ),
    ).toBe(true);
    expect(
      isUninstalledPackageMissingPathError(
        new Error(
          "ENOENT: no such file or directory, stat 'C:\\Users\\Admin\\.pi\\agent\\settings.json'",
        ),
        [],
      ),
    ).toBe(false);
  });
});

describe("RESOURCE_RELOAD_FAILED prompt block", () => {
  it("blocks agent.prompt when resourceReloadRequired", async () => {
    const factory = mockFactory({ resourceReloadRequired: true });
    const handlers = createAgentHandlers(factory);
    const out = await handlers["agent.prompt"]!(promptCtx as never);
    expect("error" in out).toBe(true);
    if ("error" in out) {
      expect(out.error.code).toBe("RESOURCE_RELOAD_FAILED");
    }
  });

  it("allows agent.prompt when reload flag already clear", async () => {
    const factory = mockFactory({ resourceReloadRequired: false });
    const handlers = createAgentHandlers(factory);
    const out = await handlers["agent.prompt"]!(promptCtx as never);
    expect("error" in out).toBe(false);
    if (!("error" in out)) {
      expect((out.result as { accepted: boolean }).accepted).toBe(true);
    }
  });

  it("provisionally names an unnamed session and schedules refinement", async () => {
    const factory = mockFactory({ resourceReloadRequired: false });
    const graph = factory.getGraph()!;
    (graph.agentSession as unknown as { sessionName?: string }).sessionName = undefined;

    const out = await createAgentHandlers(factory)["agent.prompt"]!({
      ...promptCtx,
      params: { text: "修复 session 恢复问题。然后补测试" },
    } as never);

    expect("error" in out).toBe(false);
    expect(factory.setSessionRuntimeName).toHaveBeenCalledWith(
      graph.agentSession,
      "修复 session 恢复问题",
    );
    await vi.waitFor(() => {
      expect(factory.refineActiveSessionName).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "s1",
          provisionalTitle: "修复 session 恢复问题",
          userPrompt: "修复 session 恢复问题。然后补测试",
        }),
      );
    });
  });

  it("catches failures from the detached prompt task", async () => {
    const factory = mockFactory({ resourceReloadRequired: false });
    const graph = factory.getGraph()!;
    (graph.agentSession as unknown as { sessionName?: string }).sessionName = undefined;
    vi.mocked(factory.refineActiveSessionName).mockRejectedValueOnce(
      new Error("refinement escaped"),
    );
    const logError = vi.spyOn(logger, "error").mockImplementation(() => {});

    const out = await createAgentHandlers(factory)["agent.prompt"]!({
      ...promptCtx,
      params: { text: "Create a safe title" },
    } as never);

    expect("error" in out).toBe(false);
    await vi.waitFor(() => {
      expect(logError).toHaveBeenCalledWith(
        "Detached agent prompt task failed",
        expect.objectContaining({ error: "refinement escaped" }),
      );
    });
  });

  it("agent.compact passes the public SDK instructions string and updates the snapshot", async () => {
    const factory = mockFactory({ resourceReloadRequired: false });
    const handlers = createAgentHandlers(factory);
    const out = await handlers["agent.compact"]!({
      ...promptCtx,
      id: "req-compact",
      params: { instructions: "preserve decisions" },
    } as never);

    expect("error" in out).toBe(false);
    expect(factory.getGraph()!.agentSession!.compact).toHaveBeenCalledWith("preserve decisions");
    expect(factory.getGraph()!.sessionSnapshot).not.toBeNull();
  });

  it("agent.compact rejects while a graph mutation owns the service lock", async () => {
    const factory = mockFactory({ resourceReloadRequired: false, graphBusy: true });
    const handlers = createAgentHandlers(factory);
    const out = await handlers["agent.compact"]!({
      ...promptCtx,
      id: "req-compact-busy",
      params: {},
    } as never);

    expect("error" in out && out.error.code).toBe("SERVICE_GRAPH_BUSY");
    expect(factory.getGraph()!.agentSession!.compact).not.toHaveBeenCalled();
  });

  it("agent.prompt releases the agent lock when a graph mutation wins the handoff", async () => {
    const factory = mockFactory({
      resourceReloadRequired: false,
      graphBusyAfterAgentAcquire: true,
    });
    const handlers = createAgentHandlers(factory);
    const out = await handlers["agent.prompt"]!(promptCtx as never);

    expect("error" in out && out.error.code).toBe("SERVICE_GRAPH_BUSY");
    expect(factory.getGraph()!.agentSession!.prompt).not.toHaveBeenCalled();
    expect(
      factory.getSessionOperationLock(factory.getGraph()!.agentSession!).release,
    ).toHaveBeenCalledWith(promptCtx.id);
  });

  it("graph mutations reject while the agent operation lock is held", async () => {
    const factory = mockFactory({ resourceReloadRequired: false, agentBusy: true });
    const packageOut = await createPackageHandlers(factory)["package.reloadResources"]!(
      reloadCtx as never,
    );
    const modelOut = await createAgentHandlers(factory)["model.setCurrent"]!({
      ...promptCtx,
      id: "req-model-busy",
      params: { provider: "test", modelId: "model" },
    } as never);

    expect("error" in packageOut && packageOut.error.code).toBe("AGENT_BUSY");
    expect("error" in modelOut && modelOut.error.code).toBe("AGENT_BUSY");
  });

  it("agent.setActiveTools rechecks the agent operation lock after acquiring the graph lock", async () => {
    const factory = mockFactory({ resourceReloadRequired: false, agentBusy: true });
    const out = await createAgentHandlers(factory)["agent.setActiveTools"]!({
      ...promptCtx,
      id: "req-tools-busy",
      context: {
        ...promptCtx.context,
        expectedToolRevision: 1,
      },
      params: { names: [] },
    } as never);

    expect("error" in out && out.error.code).toBe("AGENT_BUSY");
    expect(factory.getGraph()!.agentSession!.setActiveToolsByName).not.toHaveBeenCalled();
  });

  it("session.setName uses the public AgentSession API without advancing generations", async () => {
    const factory = mockFactory({ resourceReloadRequired: false });
    const before = factory.getServer()!.identity.snapshot();
    const out = await createSessionHandlers(factory)["session.setName"]!({
      ...promptCtx,
      id: "req-session-name",
      params: { name: "Renamed" },
    } as never);

    expect("error" in out).toBe(false);
    expect(factory.getGraph()!.agentSession!.setSessionName).toHaveBeenCalledWith("Renamed");
    expect(factory.getServer()!.identity.snapshot()).toMatchObject({
      workspaceRevision: before.workspaceRevision,
      sessionRevision: before.sessionRevision,
      packageRevision: before.packageRevision,
    });
  });

  it("package.reloadResources success path clears flag then agent.prompt accepts", async () => {
    const factory = mockFactory({ resourceReloadRequired: true });
    const g = factory.getGraph()!;
    expect(g.resourceReloadRequired).toBe(true);
    // Snapshot still says reload required (stale until mutation finalizes)
    expect(g.packageSnapshot?.resourceReloadRequired).toBe(true);

    // Blocked while flag is set
    const agentHandlers = createAgentHandlers(factory);
    const blocked = await agentHandlers["agent.prompt"]!(promptCtx as never);
    expect("error" in blocked && blocked.error.code === "RESOURCE_RELOAD_FAILED").toBe(true);

    // Drive REAL package.reloadResources handler (not a manual flag flip)
    const packageHandlers = createPackageHandlers(factory);
    const reloadOut = await packageHandlers["package.reloadResources"]!(reloadCtx as never);
    expect("error" in reloadOut).toBe(false);
    if (!("error" in reloadOut)) {
      const result = reloadOut.result as {
        status: string;
        packageSnapshot: { resourceReloadRequired?: boolean };
      };
      expect(result.status).toBe("committed");
      // UI contract: returned snapshot must clear the banner (not only graph flag)
      expect(result.packageSnapshot.resourceReloadRequired).toBe(false);
    }

    // Graph + stored snapshot both cleared by finalizePackageSnapshot
    expect(g.resourceReloadRequired).toBe(false);
    expect(g.packageSnapshot?.resourceReloadRequired).toBe(false);
    expect(g.resourceLoader!.reload).not.toHaveBeenCalled();
    expect(g.agentSession!.reload).toHaveBeenCalledTimes(1);
    expect(g.extensionUiUpdateIdentity).toHaveBeenCalledOnce();
    expect(g.extensionUiUpdateIdentity).toHaveBeenCalledWith({
      hostInstanceId: "h1",
      workspaceId: "w1",
      workspaceRevision: 1,
      sessionId: "s1",
      sessionRevision: 2,
      packageRevision: 2,
    });

    // Prompt unblocked after real reloadResources
    const allowed = await agentHandlers["agent.prompt"]!(promptCtx as never);
    expect("error" in allowed).toBe(false);
    if (!("error" in allowed)) {
      expect((allowed.result as { accepted: boolean }).accepted).toBe(true);
    }
  });

  it("flushes settings, reloads resources, rebuilds snapshot, then emits", async () => {
    const factory = mockFactory({ resourceReloadRequired: false });
    const g = factory.getGraph()!;
    const server = factory.getServer()!;
    const order: string[] = [];
    g.settingsManager!.flush = vi.fn(async () => {
      order.push("flush");
    });
    g.agentSession!.reload = vi.fn(async () => {
      order.push("reload");
    });
    g.packageManager!.resolve = vi.fn(async () => {
      order.push("snapshot");
      return { extensions: [], skills: [], prompts: [], themes: [] };
    });
    server.emit = vi.fn((event: string) => {
      if (event === "package.snapshot") order.push("emit");
    }) as never;

    const result = await createPackageHandlers(factory)["package.reloadResources"]!(
      reloadCtx as never,
    );
    expect("error" in result).toBe(false);
    expect(order).toEqual(["flush", "reload", "snapshot", "emit"]);
  });

  it("uses the official full reload for both preference and resource reload paths", async () => {
    const preferenceFactory = mockFactory({ resourceReloadRequired: false });
    const preferenceGraph = preferenceFactory.getGraph()!;
    preferenceGraph.resourceIdMap.set("resource-extension", {
      type: "extension",
      scope: "user",
      path: "/tmp/.pi/extensions/example.ts",
      baseDir: "/tmp/.pi",
      relativePath: "extensions/example.ts",
      origin: "top-level",
      configurableScopes: ["user"],
    });

    const preferenceOut = await createPackageHandlers(preferenceFactory)["resource.setPreference"]!(
      preferenceCtx as never,
    );

    expect("error" in preferenceOut).toBe(false);
    // 0.82.1 removed preserveExtensionCache: preference reconcile now takes the
    // same official full reload as every other path.
    expect(preferenceGraph.agentSession!.reload).toHaveBeenCalledWith();

    const reloadFactory = mockFactory({ resourceReloadRequired: false });
    const reloadGraph = reloadFactory.getGraph()!;
    const reloadOut = await createPackageHandlers(reloadFactory)["package.reloadResources"]!(
      reloadCtx as never,
    );

    expect("error" in reloadOut).toBe(false);
    expect(reloadGraph.agentSession!.reload).toHaveBeenCalledWith();
  });

  it("treats ENOENT during package.remove as a finished uninstall", async () => {
    const factory = mockFactory({ resourceReloadRequired: false });
    const graph = factory.getGraph()!;
    const configured = [
      {
        source: "npm:pi-markdown-preview",
        scope: "user" as const,
        filtered: false,
      },
    ];
    graph.packageSnapshot = {
      ...graph.packageSnapshot!,
      configured: [
        {
          id: "pkg-markdown",
          source: "npm:pi-markdown-preview",
          kind: "npm",
          scope: "user",
        },
      ],
    } as typeof graph.packageSnapshot;
    graph.packageManager!.listConfiguredPackages = vi.fn(() => configured);
    graph.packageManager!.removeAndPersist = vi.fn(async () => {
      throw Object.assign(
        new Error(
          "ENOENT: no such file or directory, stat 'C:\\Users\\Admin\\.pi\\agent\\npm\\node_modules\\pi-markdown-preview\\index.ts'",
        ),
        { code: "ENOENT" },
      );
    });
    graph.packageManager!.removeSourceFromSettings = vi.fn(() => {
      configured.splice(0, configured.length);
      return true;
    });

    const out = await createPackageHandlers(factory)["package.remove"]!({
      ...reloadCtx,
      id: "req-remove-enoent",
      params: { packageId: "pkg-markdown" },
    } as never);

    expect("error" in out).toBe(false);
    if (!("error" in out)) {
      const result = out.result as {
        status: string;
        reconcileRequired: boolean;
        packageSnapshot: { resourceReloadRequired?: boolean };
      };
      expect(result.status).toBe("committed");
      expect(result.reconcileRequired).toBe(false);
      expect(result.packageSnapshot.resourceReloadRequired).toBe(false);
    }
    expect(graph.packageManager!.removeSourceFromSettings).toHaveBeenCalledWith(
      "npm:pi-markdown-preview",
      { local: false },
    );
    expect(graph.resourceReloadRequired).toBe(false);
  });

  it("does not raise reconcile banners when reload after remove stats a deleted file", async () => {
    const factory = mockFactory({ resourceReloadRequired: false });
    const graph = factory.getGraph()!;
    graph.packageSnapshot = {
      ...graph.packageSnapshot!,
      configured: [
        {
          id: "pkg-markdown",
          source: "npm:pi-markdown-preview",
          kind: "npm",
          scope: "user",
        },
      ],
    } as typeof graph.packageSnapshot;
    graph.packageManager!.removeAndPersist = vi.fn(async () => true);
    graph.agentSession!.reload = vi.fn(async () => {
      throw Object.assign(
        new Error(
          "ENOENT: no such file or directory, stat 'C:\\Users\\Admin\\.pi\\agent\\npm\\node_modules\\pi-markdown-preview\\index.ts'",
        ),
        { code: "ENOENT" },
      );
    });

    const out = await createPackageHandlers(factory)["package.remove"]!({
      ...reloadCtx,
      id: "req-remove-reload-enoent",
      params: { packageId: "pkg-markdown" },
    } as never);

    expect("error" in out).toBe(false);
    if (!("error" in out)) {
      const result = out.result as {
        status: string;
        reconcileRequired: boolean;
        warnings: Array<{ message: string }>;
        packageSnapshot: { resourceReloadRequired?: boolean };
      };
      expect(result.status).toBe("committed");
      expect(result.reconcileRequired).toBe(false);
      expect(result.warnings).toEqual([]);
      expect(result.packageSnapshot.resourceReloadRequired).toBe(false);
    }
    expect(graph.agentSession!.reload).toHaveBeenCalled();
    expect(graph.resourceReloadRequired).toBe(false);
  });

  it("does not raise reconcile banners when reload after remove stats a deleted git clone", async () => {
    const factory = mockFactory({ resourceReloadRequired: false });
    const graph = factory.getGraph()!;
    graph.packageSnapshot = {
      ...graph.packageSnapshot!,
      configured: [
        {
          id: "pkg-git-repo",
          source: "git:github.com/owner/repo",
          kind: "git",
          scope: "user",
        },
      ],
    } as typeof graph.packageSnapshot;
    graph.packageManager!.removeAndPersist = vi.fn(async () => true);
    graph.agentSession!.reload = vi.fn(async () => {
      throw Object.assign(
        new Error(
          "ENOENT: no such file or directory, stat 'C:\\Users\\Admin\\.pi\\agent\\git\\github.com\\owner\\repo\\index.ts'",
        ),
        { code: "ENOENT" },
      );
    });

    const out = await createPackageHandlers(factory)["package.remove"]!({
      ...reloadCtx,
      id: "req-remove-reload-git-enoent",
      params: { packageId: "pkg-git-repo" },
    } as never);

    expect("error" in out).toBe(false);
    if (!("error" in out)) {
      const result = out.result as {
        status: string;
        reconcileRequired: boolean;
        warnings: Array<{ message: string }>;
        packageSnapshot: { resourceReloadRequired?: boolean };
      };
      expect(result.status).toBe("committed");
      expect(result.reconcileRequired).toBe(false);
      expect(result.warnings).toEqual([]);
      expect(result.packageSnapshot.resourceReloadRequired).toBe(false);
    }
    expect(graph.agentSession!.reload).toHaveBeenCalled();
    expect(graph.resourceReloadRequired).toBe(false);
  });

  it("does not raise reconcile banners when cache refresh stats a deleted git clone", async () => {
    const factory = mockFactory({ resourceReloadRequired: false });
    const graph = factory.getGraph()!;
    graph.packageSnapshot = {
      ...graph.packageSnapshot!,
      configured: [
        {
          id: "pkg-git-repo",
          source: "git:github.com/badlogic/pi-doom",
          kind: "git",
          scope: "user",
        },
      ],
    } as typeof graph.packageSnapshot;
    graph.packageManager!.removeAndPersist = vi.fn(async () => true);
    Object.assign(factory, {
      userResourceCache: {
        invalidate: vi.fn(async () => {}),
        prepareLoaderExtensionRefresh: vi.fn(async () => {
          throw Object.assign(
            new Error(
              "ENOENT: no such file or directory, stat 'C:\\Users\\Admin\\.pi\\agent\\git\\github.com\\badlogic\\pi-doom\\src\\index.ts'",
            ),
            { code: "ENOENT" },
          );
        }),
      },
    });

    const out = await createPackageHandlers(factory)["package.remove"]!({
      ...reloadCtx,
      id: "req-remove-cache-git-enoent",
      params: { packageId: "pkg-git-repo" },
    } as never);

    expect("error" in out).toBe(false);
    if (!("error" in out)) {
      const result = out.result as {
        status: string;
        reconcileRequired: boolean;
        warnings: Array<{ message: string }>;
        packageSnapshot: { resourceReloadRequired?: boolean };
      };
      expect(result.status).toBe("committed");
      expect(result.reconcileRequired).toBe(false);
      expect(result.warnings).toEqual([]);
      expect(result.packageSnapshot.resourceReloadRequired).toBe(false);
    }
    expect(graph.agentSession!.reload).not.toHaveBeenCalled();
    expect(graph.resourceReloadRequired).toBe(false);
  });

  it("does not raise reconcile banners when disable reloads a just-deleted package path", async () => {
    const factory = mockFactory({ resourceReloadRequired: false });
    const graph = factory.getGraph()!;
    graph.resourceIdMap.set("resource-extension", {
      type: "extension",
      scope: "user",
      path: "/tmp/.pi/extensions/example.ts",
      baseDir: "/tmp/.pi",
      relativePath: "extensions/example.ts",
      origin: "top-level",
      configurableScopes: ["user"],
    });
    graph.agentSession!.reload = vi.fn(async () => {
      throw Object.assign(
        new Error(
          "ENOENT: no such file or directory, stat 'C:\\Users\\Admin\\.pi\\agent\\npm\\node_modules\\pi-web-access\\index.ts'",
        ),
        { code: "ENOENT" },
      );
    });

    const out = await createPackageHandlers(factory)["resource.setPreference"]!(
      preferenceCtx as never,
    );

    expect("error" in out).toBe(false);
    if (!("error" in out)) {
      const result = out.result as {
        status: string;
        reconcileRequired: boolean;
        warnings: Array<{ message: string }>;
        packageSnapshot: { resourceReloadRequired?: boolean };
      };
      expect(result.status).toBe("committed");
      expect(result.reconcileRequired).toBe(false);
      expect(result.warnings).toEqual([]);
      expect(result.packageSnapshot.resourceReloadRequired).toBe(false);
    }
    expect(graph.agentSession!.reload).toHaveBeenCalled();
    expect(graph.resourceReloadRequired).toBe(false);
  });

  it("still raises reload failure when ENOENT is a still-configured package", async () => {
    const factory = mockFactory({ resourceReloadRequired: false });
    const graph = factory.getGraph()!;
    graph.resourceIdMap.set("resource-extension", {
      type: "extension",
      scope: "user",
      path: "/tmp/.pi/extensions/example.ts",
      baseDir: "/tmp/.pi",
      relativePath: "extensions/example.ts",
      origin: "top-level",
      configurableScopes: ["user"],
    });
    graph.packageManager!.listConfiguredPackages = vi.fn(() => [
      { source: "npm:pi-web-access", scope: "user" as const, filtered: false },
    ]);
    graph.agentSession!.reload = vi.fn(async () => {
      throw Object.assign(
        new Error(
          "ENOENT: no such file or directory, stat 'C:\\Users\\Admin\\.pi\\agent\\npm\\node_modules\\pi-web-access\\index.ts'",
        ),
        { code: "ENOENT" },
      );
    });

    const out = await createPackageHandlers(factory)["resource.setPreference"]!(
      preferenceCtx as never,
    );

    expect("error" in out).toBe(false);
    if (!("error" in out)) {
      const result = out.result as {
        status: string;
        reconcileRequired: boolean;
        warnings: Array<{ code: string }>;
        packageSnapshot: { resourceReloadRequired?: boolean };
      };
      expect(result.status).toBe("partialFailure");
      expect(result.reconcileRequired).toBe(true);
      expect(result.warnings.some((warning) => warning.code === "RESOURCE_RELOAD_FAILED")).toBe(
        true,
      );
      expect(result.packageSnapshot.resourceReloadRequired).toBe(true);
    }
    expect(graph.resourceReloadRequired).toBe(true);
  });

  it("still raises reload failure when ENOENT is a still-configured git clone", async () => {
    const factory = mockFactory({ resourceReloadRequired: false });
    const graph = factory.getGraph()!;
    graph.resourceIdMap.set("resource-extension", {
      type: "extension",
      scope: "user",
      path: "/tmp/.pi/extensions/example.ts",
      baseDir: "/tmp/.pi",
      relativePath: "extensions/example.ts",
      origin: "top-level",
      configurableScopes: ["user"],
    });
    graph.packageManager!.listConfiguredPackages = vi.fn(() => [
      { source: "git:github.com/owner/repo", scope: "user" as const, filtered: false },
    ]);
    graph.agentSession!.reload = vi.fn(async () => {
      throw Object.assign(
        new Error(
          "ENOENT: no such file or directory, stat 'C:\\Users\\Admin\\.pi\\agent\\git\\github.com\\owner\\repo\\index.ts'",
        ),
        { code: "ENOENT" },
      );
    });

    const out = await createPackageHandlers(factory)["resource.setPreference"]!(
      preferenceCtx as never,
    );

    expect("error" in out).toBe(false);
    if (!("error" in out)) {
      const result = out.result as {
        status: string;
        reconcileRequired: boolean;
        warnings: Array<{ code: string }>;
        packageSnapshot: { resourceReloadRequired?: boolean };
      };
      expect(result.status).toBe("partialFailure");
      expect(result.reconcileRequired).toBe(true);
      expect(result.warnings.some((warning) => warning.code === "RESOURCE_RELOAD_FAILED")).toBe(
        true,
      );
      expect(result.packageSnapshot.resourceReloadRequired).toBe(true);
    }
    expect(graph.resourceReloadRequired).toBe(true);
  });

  it("clean package failure does not advance the authoritative package revision", async () => {
    const factory = mockFactory({ resourceReloadRequired: false });
    const packageHandlers = createPackageHandlers(factory);
    const beforeRevision = factory.getServer()!.identity.packageRevision;
    const out = await packageHandlers["package.remove"]!({
      ...reloadCtx,
      id: "req-remove-missing",
      params: { packageId: "missing" },
    } as never);

    expect("error" in out).toBe(true);
    expect(factory.getServer()!.identity.packageRevision).toBe(beforeRevision);
  });

  it("cancels a timed-out package operation, reconciles, and releases ownership", async () => {
    vi.useFakeTimers();
    try {
      const factory = mockFactory({ resourceReloadRequired: false });
      const graph = factory.getGraph()!;
      const server = factory.getServer()!;
      let operationSignal: AbortSignal | undefined;
      let mutationSignal: AbortSignal | undefined;
      graph.packageManager!.setOperationSignal = vi.fn((signal) => {
        operationSignal = signal;
        if (signal) mutationSignal = signal;
      });
      graph.packageManager!.installAndPersist = vi.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            if (operationSignal?.aborted) {
              reject(operationSignal.reason);
              return;
            }
            operationSignal?.addEventListener("abort", () => reject(operationSignal?.reason), {
              once: true,
            });
          }),
      );

      const pending = createPackageHandlers(factory)["package.install"]!({
        ...reloadCtx,
        id: "req-timeout-install",
        params: { source: "npm:never-finishes", scope: "user" },
      } as never);
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(operationSignal).toBeDefined());
      expect(operationSignal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(600_000);
      const out = await pending;

      expect("error" in out && out.error.code).toBe("PACKAGE_PARTIAL_FAILURE");
      expect(mutationSignal?.aborted).toBe(true);
      expect(operationSignal).toBeUndefined();
      expect(server.serviceGraphLock.isHeld()).toBe(false);
      expect(server.graphOperations.getActive()).toBeNull();
      expect(server.requestShutdown).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("package.reloadResources failure keeps snapshot flag true and prompt blocked", async () => {
    const factory = mockFactory({ resourceReloadRequired: true });
    const g = factory.getGraph()!;
    g.agentSession!.reload = vi.fn(async () => {
      throw new Error("reload boom");
    });

    const packageHandlers = createPackageHandlers(factory);
    const reloadOut = await packageHandlers["package.reloadResources"]!(reloadCtx as never);
    // Should return result with partialFailure, not throw
    expect("error" in reloadOut).toBe(false);
    if (!("error" in reloadOut)) {
      const result = reloadOut.result as {
        status: string;
        reconcileRequired: boolean;
        packageSnapshot: { resourceReloadRequired?: boolean };
      };
      expect(result.status).toBe("partialFailure");
      expect(result.reconcileRequired).toBe(true);
      // UI contract: snapshot still requires reload banner
      expect(result.packageSnapshot.resourceReloadRequired).toBe(true);
    }
    expect(g.resourceReloadRequired).toBe(true);
    expect(g.packageSnapshot?.resourceReloadRequired).toBe(true);
    expect(g.resourceLoader!.reload).not.toHaveBeenCalled();
    expect(g.agentSession!.reload).toHaveBeenCalledTimes(1);
    expect(g.extensionUiUpdateIdentity).not.toHaveBeenCalled();

    const agentHandlers = createAgentHandlers(factory);
    const blocked = await agentHandlers["agent.prompt"]!(promptCtx as never);
    expect("error" in blocked && blocked.error.code === "RESOURCE_RELOAD_FAILED").toBe(true);
  });
});

describe("extension refresh rollback", () => {
  const roots: string[] = [];
  const sessions: AgentSession[] = [];

  afterEach(() => {
    for (const session of sessions.splice(0)) {
      session.dispose();
    }
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  async function refreshFixture() {
    const root = mkdtempSync(join(tmpdir(), "pideck-ext-refresh-"));
    roots.push(root);
    const agentDir = join(root, "agent");
    const workspace = join(root, "workspace");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    writeFileSync(
      join(agentDir, "ext.js"),
      [
        "export default function (pi) {",
        '  pi.on("session_start", async (_event, ctx) => { void ctx; });',
        "}",
      ].join("\n"),
    );
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ extensions: [join(agentDir, "ext.js")] }),
    );

    const cache = new UserResourceCache(agentDir);
    const settingsManager = SettingsManager.create(workspace, agentDir, { projectTrusted: false });
    const loader = await cache.createWorkspaceLoader({
      cwd: workspace,
      settingsManager,
    });
    const factory = mockFactory({ resourceReloadRequired: false });
    const graph = factory.getGraph()!;
    graph.resourceLoader = loader;
    Object.assign(factory, { userResourceCache: cache });
    return {
      cache,
      loader,
      factory,
      graph,
      settingsManager,
      agentDir,
      workspace,
      before: loader.getExtensions(),
    };
  }

  it("restores the loader immediately when reload fails before the new runner is built", async () => {
    const { loader, factory, graph, before } = await refreshFixture();
    graph.agentSession!.reload = vi.fn(async () => {
      throw new Error("settingsManager.reload failed");
    });

    const out = await createPackageHandlers(factory)["package.reloadResources"]!(
      reloadCtx as never,
    );
    expect("error" in out).toBe(false);
    if (!("error" in out)) {
      expect((out.result as { status: string }).status).toBe("partialFailure");
    }
    expect(loader.getExtensions().runtime).toBe(before.runtime);
    expect(() => before.runtime.assertActive()).not.toThrow();
    expect(graph.resourceReloadRequired).toBe(true);
  });

  it("keeps the adopted runner when a real AgentSession fails after _buildRuntime", async () => {
    const { loader, factory, graph, settingsManager, agentDir, workspace, before } =
      await refreshFixture();
    const { modelRuntime } = await createTestModelServices(agentDir);
    const { session } = await createAgentSession({
      cwd: workspace,
      agentDir,
      modelRuntime,
      settingsManager,
      resourceLoader: loader,
      sessionManager: SessionManager.create(workspace),
    });
    sessions.push(session);
    graph.agentSession = session;
    const runnerBefore = session.extensionRunner;
    const originalReload = session.reload.bind(session);
    session.reload = async () => {
      await originalReload();
      throw new Error("extension discovery failed");
    };

    const out = await createPackageHandlers(factory)["package.reloadResources"]!(
      reloadCtx as never,
    );
    expect("error" in out).toBe(false);
    if (!("error" in out)) {
      expect((out.result as { status: string }).status).toBe("partialFailure");
    }
    const current = loader.getExtensions();
    expect(session.extensionRunner).not.toBe(runnerBefore);
    expect(graph.agentSession.extensionRunner).toBe(session.extensionRunner);
    expect(current.runtime).not.toBe(before.runtime);
    expect(() => current.runtime.assertActive()).not.toThrow();
    expect(() => before.runtime.assertActive()).toThrow(/user-resource-refresh/);
    expect(graph.resourceReloadRequired).toBe(true);
  });
});
