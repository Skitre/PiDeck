import { describe, expect, it } from "vitest";
import { HOST_METHODS, METHOD_CONTEXT_SCOPE } from "./methods.js";
import {
  isJsonValue,
  parseHostEvent,
  parseHostRequest,
  parseHostResponse,
  toJsonValue,
  validateEventPayload,
  validateMethodContext,
  validateSerializableAgentToolResult,
  validateSuccessResult,
} from "./validate.js";

const REQUEST_ID = "00000000-0000-4000-8000-000000000001";
const HOST_ID = "00000000-0000-4000-8000-000000000002";
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000003";
const SESSION_ID = "00000000-0000-4000-8000-000000000004";
const EXTENSION_REQUEST_ID = "00000000-0000-4000-8000-000000000005";
const RUN_ID = "00000000-0000-4000-8000-000000000006";

const hostStatus = {
  protocolVersion: 1,
  hostInstanceId: HOST_ID,
  workspaceId: WORKSPACE_ID,
  workspaceRevision: 1,
  sessionId: SESSION_ID,
  sessionRevision: 1,
  packageRevision: 0,
  sdkVersion: "0.80.7",
  nodeVersion: "v24.18.0",
  agentDir: "C:/agent",
  phase: "ready",
  capabilities: {
    packageUpdateCheck: false,
    extensionUi: true,
    projectTrust: true,
    sessionExport: false,
  },
  modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
} as const;

describe("METHOD_CONTEXT_SCOPE coverage", () => {
  it("covers every HostMethod exactly once", () => {
    const keys = Object.keys(METHOD_CONTEXT_SCOPE);
    expect(keys.sort()).toEqual([...HOST_METHODS].sort());
  });
});

describe("parseHostRequest", () => {
  it("accepts system.hello with empty context", () => {
    const result = parseHostRequest({
      protocolVersion: 1,
      id: REQUEST_ID,
      method: "system.hello",
      context: {},
      params: {
        clientName: "test",
        clientVersion: "0.1.0",
        protocolVersion: 1,
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.method).toBe("system.hello");
    }
  });

  it("rejects unknown method", () => {
    const result = parseHostRequest({
      protocolVersion: 1,
      id: REQUEST_ID,
      method: "not.a.method",
      context: {},
      params: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("UNSUPPORTED_METHOD");
    }
  });

  it("requires expectedHostInstanceId for system.getStatus", () => {
    const result = parseHostRequest({
      protocolVersion: 1,
      id: REQUEST_ID,
      method: "system.getStatus",
      context: {},
      params: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_REQUEST");
    }
  });

  it("rejects extra context fields", () => {
    const result = validateMethodContext("system.getStatus", {
      expectedHostInstanceId: HOST_ID,
      unexpected: true,
    });
    expect(result.ok).toBe(false);
  });

  it("requires expectedToolRevision for agent.setActiveTools", () => {
    const result = validateMethodContext("agent.setActiveTools", {
      expectedHostInstanceId: HOST_ID,
      expectedWorkspaceId: WORKSPACE_ID,
      expectedWorkspaceRevision: 1,
      expectedSessionId: SESSION_ID,
      expectedSessionRevision: 1,
    });
    expect(result.ok).toBe(false);
  });

  it("accepts full tool mutation context", () => {
    const result = validateMethodContext("agent.setActiveTools", {
      expectedHostInstanceId: HOST_ID,
      expectedWorkspaceId: WORKSPACE_ID,
      expectedWorkspaceRevision: 1,
      expectedSessionId: SESSION_ID,
      expectedSessionRevision: 1,
      expectedToolRevision: 2,
    });
    expect(result.ok).toBe(true);
  });

  it("requires params null for system.getStatus", () => {
    const result = parseHostRequest({
      protocolVersion: 1,
      id: REQUEST_ID,
      method: "system.getStatus",
      context: { expectedHostInstanceId: HOST_ID },
      params: {},
    });
    expect(result.ok).toBe(false);
  });
});

describe("SerializableAgentToolResult", () => {
  it("preserves addedToolNames and terminate", () => {
    const result = validateSerializableAgentToolResult({
      content: [{ type: "text", text: "ok" }],
      details: { x: 1 },
      addedToolNames: ["dynamic_tool"],
      terminate: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.addedToolNames).toEqual(["dynamic_tool"]);
      expect(result.value.terminate).toBe(false);
    }
  });

  it("rejects non-JSON details", () => {
    const result = validateSerializableAgentToolResult({
      content: [],
      details: () => {},
    });
    expect(result.ok).toBe(false);
  });

  it.each([
    ["non-object part", ["text"]],
    ["missing type", [{ text: "ok" }]],
    ["non-string type", [{ type: 1, text: "ok" }]],
    ["non-string text", [{ type: "text", text: 123 }]],
    ["non-JSON extension field", [{ type: "text", metadata: () => {} }]],
  ])("rejects %s in content", (_label, content) => {
    const result = validateSerializableAgentToolResult({ content, details: null });
    expect(result.ok).toBe(false);
  });
});

describe("deep result/event validation (C3)", () => {
  const identity = {
    hostInstanceId: HOST_ID,
    workspaceId: WORKSPACE_ID as string | null,
    workspaceRevision: 1,
    sessionId: SESSION_ID as string | null,
    sessionRevision: 1,
    packageRevision: 0,
  };

  const session = {
    sessionId: SESSION_ID,
    cwd: "C:/workspace",
    revision: 1,
    isStreaming: false,
    isIdle: true,
    isCompacting: false,
    isRetrying: false,
    thinkingLevel: "off",
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    steeringMode: "all",
    followUpMode: "all",
    pending: { steering: [], followUp: [] },
    messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
    tools: {
      revision: 1,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      sessionRevision: 1,
      tools: [],
      active: [],
    },
  };

  it("validateSuccessResult accepts system.shutdown", () => {
    const r = validateSuccessResult("system.shutdown", { accepted: true });
    expect(r.ok).toBe(true);
  });

  it("validateSuccessResult rejects shutdown without accepted", () => {
    const r = validateSuccessResult("system.shutdown", { accepted: false });
    expect(r.ok).toBe(false);
  });

  it("validates nested agent content fields in SessionSnapshot results", () => {
    expect(validateSuccessResult("agent.abort", { aborted: false, session }).ok).toBe(true);
    expect(
      validateSuccessResult("agent.abort", {
        aborted: false,
        session: {
          ...session,
          messages: [{ role: "assistant", content: [{ type: "text", text: 123 }] }],
        },
      }).ok,
    ).toBe(false);
  });

  it.each([
    ["summary", { summary: 42 }],
    ["tokensBefore", { tokensBefore: "100" }],
    ["tokensAfter", { tokensAfter: Number.NaN }],
    ["extension field", { providerData: undefined, nested: () => {} }],
  ])("rejects malformed agent.compact %s", (_label, compactResult) => {
    expect(
      validateSuccessResult("agent.compact", { result: compactResult, session }).ok,
    ).toBe(false);
  });

  it("accepts a typed compaction result with JSON extension fields", () => {
    expect(
      validateSuccessResult("agent.compact", {
        result: {
          summary: "condensed",
          tokensBefore: 200,
          tokensAfter: 80,
          providerData: { cached: true },
        },
        session,
      }).ok,
    ).toBe(true);
  });

  it.each([
    { active: false, result: { summary: 42 } },
    { active: false, result: { tokensBefore: "100" } },
    { active: false, result: { tokensAfter: Number.POSITIVE_INFINITY } },
    { active: false, result: { metadata: () => {} } },
  ])("rejects malformed agent.compactionChanged payload %#", (payload) => {
    expect(validateEventPayload("agent.compactionChanged", payload).ok).toBe(false);
  });

  it.each([
    { runId: RUN_ID, event: { type: 1 } },
    { runId: RUN_ID, event: { type: "message", value: Number.NaN } },
    { runId: RUN_ID, event: { type: "message", callback: () => {} } },
  ])("rejects malformed agent.event payload %#", (payload) => {
    expect(validateEventPayload("agent.event", payload).ok).toBe(false);
  });

  it("accepts undefined optional extension fields in agent events", () => {
    expect(
      validateEventPayload("agent.event", {
        runId: RUN_ID,
        event: { type: "message", optionalMetadata: undefined },
      }).ok,
    ).toBe(true);
  });

  it("validates optional Session runtime metadata in session.list", () => {
    const valid = validateSuccessResult("session.list", {
      workspaceId: WORKSPACE_ID,
      items: [
        {
          sessionId: SESSION_ID,
          sessionPath: "C:/sessions/session.jsonl",
          cwd: "C:/workspace",
          updatedAt: 1,
          archived: true,
          runtimeState: "running",
          sessionRevision: 3,
        },
      ],
    });
    expect(valid.ok).toBe(true);

    const invalidState = validateSuccessResult("session.list", {
      workspaceId: WORKSPACE_ID,
      items: [
        {
          sessionId: SESSION_ID,
          sessionPath: "C:/sessions/session.jsonl",
          cwd: "C:/workspace",
          updatedAt: 1,
          runtimeState: "sleeping",
          sessionRevision: 3,
        },
      ],
    });
    expect(invalidState.ok).toBe(false);

    const invalidRevision = validateSuccessResult("session.list", {
      workspaceId: WORKSPACE_ID,
      items: [
        {
          sessionId: SESSION_ID,
          sessionPath: "C:/sessions/session.jsonl",
          cwd: "C:/workspace",
          updatedAt: 1,
          runtimeState: "idle",
          sessionRevision: -1,
        },
      ],
    });
    expect(invalidRevision.ok).toBe(false);

    const invalidArchived = validateSuccessResult("session.list", {
      workspaceId: WORKSPACE_ID,
      items: [
        {
          sessionId: SESSION_ID,
          sessionPath: "C:/sessions/session.jsonl",
          cwd: "C:/workspace",
          updatedAt: 1,
          archived: "yes",
        },
      ],
    });
    expect(invalidArchived.ok).toBe(false);
  });

  it("parseHostResponse deep-fails wrong result shape", () => {
    const r = parseHostResponse({
      protocolVersion: 1,
      id: REQUEST_ID,
      method: "system.shutdown",
      ok: true,
      result: { accepted: false },
      ...identity,
    });
    expect(r.ok).toBe(false);
  });

  it("parseHostResponse accepts valid shutdown", () => {
    const r = parseHostResponse({
      protocolVersion: 1,
      id: REQUEST_ID,
      method: "system.shutdown",
      ok: true,
      result: { accepted: true },
      ...identity,
    });
    expect(r.ok).toBe(true);
  });

  it("validateEventPayload requires extensionUi.requestId", () => {
    expect(validateEventPayload("extensionUi.request", {}).ok).toBe(false);
    expect(
      validateEventPayload("extensionUi.request", {
        requestId: EXTENSION_REQUEST_ID,
        kind: "select",
      }).ok,
    ).toBe(true);
  });

  it("parseHostEvent rejects bad host.fatal", () => {
    const r = parseHostEvent({
      protocolVersion: 1,
      event: "host.fatal",
      sequence: 1,
      timestamp: Date.now(),
      payload: {},
      ...identity,
    });
    expect(r.ok).toBe(false);
  });

  it("parseHostEvent accepts host.ready with phase", () => {
    const r = parseHostEvent({
      protocolVersion: 1,
      event: "host.ready",
      sequence: 1,
      timestamp: Date.now(),
      payload: hostStatus,
      ...identity,
    });
    expect(r.ok).toBe(true);
  });
});

describe("toJsonValue", () => {
  it("serializes Error and drops functions", () => {
    const v = toJsonValue({
      err: new Error("boom"),
      fn: () => 1,
      n: 42,
    });
    expect(isJsonValue(v)).toBe(true);
    expect(v).toMatchObject({
      err: { name: "Error", message: "boom" },
      fn: "[function]",
      n: 42,
    });
  });

  it("handles circular refs", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    const v = toJsonValue(obj);
    expect(isJsonValue(v)).toBe(true);
  });
});
