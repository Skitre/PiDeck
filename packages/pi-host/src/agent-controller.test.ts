import { describe, expect, it, vi } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createAgentHandlers, summarizeModel } from "./agent-controller.js";
import { AttachmentStoreError } from "./attachment-store.js";
import { AgentOperationLock, TryMutex } from "./locks.js";
import { GraphOperationRegistry } from "./operation-lifecycle.js";
import type { PiHostServer } from "./server.js";
import type { BackgroundSessionRuntime, WorkspaceGraphFactory } from "./workspace-graph-factory.js";
import { getActiveExtensionCommandOrigin } from "./extension-invocation-context.js";
import {
  beginQueueTransaction,
  finishQueueTransaction,
  observeQueueUpdate,
} from "./queue-state.js";

function model(overrides: Partial<Model<any>>): Model<any> {
  return {
    provider: "muapi",
    id: "model",
    name: "Model",
    api: "openai-completions",
    baseUrl: "http://localhost:8317/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    ...overrides,
  } as Model<any>;
}

describe("summarizeModel", () => {
  it("projects exact configured thinking levels for each model", () => {
    expect(
      summarizeModel(
        model({
          id: "grok-4.5",
          reasoning: true,
          thinkingLevelMap: {
            off: null,
            minimal: null,
            low: "low",
            medium: "medium",
            high: "high",
            xhigh: null,
            max: null,
          },
        }),
      ).thinkingLevels,
    ).toEqual(["low", "medium", "high"]);
    expect(
      summarizeModel(
        model({
          id: "glm-5.2",
          reasoning: true,
          thinkingLevelMap: {
            off: null,
            minimal: null,
            low: null,
            medium: null,
            high: "high",
            xhigh: null,
            max: "max",
          },
        }),
      ).thinkingLevels,
    ).toEqual(["high", "max"]);
    expect(summarizeModel(model({ id: "grok-composer-2.5-fast" })).thinkingLevels).toEqual(["off"]);
  });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function stableHandlerFixture(wait: Promise<void>) {
  const identity = {
    hostInstanceId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    workspaceRevision: 1,
    sessionId: "33333333-3333-4333-8333-333333333333",
    sessionRevision: 1,
    packageRevision: 1,
    snapshot() {
      return {
        hostInstanceId: this.hostInstanceId,
        workspaceId: this.workspaceId,
        workspaceRevision: this.workspaceRevision,
        sessionId: this.sessionId,
        sessionRevision: this.sessionRevision,
        packageRevision: this.packageRevision,
      };
    },
  };
  const session = {
    prompt: vi.fn(async () => wait),
    steer: vi.fn(async () => wait),
    followUp: vi.fn(async () => wait),
    abort: vi.fn(async () => wait),
    clearQueue: vi.fn(() => ({ steering: [], followUp: [] })),
    isIdle: false,
    isCompacting: false,
    isRetrying: false,
    sessionId: identity.sessionId,
    sessionFile: "C:/sessions/current.jsonl",
    sessionName: "Current",
    model: undefined,
    messages: [],
    thinkingLevel: "off",
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    steeringMode: "all",
    followUpMode: "all",
    getSteeringMessages: () => ["steer"],
    getFollowUpMessages: () => ["follow-up"],
    getAllTools: () => [],
    getActiveToolNames: () => [],
    getAvailableThinkingLevels: () => ["off"],
    extensionRunner: {
      getCommand: () => undefined,
    },
  } as unknown as AgentSession;
  const graph = {
    agentSession: session,
    sessionManager: {},
    sessionSnapshot: null,
    canonicalCwd: "C:/workspace",
    workspaceId: identity.workspaceId,
    toolRevision: 1,
    backgroundSessions: new Map<string, BackgroundSessionRuntime>(),
  };
  const serviceGraphLock = new TryMutex();
  const sessionOperationLock = new AgentOperationLock();
  let phase = "ready";
  const server = {
    identity,
    graphOperations: new GraphOperationRegistry(),
    serviceGraphLock,
    emit: vi.fn(),
    emitForIdentity: vi.fn(),
    getIdentity: () => identity.snapshot(),
    setPhase: (next: string) => {
      phase = next;
    },
    getPhase: () => phase,
  } as unknown as PiHostServer;
  const factory = {
    checkIdentity: () => null,
    getGraph: () => graph,
    getServer: () => server,
    getSessionOperationLock: () => sessionOperationLock,
    isSessionBusy: (target: AgentSession) => !target.isIdle || sessionOperationLock.isHeld(),
    disposeSettledBackgroundRuntime: vi.fn(async () => {}),
    beginQueueTransaction,
    finishQueueTransaction: (target: AgentSession) => {
      const result = finishQueueTransaction(target);
      if (result.changed) {
        server.emitForIdentity(server.getIdentity(), "agent.queueChanged", result.queue);
      }
      return result.queue;
    },
    syncQueueState: (target: AgentSession, force = false) => {
      const observed = observeQueueUpdate(target);
      if (!observed.suppressed && (observed.changed || force)) {
        server.emitForIdentity(server.getIdentity(), "agent.queueChanged", observed.queue);
      }
      return observed.queue;
    },
    hasBusySessions: () => false,
    hasBusyRetainedSessions: () => false,
    hasRunningSessions: () => false,
    findRuntimeForSession: (target: AgentSession) =>
      target === session
        ? {
            identity: identity.snapshot(),
            agentSession: session,
            sessionManager: graph.sessionManager,
            sessionSnapshot: graph.sessionSnapshot,
            toolRevision: graph.toolRevision,
            isActive: true,
          }
        : null,
    setSessionRunId: vi.fn(),
    clearSessionRunId: vi.fn(),
    setActiveSessionName: vi.fn(),
    setSessionRuntimeName: vi.fn(),
    refineActiveSessionName: vi.fn(async () => {}),
    resolveSessionTarget: () => ({
      identity: identity.snapshot(),
      agentSession: session,
      sessionManager: graph.sessionManager,
      sessionSnapshot: graph.sessionSnapshot,
      toolRevision: graph.toolRevision,
      isActive: true,
    }),
  } as unknown as WorkspaceGraphFactory;
  return { factory, graph, server, serviceGraphLock, sessionOperationLock, session };
}

describe("session-bound agent handlers", () => {
  it.each([
    ["agent.steer", "steer"],
    ["agent.followUp", "followUp"],
    ["agent.abort", "abort"],
  ] as const)("holds the service graph lock across %s", async (method, sessionMethod) => {
    const gate = deferred();
    const fixture = stableHandlerFixture(gate.promise);
    const handler = createAgentHandlers(fixture.factory)[method]!;

    const pending = handler({
      id: `request-${sessionMethod}`,
      context: {},
      params: { text: "queued" },
    } as never);

    await vi.waitFor(() => {
      expect(fixture.session[sessionMethod]).toHaveBeenCalled();
    });
    expect(fixture.serviceGraphLock.isHeld()).toBe(true);
    expect(
      fixture.serviceGraphLock.tryAcquire({
        operationKind: "session.create",
        requestId: "replace-session",
      }),
    ).toBe(false);

    gate.resolve();
    const outcome = await pending;

    expect("error" in outcome).toBe(false);
    expect(outcome.identity).toEqual(fixture.server.getIdentity());
    expect(fixture.serviceGraphLock.isHeld()).toBe(false);
  });

  it("queues only a compact attachment reference and commits after acceptance", async () => {
    const fixture = stableHandlerFixture(Promise.resolve());
    const prepareForPrompt = vi.fn().mockResolvedValue([
      {
        id: "44444444-4444-4444-8444-444444444444",
        name: "manual.pdf",
        mediaType: "application/pdf",
        sizeBytes: 1024,
        status: "ready",
        unit: "page",
        unitCount: 3,
      },
    ]);
    const commitToSession = vi.fn().mockResolvedValue(undefined);
    (fixture.factory as unknown as { deps: unknown }).deps = {
      attachmentStore: { prepareForPrompt, commitToSession },
    };

    const outcome = await createAgentHandlers(fixture.factory)["agent.followUp"]!({
      id: "attachment-follow-up",
      context: {},
      params: {
        text: "review this",
        attachmentIds: ["44444444-4444-4444-8444-444444444444"],
      },
    } as never);

    expect("error" in outcome).toBe(false);
    expect(fixture.session.followUp).toHaveBeenCalledWith(
      expect.stringContaining('<pideck-attachments version="1">'),
      undefined,
    );
    expect(fixture.session.followUp).toHaveBeenCalledWith(
      expect.stringContaining("manual.pdf"),
      undefined,
    );
    await vi.waitFor(() => {
      expect(commitToSession).toHaveBeenCalledWith(
        ["44444444-4444-4444-8444-444444444444"],
        "33333333-3333-4333-8333-333333333333",
      );
    });
  });
});

describe("agent.prompt startup", () => {
  it("releases operation state when provisional title persistence throws", async () => {
    const gate = deferred();
    gate.resolve();
    const fixture = stableHandlerFixture(gate.promise);
    (fixture.session as unknown as { sessionName?: string }).sessionName = undefined;
    vi.mocked(fixture.factory.setSessionRuntimeName).mockImplementation(() => {
      throw new Error("session title persistence failed");
    });
    const handler = createAgentHandlers(fixture.factory)["agent.prompt"]!;

    await expect(
      handler({
        id: "prompt-title-failure",
        context: {},
        params: { text: "name this session" },
      } as never),
    ).rejects.toThrow("session title persistence failed");

    expect(fixture.sessionOperationLock.isHeld()).toBe(false);
    expect(fixture.factory.clearSessionRunId).toHaveBeenCalledExactlyOnceWith(fixture.session);
    expect(fixture.server.getPhase()).toBe("ready");
    expect(fixture.session.prompt).not.toHaveBeenCalled();
  });

  it("emits detached prompt errors with the current Session identity", async () => {
    let rejectPrompt!: (error: Error) => void;
    const prompt = new Promise<void>((_resolve, reject) => {
      rejectPrompt = reject;
    });
    const fixture = stableHandlerFixture(prompt);
    const outcome = await createAgentHandlers(fixture.factory)["agent.prompt"]!({
      id: "prompt-error-identity",
      context: {},
      params: { text: "fail after switch" },
    } as never);
    expect("error" in outcome ? outcome.error.message : null).toBeNull();

    fixture.server.identity.workspaceRevision = 5;
    rejectPrompt(new Error("model failed"));
    await vi.waitFor(() => {
      expect(fixture.server.emitForIdentity).toHaveBeenCalled();
    });
    expect(fixture.server.emitForIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceRevision: 5,
        sessionId: "33333333-3333-4333-8333-333333333333",
      }),
      "agent.event",
      expect.objectContaining({
        event: expect.objectContaining({ type: "error", message: "model failed" }),
      }),
    );
  });
});

describe("agent.prompt auth preflight", () => {
  function authFixture(checkAuth: ReturnType<typeof vi.fn>) {
    const fixture = stableHandlerFixture(Promise.resolve());
    (fixture.session as unknown as { model?: unknown }).model = {
      provider: "anthropic",
      id: "claude-sonnet-4",
    };
    (fixture.factory as unknown as { deps: unknown }).deps = {
      modelRuntime: { checkAuth },
    };
    return fixture;
  }

  it("rejects with AUTH_REQUIRED when the current model provider has no credentials", async () => {
    const checkAuth = vi.fn().mockResolvedValue(undefined);
    const fixture = authFixture(checkAuth);

    const outcome = await createAgentHandlers(fixture.factory)["agent.prompt"]!({
      id: "prompt-no-auth",
      context: {},
      params: { text: "hello" },
    } as never);

    expect("error" in outcome).toBe(true);
    if (!("error" in outcome)) return;
    expect(outcome.error.code).toBe("AUTH_REQUIRED");
    expect(outcome.error.details).toEqual({ providerId: "anthropic" });
    expect(checkAuth).toHaveBeenCalledWith("anthropic");
    expect(fixture.session.prompt).not.toHaveBeenCalled();
    expect(fixture.sessionOperationLock.isHeld()).toBe(false);
  });

  it("sends when credentials resolve (stored, config, or env-provided)", async () => {
    const checkAuth = vi.fn().mockResolvedValue({ source: "env", type: "api_key" });
    const fixture = authFixture(checkAuth);

    const outcome = await createAgentHandlers(fixture.factory)["agent.prompt"]!({
      id: "prompt-auth-ok",
      context: {},
      params: { text: "hello" },
    } as never);

    expect("result" in outcome).toBe(true);
    await vi.waitFor(() => expect(fixture.session.prompt).toHaveBeenCalledOnce());
  });

  it("sends when the auth check itself fails — a probe error is not a credential verdict", async () => {
    const checkAuth = vi.fn().mockRejectedValue(new Error("probe offline"));
    const fixture = authFixture(checkAuth);

    const outcome = await createAgentHandlers(fixture.factory)["agent.prompt"]!({
      id: "prompt-auth-probe-failed",
      context: {},
      params: { text: "hello" },
    } as never);

    expect("result" in outcome).toBe(true);
    await vi.waitFor(() => expect(fixture.session.prompt).toHaveBeenCalledOnce());
  });
});

describe("agent.prompt extension command provenance", () => {
  it("scopes the accepted run id and invocation to the registered command handler", async () => {
    const gate = deferred();
    const fixture = stableHandlerFixture(gate.promise);
    const session = fixture.session as unknown as {
      extensionRunner: { getCommand: (name: string) => unknown };
      prompt: ReturnType<typeof vi.fn>;
    };
    session.extensionRunner = {
      getCommand: (name) =>
        name === "brainstorm"
          ? {
              name,
              invocationName: name,
              sourceInfo: {
                path: "/packages/brainstorm/extensions/index.ts",
                source: "npm:@pideck/brainstorm@1.0.0",
                scope: "user",
                origin: "package",
                baseDir: "/packages/brainstorm",
              },
              handler: async () => {},
            }
          : undefined,
    };
    let duringPrompt: { runId: string; invocation: string } | undefined;
    let afterAwait: { runId: string; invocation: string } | undefined;
    session.prompt = vi.fn(async () => {
      const origin = getActiveExtensionCommandOrigin(fixture.session);
      duringPrompt = origin ? { runId: origin.runId, invocation: origin.invocation } : undefined;
      await gate.promise;
      const resumed = getActiveExtensionCommandOrigin(fixture.session);
      afterAwait = resumed ? { runId: resumed.runId, invocation: resumed.invocation } : undefined;
    });

    const handler = createAgentHandlers(fixture.factory)["agent.prompt"]!;
    const outcome = await handler({
      id: "prompt-command",
      context: {},
      params: { text: "/brainstorm topic" },
    } as never);

    expect("result" in outcome).toBe(true);
    if (!("result" in outcome)) return;
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledOnce());
    expect(duringPrompt).toEqual({
      runId: (outcome.result as { runId: string }).runId,
      invocation: "brainstorm",
    });
    expect(getActiveExtensionCommandOrigin(fixture.session)).toBeUndefined();

    gate.resolve();
    await vi.waitFor(() => expect(fixture.sessionOperationLock.isHeld()).toBe(false));
    expect(afterAwait).toEqual(duringPrompt);
  });
});

describe("agent.abort with queued messages", () => {
  it("parks the queue before aborting and restores it after, so the chain stops", async () => {
    const gate = deferred();
    gate.resolve();
    const fixture = stableHandlerFixture(gate.promise);
    const session = fixture.session as unknown as Record<string, unknown>;
    const order: string[] = [];
    const steering = ["s1"];
    const followUp = ["f1", "f2"];
    session.getSteeringMessages = () => steering;
    session.getFollowUpMessages = () => followUp;
    session.clearQueue = vi.fn(() => {
      order.push("clearQueue");
      const cleared = { steering: [...steering], followUp: [...followUp] };
      steering.length = 0;
      followUp.length = 0;
      return cleared;
    });
    session.abort = vi.fn(async () => {
      order.push("abort");
    });
    session.steer = vi.fn(async (text: string) => {
      order.push(`steer:${text}`);
      steering.push(text);
    });
    session.followUp = vi.fn(async (text: string) => {
      order.push(`followUp:${text}`);
      followUp.push(text);
    });
    const handler = createAgentHandlers(fixture.factory)["agent.abort"]!;

    const outcome = await handler({ id: "abort-queued", context: {}, params: null } as never);

    expect("error" in outcome).toBe(false);
    // Queue must be cleared BEFORE abort (the SDK auto-runs the next queued
    // follow-up when a run ends) and re-added afterwards in original order.
    expect(order).toEqual(["clearQueue", "abort", "steer:s1", "followUp:f1", "followUp:f2"]);
    expect(fixture.server.emitForIdentity).not.toHaveBeenCalled();
    expect(fixture.serviceGraphLock.isHeld()).toBe(false);
  });

  it("skips park/restore entirely when the session is idle", async () => {
    const gate = deferred();
    gate.resolve();
    const fixture = stableHandlerFixture(gate.promise);
    const session = fixture.session as unknown as Record<string, unknown>;
    session.isIdle = true;
    const handler = createAgentHandlers(fixture.factory)["agent.abort"]!;

    const outcome = await handler({ id: "abort-idle", context: {}, params: null } as never);

    expect("error" in outcome).toBe(false);
    expect(session.clearQueue).not.toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();
  });

  it("aborts a committed operation before the SDK reports the session running", async () => {
    const gate = deferred();
    gate.resolve();
    const fixture = stableHandlerFixture(gate.promise);
    const session = fixture.session as unknown as Record<string, unknown>;
    session.isIdle = true;
    expect(fixture.sessionOperationLock.tryAcquire("in-flight-prompt")).toBe(true);
    const handler = createAgentHandlers(fixture.factory)["agent.abort"]!;

    const outcome = await handler({
      id: "abort-pre-run",
      context: {},
      params: null,
    } as never);

    expect("error" in outcome).toBe(false);
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect("result" in outcome && outcome.result).toMatchObject({
      aborted: true,
      settled: true,
    });
    fixture.sessionOperationLock.release("in-flight-prompt");
  });

  it("aborts a retained background Session without touching the foreground", async () => {
    const gate = deferred();
    gate.resolve();
    const fixture = stableHandlerFixture(gate.promise);
    const backgroundIdentity = {
      ...fixture.server.getIdentity(),
      sessionId: "44444444-4444-4444-8444-444444444444",
      sessionRevision: 3,
    };
    const backgroundSession = {
      ...fixture.session,
      sessionId: backgroundIdentity.sessionId,
      sessionFile: "C:/sessions/background.jsonl",
      sessionName: "Background",
      isIdle: false,
      abort: vi.fn(async () => {}),
      clearQueue: vi.fn(() => ({ steering: [], followUp: [] })),
      getSteeringMessages: () => [],
      getFollowUpMessages: () => [],
    } as unknown as AgentSession;
    const background = {
      sessionId: backgroundIdentity.sessionId,
      sessionRevision: backgroundIdentity.sessionRevision,
      agentSession: backgroundSession,
      sessionManager: {},
      sessionSnapshot: {
        sessionId: backgroundIdentity.sessionId,
        sessionPath: "C:/sessions/background.jsonl",
        cwd: "C:/workspace",
        revision: 3,
        isStreaming: true,
        isIdle: false,
        isCompacting: false,
        isRetrying: false,
        thinkingLevel: "off",
        autoCompactionEnabled: true,
        autoRetryEnabled: true,
        steeringMode: "all",
        followUpMode: "all",
        pending: { revision: 0, steering: [], followUp: [] },
        messages: [],
        tools: {
          revision: 1,
          workspaceId: backgroundIdentity.workspaceId,
          sessionId: backgroundIdentity.sessionId,
          sessionRevision: 3,
          tools: [],
          active: [],
        },
      },
      toolRevision: 1,
    } as unknown as BackgroundSessionRuntime;
    fixture.graph.backgroundSessions.set(backgroundIdentity.sessionId!, background);
    fixture.factory.resolveSessionTarget = vi.fn((sessionId, sessionRevision) => {
      if (
        sessionId === backgroundIdentity.sessionId &&
        sessionRevision === backgroundIdentity.sessionRevision
      ) {
        return {
          identity: backgroundIdentity,
          agentSession: backgroundSession,
          sessionManager: background.sessionManager,
          sessionSnapshot: background.sessionSnapshot,
          toolRevision: background.toolRevision,
          isActive: false,
          background,
        };
      }
      return null;
    }) as never;

    const outcome = await createAgentHandlers(fixture.factory)["agent.abort"]!({
      id: "abort-background",
      context: {
        expectedSessionId: backgroundIdentity.sessionId,
        expectedSessionRevision: backgroundIdentity.sessionRevision,
      },
      params: null,
    } as never);

    expect("error" in outcome).toBe(false);
    expect(backgroundSession.abort).toHaveBeenCalledTimes(1);
    expect(fixture.session.abort).not.toHaveBeenCalled();
    expect(fixture.graph.sessionSnapshot).toBeNull();
    expect(background.sessionSnapshot.sessionId).toBe(backgroundIdentity.sessionId);
  });
});

describe("queued image preservation", () => {
  /** Stateful fake queue so rebuilds/parks exercise real text flows. */
  function queueFixture() {
    const gate = deferred();
    gate.resolve();
    const fixture = stableHandlerFixture(gate.promise);
    const session = fixture.session as unknown as Record<string, unknown>;
    const steering: Array<{ text: string; images?: unknown }> = [];
    const followUp: Array<{ text: string; images?: unknown }> = [];
    session.steer = vi.fn(async (text: string, images?: unknown) => {
      steering.push({ text, images });
    });
    session.followUp = vi.fn(async (text: string, images?: unknown) => {
      followUp.push({ text, images });
    });
    session.getSteeringMessages = () => steering.map((entry) => entry.text);
    session.getFollowUpMessages = () => followUp.map((entry) => entry.text);
    session.clearQueue = vi.fn(() => {
      const cleared = {
        steering: steering.map((entry) => entry.text),
        followUp: followUp.map((entry) => entry.text),
      };
      steering.length = 0;
      followUp.length = 0;
      return cleared;
    });
    session.abort = vi.fn(async () => {});
    const handlers = createAgentHandlers(fixture.factory);
    return { fixture, handlers, session, steering, followUp };
  }

  const png = [{ mediaType: "image/png", data: "Zm9v" }];
  const sdkPng = [{ type: "image", mimeType: "image/png", data: "Zm9v" }];

  it("setQueue rebuild re-attaches images to reordered items", async () => {
    const { handlers, followUp } = queueFixture();
    await handlers["agent.followUp"]!({
      id: "q1",
      context: {},
      params: { text: "with image", images: png },
    } as never);
    await handlers["agent.followUp"]!({
      id: "q2",
      context: {},
      params: { text: "plain" },
    } as never);

    const outcome = await handlers["agent.setQueue"]!({
      id: "q3",
      context: {},
      params: {
        expectedRevision: 2,
        steering: [],
        followUp: ["plain", "with image"],
      },
    } as never);

    expect("error" in outcome).toBe(false);
    expect(followUp.map((entry) => entry.text)).toEqual(["plain", "with image"]);
    expect(followUp[0]!.images).toBeUndefined();
    expect(followUp[1]!.images).toEqual(sdkPng);
  });

  it("setQueue rebuild carries images across a single edit", async () => {
    const { handlers, followUp } = queueFixture();
    await handlers["agent.followUp"]!({
      id: "e1",
      context: {},
      params: { text: "original", images: png },
    } as never);

    await handlers["agent.setQueue"]!({
      id: "e2",
      context: {},
      params: { expectedRevision: 1, steering: [], followUp: ["edited"] },
    } as never);

    expect(followUp.map((entry) => entry.text)).toEqual(["edited"]);
    expect(followUp[0]!.images).toEqual(sdkPng);
  });

  it("setQueue rolls back the original queue when a re-add fails", async () => {
    const { handlers, session, followUp } = queueFixture();
    await handlers["agent.followUp"]!({
      id: "rollback-1",
      context: {},
      params: { text: "first", images: png },
    } as never);
    await handlers["agent.followUp"]!({
      id: "rollback-2",
      context: {},
      params: { text: "second" },
    } as never);
    session.followUp = vi.fn(async (text: string, images?: unknown) => {
      if (text === "broken") throw new Error("cannot enqueue broken item");
      followUp.push({ text, images });
    });

    const outcome = await handlers["agent.setQueue"]!({
      id: "rollback-3",
      context: {},
      params: {
        expectedRevision: 2,
        steering: [],
        followUp: ["second", "broken", "first"],
      },
    } as never);

    expect("error" in outcome && outcome.error.code).toBe("QUEUE_TRANSACTION_FAILED");
    expect(followUp.map((entry) => entry.text)).toEqual(["first", "second"]);
    expect(followUp[0]!.images).toEqual(sdkPng);
  });

  it("setQueue rejects a stale queue revision before clearing anything", async () => {
    const { handlers, session, followUp } = queueFixture();
    await handlers["agent.followUp"]!({
      id: "stale-1",
      context: {},
      params: { text: "current" },
    } as never);

    const outcome = await handlers["agent.setQueue"]!({
      id: "stale-2",
      context: {},
      params: {
        expectedRevision: 0,
        steering: [],
        followUp: ["replacement"],
      },
    } as never);

    expect("error" in outcome && outcome.error.code).toBe("STALE_REVISION");
    expect(session.clearQueue).not.toHaveBeenCalled();
    expect(followUp.map((entry) => entry.text)).toEqual(["current"]);
  });

  it("abort park/restore keeps images on queued items", async () => {
    const { handlers, followUp } = queueFixture();
    await handlers["agent.followUp"]!({
      id: "a1",
      context: {},
      params: { text: "queued while running", images: png },
    } as never);

    const outcome = await handlers["agent.abort"]!({
      id: "a2",
      context: {},
      params: null,
    } as never);

    expect("error" in outcome).toBe(false);
    expect(followUp.map((entry) => entry.text)).toEqual(["queued while running"]);
    expect(followUp[0]!.images).toEqual(sdkPng);
  });
});

describe("agent.runNow transaction", () => {
  it("pins the original Session while aborting and restores the remaining queue", async () => {
    const abortGate = deferred();
    const runGate = deferred();
    const fixture = stableHandlerFixture(Promise.resolve());
    const session = fixture.session as unknown as Record<string, unknown>;
    const steering = ["steer-first"];
    const followUp = ["later", "run this", "last"];
    session.getSteeringMessages = () => steering;
    session.getFollowUpMessages = () => followUp;
    session.clearQueue = vi.fn(() => {
      const cleared = { steering: [...steering], followUp: [...followUp] };
      steering.length = 0;
      followUp.length = 0;
      return cleared;
    });
    session.steer = vi.fn(async (text: string) => {
      steering.push(text);
    });
    session.followUp = vi.fn(async (text: string) => {
      followUp.push(text);
    });
    session.prompt = vi.fn(() => runGate.promise);
    expect(fixture.sessionOperationLock.tryAcquire("current-run")).toBe(true);
    session.abort = vi.fn(async () => {
      await abortGate.promise;
      session.isIdle = true;
      fixture.sessionOperationLock.release("current-run");
    });

    const handler = createAgentHandlers(fixture.factory)["agent.runNow"]!;
    const pending = handler({
      id: "run-now",
      context: {},
      params: { expectedRevision: 0, followUpIndex: 1 },
    } as never);

    await vi.waitFor(() => expect(session.abort).toHaveBeenCalledOnce());
    expect(
      fixture.serviceGraphLock.tryAcquire({
        operationKind: "session.open",
        requestId: "switch-session",
      }),
    ).toBe(false);

    abortGate.resolve();
    const outcome = await pending;

    expect("error" in outcome).toBe(false);
    if (!("result" in outcome)) return;
    expect(session.prompt).toHaveBeenCalledWith(
      "run this",
      expect.objectContaining({ streamingBehavior: undefined }),
    );
    expect(steering).toEqual(["steer-first"]);
    expect(followUp).toEqual(["later", "last"]);
    expect(outcome.result).toEqual(
      expect.objectContaining({
        started: true,
        settled: true,
        queueRestored: true,
        partialFailure: false,
        queue: {
          revision: 1,
          steering: ["steer-first"],
          followUp: ["later", "last"],
        },
      }),
    );

    runGate.resolve();
    await vi.waitFor(() => expect(fixture.sessionOperationLock.isHeld()).toBe(false));
  });

  it("reports the authoritative partial queue when restoration fails after start", async () => {
    const runGate = deferred();
    const fixture = stableHandlerFixture(Promise.resolve());
    const session = fixture.session as unknown as Record<string, unknown>;
    const followUp = ["run this", "kept", "cannot restore", "never reached"];
    session.isIdle = true;
    session.getSteeringMessages = () => [];
    session.getFollowUpMessages = () => followUp;
    session.clearQueue = vi.fn(() => {
      const cleared = { steering: [], followUp: [...followUp] };
      followUp.length = 0;
      return cleared;
    });
    session.followUp = vi.fn(async (text: string) => {
      if (text === "cannot restore") throw new Error("restore failed");
      followUp.push(text);
    });
    session.prompt = vi.fn(() => runGate.promise);

    const handler = createAgentHandlers(fixture.factory)["agent.runNow"]!;
    const outcome = await handler({
      id: "run-now-partial",
      context: {},
      params: { expectedRevision: 0, followUpIndex: 0 },
    } as never);

    expect("error" in outcome).toBe(false);
    if (!("result" in outcome)) return;
    expect(outcome.result).toEqual(
      expect.objectContaining({
        started: true,
        settled: true,
        queueRestored: false,
        partialFailure: true,
        queue: {
          revision: 1,
          steering: [],
          followUp: ["kept"],
        },
        error: expect.objectContaining({ code: "QUEUE_TRANSACTION_FAILED" }),
      }),
    );
    expect(followUp).toEqual(["kept"]);

    runGate.resolve();
    await vi.waitFor(() => expect(fixture.sessionOperationLock.isHeld()).toBe(false));
  });
});

describe("agent.compact concurrency", () => {
  function compactFixture(isIdle: boolean, compactWait = Promise.resolve()) {
    const gate = deferred();
    const fixture = stableHandlerFixture(gate.promise);
    (fixture.session as unknown as { isIdle: boolean }).isIdle = isIdle;
    (fixture.session as unknown as { compact: unknown }).compact = vi.fn(async () => {
      await compactWait;
      return { tokensBefore: 10, tokensAfter: 5 };
    });
    return { ...fixture, gate };
  }

  it("rejects while the session is streaming (not idle)", async () => {
    const fixture = compactFixture(false);
    const handler = createAgentHandlers(fixture.factory)["agent.compact"]!;

    const outcome = await handler({ id: "compact-1", context: {}, params: {} } as never);

    expect("error" in outcome && outcome.error.code).toBe("AGENT_BUSY");
    expect(
      (fixture.session as unknown as { compact: ReturnType<typeof vi.fn> }).compact,
    ).not.toHaveBeenCalled();
    expect(fixture.sessionOperationLock.isHeld()).toBe(false);
  });

  it("shares the per-session operation lock with agent.prompt", async () => {
    const fixture = compactFixture(true);
    const handler = createAgentHandlers(fixture.factory)["agent.compact"]!;

    // Simulate an in-flight prompt owning the session lock
    expect(fixture.sessionOperationLock.tryAcquire("in-flight-prompt")).toBe(true);
    const busy = await handler({ id: "compact-2", context: {}, params: {} } as never);
    expect("error" in busy && busy.error.code).toBe("AGENT_BUSY");
    expect(
      (fixture.session as unknown as { compact: ReturnType<typeof vi.fn> }).compact,
    ).not.toHaveBeenCalled();

    // After the prompt releases, compact acquires and releases the same lock
    fixture.sessionOperationLock.release("in-flight-prompt");
    const outcome = await handler({ id: "compact-3", context: {}, params: {} } as never);
    expect("error" in outcome).toBe(false);
    expect(
      (fixture.session as unknown as { compact: ReturnType<typeof vi.fn> }).compact,
    ).toHaveBeenCalledTimes(1);
    expect(fixture.sessionOperationLock.isHeld()).toBe(false);
  });

  it("keeps delayed completion bound to the compacted session after replacement", async () => {
    const compactGate = deferred();
    const fixture = compactFixture(true, compactGate.promise);
    const handler = createAgentHandlers(fixture.factory)["agent.compact"]!;
    const originalIdentity = fixture.server.getIdentity();
    const replacementSessionId = "55555555-5555-4555-8555-555555555555";

    const pending = handler({
      id: "compact-replaced",
      context: {},
      params: {},
    } as never);
    await vi.waitFor(() => {
      expect(
        (fixture.session as unknown as { compact: ReturnType<typeof vi.fn> }).compact,
      ).toHaveBeenCalledTimes(1);
    });

    const replacementSession = {
      ...(fixture.session as unknown as Record<string, unknown>),
      sessionId: replacementSessionId,
      sessionFile: `C:/sessions/${replacementSessionId}.jsonl`,
      sessionName: "Replacement",
    } as unknown as AgentSession;
    const replacementSnapshot = {
      sessionId: replacementSessionId,
      revision: 2,
    };
    Reflect.set(fixture.graph, "agentSession", replacementSession);
    Reflect.set(fixture.graph, "sessionManager", { replacement: true });
    Reflect.set(fixture.graph, "sessionSnapshot", replacementSnapshot);
    fixture.server.identity.sessionId = replacementSessionId;
    fixture.server.identity.sessionRevision = 2;

    compactGate.resolve();
    const outcome = await pending;

    expect("error" in outcome).toBe(false);
    expect(outcome.identity).toEqual(originalIdentity);
    expect(fixture.graph.sessionSnapshot).toBe(replacementSnapshot);
    expect("result" in outcome && outcome.result).toMatchObject({
      session: {
        sessionId: originalIdentity.sessionId,
        revision: originalIdentity.sessionRevision,
      },
    });
  });

  it("updates the originating background runtime after a delayed compact", async () => {
    const compactGate = deferred();
    const fixture = compactFixture(true, compactGate.promise);
    const handler = createAgentHandlers(fixture.factory)["agent.compact"]!;
    const originalIdentity = fixture.server.getIdentity();
    const originalSnapshot = {
      sessionId: originalIdentity.sessionId!,
      sessionPath: fixture.session.sessionFile!,
      revision: originalIdentity.sessionRevision,
    } as BackgroundSessionRuntime["sessionSnapshot"];

    const pending = handler({
      id: "compact-background",
      context: {},
      params: {},
    } as never);
    await vi.waitFor(() => {
      expect(
        (fixture.session as unknown as { compact: ReturnType<typeof vi.fn> }).compact,
      ).toHaveBeenCalledTimes(1);
    });

    const background = {
      sessionId: originalIdentity.sessionId!,
      sessionRevision: originalIdentity.sessionRevision,
      sessionManager: fixture.graph.sessionManager,
      agentSession: fixture.session,
      resourceLoader: {},
      extensionsResult: null,
      toolRevision: fixture.graph.toolRevision,
      sessionSnapshot: originalSnapshot,
      unsubscribeAgent: null,
      extensionUiActivate: null,
      extensionUiCleanup: null,
      extensionUiUpdateIdentity: null,
    } as BackgroundSessionRuntime;
    fixture.graph.backgroundSessions.set(background.sessionId, background);

    const replacementSessionId = "66666666-6666-4666-8666-666666666666";
    const replacementSession = {
      ...(fixture.session as unknown as Record<string, unknown>),
      sessionId: replacementSessionId,
      sessionFile: `C:/sessions/${replacementSessionId}.jsonl`,
      sessionName: "Replacement",
    } as unknown as AgentSession;
    const replacementSnapshot = {
      sessionId: replacementSessionId,
      revision: 2,
    };
    Reflect.set(fixture.graph, "agentSession", replacementSession);
    Reflect.set(fixture.graph, "sessionManager", { replacement: true });
    Reflect.set(fixture.graph, "sessionSnapshot", replacementSnapshot);
    fixture.server.identity.sessionId = replacementSessionId;
    fixture.server.identity.sessionRevision = 2;

    compactGate.resolve();
    const outcome = await pending;

    expect("error" in outcome).toBe(false);
    expect(outcome.identity).toEqual(originalIdentity);
    expect(fixture.graph.sessionSnapshot).toBe(replacementSnapshot);
    expect(background.sessionSnapshot).not.toBe(originalSnapshot);
    expect(background.sessionSnapshot).toMatchObject({
      sessionId: originalIdentity.sessionId,
      revision: originalIdentity.sessionRevision,
    });
    await vi.waitFor(() => {
      expect(fixture.factory.disposeSettledBackgroundRuntime).toHaveBeenCalledWith(
        fixture.graph,
        background,
      );
    });
  });
});

describe("agent.prompt fromEntryId", () => {
  it("navigates the current session then prompts without a second lock handoff", async () => {
    const fixture = stableHandlerFixture(Promise.resolve());
    (fixture.session as unknown as { isIdle: boolean }).isIdle = true;
    const navigateTree = vi.fn(async () => ({ cancelled: false }));
    (fixture.session as unknown as { navigateTree: unknown }).navigateTree = navigateTree;
    const handler = createAgentHandlers(fixture.factory)["agent.prompt"]!;

    const outcome = await handler({
      id: "prompt-from-entry",
      context: {},
      params: { text: "ask again", fromEntryId: "u1" },
    } as never);

    expect("error" in outcome).toBe(false);
    if (!("result" in outcome)) return;
    expect(navigateTree).toHaveBeenCalledExactlyOnceWith("u1", { summarize: false });
    await vi.waitFor(() => {
      expect(fixture.session.prompt).toHaveBeenCalled();
    });
    const result = outcome.result as {
      accepted: true;
      runId: string;
      session?: { leafId?: string };
    };
    expect(result.accepted).toBe(true);
    expect(result.session).toBeTruthy();
  });

  it("does not prompt when the tree navigation is cancelled", async () => {
    const fixture = stableHandlerFixture(Promise.resolve());
    (fixture.session as unknown as { isIdle: boolean }).isIdle = true;
    const navigateTree = vi.fn(async () => ({ cancelled: true }));
    (fixture.session as unknown as { navigateTree: unknown }).navigateTree = navigateTree;
    const handler = createAgentHandlers(fixture.factory)["agent.prompt"]!;

    const outcome = await handler({
      id: "prompt-from-entry-cancel",
      context: {},
      params: { text: "ask again", fromEntryId: "u1" },
    } as never);

    expect("error" in outcome && outcome.error.code).toBe("INVALID_REQUEST");
    expect(fixture.session.prompt).not.toHaveBeenCalled();
    expect(fixture.sessionOperationLock.isHeld()).toBe(false);
  });

  it("validates attachments before navigating fromEntryId", async () => {
    const fixture = stableHandlerFixture(Promise.resolve());
    (fixture.session as unknown as { isIdle: boolean }).isIdle = true;
    const navigateTree = vi.fn(async () => ({ cancelled: false }));
    (fixture.session as unknown as { navigateTree: unknown }).navigateTree = navigateTree;
    const prepareForPrompt = vi
      .fn()
      .mockRejectedValue(new AttachmentStoreError("not_ready", "manual.pdf is not ready"));
    (fixture.factory as unknown as { deps: unknown }).deps = {
      attachmentStore: { prepareForPrompt, commitToSession: vi.fn() },
    };
    const handler = createAgentHandlers(fixture.factory)["agent.prompt"]!;

    const outcome = await handler({
      id: "prompt-from-entry-attachment",
      context: {},
      params: {
        text: "",
        fromEntryId: "u1",
        attachmentIds: ["11111111-1111-4111-8111-111111111111"],
      },
    } as never);

    expect("error" in outcome && outcome.error.code).toBe("INVALID_REQUEST");
    expect(prepareForPrompt).toHaveBeenCalled();
    expect(navigateTree).not.toHaveBeenCalled();
    expect(fixture.session.prompt).not.toHaveBeenCalled();
    expect(fixture.sessionOperationLock.isHeld()).toBe(false);
  });

  it("refuses fromEntryId while the session is not idle", async () => {
    const fixture = stableHandlerFixture(Promise.resolve());
    const navigateTree = vi.fn(async () => ({ cancelled: false }));
    (fixture.session as unknown as { navigateTree: unknown }).navigateTree = navigateTree;
    const handler = createAgentHandlers(fixture.factory)["agent.prompt"]!;

    const outcome = await handler({
      id: "prompt-from-entry-busy",
      context: {},
      params: { text: "ask again", fromEntryId: "u1" },
    } as never);

    expect("error" in outcome && outcome.error.code).toBe("AGENT_BUSY");
    expect(navigateTree).not.toHaveBeenCalled();
    expect(fixture.session.prompt).not.toHaveBeenCalled();
  });

  it("releases the session operation lock when fromEntryId is missing", async () => {
    const fixture = stableHandlerFixture(Promise.resolve());
    (fixture.session as unknown as { isIdle: boolean }).isIdle = true;
    const navigateTree = vi.fn(async () => {
      throw new Error("Entry not found: stale-id");
    });
    (fixture.session as unknown as { navigateTree: unknown }).navigateTree = navigateTree;
    const handler = createAgentHandlers(fixture.factory)["agent.prompt"]!;

    const outcome = await handler({
      id: "prompt-from-entry-missing",
      context: {},
      params: { text: "ask again", fromEntryId: "stale-id" },
    } as never);

    expect("error" in outcome && outcome.error.code).toBe("INVALID_REQUEST");
    expect(fixture.session.prompt).not.toHaveBeenCalled();
    expect(fixture.sessionOperationLock.isHeld()).toBe(false);
    expect(fixture.sessionOperationLock.tryAcquire("next-prompt")).toBe(true);
    fixture.sessionOperationLock.release("next-prompt");

    const retry = await handler({
      id: "prompt-after-invalid-entry",
      context: {},
      params: { text: "retry" },
    } as never);
    expect("error" in retry).toBe(false);
    await vi.waitFor(() => {
      expect(fixture.session.prompt).toHaveBeenCalled();
    });
  });

  it("keeps navigate, prompt, and attachments on the session that acquired the lock", async () => {
    const gate = deferred();
    const fixture = stableHandlerFixture(Promise.resolve());
    (fixture.session as unknown as { isIdle: boolean }).isIdle = true;
    const originalNavigate = vi.fn(async () => ({ cancelled: false }));
    (fixture.session as unknown as { navigateTree: unknown }).navigateTree = originalNavigate;

    const replacementLock = new AgentOperationLock();
    const replacement = {
      prompt: vi.fn(async () => {}),
      navigateTree: vi.fn(async () => ({ cancelled: false })),
      isIdle: true,
      sessionId: "44444444-4444-4444-8444-444444444444",
      sessionFile: "C:/sessions/replacement.jsonl",
      sessionName: "Replacement",
      model: undefined,
      messages: [],
      getSteeringMessages: () => [],
      getFollowUpMessages: () => [],
      getAllTools: () => [],
      getActiveToolNames: () => [],
      getAvailableThinkingLevels: () => ["off"],
      extensionRunner: { getCommand: () => undefined },
    } as unknown as AgentSession;

    const originalLock = fixture.sessionOperationLock;
    fixture.factory.getSessionOperationLock = (target) =>
      target === fixture.session ? originalLock : replacementLock;

    const prepareForPrompt = vi.fn(async (ids: string[]) => {
      await gate.promise;
      return [
        {
          id: ids[0],
          name: "manual.pdf",
          mediaType: "application/pdf",
          sizeBytes: 1024,
          status: "ready",
          unit: "page",
          unitCount: 3,
        },
      ];
    });
    const commitToSession = vi.fn().mockResolvedValue(undefined);
    (fixture.factory as unknown as { deps: unknown }).deps = {
      attachmentStore: { prepareForPrompt, commitToSession },
    };

    const handler = createAgentHandlers(fixture.factory)["agent.prompt"]!;
    const pending = handler({
      id: "prompt-from-entry-swap",
      context: {},
      params: {
        text: "ask again",
        fromEntryId: "u1",
        attachmentIds: ["11111111-1111-4111-8111-111111111111"],
      },
    } as never);

    await vi.waitFor(() => {
      expect(prepareForPrompt).toHaveBeenCalledWith(
        ["11111111-1111-4111-8111-111111111111"],
        "33333333-3333-4333-8333-333333333333",
      );
    });

    const originalIdentity = fixture.server.getIdentity();
    const originalSnapshot = {
      sessionId: originalIdentity.sessionId!,
      sessionPath: fixture.session.sessionFile!,
      revision: originalIdentity.sessionRevision,
    } as BackgroundSessionRuntime["sessionSnapshot"];
    const background = {
      sessionId: originalIdentity.sessionId!,
      sessionRevision: originalIdentity.sessionRevision,
      sessionManager: fixture.graph.sessionManager,
      agentSession: fixture.session,
      resourceLoader: {},
      extensionsResult: null,
      toolRevision: fixture.graph.toolRevision,
      sessionSnapshot: originalSnapshot,
      unsubscribeAgent: null,
      extensionUiActivate: null,
      extensionUiCleanup: null,
      extensionUiUpdateIdentity: null,
    } as BackgroundSessionRuntime;
    fixture.graph.backgroundSessions.set(background.sessionId, background);

    const replacementSnapshot = {
      sessionId: replacement.sessionId,
      revision: 2,
    };
    fixture.graph.agentSession = replacement;
    Reflect.set(fixture.graph, "sessionSnapshot", replacementSnapshot);
    fixture.server.identity.sessionId = replacement.sessionId;
    fixture.server.identity.sessionRevision = 2;

    gate.resolve();
    const outcome = await pending;

    expect("error" in outcome).toBe(false);
    expect(outcome.identity).toEqual(originalIdentity);
    expect(fixture.graph.sessionSnapshot).toBe(replacementSnapshot);
    expect(background.sessionSnapshot).not.toBe(originalSnapshot);
    expect(background.sessionSnapshot).toMatchObject({
      sessionId: originalIdentity.sessionId,
      revision: originalIdentity.sessionRevision,
    });
    expect(originalNavigate).toHaveBeenCalledExactlyOnceWith("u1", { summarize: false });
    expect(replacement.navigateTree).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(fixture.session.prompt).toHaveBeenCalled();
    });
    expect(replacement.prompt).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(commitToSession).toHaveBeenCalledWith(
        ["11111111-1111-4111-8111-111111111111"],
        "33333333-3333-4333-8333-333333333333",
      );
    });
    expect(replacementLock.isHeld()).toBe(false);
  });

  it("does not write the current graph when the originating workspace is gone", async () => {
    const gate = deferred();
    const fixture = stableHandlerFixture(Promise.resolve());
    (fixture.session as unknown as { isIdle: boolean }).isIdle = true;
    (fixture.session as unknown as { navigateTree: unknown }).navigateTree = vi.fn(async () => ({
      cancelled: false,
    }));
    const prepareForPrompt = vi.fn(async (ids: string[]) => {
      await gate.promise;
      return [
        {
          id: ids[0],
          name: "manual.pdf",
          mediaType: "application/pdf",
          sizeBytes: 1024,
          status: "ready",
          unit: "page",
          unitCount: 3,
        },
      ];
    });
    (fixture.factory as unknown as { deps: unknown }).deps = {
      attachmentStore: { prepareForPrompt, commitToSession: vi.fn().mockResolvedValue(undefined) },
    };

    const originalIdentity = fixture.server.getIdentity();
    const replacementSnapshot = { sessionId: "workspace-b", revision: 9 };
    const otherGraph = {
      agentSession: {},
      sessionSnapshot: replacementSnapshot,
      backgroundSessions: new Map(),
    };
    const handler = createAgentHandlers(fixture.factory)["agent.prompt"]!;
    const pending = handler({
      id: "prompt-from-entry-workspace-gone",
      context: {},
      params: {
        text: "ask again",
        fromEntryId: "u1",
        attachmentIds: ["11111111-1111-4111-8111-111111111111"],
      },
    } as never);

    await vi.waitFor(() => {
      expect(prepareForPrompt).toHaveBeenCalled();
    });
    fixture.factory.getGraph = () => otherGraph as never;
    Reflect.set(fixture.graph, "sessionSnapshot", { sessionId: originalIdentity.sessionId });
    gate.resolve();
    const outcome = await pending;

    expect("error" in outcome).toBe(false);
    expect(outcome.identity).toEqual(originalIdentity);
    expect(otherGraph.sessionSnapshot).toBe(replacementSnapshot);
    expect(fixture.graph.sessionSnapshot).toEqual({ sessionId: originalIdentity.sessionId });
  });
});

describe("agent.navigateTree", () => {
  function navigateFixture(isIdle: boolean) {
    const gate = deferred();
    const fixture = stableHandlerFixture(gate.promise);
    (fixture.session as unknown as { isIdle: boolean }).isIdle = isIdle;
    (fixture.session as unknown as { navigateTree: unknown }).navigateTree = vi.fn(async () => ({
      cancelled: false,
      editorText: "picked user text",
    }));
    return { ...fixture, gate };
  }

  function navigateMock(fixture: ReturnType<typeof navigateFixture>) {
    return (fixture.session as unknown as { navigateTree: ReturnType<typeof vi.fn> }).navigateTree;
  }

  it("rejects while the session is busy", async () => {
    const fixture = navigateFixture(false);
    const handler = createAgentHandlers(fixture.factory)["agent.navigateTree"]!;

    const outcome = await handler({
      id: "navigate-1",
      context: {},
      params: { targetId: "entry-1" },
    } as never);

    expect("error" in outcome && outcome.error.code).toBe("AGENT_BUSY");
    expect(navigateMock(fixture)).not.toHaveBeenCalled();
    expect(fixture.sessionOperationLock.isHeld()).toBe(false);
  });

  it("navigates without summarization and returns the rebuilt snapshot", async () => {
    const fixture = navigateFixture(true);
    const handler = createAgentHandlers(fixture.factory)["agent.navigateTree"]!;

    const outcome = await handler({
      id: "navigate-2",
      context: {},
      params: { targetId: "entry-1" },
    } as never);

    expect("error" in outcome).toBe(false);
    if (!("result" in outcome)) return;
    expect(navigateMock(fixture)).toHaveBeenCalledExactlyOnceWith("entry-1", {
      summarize: false,
    });
    const result = outcome.result as {
      session: unknown;
      cancelled: boolean;
      editorText?: string;
    };
    expect(result.cancelled).toBe(false);
    expect(result.editorText).toBe("picked user text");
    expect(result.session).toBeTruthy();
    expect(fixture.sessionOperationLock.isHeld()).toBe(false);
  });

  it("shares the per-session operation lock with agent.prompt", async () => {
    const fixture = navigateFixture(true);
    const handler = createAgentHandlers(fixture.factory)["agent.navigateTree"]!;

    expect(fixture.sessionOperationLock.tryAcquire("in-flight-prompt")).toBe(true);
    const busy = await handler({
      id: "navigate-3",
      context: {},
      params: { targetId: "entry-1" },
    } as never);
    expect("error" in busy && busy.error.code).toBe("AGENT_BUSY");
    expect(navigateMock(fixture)).not.toHaveBeenCalled();
    fixture.sessionOperationLock.release("in-flight-prompt");
  });
});
