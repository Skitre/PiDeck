/**
 * R2 protocol coverage — every HostMethod and HostEventName has valid+invalid cases.
 */
import { describe, expect, it } from "vitest";
import { HOST_METHODS, METHOD_CONTEXT_SCOPE, type HostMethod } from "./methods.js";
import { HOST_EVENT_NAMES, type HostEventName } from "./events.js";
import type {
  HostContextMap,
  HostEventPayloadMap,
  HostRequestParams,
  HostResultMap,
} from "./contracts.js";
import {
  parseHostRequest,
  validateMethodContext,
  validateRequestParams,
  validateEventPayload,
  validateSuccessResult,
  isHostEvent,
  isHostResponse,
} from "./validate.js";
import { createEvent, createSuccessResponse, createFailureResponse } from "./envelopes.js";
import { createHostError, HOST_ERROR_CODES } from "./errors.js";
import { isPackageSnapshot, isSessionSnapshot } from "./dto-validate.js";

const REQUEST_ID = "00000000-0000-4000-8000-000000000001";
const RESPONSE_ID = "00000000-0000-4000-8000-000000000002";
const HOST_ID = "00000000-0000-4000-8000-000000000003";
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000004";
const SESSION_ID = "00000000-0000-4000-8000-000000000005";
const RUN_ID = "00000000-0000-4000-8000-000000000006";
const OPERATION_ID = "00000000-0000-4000-8000-000000000007";
const EXTENSION_REQUEST_ID = "00000000-0000-4000-8000-000000000008";

const baseIdentity = {
  hostInstanceId: HOST_ID,
  workspaceId: WORKSPACE_ID as string | null,
  workspaceRevision: 1,
  sessionId: SESSION_ID as string | null,
  sessionRevision: 1,
  packageRevision: 2,
};

function hostCtx() {
  return { expectedHostInstanceId: HOST_ID };
}
function wsCtx() {
  return {
    expectedHostInstanceId: HOST_ID,
    expectedWorkspaceId: WORKSPACE_ID as string | null,
    expectedWorkspaceRevision: 1,
  };
}
function nullSessCtx() {
  return {
    ...wsCtx(),
    expectedSessionId: null as string | null,
    expectedSessionRevision: 0,
  };
}
function activeSessCtx() {
  return {
    ...wsCtx(),
    expectedSessionId: SESSION_ID,
    expectedSessionRevision: 1,
  };
}
function toolCtx() {
  return { ...activeSessCtx(), expectedToolRevision: 1 };
}
function sessPkgCtx() {
  return { ...nullSessCtx(), expectedPackageRevision: 2 };
}
function wsPkgCtx() {
  return { ...wsCtx(), expectedPackageRevision: 2 };
}

/** Minimal valid params per method */
const VALID_PARAMS: Record<HostMethod, unknown> = {
  "system.hello": { clientName: "t", clientVersion: "0", protocolVersion: 1 },
  "system.getStatus": null,
  "system.shutdown": null,
  "workspace.setCurrent": { cwd: "C:/tmp" },
  "workspace.getCurrent": null,
  "workspace.searchFiles": { query: "src" },
  "session.list": null,
  "session.create": {},
  "session.open": { sessionPath: "/s.jsonl" },
  "session.reload": null,
  "session.archive": { sessionId: SESSION_ID, sessionPath: "/s.jsonl" },
  "session.restore": { sessionId: SESSION_ID, sessionPath: "/archive/s.jsonl" },
  "session.delete": { sessionId: SESSION_ID, sessionPath: "/archive/s.jsonl" },
  "session.cleanupArchived": null,
  "session.getSnapshot": null,
  "session.setName": { name: "n" },
  "session.rename": { sessionId: SESSION_ID, sessionPath: "/s.jsonl", name: "n" },
  "session.getEntries": null,
  "session.getTree": null,
  "session.getStats": null,
  "session.usageReport": null,
  "session.getCommands": null,
  "agent.prompt": { text: "hi" },
  "agent.steer": { text: "hi" },
  "agent.followUp": { text: "hi" },
  "agent.abort": null,
  "agent.clearQueue": null,
  "agent.setQueue": { steering: [], followUp: ["next task"] },
  "agent.compact": null,
  "agent.abortCompaction": null,
  "agent.setAutoCompaction": { enabled: true },
  "agent.setAutoRetry": { enabled: false },
  "agent.abortRetry": null,
  "agent.getTools": null,
  "agent.setActiveTools": { names: ["read"] },
  "provider.list": null,
  "provider.setEnabled": { providerId: "local", enabled: true },
  "provider.save": {
    provider: {
      id: "local",
      name: "Local",
      baseUrl: "http://localhost:8317/v1",
      api: "openai-responses",
      authHeader: true,
      headers: {},
      models: [
        {
          id: "model-1",
          name: "Model 1",
          reasoning: false,
          input: ["text"],
          contextWindow: 128000,
          maxTokens: 16384,
        },
      ],
    },
  },
  "provider.remove": { providerId: "local" },
  "provider.fetchModels": { providerId: "local" },
  "model.list": null,
  "model.setCurrent": { provider: "openai", modelId: "gpt" },
  "model.setThinkingLevel": { level: "off" },
  "package.list": { scope: "all" },
  "package.install": { source: "npm:x", scope: "user" },
  "package.remove": { packageId: "p1" },
  "package.checkUpdates": null,
  "package.update": { packageId: "p1" },
  "package.updateAll": null,
  "package.getResources": { packageId: "p1" },
  "package.reloadResources": null,
  "resource.setPreference": {
    resourceId: "r1",
    targetScope: "user",
    preference: "enabled",
  },
  "resource.setPreferences": {
    updates: [
      {
        resourceId: "r1",
        targetScope: "project",
        preference: "inherit",
      },
    ],
  },
  "piSettings.get": null,
  "piSettings.patch": { patch: {} },
  "extensionUi.respond": { requestId: EXTENSION_REQUEST_ID, status: "resolved", value: true },
  "extensionUi.customInput": { requestId: EXTENSION_REQUEST_ID, data: "\r" },
  "extensionUi.customResize": { requestId: EXTENSION_REQUEST_ID, cols: 100, rows: 32 },
};

function contextFor(method: HostMethod): Record<string, unknown> {
  const scope = METHOD_CONTEXT_SCOPE[method];
  switch (scope) {
    case "empty":
      return {};
    case "host":
      return hostCtx();
    case "workspace":
      return wsCtx();
    case "nullableSession":
      return nullSessCtx();
    case "activeSession":
      return activeSessCtx();
    case "toolMutation":
      return toolCtx();
    case "workspacePackage":
      return wsPkgCtx();
    case "sessionPackage":
      return sessPkgCtx();
    default:
      return {};
  }
}

/** Deliberately invalid params for each method */
function invalidParams(method: HostMethod): unknown {
  switch (method) {
    case "system.hello":
      return { clientName: "a" }; // missing version
    case "system.getStatus":
    case "system.shutdown":
    case "workspace.getCurrent":
    case "session.list":
    case "session.cleanupArchived":
    case "session.reload":
    case "session.getSnapshot":
    case "session.getTree":
    case "session.getStats":
    case "session.usageReport":
    case "agent.abort":
    case "agent.clearQueue":
    case "agent.abortCompaction":
    case "agent.abortRetry":
    case "agent.getTools":
    case "provider.list":
    case "model.list":
    case "package.reloadResources":
    case "piSettings.get":
      return {}; // must be null
    case "workspace.setCurrent":
      return { path: "x" }; // missing cwd
    case "workspace.searchFiles":
      return { query: 1 };
    case "session.create":
      return "nope";
    case "session.open":
      return {};
    case "session.archive":
    case "session.restore":
    case "session.delete":
      return { sessionId: "not-a-uuid", sessionPath: "" };
    case "session.setName":
      return {};
    case "session.rename":
      return { sessionId: "not-a-uuid", sessionPath: "", name: "" };
    case "session.getEntries":
      return "bad";
    case "agent.prompt":
    case "agent.steer":
    case "agent.followUp":
      return {};
    case "agent.setQueue":
      return { steering: "x", followUp: [] };
    case "agent.compact":
      return "x";
    case "agent.setAutoCompaction":
    case "agent.setAutoRetry":
      return { enabled: "yes" };
    case "agent.setActiveTools":
      return { names: "read" }; // not array
    case "provider.save":
      return { provider: { id: "" } };
    case "provider.setEnabled":
      return { providerId: "local", enabled: "yes" };
    case "provider.remove":
    case "provider.fetchModels":
      return { providerId: "" };
    case "model.setCurrent":
      return { provider: "x" };
    case "model.setThinkingLevel":
      return {};
    case "package.list":
      return { scope: "both" };
    case "package.install":
      return { source: "x", scope: "all" };
    case "package.remove":
    case "package.update":
      return {};
    case "package.checkUpdates":
      return "x";
    case "package.updateAll":
      return { scope: "all" };
    case "package.getResources":
      return {};
    case "resource.setPreference":
      return { resourceId: "r", targetScope: "user", preference: "inherit" };
    case "resource.setPreferences":
      return { updates: [{ resourceId: "r", targetScope: "workspace", preference: "enabled" }] };
    case "piSettings.patch":
      return {};
    case "extensionUi.respond":
      return { requestId: "r", status: "maybe" };
    case "extensionUi.customInput":
      return { requestId: EXTENSION_REQUEST_ID, data: "" };
    case "extensionUi.customResize":
      return { requestId: EXTENSION_REQUEST_ID, cols: 0, rows: 32 };
    default:
      return { __invalid: true };
  }
}

describe("protocol coverage — methods", () => {
  it("HOST_METHODS is unique and covers maps", () => {
    const set = new Set(HOST_METHODS);
    expect(set.size).toBe(HOST_METHODS.length);
    expect(HOST_METHODS.length).toBeGreaterThan(30);
  });

  for (const method of HOST_METHODS) {
    describe(method, () => {
      it("accepts valid params+context", () => {
        const r = parseHostRequest({
          protocolVersion: 1,
          id: REQUEST_ID,
          method,
          context: contextFor(method),
          params: VALID_PARAMS[method],
        });
        expect(r.ok, r.ok ? "" : r.error.message).toBe(true);
      });

      it("rejects invalid params", () => {
        const r = parseHostRequest({
          protocolVersion: 1,
          id: REQUEST_ID,
          method,
          context: contextFor(method),
          params: invalidParams(method),
        });
        expect(r.ok).toBe(false);
      });

      it("rejects extra context fields", () => {
        const ctx = { ...contextFor(method), unexpectedField: true };
        const r = validateMethodContext(method, ctx);
        if (METHOD_CONTEXT_SCOPE[method] === "empty") {
          // empty rejects any key
          expect(r.ok).toBe(false);
        } else {
          expect(r.ok).toBe(false);
        }
      });
    });
  }

  it("agent.setActiveTools rejects non-string names elements loosely via structure", () => {
    const bad = validateRequestParams("agent.setActiveTools", { names: 123 });
    expect(bad.ok).toBe(false);
  });

  it("package.checkUpdates workspace-only (rejects session fields)", () => {
    const r = validateMethodContext("package.checkUpdates", {
      ...activeSessCtx(),
      expectedPackageRevision: 1,
    });
    expect(r.ok).toBe(false);
  });

  it("uses preference methods instead of the legacy boolean resource methods", () => {
    expect(HOST_METHODS).toContain("resource.setPreference");
    expect(HOST_METHODS).toContain("resource.setPreferences");
    expect(HOST_METHODS).not.toContain("package.setResourceEnabled" as HostMethod);
    expect(HOST_METHODS).not.toContain("package.setResourceTypeEnabled" as HostMethod);
    expect(HOST_METHODS).not.toContain("resource.setTopLevelEnabled" as HostMethod);
  });

  it("enforces scope-specific resource preferences", () => {
    expect(
      validateRequestParams("resource.setPreference", {
        resourceId: "r1",
        targetScope: "project",
        preference: "inherit",
      }).ok,
    ).toBe(true);
    expect(
      validateRequestParams("resource.setPreference", {
        resourceId: "r1",
        targetScope: "user",
        preference: "inherit",
      }).ok,
    ).toBe(false);
    expect(
      validateRequestParams("resource.setPreferences", {
        updates: [
          { resourceId: "r1", targetScope: "user", preference: "enabled" },
          { resourceId: "r2", targetScope: "project", preference: "disabled" },
        ],
      }).ok,
    ).toBe(true);
    expect(validateRequestParams("resource.setPreferences", { updates: [] }).ok).toBe(true);
  });

  it("requires null package.updateAll params", () => {
    expect(validateRequestParams("package.updateAll", null).ok).toBe(true);
    expect(validateRequestParams("package.updateAll", { scope: "all" }).ok).toBe(false);
  });
});

describe("unified package resources", () => {
  const packageRecord = {
    id: "package:user:tools",
    identity: "npm:tools",
    source: "npm:tools",
    kind: "npm",
    scope: "user",
    filtered: false,
    installed: true,
    installedPath: "C:/agent/packages/tools",
    displayName: "Tools",
    description: "Shared tools",
    versionOrRef: "1.2.3",
    effective: true,
    projectOverride: { source: "./project-tools", overrideCount: 2 },
    resourceCounts: {
      extensions: 1,
      skills: 1,
      prompts: 1,
      themes: 0,
      enabled: 2,
      disabled: 1,
    },
    resourceCountsState: "resolvedEffective",
  };

  const extensionResource = {
    id: "resource:extension:tools",
    type: "extension",
    name: "Tools extension",
    description: "Registers shared tools",
    path: "C:/agent/extensions/tools.ts",
    relativePath: "extensions/tools.ts",
    scope: "user",
    origin: "package",
    source: "npm:tools",
    packageId: packageRecord.id,
    enabled: true,
    preferences: { user: "enabled", project: "inherit" },
    control: { kind: "preference", scopes: ["user", "project"] },
    diagnostics: [],
  };

  const snapshot = {
    revision: 2,
    workspaceId: WORKSPACE_ID,
    scope: "all",
    configured: [packageRecord],
    resources: [
      extensionResource,
      {
        id: "resource:skill:review",
        type: "skill",
        name: "Review",
        path: "runtime://tools/review/SKILL.md",
        scope: "temporary",
        origin: "extension",
        source: "runtime:tools",
        enabled: true,
        preferences: {},
        control: {
          kind: "owner-extension",
          ownerResourceId: extensionResource.id,
        },
        manualOnly: true,
        diagnostics: [],
      },
      {
        id: "resource:prompt:built-in",
        type: "prompt",
        name: "Built-in prompt",
        path: "C:/agent/prompts/built-in.md",
        scope: "user",
        origin: "top-level",
        source: "local",
        enabled: false,
        preferences: { user: "disabled" },
        control: { kind: "read-only", reason: "Managed by the host" },
        diagnostics: [{ severity: "warning", source: "loader", message: "Disabled" }],
      },
    ],
    updateCheck: { supported: true, checkedAt: 1 },
    diagnostics: [],
  };

  it("validates package metadata and every resource control variant", () => {
    expect(isPackageSnapshot(snapshot)).toBe(true);
    expect(
      validateSuccessResult("package.getResources", {
        package: packageRecord,
        resources: snapshot.resources,
      }).ok,
    ).toBe(true);
  });

  it("rejects retired arrays and malformed preferences", () => {
    const { resources: _resources, ...withoutResources } = snapshot;
    const { identity: _identity, ...legacyPackageRecord } = packageRecord;
    expect(
      isPackageSnapshot({
        ...withoutResources,
        packageResources: [],
        topLevelResources: [],
      }),
    ).toBe(false);
    expect(
      isPackageSnapshot({
        ...snapshot,
        resources: [
          {
            ...extensionResource,
            preferences: { user: "inherit", project: "inherit" },
          },
        ],
      }),
    ).toBe(false);
    expect(
      isPackageSnapshot({ ...snapshot, configured: [legacyPackageRecord] }),
    ).toBe(false);
    expect(
      validateSuccessResult("package.getResources", {
        package: packageRecord,
        resources: [
          {
            id: extensionResource.id,
            packageId: packageRecord.id,
            type: extensionResource.type,
            name: extensionResource.name,
            path: extensionResource.path,
            enabled: true,
            scope: "user",
            origin: "package",
          },
        ],
      }).ok,
    ).toBe(false);
  });

  it("exposes the non-configurable resource error", () => {
    expect(HOST_ERROR_CODES).toContain("RESOURCE_NOT_CONFIGURABLE");
  });
});

describe("protocol coverage — events", () => {
  it("HOST_EVENT_NAMES unique", () => {
    expect(new Set(HOST_EVENT_NAMES).size).toBe(HOST_EVENT_NAMES.length);
  });

  const minimalPayload: Record<HostEventName, unknown> = {
    "host.ready": {
      ...baseIdentity,
      protocolVersion: 1,
      sdkVersion: "0.80.7",
      nodeVersion: "v22",
      agentDir: "/a",
      phase: "waitingForWorkspace",
      capabilities: {
        packageUpdateCheck: false,
        extensionUi: true,
        sessionExport: false,
      },
      modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
    },
    "host.statusChanged": {
      ...baseIdentity,
      protocolVersion: 1,
      sdkVersion: "0.80.7",
      nodeVersion: "v22",
      agentDir: "/a",
      phase: "ready",
      capabilities: {
        packageUpdateCheck: false,
        extensionUi: true,
        sessionExport: false,
      },
      modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
    },
    "host.fatal": {
      error: createHostError("INTERNAL_ERROR", "boom"),
    },
    "workspace.changed": {
      id: WORKSPACE_ID,
      revision: 1,
      cwd: "/p",
      canonicalCwd: "/p",
      servicesReady: true,
    },
    "session.snapshot": null,
    "session.infoChanged": { sessionId: SESSION_ID, name: "n" },
    "session.runtimeChanged": {
      sessionId: SESSION_ID,
      sessionRevision: 1,
      state: "running",
      updatedAt: 1,
    },
    "agent.event": { runId: RUN_ID, event: { type: "agent_start" } },
    "agent.toolsChanged": {
      revision: 1,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      sessionRevision: 1,
      tools: [],
      active: [],
    },
    "agent.queueChanged": { steering: [], followUp: [] },
    "agent.compactionChanged": { active: false },
    "agent.retryChanged": { active: false },
    "model.changed": { thinkingLevel: "off", availableThinkingLevels: ["off"] },
    "package.progress": {
      operationId: OPERATION_ID,
      type: "start",
      action: "install",
      source: "npm:x",
    },
    "package.snapshot": {
      revision: 1,
      workspaceId: WORKSPACE_ID,
      scope: "all",
      configured: [],
      resources: [],
      updateCheck: { supported: false },
      diagnostics: [],
    },
    "package.resourcesChanged": {
      packages: {
        revision: 1,
        workspaceId: WORKSPACE_ID,
        scope: "all",
        configured: [],
        resources: [],
        updateCheck: { supported: false },
        diagnostics: [],
      },
    },
    "package.diagnostic": { severity: "info", message: "m" },
    "extensionUi.request": {
      requestId: EXTENSION_REQUEST_ID,
      kind: "confirm",
      title: "t",
    },
    "extensionUi.statusChanged": { text: "working" },
    "extensionUi.widgetChanged": { key: "k", widget: null, placement: "belowEditor" },
    "extensionUi.widgetAttentionRequested": {
      key: "k",
      runId: RUN_ID,
      invocation: "brainstorm",
    },
    "extensionUi.notification": { message: "hi", level: "info" },
    "extensionUi.customStarted": {
      requestId: EXTENSION_REQUEST_ID,
      title: "MCP",
      cols: 100,
      rows: 32,
    },
    "extensionUi.customFrame": { requestId: EXTENSION_REQUEST_ID, data: "\x1b[2J" },
    "extensionUi.customClosed": { requestId: EXTENSION_REQUEST_ID },
  };

  for (const event of HOST_EVENT_NAMES) {
    it(`${event} createEvent produces isHostEvent`, () => {
      const env = createEvent(
        baseIdentity,
        event,
        1,
        minimalPayload[event] as HostEventPayloadMap[typeof event],
      );
      expect(isHostEvent(env)).toBe(true);
      expect(env.event).toBe(event);
      expect(env.sequence).toBe(1);
      expect(typeof env.payload).not.toBe("undefined");
    });

    it(`${event} rejects incomplete envelope`, () => {
      expect(
        isHostEvent({
          protocolVersion: 1,
          event,
          // missing identity / sequence
          payload: minimalPayload[event],
        }),
      ).toBe(false);
    });
  }

  it.each([
    { key: "", runId: RUN_ID, invocation: "brainstorm" },
    { key: "brainstorm", runId: "not-a-run-id", invocation: "brainstorm" },
    { key: "brainstorm", runId: RUN_ID, invocation: "" },
    { key: "brainstorm", runId: RUN_ID, invocation: "brainstorm", extra: true },
  ])("rejects malformed widget attention payload %#", (payload) => {
    expect(validateEventPayload("extensionUi.widgetAttentionRequested", payload).ok).toBe(
      false,
    );
  });

  it("session.runtimeChanged rejects unknown states and extra fields", () => {
    expect(
      isHostEvent({
        ...createEvent(baseIdentity, "session.runtimeChanged", 1, {
          sessionId: SESSION_ID,
          sessionRevision: 1,
          state: "running",
          updatedAt: 1,
        }),
        payload: {
          sessionId: SESSION_ID,
          sessionRevision: 1,
          state: "sleeping",
          updatedAt: 1,
          extra: true,
        },
      }),
    ).toBe(false);
  });
});

describe("protocol coverage — response discrimination", () => {
  it("ok true has result, ok false has error", () => {
    const ok = createSuccessResponse(baseIdentity, RESPONSE_ID, "system.shutdown", {
      accepted: true,
    });
    expect(isHostResponse(ok)).toBe(true);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.result.accepted).toBe(true);

    const fail = createFailureResponse(
      baseIdentity,
      REQUEST_ID,
      "system.shutdown",
      createHostError("HOST_SHUTTING_DOWN", "bye"),
    );
    expect(isHostResponse(fail)).toBe(true);
    expect(fail.ok).toBe(false);
    if (!fail.ok) expect(fail.error.code).toBe("HOST_SHUTTING_DOWN");
  });

  it("response method mismatch is client responsibility (structure ok)", () => {
    const env = createSuccessResponse(baseIdentity, RESPONSE_ID, "system.hello", {
      ...baseIdentity,
      protocolVersion: 1,
      sdkVersion: "0.80.7",
      nodeVersion: "v22",
      agentDir: "/a",
      phase: "waitingForWorkspace",
      capabilities: {
        packageUpdateCheck: false,
        extensionUi: true,
        sessionExport: false,
      },
      modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
    });
    expect(env.method).toBe("system.hello");
    expect(env.id).toBe(RESPONSE_ID);
  });
  it("session.usageReport validates the complete report shape", () => {
    const usage = {
      input: 10,
      output: 2,
      cacheRead: 3,
      cacheWrite: 1,
      reasoning: 1,
      totalTokens: 16,
      cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.004, total: 0.037 },
    };
    const response = createSuccessResponse(baseIdentity, RESPONSE_ID, "session.usageReport", {
      workspaceId: WORKSPACE_ID,
      generatedAt: 1,
      totals: { sessionCount: 1, messageCount: 1, usage },
      sessions: [
        {
          sessionId: SESSION_ID,
          sessionPath: "/sessions/one.jsonl",
          updatedAt: 1,
          archived: false,
          messageCount: 1,
          usage,
        },
      ],
    });
    expect(isHostResponse(response)).toBe(true);
    expect(
      isHostResponse({
        ...response,
        result: { ...response.result, unexpected: true },
      }),
    ).toBe(false);
  });
});

describe("context usage breakdown", () => {
  const snapshot = {
    sessionId: SESSION_ID,
    cwd: "/p",
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
    contextUsage: {
      tokens: 100,
      contextWindow: 1_000,
      breakdown: {
        systemPrompt: 20,
        toolDefinitions: 20,
        userPrompts: 10,
        assistantMessages: 20,
        toolResults: 20,
        summaries: 5,
        other: 5,
      },
    },
    messages: [],
    tools: {
      revision: 1,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      sessionRevision: 1,
      tools: [],
      active: [],
    },
  };

  it("accepts the exact breakdown shape", () => {
    expect(isSessionSnapshot(snapshot)).toBe(true);
  });

  it("rejects extra breakdown fields", () => {
    expect(
      isSessionSnapshot({
        ...snapshot,
        contextUsage: {
          ...snapshot.contextUsage,
          breakdown: { ...snapshot.contextUsage.breakdown, hidden: 1 },
        },
      }),
    ).toBe(false);
  });

  it("accepts an optional compaction-aware session entry path", () => {
    expect(
      isSessionSnapshot({
        ...snapshot,
        entries: [
          {
            id: "entry-1",
            type: "compaction",
            parentId: null,
            timestamp: "2026-01-01T00:00:00.000Z",
            summary: "Earlier context",
            firstKeptEntryId: "entry-1",
            tokensBefore: 12,
          },
        ],
        leafId: "entry-1",
      }),
    ).toBe(true);
  });

  it.each([
    { entries: "not-an-array" },
    { entries: [{ id: 1, type: "message" }] },
    { leafId: 42 },
  ])("rejects malformed session entry path %#", (extra) => {
    expect(isSessionSnapshot({ ...snapshot, ...extra })).toBe(false);
  });
});

describe("compile-time maps completeness", () => {
  it("type maps assignable", () => {
    type Ctx = HostContextMap["system.getStatus"];
    type Params = HostRequestParams["package.list"];
    type PreferenceParams = HostRequestParams["resource.setPreference"];
    type Result = HostResultMap["system.hello"];
    type Payload = HostEventPayloadMap["host.ready"];
    const _c: Ctx = { expectedHostInstanceId: "h" };
    const _p: Params = { scope: "all" };
    const _userPreference: PreferenceParams = {
      resourceId: "r1",
      targetScope: "user",
      preference: "disabled",
    };
    const _projectPreference: PreferenceParams = {
      resourceId: "r1",
      targetScope: "project",
      preference: "inherit",
    };
    // @ts-expect-error User preferences cannot inherit from another scope.
    const _invalidUserPreference: PreferenceParams = {
      resourceId: "r1",
      targetScope: "user",
      preference: "inherit",
    };
    void _c;
    void _p;
    void _userPreference;
    void _projectPreference;
    void _invalidUserPreference;
    void (null as unknown as Result);
    void (null as unknown as Payload);
  });
});
