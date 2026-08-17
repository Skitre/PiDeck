import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HostResponseEnvelope,
  HostStatusSnapshot,
  SessionSnapshot,
  WorkspaceSnapshot,
} from "@pideck/protocol";
import { hostClient } from "./bridge/host-client";
import { __resetDraftPersistenceForTests } from "./draft-persistence";
import { draftKeyForTarget, draftTargetFor } from "./draft-target";
import { useAppStore } from "./stores/app-store";
import {
  requestNavigateTree,
  requestPromptFromEntry,
  requestRegenerateInSession,
} from "./tree-actions";

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_A = "33333333-3333-4333-8333-333333333333";
const SESSION_B = "44444444-4444-4444-8444-444444444444";

function host(sessionId: string = SESSION_A): HostStatusSnapshot {
  return {
    protocolVersion: 1,
    hostInstanceId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    workspaceRevision: 1,
    sessionId,
    sessionRevision: 3,
    packageRevision: 1,
    sdkVersion: "0.82.1",
    nodeVersion: process.version,
    agentDir: "/agent",
    phase: "ready",
    capabilities: {
      packageUpdateCheck: true,
      extensionUi: true,
      sessionExport: true,
    },
    modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
  };
}

function workspace(): WorkspaceSnapshot {
  return {
    id: WORKSPACE_ID,
    cwd: "/workspace",
    canonicalCwd: "/workspace",
    revision: 1,
    servicesReady: true,
  };
}

function session(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: SESSION_A,
    cwd: "/workspace",
    revision: 3,
    isStreaming: false,
    isIdle: true,
    isCompacting: false,
    isRetrying: false,
    thinkingLevel: "off",
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    steeringMode: "all",
    followUpMode: "all",
    pending: { revision: 1, steering: [], followUp: [] },
    messages: [],
    tools: {
      revision: 1,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_A,
      sessionRevision: 3,
      tools: [],
      active: [],
    },
    ...overrides,
  };
}

const EXPECTED_CONTEXT = {
  expectedHostInstanceId: HOST_ID,
  expectedWorkspaceId: WORKSPACE_ID,
  expectedWorkspaceRevision: 1,
  expectedSessionId: SESSION_A,
  expectedSessionRevision: 3,
};

function envelope(method: string, body: { ok: true; result: unknown } | { ok: false }) {
  return {
    protocolVersion: 1,
    id: "test-request",
    method,
    hostInstanceId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    workspaceRevision: 1,
    sessionId: SESSION_A,
    sessionRevision: 3,
    packageRevision: 1,
    ...body,
  } as HostResponseEnvelope;
}

function notifications() {
  return useAppStore.getState().notifications.map(({ message, level }) => ({
    message,
    level,
  }));
}

function draftText(): string {
  const target = draftTargetFor(workspace(), session());
  return target ? (useAppStore.getState().draftTexts[draftKeyForTarget(target)] ?? "") : "";
}

describe("tree actions", () => {
  beforeEach(() => {
    useAppStore.getState().setHost(null);
    useAppStore.getState().setWorkspace(null);
    useAppStore.getState().applySessionSnapshot(null);
    useAppStore.getState().clearNotifications();
    useAppStore.getState().setAuthBlocked(null);
    useAppStore.getState().setHost(host());
    useAppStore.getState().setWorkspace(workspace());
    useAppStore.getState().applySessionSnapshot(session());
    useAppStore.setState({ draftTexts: {}, draftEditVersions: {}, draftTargets: {} });
  });

  afterEach(() => {
    __resetDraftPersistenceForTests();
    vi.restoreAllMocks();
  });

  it("navigates the current session and restores editor text", async () => {
    const request = vi.spyOn(hostClient, "request").mockResolvedValue(
      envelope("agent.navigateTree", {
        ok: true,
        result: {
          session: session({ thinkingLevel: "high" }),
          cancelled: false,
          editorText: "rewrite this",
        },
      }) as never,
    );

    await expect(requestNavigateTree("u1")).resolves.toEqual({
      applied: true,
      editorText: "rewrite this",
    });

    expect(request).toHaveBeenCalledExactlyOnceWith("agent.navigateTree", EXPECTED_CONTEXT, {
      targetId: "u1",
    });
    expect(useAppStore.getState().session?.thinkingLevel).toBe("high");
    expect(draftText()).toBe("rewrite this");
  });

  it("can skip restoring the composer draft", async () => {
    vi.spyOn(hostClient, "request").mockResolvedValue(
      envelope("agent.navigateTree", {
        ok: true,
        result: {
          session: session(),
          cancelled: false,
          editorText: "leave me out",
        },
      }) as never,
    );

    await expect(requestNavigateTree("u1", { restoreDraft: false })).resolves.toEqual({
      applied: true,
      editorText: "leave me out",
    });
    expect(draftText()).toBe("");
  });

  it("refuses navigation while the agent is busy", async () => {
    useAppStore.getState().applySessionSnapshot(session({ isIdle: false, isStreaming: true }));
    const request = vi.spyOn(hostClient, "request");

    await expect(requestNavigateTree("u1")).resolves.toEqual({ applied: false });
    expect(request).not.toHaveBeenCalled();
    expect(notifications()).toEqual([
      {
        message: "Wait for the agent to finish before changing the conversation",
        level: "info",
      },
    ]);
  });

  it("drops a navigate result after a session switch", async () => {
    let resolveRequest!: (response: HostResponseEnvelope) => void;
    vi.spyOn(hostClient, "request").mockImplementation(
      () =>
        new Promise<HostResponseEnvelope>((resolve) => {
          resolveRequest = resolve;
        }) as never,
    );

    const pending = requestNavigateTree("u1");
    useAppStore.getState().setHost(host(SESSION_B));
    resolveRequest(
      envelope("agent.navigateTree", {
        ok: true,
        result: { session: session({ thinkingLevel: "high" }), cancelled: false },
      }),
    );

    await expect(pending).resolves.toEqual({ applied: false });
    expect(useAppStore.getState().session?.thinkingLevel).toBe("off");
  });

  it("prompts from a tree entry in one request and applies the navigated snapshot", async () => {
    const request = vi.spyOn(hostClient, "request").mockResolvedValue(
      envelope("agent.prompt", {
        ok: true,
        result: {
          accepted: true,
          runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          session: session({ thinkingLevel: "high" }),
        },
      }) as never,
    );

    await expect(requestPromptFromEntry("u1", { text: "ask again" })).resolves.toBe(true);

    expect(request).toHaveBeenCalledExactlyOnceWith(
      "agent.prompt",
      EXPECTED_CONTEXT,
      { text: "ask again", fromEntryId: "u1" },
      null,
    );
    expect(useAppStore.getState().session?.thinkingLevel).toBe("high");
    expect(draftText()).toBe("");
  });

  it("regenerates with text and images in the same prompt", async () => {
    const request = vi.spyOn(hostClient, "request").mockResolvedValue(
      envelope("agent.prompt", {
        ok: true,
        result: { accepted: true, runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      }) as never,
    );

    await expect(
      requestRegenerateInSession("u1", {
        fallbackText: "pictured",
        images: [{ mediaType: "image/png", data: "aaa" }],
      }),
    ).resolves.toBe(true);

    expect(request).toHaveBeenCalledExactlyOnceWith(
      "agent.prompt",
      EXPECTED_CONTEXT,
      {
        text: "pictured",
        fromEntryId: "u1",
        images: [{ mediaType: "image/png", data: "aaa" }],
      },
      null,
    );
  });

  it("surfaces AUTH_REQUIRED on regenerate and restores the prompt into the composer", async () => {
    vi.spyOn(hostClient, "request").mockResolvedValue({
      ...envelope("agent.prompt", { ok: false }),
      error: {
        code: "AUTH_REQUIRED",
        message: "Sign in",
        details: { providerId: "anthropic" },
      },
    } as never);

    await expect(requestRegenerateInSession("u1", { fallbackText: "need a key" })).resolves.toBe(
      false,
    );
    expect(useAppStore.getState().authBlocked).toEqual({ providerId: "anthropic" });
    expect(draftText()).toBe("need a key");
  });

  it("does not prompt when there is no text, images, or attachments", async () => {
    const request = vi.spyOn(hostClient, "request");

    await expect(requestRegenerateInSession("u1")).resolves.toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(notifications()).toEqual([{ message: "Nothing to regenerate", level: "info" }]);
  });

  it("regenerates a document-only message with attachment ids", async () => {
    const request = vi.spyOn(hostClient, "request").mockResolvedValue(
      envelope("agent.prompt", {
        ok: true,
        result: { accepted: true, runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      }) as never,
    );

    await expect(
      requestRegenerateInSession("u1", {
        attachmentIds: ["11111111-1111-4111-8111-111111111111"],
      }),
    ).resolves.toBe(true);

    expect(request).toHaveBeenCalledExactlyOnceWith(
      "agent.prompt",
      EXPECTED_CONTEXT,
      {
        text: "",
        fromEntryId: "u1",
        attachmentIds: ["11111111-1111-4111-8111-111111111111"],
      },
      null,
    );
  });
});
