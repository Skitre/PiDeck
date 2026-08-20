import { describe, expect, it } from "vitest";
import { HOST_METHODS, METHOD_CONTEXT_SCOPE } from "./methods.js";
import {
  MAX_AGENT_IMAGE_BYTES,
  MAX_AGENT_REQUEST_ATTACHMENTS,
  MAX_AGENT_REQUEST_IMAGES,
  MAX_GIT_COMMIT_MESSAGE_BYTES,
  MAX_GIT_BRANCH_NAME_BYTES,
  MAX_GIT_PATH_BYTES,
  MAX_PASTED_TEXT_ATTACHMENT_BYTES,
  MAX_EXTENSION_UI_CORRELATION_ID_LENGTH,
  MAX_EXTENSION_UI_DEFAULT_VALUE_LENGTH,
  MAX_EXTENSION_UI_MESSAGE_LENGTH,
  MAX_EXTENSION_UI_OPTION_DESCRIPTION_LENGTH,
  MAX_EXTENSION_UI_OPTION_ID_LENGTH,
  MAX_EXTENSION_UI_OPTION_LABEL_LENGTH,
  MAX_EXTENSION_UI_OPTIONS,
  MAX_EXTENSION_UI_SOURCE_LABEL_LENGTH,
  MAX_EXTENSION_UI_TITLE_LENGTH,
  MAX_EXTENSION_MESSAGE_RENDER_LINE_LENGTH,
} from "./limits.js";
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

describe("Extension message renderer snapshots", () => {
  it("accepts bounded renderer updates and rejects oversized lines", () => {
    expect(
      validateEventPayload("extensionUi.messageRendered", {
        entryId: "custom-1",
        render: { version: 1, collapsed: ["summary"], expanded: ["full"], messageIndex: 2 },
      }).ok,
    ).toBe(true);
    expect(
      validateEventPayload("extensionUi.messageRendered", {
        entryId: "custom-1",
        render: {
          version: 1,
          collapsed: ["x".repeat(MAX_EXTENSION_MESSAGE_RENDER_LINE_LENGTH + 1)],
          expanded: [],
        },
      }).ok,
    ).toBe(false);
    expect(
      validateEventPayload("extensionUi.messageRendered", {
        entryId: "custom-1",
        render: { version: 1, collapsed: [], expanded: [], messageIndex: -1 },
      }).ok,
    ).toBe(false);
  });
});
const EXTENSION_REQUEST_ID = "00000000-0000-4000-8000-000000000005";
const RUN_ID = "00000000-0000-4000-8000-000000000006";

describe("compact Assistant message updates", () => {
  const update = (assistantMessageEvent: unknown) =>
    validateEventPayload("agent.event", {
      runId: RUN_ID,
      event: { type: "message_update", assistantMessageEvent },
    }).ok;

  it("accepts replayable text, thinking, and tool-call events", () => {
    expect(update({ type: "text_delta", contentIndex: 0, delta: "hello" })).toBe(true);
    expect(update({ type: "thinking_end", contentIndex: 1, content: "plan" })).toBe(true);
    expect(update({ type: "toolcall_start", contentIndex: 2, id: "call-1", name: "read" })).toBe(
      true,
    );
    expect(
      update({
        type: "toolcall_end",
        contentIndex: 2,
        toolCall: { type: "toolCall", id: "call-1", name: "read", arguments: {} },
      }),
    ).toBe(true);
  });

  it("rejects full snapshots, partial snapshots, invalid indexes, and unknown variants", () => {
    expect(
      validateEventPayload("agent.event", {
        runId: RUN_ID,
        event: {
          type: "message_update",
          message: { role: "assistant", content: "full snapshot" },
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" },
        },
      }).ok,
    ).toBe(false);
    expect(
      update({
        type: "text_delta",
        contentIndex: 0,
        delta: "x",
        partial: { role: "assistant", content: "x" },
      }),
    ).toBe(false);
    expect(update({ type: "text_delta", contentIndex: -1, delta: "x" })).toBe(false);
    expect(update({ type: "future_delta", contentIndex: 0, delta: "x" })).toBe(false);
  });
});

const hostStatus = {
  protocolVersion: 1,
  hostInstanceId: HOST_ID,
  workspaceId: WORKSPACE_ID,
  workspaceRevision: 1,
  sessionId: SESSION_ID,
  sessionRevision: 1,
  packageRevision: 0,
  sdkVersion: "0.84.2",
  nodeVersion: "v24.18.0",
  agentDir: "C:/agent",
  phase: "ready",
  capabilities: {
    packageUpdateCheck: false,
    extensionUi: true,
    sessionExport: false,
  },
  modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
} as const;

describe("METHOD_CONTEXT_SCOPE coverage", () => {
  it("covers every HostMethod exactly once", () => {
    const keys = Object.keys(METHOD_CONTEXT_SCOPE);
    expect(keys.sort()).toEqual([...HOST_METHODS].sort());
  });

  it("classifies Extension UI interactions as target-Session methods", () => {
    expect(METHOD_CONTEXT_SCOPE["extensionUi.respond"]).toBe("sessionTarget");
    expect(METHOD_CONTEXT_SCOPE["extensionUi.customInput"]).toBe("sessionTarget");
    expect(METHOD_CONTEXT_SCOPE["extensionUi.customResize"]).toBe("sessionTarget");
  });

  it("classifies agent stop methods as target-Session methods", () => {
    expect(METHOD_CONTEXT_SCOPE["agent.abort"]).toBe("sessionTarget");
    expect(METHOD_CONTEXT_SCOPE["agent.abortCompaction"]).toBe("sessionTarget");
    expect(METHOD_CONTEXT_SCOPE["agent.abortRetry"]).toBe("sessionTarget");
  });
});

describe("parseHostRequest", () => {
  const activeSessionContext = {
    expectedHostInstanceId: HOST_ID,
    expectedWorkspaceId: WORKSPACE_ID,
    expectedWorkspaceRevision: 1,
    expectedSessionId: SESSION_ID,
    expectedSessionRevision: 1,
  };
  const workspaceContext = {
    expectedHostInstanceId: HOST_ID,
    expectedWorkspaceId: WORKSPACE_ID,
    expectedWorkspaceRevision: 1,
  };

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

  it("accepts an optional presentation mode in hello and rejects unknown modes", () => {
    const request = {
      protocolVersion: 1 as const,
      id: REQUEST_ID,
      method: "system.hello" as const,
      context: {},
      params: {
        clientName: "test",
        clientVersion: "0.1.0",
        protocolVersion: 1 as const,
      },
    };
    expect(
      parseHostRequest({
        ...request,
        params: {
          ...request.params,
          extensionDecisionPresentation: "legacy-modal",
        },
      }).ok,
    ).toBe(true);
    expect(
      parseHostRequest({
        ...request,
        params: {
          ...request.params,
          extensionDecisionPresentation: "automatic",
        },
      }).ok,
    ).toBe(false);
  });

  it("classifies Extension UI configuration as Host-scoped", () => {
    expect(METHOD_CONTEXT_SCOPE["extensionUi.configure"]).toBe("host");
    expect(
      parseHostRequest({
        protocolVersion: 1,
        id: REQUEST_ID,
        method: "extensionUi.configure",
        context: { expectedHostInstanceId: HOST_ID },
        params: { extensionDecisionPresentation: "auto" },
      }).ok,
    ).toBe(true);
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

  it("validates attachment.createText using UTF-8 bytes and exact fields", () => {
    const request = (text: string, extra?: Record<string, unknown>) =>
      parseHostRequest({
        protocolVersion: 1,
        id: REQUEST_ID,
        method: "attachment.createText",
        context: activeSessionContext,
        params: { text, ...extra },
      });

    expect(request("界".repeat(Math.floor(MAX_PASTED_TEXT_ATTACHMENT_BYTES / 3))).ok).toBe(true);
    expect(request("界".repeat(Math.floor(MAX_PASTED_TEXT_ATTACHMENT_BYTES / 3) + 1)).ok).toBe(
      false,
    );
    expect(request("   ").ok).toBe(false);
    expect(request("text\u0000data").ok).toBe(false);
    expect(request("text", { name: "forbidden.txt" }).ok).toBe(false);
  });

  it("validates Git paths, revisions, and exact fields", () => {
    const request = (
      method: "git.getDiff" | "git.stage" | "git.unstage" | "git.discard",
      params: unknown,
    ) =>
      parseHostRequest({
        protocolVersion: 1,
        id: REQUEST_ID,
        method,
        context: workspaceContext,
        params,
      });

    expect(
      request("git.stage", { path: "a".repeat(MAX_GIT_PATH_BYTES), expectedRevision: 1 }).ok,
    ).toBe(true);
    expect(
      request("git.getDiff", { path: "src/app.ts", area: "unstaged", expectedRevision: 2 }).ok,
    ).toBe(true);
    for (const path of [
      "/etc/passwd",
      "C:\\repo\\file.txt",
      "../file",
      "src/../../file",
      "\\\\server\\share\\file",
      "bad\u0000path",
    ]) {
      expect(request("git.stage", { path, expectedRevision: 1 }).ok).toBe(false);
    }
    expect(
      request("git.stage", { path: "a".repeat(MAX_GIT_PATH_BYTES + 1), expectedRevision: 1 }).ok,
    ).toBe(false);
    expect(request("git.unstage", { path: "src/app.ts", expectedRevision: -1 }).ok).toBe(false);
    expect(request("git.discard", { path: "src/app.ts", expectedRevision: 3 }).ok).toBe(true);
    expect(request("git.stage", { path: "src/app.ts", expectedRevision: 1, force: true }).ok).toBe(
      false,
    );
  });

  it("validates Git batch mutations by revision and exact fields", () => {
    const request = (method: "git.stageAll" | "git.unstageAll", params: unknown) =>
      parseHostRequest({
        protocolVersion: 1,
        id: REQUEST_ID,
        method,
        context: workspaceContext,
        params,
      });

    expect(request("git.stageAll", { expectedRevision: 1 }).ok).toBe(true);
    expect(request("git.unstageAll", { expectedRevision: 2 }).ok).toBe(true);
    expect(request("git.stageAll", { expectedRevision: -1 }).ok).toBe(false);
    expect(request("git.unstageAll", { expectedRevision: 1, path: "." }).ok).toBe(false);
  });

  it("validates Git commit messages by UTF-8 bytes and index generation", () => {
    const request = (message: string, extra?: Record<string, unknown>) =>
      parseHostRequest({
        protocolVersion: 1,
        id: REQUEST_ID,
        method: "git.commit",
        context: workspaceContext,
        params: { message, expectedIndexGeneration: "a".repeat(64), ...extra },
      });

    expect(request("界".repeat(Math.floor(MAX_GIT_COMMIT_MESSAGE_BYTES / 3))).ok).toBe(true);
    expect(request("界".repeat(Math.floor(MAX_GIT_COMMIT_MESSAGE_BYTES / 3) + 1)).ok).toBe(false);
    expect(request("   ").ok).toBe(false);
    expect(request("bad\u0000message").ok).toBe(false);
    expect(request("message", { expectedIndexGeneration: "short" }).ok).toBe(false);
    expect(request("message", { amend: true }).ok).toBe(false);
  });

  it("validates Git hunk, branch, history, and commit comparison requests", () => {
    const request = (
      method:
        | "git.mutateHunk"
        | "git.createBranch"
        | "git.switchBranch"
        | "git.listHistory"
        | "git.getCommitDiff",
      params: unknown,
    ) =>
      parseHostRequest({
        protocolVersion: 1,
        id: REQUEST_ID,
        method,
        context: workspaceContext,
        params,
      });
    const hunk = {
      path: "src/app.ts",
      area: "unstaged",
      hunkId: "a".repeat(64),
      operation: "stage",
      expectedRevision: 2,
      expectedContentGeneration: "b".repeat(64),
    };
    expect(request("git.mutateHunk", hunk).ok).toBe(true);
    expect(request("git.mutateHunk", { ...hunk, hunkId: "short" }).ok).toBe(false);
    expect(request("git.createBranch", { name: "feature/git", expectedRevision: 2 }).ok).toBe(true);
    expect(request("git.switchBranch", { name: " bad", expectedRevision: 2 }).ok).toBe(false);
    expect(
      request("git.createBranch", {
        name: "a".repeat(MAX_GIT_BRANCH_NAME_BYTES + 1),
        expectedRevision: 2,
      }).ok,
    ).toBe(false);
    expect(request("git.listHistory", { limit: 50, cursor: "c".repeat(40) }).ok).toBe(true);
    expect(request("git.listHistory", { limit: 101 }).ok).toBe(false);
    expect(request("git.getCommitDiff", { commitSha: "d".repeat(40) }).ok).toBe(true);
    expect(request("git.getCommitDiff", { commitSha: "HEAD" }).ok).toBe(false);
  });

  it.each(["agent.prompt", "agent.steer", "agent.followUp"] as const)(
    "rejects a fifth image for %s",
    (method) => {
      const result = parseHostRequest({
        protocolVersion: 1,
        id: REQUEST_ID,
        method,
        context: activeSessionContext,
        params: {
          text: "images",
          images: Array.from({ length: MAX_AGENT_REQUEST_IMAGES + 1 }, () => ({
            mediaType: "image/png",
            data: "AA==",
          })),
        },
      });

      expect(result).toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST" },
      });
    },
  );

  it.each(["agent.prompt", "agent.steer", "agent.followUp"] as const)(
    "accepts managed attachment IDs and rejects overflow, duplicates, or unknown fields for %s",
    (method) => {
      const base = {
        protocolVersion: 1 as const,
        id: REQUEST_ID,
        method,
        context: activeSessionContext,
      };
      expect(
        parseHostRequest({
          ...base,
          params: { text: "docs", attachmentIds: [RUN_ID] },
        }).ok,
      ).toBe(true);
      for (const params of [
        {
          text: "docs",
          attachmentIds: Array.from(
            { length: MAX_AGENT_REQUEST_ATTACHMENTS + 1 },
            (_, index) => `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
          ),
        },
        { text: "docs", attachmentIds: [RUN_ID, RUN_ID] },
        { text: "docs", attachmentIds: ["not-a-uuid"] },
        { text: "docs", attachmentIds: [RUN_ID], fileData: "forbidden" },
      ]) {
        expect(parseHostRequest({ ...base, params })).toMatchObject({
          ok: false,
          error: { code: "INVALID_REQUEST" },
        });
      }
    },
  );

  it.each(["agent.prompt", "agent.steer", "agent.followUp"] as const)(
    "rejects image data larger than the five MiB decoded-equivalent limit for %s",
    (method) => {
      const maximumBase64Chars = Math.ceil(MAX_AGENT_IMAGE_BYTES / 3) * 4;
      const result = parseHostRequest({
        protocolVersion: 1,
        id: REQUEST_ID,
        method,
        context: activeSessionContext,
        params: {
          text: "oversized image",
          images: [
            {
              mediaType: "image/png",
              data: "A".repeat(maximumBase64Chars + 4),
            },
          ],
        },
      });

      expect(result).toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST" },
      });
    },
  );

  it("accepts image data exactly at the five MiB decoded-equivalent limit", () => {
    const maximumBase64Chars = Math.ceil(MAX_AGENT_IMAGE_BYTES / 3) * 4;
    const result = parseHostRequest({
      protocolVersion: 1,
      id: REQUEST_ID,
      method: "agent.prompt",
      context: activeSessionContext,
      params: {
        text: "boundary image",
        images: [
          {
            mediaType: "image/png",
            data: `${"A".repeat(maximumBase64Chars - 1)}=`,
          },
        ],
      },
    });

    expect(result.ok).toBe(true);
  });

  it("rejects non-base64 image data instead of accepting multibyte size bypasses", () => {
    const result = parseHostRequest({
      protocolVersion: 1,
      id: REQUEST_ID,
      method: "agent.prompt",
      context: activeSessionContext,
      params: {
        text: "invalid image",
        images: [{ mediaType: "image/png", data: "界界界界" }],
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
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
    pending: { revision: 0, steering: [], followUp: [] },
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

  const rehydrateSnapshot = {
    watermark: 7,
    host: hostStatus,
    workspace: {
      id: WORKSPACE_ID,
      cwd: "C:/workspace",
      canonicalCwd: "C:/workspace",
      revision: 1,
      servicesReady: true,
    },
    session,
    tools: session.tools,
    packages: {
      revision: 0,
      workspaceId: WORKSPACE_ID,
      scope: "all",
      configured: [],
      resources: [],
      updateCheck: { supported: false },
      diagnostics: [],
    },
  } as const;

  it("validates a consistent atomic rehydrate snapshot", () => {
    expect(validateSuccessResult("system.rehydrate", rehydrateSnapshot).ok).toBe(true);
  });

  it("rejects inconsistent identities inside a rehydrate snapshot", () => {
    expect(
      validateSuccessResult("system.rehydrate", {
        ...rehydrateSnapshot,
        tools: {
          ...rehydrateSnapshot.tools,
          workspaceId: "00000000-0000-4000-8000-000000000099",
        },
      }).ok,
    ).toBe(false);
  });

  it("accepts an atomic no-workspace rehydrate snapshot", () => {
    expect(
      validateSuccessResult("system.rehydrate", {
        watermark: 0,
        host: {
          ...hostStatus,
          workspaceId: null,
          workspaceRevision: 0,
          sessionId: null,
          sessionRevision: 0,
          phase: "waitingForWorkspace",
        },
        workspace: null,
        session: null,
        tools: null,
        packages: null,
      }).ok,
    ).toBe(true);
  });

  it("validateSuccessResult accepts system.shutdown", () => {
    const r = validateSuccessResult("system.shutdown", { accepted: true });
    expect(r.ok).toBe(true);
  });

  it("validateSuccessResult rejects shutdown without accepted", () => {
    const r = validateSuccessResult("system.shutdown", { accepted: false });
    expect(r.ok).toBe(false);
  });

  it("validates nested agent content fields in SessionSnapshot results", () => {
    const abortResult = {
      aborted: false,
      settled: true,
      queueRestored: true,
      partialFailure: false,
      queue: session.pending,
      session,
    };
    expect(validateSuccessResult("agent.abort", abortResult).ok).toBe(true);
    expect(
      validateSuccessResult("agent.abort", {
        ...abortResult,
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
    expect(validateSuccessResult("agent.compact", { result: compactResult, session }).ok).toBe(
      false,
    );
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

  it("validates session.rename results", () => {
    expect(
      validateSuccessResult("session.rename", {
        sessionId: SESSION_ID,
        name: "Renamed session",
      }).ok,
    ).toBe(true);
    expect(
      validateSuccessResult("session.rename", {
        sessionId: SESSION_ID,
        name: "Renamed session",
        unexpected: true,
      }).ok,
    ).toBe(false);
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

  it("validates authoritative Extension UI close reasons with exact keys", () => {
    for (const reason of ["aborted", "timed-out", "disposed", "stale"] as const) {
      expect(
        validateEventPayload("extensionUi.closed", {
          requestId: EXTENSION_REQUEST_ID,
          reason,
        }).ok,
      ).toBe(true);
    }
    expect(
      validateEventPayload("extensionUi.closed", {
        requestId: EXTENSION_REQUEST_ID,
        reason: "resolved",
      }).ok,
    ).toBe(false);
    expect(
      validateEventPayload("extensionUi.closed", {
        requestId: EXTENSION_REQUEST_ID,
        reason: "aborted",
        extra: true,
      }).ok,
    ).toBe(false);
  });

  it("validates authoritative Extension UI group completion with bounded exact keys", () => {
    for (const status of ["completed", "failed", "cancelled", "stale"] as const) {
      expect(
        validateEventPayload("extensionUi.groupClosed", {
          groupKey: "tool:0123456789abcdef",
          status,
        }).ok,
      ).toBe(true);
    }
    expect(
      validateEventPayload("extensionUi.groupClosed", {
        groupKey: "x".repeat(257),
        status: "completed",
      }).ok,
    ).toBe(false);
    expect(
      validateEventPayload("extensionUi.groupClosed", {
        groupKey: "tool:0123456789abcdef",
        status: "active",
      }).ok,
    ).toBe(false);
    expect(
      validateEventPayload("extensionUi.groupClosed", {
        groupKey: "tool:0123456789abcdef",
        status: "completed",
        extra: true,
      }).ok,
    ).toBe(false);
  });

  it("accepts declarative Extension UI presentation metadata", () => {
    expect(
      validateEventPayload("extensionUi.request", {
        requestId: EXTENSION_REQUEST_ID,
        kind: "select",
        sourceLabel: "Subagents",
        correlationId: "decision-1",
        presentationHint: "inline",
        riskHint: "normal",
        presentation: "modal",
        risk: "high",
        routeReason: "destructive-option",
        groupKey: "tool:0123456789abcdef",
        allowFreeform: true,
        options: [
          { id: "continue", label: "Continue", description: "Resume the agent" },
          { id: "stop", label: "Stop", destructive: true },
        ],
      }).ok,
    ).toBe(true);
    expect(
      validateEventPayload("extensionUi.request", {
        requestId: EXTENSION_REQUEST_ID,
        kind: "confirm",
        groupKey: "x".repeat(257),
      }).ok,
    ).toBe(false);
  });

  it("enforces blocking Extension UI request bounds", () => {
    const request = (overrides: Record<string, unknown>) =>
      validateEventPayload("extensionUi.request", {
        requestId: EXTENSION_REQUEST_ID,
        kind: "select",
        ...overrides,
      }).ok;
    expect(
      request({
        title: "t".repeat(MAX_EXTENSION_UI_TITLE_LENGTH),
        message: "m".repeat(MAX_EXTENSION_UI_MESSAGE_LENGTH),
        defaultValue: "d".repeat(MAX_EXTENSION_UI_DEFAULT_VALUE_LENGTH),
        sourceLabel: "s".repeat(MAX_EXTENSION_UI_SOURCE_LABEL_LENGTH),
        correlationId: "c".repeat(MAX_EXTENSION_UI_CORRELATION_ID_LENGTH),
        options: [
          {
            id: "i".repeat(MAX_EXTENSION_UI_OPTION_ID_LENGTH),
            label: "l".repeat(MAX_EXTENSION_UI_OPTION_LABEL_LENGTH),
            description: "d".repeat(MAX_EXTENSION_UI_OPTION_DESCRIPTION_LENGTH),
          },
        ],
      }),
    ).toBe(true);
    for (const [field, maxLength] of [
      ["title", MAX_EXTENSION_UI_TITLE_LENGTH],
      ["message", MAX_EXTENSION_UI_MESSAGE_LENGTH],
      ["defaultValue", MAX_EXTENSION_UI_DEFAULT_VALUE_LENGTH],
      ["sourceLabel", MAX_EXTENSION_UI_SOURCE_LABEL_LENGTH],
      ["correlationId", MAX_EXTENSION_UI_CORRELATION_ID_LENGTH],
    ] as const) {
      expect(request({ [field]: "x".repeat(maxLength + 1) })).toBe(false);
    }
    for (const [field, maxLength] of [
      ["id", MAX_EXTENSION_UI_OPTION_ID_LENGTH],
      ["label", MAX_EXTENSION_UI_OPTION_LABEL_LENGTH],
      ["description", MAX_EXTENSION_UI_OPTION_DESCRIPTION_LENGTH],
    ] as const) {
      expect(
        request({
          options: [{ id: "id", label: "label", [field]: "x".repeat(maxLength + 1) }],
        }),
      ).toBe(false);
    }
    expect(
      request({
        options: Array.from({ length: MAX_EXTENSION_UI_OPTIONS }, (_, index) => ({
          id: String(index),
          label: String(index),
        })),
      }),
    ).toBe(true);
    expect(
      request({
        options: Array.from({ length: MAX_EXTENSION_UI_OPTIONS + 1 }, (_, index) => ({
          id: String(index),
          label: String(index),
        })),
      }),
    ).toBe(false);
    expect(request({ options: [{ id: undefined, label: "label" }] })).toBe(false);
  });

  it("accepts strict trusted Extension UI invocation origins", () => {
    const identity = {
      extensionId: "ext_0123456789abcdef",
      extensionDisplayName: "Ask User",
      sourceKind: "package" as const,
    };
    for (const origin of [
      { invocationKind: "unknown" },
      {
        ...identity,
        invocationKind: "tool",
        toolName: "ask_user_question",
        toolCallId: "tool-call-1",
      },
      { ...identity, invocationKind: "command", commandName: "review" },
      { ...identity, invocationKind: "shortcut", shortcut: "ctrl+r" },
      {
        ...identity,
        invocationKind: "event",
        eventType: "tool_call",
        toolName: "read",
        toolCallId: "tool-call-2",
      },
      { ...identity, invocationKind: "background" },
    ]) {
      expect(
        validateEventPayload("extensionUi.request", {
          requestId: EXTENSION_REQUEST_ID,
          kind: "confirm",
          origin,
        }).ok,
      ).toBe(true);
    }
  });

  it("rejects malformed or unbounded Extension UI origins", () => {
    const request = (origin: unknown) =>
      validateEventPayload("extensionUi.request", {
        requestId: EXTENSION_REQUEST_ID,
        kind: "confirm",
        origin,
      }).ok;
    expect(request({ invocationKind: "unknown", extensionId: "forged" })).toBe(false);
    expect(
      request({
        invocationKind: "tool",
        extensionId: "ext_0123456789abcdef",
        extensionDisplayName: "Ask User",
        sourceKind: "package",
        toolName: "ask_user_question",
      }),
    ).toBe(false);
    expect(
      request({
        invocationKind: "event",
        extensionId: "ext_0123456789abcdef",
        extensionDisplayName: "Ask User",
        sourceKind: "untrusted",
        eventType: "session_start",
      }),
    ).toBe(false);
    expect(
      request({
        invocationKind: "command",
        extensionId: "x".repeat(129),
        extensionDisplayName: "Ask User",
        sourceKind: "package",
        commandName: "review",
      }),
    ).toBe(false);
    expect(
      request({
        invocationKind: "event",
        extensionId: "ext_0123456789abcdef",
        extensionDisplayName: "",
        sourceKind: "package",
        eventType: "session_start",
      }),
    ).toBe(false);
  });

  it("rejects executable or unknown Extension UI metadata", () => {
    expect(
      validateEventPayload("extensionUi.request", {
        requestId: EXTENSION_REQUEST_ID,
        kind: "confirm",
        presentation: "inline",
        command: "subagent_supervisor(...)",
      }).ok,
    ).toBe(false);
    expect(
      validateEventPayload("extensionUi.request", {
        requestId: EXTENSION_REQUEST_ID,
        kind: "confirm",
        presentation: "modal",
        risk: "normal",
        routeReason: "extension-decided",
      }).ok,
    ).toBe(false);
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

  it("omits undefined-valued keys like JSON.stringify", () => {
    const v = toJsonValue({
      role: "toolResult",
      usage: undefined,
      details: undefined,
      isError: false,
    });
    expect(v).toEqual({ role: "toolResult", isError: false });
    expect(toJsonValue(undefined)).toBeNull();
    expect(toJsonValue([1, undefined, 2])).toEqual([1, null, 2]);
  });
});

describe("Git DTO validation", () => {
  const ready = {
    state: "ready",
    revision: 4,
    repositoryRoot: "/repo",
    workspaceIsRepositoryRoot: true,
    branch: "main",
    detached: false,
    unborn: false,
    headSha: "a".repeat(40),
    upstream: "origin/main",
    ahead: 1,
    behind: 0,
    indexGeneration: "b".repeat(64),
    files: [
      {
        path: "src/app.ts",
        staged: "modified",
        unstaged: null,
        conflict: false,
        submodule: false,
        pathSupported: true,
      },
    ],
    warnings: [],
  } as const;

  it("accepts each Git status state and rejects unknown fields", () => {
    expect(validateSuccessResult("git.getStatus", ready).ok).toBe(true);
    expect(
      validateSuccessResult("git.getStatus", { state: "not_repository", revision: 1 }).ok,
    ).toBe(true);
    expect(
      validateSuccessResult("git.getStatus", {
        state: "unavailable",
        revision: 1,
        message: "missing",
      }).ok,
    ).toBe(true);
    expect(validateSuccessResult("git.getStatus", { ...ready, localPath: "/secret" }).ok).toBe(
      false,
    );
    expect(validateSuccessResult("git.getStatus", { ...ready, indexGeneration: "short" }).ok).toBe(
      false,
    );
  });

  it("validates diff, mutation, commit, and changed event shapes exactly", () => {
    const diff = {
      path: "src/app.ts",
      area: "staged",
      patch: "@@ -1 +1 @@\n-old\n+new",
      additions: 1,
      deletions: 1,
      binary: false,
      truncated: false,
      contentGeneration: "c".repeat(64),
      hunks: [
        {
          id: "e".repeat(64),
          header: "@@ -1 +1 @@",
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          additions: 1,
          deletions: 1,
        },
      ],
      hunkOperations: ["unstage"],
    } as const;
    expect(validateSuccessResult("git.getDiff", diff).ok).toBe(true);
    expect(validateSuccessResult("git.getDiff", { ...diff, area: "working" }).ok).toBe(false);
    expect(validateSuccessResult("git.stage", { applied: true, snapshot: ready }).ok).toBe(true);
    expect(validateSuccessResult("git.stageAll", { applied: true, snapshot: ready }).ok).toBe(true);
    expect(validateSuccessResult("git.unstageAll", { applied: true, snapshot: ready }).ok).toBe(
      true,
    );
    expect(validateSuccessResult("git.discard", { applied: true, snapshot: ready }).ok).toBe(true);
    expect(validateSuccessResult("git.mutateHunk", { applied: true, snapshot: ready }).ok).toBe(
      true,
    );
    expect(
      validateSuccessResult("git.listBranches", {
        statusRevision: 2,
        current: "main",
        detached: false,
        branches: [{ name: "main", current: true, upstream: "origin/main", ahead: 1, behind: 0 }],
        truncated: false,
      }).ok,
    ).toBe(true);
    const commit = {
      sha: "d".repeat(40),
      shortSha: "dddddddd",
      parents: ["a".repeat(40)],
      authorName: "PiDeck",
      authoredAt: "2026-08-02T12:00:00+08:00",
      subject: "Test",
      refs: ["HEAD -> main"],
    };
    expect(
      validateSuccessResult("git.listHistory", { commits: [commit], nextCursor: commit.sha }).ok,
    ).toBe(true);
    expect(
      validateSuccessResult("git.getCommitDiff", {
        commitSha: commit.sha,
        parentSha: commit.parents[0],
        patch: diff.patch,
        additions: 1,
        deletions: 1,
        binary: false,
        truncated: false,
      }).ok,
    ).toBe(true);
    expect(
      validateSuccessResult("git.commit", {
        applied: true,
        commitSha: "d".repeat(40),
        snapshot: ready,
      }).ok,
    ).toBe(true);
    expect(validateSuccessResult("git.commit", { applied: true, snapshot: ready }).ok).toBe(false);
    expect(validateEventPayload("git.changed", { snapshot: ready }).ok).toBe(true);
    expect(validateEventPayload("git.changed", { snapshot: ready, path: "/repo" }).ok).toBe(false);
  });
});

describe("ModelConfigHealth degraded state", () => {
  const status = (modelConfigHealth: unknown) => ({
    ...hostStatus,
    modelConfigHealth,
  });

  it("accepts a degraded status carrying journal recovery detail", () => {
    const result = validateSuccessResult(
      "system.getStatus",
      status({
        state: "degraded",
        source: "provider.journal",
        message: "Could not fully roll back provider.save",
        recovery: { journalId: "j-1", stage: "committed", restored: false },
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("still accepts the ordinary ok status", () => {
    expect(
      validateSuccessResult(
        "system.getStatus",
        status({ state: "ok", source: "ModelRegistry.getError" }),
      ),
    ).toMatchObject({ ok: true });
  });

  it("rejects an unknown health state", () => {
    expect(
      validateSuccessResult(
        "system.getStatus",
        status({ state: "unknown", source: "provider.journal" }),
      ),
    ).toMatchObject({ ok: false });
  });

  it("rejects a malformed recovery block", () => {
    expect(
      validateSuccessResult(
        "system.getStatus",
        status({
          state: "degraded",
          source: "provider.journal",
          recovery: { journalId: "j-1", stage: "unknown-stage", restored: false },
        }),
      ),
    ).toMatchObject({ ok: false });
    expect(
      validateSuccessResult(
        "system.getStatus",
        status({
          state: "degraded",
          source: "provider.journal",
          recovery: { journalId: "j-1", stage: "prepared" },
        }),
      ),
    ).toMatchObject({ ok: false });
  });
});
