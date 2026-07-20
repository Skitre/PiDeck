import { describe, expect, it, vi } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createAgentHandlers, summarizeModel } from "./agent-controller.js";
import { AgentOperationLock, TryMutex } from "./locks.js";
import type { PiHostServer } from "./server.js";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";

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
    expect(summarizeModel(model({ id: "grok-composer-2.5-fast" })).thinkingLevels).toEqual([
      "off",
    ]);
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
  } as unknown as AgentSession;
  const graph = {
    agentSession: session,
    sessionManager: {},
    sessionSnapshot: null,
    canonicalCwd: "C:/workspace",
    workspaceId: identity.workspaceId,
    toolRevision: 1,
  };
  const serviceGraphLock = new TryMutex();
  const sessionOperationLock = new AgentOperationLock();
  const server = {
    identity,
    serviceGraphLock,
    emit: vi.fn(),
    getIdentity: () => identity.snapshot(),
  } as unknown as PiHostServer;
  const factory = {
    checkIdentity: () => null,
    getGraph: () => graph,
    getServer: () => server,
    getSessionOperationLock: () => sessionOperationLock,
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
});

describe("agent.abort with queued messages", () => {
  it("parks the queue before aborting and restores it after, so the chain stops", async () => {
    const gate = deferred();
    gate.resolve();
    const fixture = stableHandlerFixture(gate.promise);
    const session = fixture.session as unknown as Record<string, unknown>;
    const order: string[] = [];
    session.clearQueue = vi.fn(() => {
      order.push("clearQueue");
      return { steering: ["s1"], followUp: ["f1", "f2"] };
    });
    session.abort = vi.fn(async () => {
      order.push("abort");
    });
    session.steer = vi.fn(async (text: string) => {
      order.push(`steer:${text}`);
    });
    session.followUp = vi.fn(async (text: string) => {
      order.push(`followUp:${text}`);
    });
    const handler = createAgentHandlers(fixture.factory)["agent.abort"]!;

    const outcome = await handler({ id: "abort-queued", context: {}, params: null } as never);

    expect("error" in outcome).toBe(false);
    // Queue must be cleared BEFORE abort (the SDK auto-runs the next queued
    // follow-up when a run ends) and re-added afterwards in original order.
    expect(order).toEqual([
      "clearQueue",
      "abort",
      "steer:s1",
      "followUp:f1",
      "followUp:f2",
    ]);
    expect(fixture.server.emit).toHaveBeenCalledWith("agent.queueChanged", {
      steering: ["steer"],
      followUp: ["follow-up"],
    });
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
});

describe("agent.compact concurrency", () => {
  function compactFixture(isIdle: boolean) {
    const gate = deferred();
    const fixture = stableHandlerFixture(gate.promise);
    (fixture.session as unknown as { isIdle: boolean }).isIdle = isIdle;
    (fixture.session as unknown as { compact: unknown }).compact = vi.fn(
      async () => ({ tokensBefore: 10, tokensAfter: 5 }),
    );
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
});
