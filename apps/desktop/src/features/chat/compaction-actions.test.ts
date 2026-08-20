import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HostResponseEnvelope,
  HostStatusSnapshot,
  SessionSnapshot,
  WorkspaceSnapshot,
} from "@pideck/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore } from "../../lib/stores/app-store";
import { abortCompaction, requestCompact, setAutoCompaction } from "./compaction-actions";

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
    sdkVersion: "0.84.2",
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

describe("compaction actions", () => {
  beforeEach(() => {
    useAppStore.getState().setHost(null);
    useAppStore.getState().setWorkspace(null);
    useAppStore.getState().applySessionSnapshot(null);
    useAppStore.getState().clearNotifications();
    useAppStore.getState().setHost(host());
    useAppStore.getState().setWorkspace(workspace());
    useAppStore.getState().applySessionSnapshot(session());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requests agent.compact without a client timeout and applies the snapshot", async () => {
    const request = vi.spyOn(hostClient, "request").mockResolvedValue(
      envelope("agent.compact", {
        ok: true,
        result: {
          result: { summary: "s", tokensBefore: 120_000, estimatedTokensAfter: 8_000 },
          session: session({ thinkingLevel: "high" }),
        },
      }) as never,
    );

    await expect(requestCompact("keep the details")).resolves.toBe(true);

    expect(request).toHaveBeenCalledExactlyOnceWith(
      "agent.compact",
      EXPECTED_CONTEXT,
      { instructions: "keep the details" },
      null,
    );
    expect(useAppStore.getState().session?.thinkingLevel).toBe("high");
    expect(notifications()).toEqual([
      { message: "Context compacted: 120k → 8k tokens", level: "info" },
    ]);
  });

  it("sends null params when no instructions are given", async () => {
    const request = vi.spyOn(hostClient, "request").mockResolvedValue(
      envelope("agent.compact", {
        ok: true,
        result: { result: { summary: "s" }, session: session() },
      }) as never,
    );

    await expect(requestCompact()).resolves.toBe(true);

    expect(request).toHaveBeenCalledExactlyOnceWith("agent.compact", EXPECTED_CONTEXT, null, null);
    expect(notifications()).toEqual([{ message: "Context compacted", level: "info" }]);
  });

  it("refuses while the agent is busy", async () => {
    useAppStore.getState().applySessionSnapshot(session({ isIdle: false, isStreaming: true }));
    const request = vi.spyOn(hostClient, "request");

    await expect(requestCompact()).resolves.toBe(false);

    expect(request).not.toHaveBeenCalled();
    expect(notifications()).toEqual([
      { message: "Wait for the agent to finish before compacting", level: "info" },
    ]);
  });

  it("surfaces host errors and reports failure", async () => {
    vi.spyOn(hostClient, "request").mockResolvedValue({
      ...envelope("agent.compact", { ok: false }),
      error: { code: "AGENT_BUSY", message: "Agent busy", retryable: true },
    } as never);

    await expect(requestCompact()).resolves.toBe(false);

    expect(notifications()).toEqual([{ message: "Agent busy", level: "error" }]);
  });

  it("drops the result after a session switch", async () => {
    let resolveRequest!: (response: HostResponseEnvelope) => void;
    vi.spyOn(hostClient, "request").mockImplementation(
      () =>
        new Promise<HostResponseEnvelope>((resolve) => {
          resolveRequest = resolve;
        }) as never,
    );

    const pending = requestCompact();
    useAppStore.getState().setHost(host(SESSION_B));
    resolveRequest(
      envelope("agent.compact", {
        ok: true,
        result: {
          result: { summary: "s", tokensBefore: 1_000, estimatedTokensAfter: 100 },
          session: session({ thinkingLevel: "high" }),
        },
      }),
    );

    await expect(pending).resolves.toBe(false);
    expect(useAppStore.getState().session?.thinkingLevel).toBe("off");
    expect(notifications()).toEqual([]);
  });

  it("toggles auto-compaction and applies the returned snapshot", async () => {
    const request = vi.spyOn(hostClient, "request").mockResolvedValue(
      envelope("agent.setAutoCompaction", {
        ok: true,
        result: session({ autoCompactionEnabled: false }),
      }) as never,
    );

    await setAutoCompaction(false);

    expect(request).toHaveBeenCalledExactlyOnceWith("agent.setAutoCompaction", EXPECTED_CONTEXT, {
      enabled: false,
    });
    expect(useAppStore.getState().session?.autoCompactionEnabled).toBe(false);
  });

  it("aborts compaction and surfaces failures", async () => {
    const request = vi.spyOn(hostClient, "request").mockResolvedValue({
      ...envelope("agent.abortCompaction", { ok: false }),
      error: { code: "HOST_NOT_READY", message: "Server not bound" },
    } as never);

    await abortCompaction();

    expect(request).toHaveBeenCalledExactlyOnceWith(
      "agent.abortCompaction",
      EXPECTED_CONTEXT,
      null,
    );
    expect(notifications()).toEqual([{ message: "Server not bound", level: "error" }]);
  });
});
