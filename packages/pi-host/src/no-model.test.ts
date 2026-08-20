import { describe, expect, it, vi } from "vitest";
import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { SessionSnapshot } from "@pideck/protocol";
import {
  PIDECK_NO_MODEL,
  clearSessionModel,
  isPideckNoModel,
  publishIdleActiveSessionSnapshot,
} from "./no-model.js";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";
import type { WorkspaceGraph } from "./workspace-graph-types.js";

const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

function model(provider: string, id: string): Model<Api> {
  return {
    ...PIDECK_NO_MODEL,
    provider,
    id,
    name: id,
  };
}

function sessionFixture(current: Model<Api>): {
  session: AgentSession;
  emit: ReturnType<typeof vi.fn>;
  setThinkingLevel: ReturnType<typeof vi.fn>;
} {
  const state = { model: current };
  const runtime = { thinkingLevel: "medium" };
  const emit = vi.fn(async () => undefined);
  const setThinkingLevel = vi.fn((level: string) => {
    runtime.thinkingLevel = level;
  });
  const session = {
    isIdle: true,
    isCompacting: false,
    isRetrying: false,
    messages: [],
    get thinkingLevel() {
      return runtime.thinkingLevel;
    },
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    steeringMode: "all",
    followUpMode: "all",
    get model() {
      return state.model;
    },
    agent: { state },
    setThinkingLevel,
    extensionRunner: { emit },
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    getAllTools: () => [],
    getActiveToolNames: () => [],
  } as unknown as AgentSession;
  return { session, emit, setThinkingLevel };
}

describe("no-model sentinel", () => {
  it("recognizes the unknown/unknown sentinel", () => {
    expect(isPideckNoModel(PIDECK_NO_MODEL)).toBe(true);
    expect(isPideckNoModel({ provider: "anthropic", id: "claude" })).toBe(false);
    expect(isPideckNoModel(undefined)).toBe(false);
  });

  it("writes the sentinel, turns thinking off, and emits model_select", async () => {
    const previous = model("custom", "primary");
    const { session, emit, setThinkingLevel } = sessionFixture(previous);
    await clearSessionModel(session);
    expect(session.model).toBe(PIDECK_NO_MODEL);
    expect(setThinkingLevel).toHaveBeenCalledWith("off");
    expect(emit).toHaveBeenCalledWith({
      type: "model_select",
      model: PIDECK_NO_MODEL,
      previousModel: previous,
      source: "set",
    });
  });

  it("does not re-emit model_select when the session is already the sentinel", async () => {
    const { session, emit } = sessionFixture(PIDECK_NO_MODEL);
    await clearSessionModel(session);
    expect(emit).not.toHaveBeenCalled();
  });

  it("rebuilds graph.sessionSnapshot and emits session.snapshot without bumping revision", async () => {
    const { session } = sessionFixture(model("custom", "primary"));
    await clearSessionModel(session);
    const emit = vi.fn();
    const current = {
      sessionId: SESSION_ID,
      revision: 7,
    } as SessionSnapshot;
    const graph = {
      agentSession: session,
      sessionManager: {} as SessionManager,
      sessionSnapshot: current,
      canonicalCwd: "C:/workspace",
      workspaceId: WORKSPACE_ID,
      toolRevision: 1,
    } as WorkspaceGraph;
    const factory = {
      getGraph: () => graph,
      server: { emit },
    } as unknown as WorkspaceGraphFactory;

    publishIdleActiveSessionSnapshot(factory);

    expect(graph.sessionSnapshot).not.toBe(current);
    expect(graph.sessionSnapshot?.revision).toBe(7);
    expect(graph.sessionSnapshot?.sessionId).toBe(SESSION_ID);
    expect(graph.sessionSnapshot?.model).toMatchObject({
      provider: "unknown",
      modelId: "unknown",
    });
    expect(graph.sessionSnapshot?.thinkingLevel).toBe("off");
    expect(emit).toHaveBeenCalledWith("session.snapshot", graph.sessionSnapshot);
  });

  it("is a no-op without a complete graph", () => {
    const emit = vi.fn();
    const factory = {
      getGraph: () => null,
      server: { emit },
    } as unknown as WorkspaceGraphFactory;
    publishIdleActiveSessionSnapshot(factory);
    expect(emit).not.toHaveBeenCalled();
  });
});
