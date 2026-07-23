/**
 * R6: agent.prompt blocked while resourceReloadRequired until
 * package.reloadResources success path clears the flag.
 */
import { describe, expect, it, vi } from "vitest";
import { createAgentHandlers } from "./agent-controller.js";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";
import { createPackageHandlers } from "./package-controller.js";
import { createSettingsHandlers } from "./settings-controller.js";
import { createSessionHandlers } from "./session-controller.js";
import { logger } from "./logger.js";

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
  const releaseAgent = vi.fn();
  const server = {
    identity,
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
    agentOperationLock: {
      tryAcquire: () => opts.agentBusy !== true,
      release: releaseAgent,
      isHeld: () => opts.agentBusy === true,
    },
    emit: () => {},
    getIdentity: () => identity.snapshot(),
    setPhase: (p: string) => {
      phase = p;
    },
    getPhase: () => phase,
  };

  return {
    checkIdentity: () => null,
    getGraph: () => g,
    getServer: () => server,
    getSessionOperationLock: () => server.agentOperationLock,
    hasBusySessions: () => opts.agentBusy === true || !g.agentSession.isIdle,
    setSessionRunId: () => {},
    clearSessionRunId: () => {},
    setActiveSessionName: vi.fn((name: string) => {
      g.agentSession.setSessionName(name);
      const snapshot = { sessionId: "s1", name };
      g.sessionSnapshot = snapshot;
      return snapshot;
    }),
    refineActiveSessionName: vi.fn(async () => {}),
    currentRunId: null as string | null,
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
    expect(factory.setActiveSessionName).toHaveBeenCalledWith("修复 session 恢复问题");
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
    expect(factory.getServer()!.agentOperationLock.release).toHaveBeenCalledWith(
      promptCtx.id,
    );
  });

  it("graph mutations reject while the agent operation lock is held", async () => {
    const factory = mockFactory({ resourceReloadRequired: false, agentBusy: true });
    const packageOut = await createPackageHandlers(factory)["package.reloadResources"]!(
      reloadCtx as never,
    );
    const settingsOut = await createSettingsHandlers(factory)["piSettings.patch"]!({
      ...reloadCtx,
      id: "req-settings-busy",
      params: { patch: { autoRetry: false } },
    } as never);
    const modelOut = await createAgentHandlers(factory)["model.setCurrent"]!({
      ...promptCtx,
      id: "req-model-busy",
      params: { provider: "test", modelId: "model" },
    } as never);

    expect("error" in packageOut && packageOut.error.code).toBe("AGENT_BUSY");
    expect("error" in settingsOut && settingsOut.error.code).toBe("AGENT_BUSY");
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
    expect("error" in blocked && blocked.error.code === "RESOURCE_RELOAD_FAILED").toBe(
      true,
    );

    // Drive REAL package.reloadResources handler (not a manual flag flip)
    const packageHandlers = createPackageHandlers(factory);
    const reloadOut = await packageHandlers["package.reloadResources"]!(
      reloadCtx as never,
    );
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
    g.settingsManager!.flush = vi.fn(async () => { order.push("flush"); });
    g.agentSession!.reload = vi.fn(async () => { order.push("reload"); });
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

  it("preserves the extension module cache only for resource preference changes", async () => {
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

    const preferenceOut = await createPackageHandlers(preferenceFactory)[
      "resource.setPreference"
    ]!(preferenceCtx as never);

    expect("error" in preferenceOut).toBe(false);
    expect(preferenceGraph.agentSession!.reload).toHaveBeenCalledWith({
      preserveExtensionCache: true,
    });

    const reloadFactory = mockFactory({ resourceReloadRequired: false });
    const reloadGraph = reloadFactory.getGraph()!;
    const reloadOut = await createPackageHandlers(reloadFactory)["package.reloadResources"]!(
      reloadCtx as never,
    );

    expect("error" in reloadOut).toBe(false);
    expect(reloadGraph.agentSession!.reload).toHaveBeenCalledWith(undefined);
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

  it("package.reloadResources failure keeps snapshot flag true and prompt blocked", async () => {
    const factory = mockFactory({ resourceReloadRequired: true });
    const g = factory.getGraph()!;
    g.agentSession!.reload = vi.fn(async () => {
      throw new Error("reload boom");
    });

    const packageHandlers = createPackageHandlers(factory);
    const reloadOut = await packageHandlers["package.reloadResources"]!(
      reloadCtx as never,
    );
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

    const agentHandlers = createAgentHandlers(factory);
    const blocked = await agentHandlers["agent.prompt"]!(promptCtx as never);
    expect("error" in blocked && blocked.error.code === "RESOURCE_RELOAD_FAILED").toBe(
      true,
    );
  });
});
