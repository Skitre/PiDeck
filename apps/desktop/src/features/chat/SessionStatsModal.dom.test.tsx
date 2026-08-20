/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HostResponseEnvelope,
  HostStatusSnapshot,
  SessionSnapshot,
  WorkspaceSnapshot,
} from "@pideck/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore } from "../../lib/stores/app-store";
import { SessionStatsModal } from "./SessionStatsModal";

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";

function host(): HostStatusSnapshot {
  return {
    protocolVersion: 1,
    hostInstanceId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    workspaceRevision: 1,
    sessionId: SESSION_ID,
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

function session(): SessionSnapshot {
  return {
    sessionId: SESSION_ID,
    cwd: "/workspace",
    revision: 3,
    name: "My session",
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
      sessionId: SESSION_ID,
      sessionRevision: 3,
      tools: [],
      active: [],
    },
  };
}

const EXPECTED_CONTEXT = {
  expectedHostInstanceId: HOST_ID,
  expectedWorkspaceId: WORKSPACE_ID,
  expectedWorkspaceRevision: 1,
  expectedSessionId: SESSION_ID,
  expectedSessionRevision: 3,
};

function statsEnvelope(): HostResponseEnvelope {
  return {
    protocolVersion: 1,
    id: "test-request",
    method: "session.getStats",
    hostInstanceId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    workspaceRevision: 1,
    sessionId: SESSION_ID,
    sessionRevision: 3,
    packageRevision: 1,
    ok: true,
    result: {
      messageCount: 16,
      toolCallCount: 7,
      userMessageCount: 4,
      assistantMessageCount: 5,
      toolResultCount: 7,
      tokens: {
        input: 1_200,
        output: 300,
        cacheRead: 8_000,
        cacheWrite: 900,
        total: 10_400,
      },
      cost: 0.42,
      sessionFile: "/sessions/active.jsonl",
    },
  } as HostResponseEnvelope;
}

describe("SessionStatsModal", () => {
  beforeEach(() => {
    useAppStore.getState().setHost(null);
    useAppStore.getState().setWorkspace(null);
    useAppStore.getState().applySessionSnapshot(null);
    useAppStore.getState().setHost(host());
    useAppStore.getState().setWorkspace(workspace());
    useAppStore.getState().applySessionSnapshot(session());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("fetches and renders the stats when opened", async () => {
    const request = vi.spyOn(hostClient, "request").mockResolvedValue(statsEnvelope() as never);
    render(<SessionStatsModal open onClose={() => {}} />);

    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledWith("session.getStats", EXPECTED_CONTEXT, null);
    expect(await screen.findByText("My session")).toBeInTheDocument();
    expect(screen.getByText("Tool calls")).toBeInTheDocument();
    expect(screen.getByText("1.2k")).toBeInTheDocument();
    expect(screen.getByText("10.4k")).toBeInTheDocument();
    expect(screen.getByText("$0.42")).toBeInTheDocument();
    expect(screen.getByText("/sessions/active.jsonl")).toBeInTheDocument();
  });

  it("shows host errors instead of stats", async () => {
    vi.spyOn(hostClient, "request").mockResolvedValue({
      ...statsEnvelope(),
      ok: false,
      result: undefined,
      error: { code: "HOST_NOT_READY", message: "Server not bound" },
    } as never);
    render(<SessionStatsModal open onClose={() => {}} />);

    expect(await screen.findByText("Server not bound")).toBeInTheDocument();
  });

  it("does not fetch while closed and closes on Escape", async () => {
    const request = vi.spyOn(hostClient, "request").mockResolvedValue(statsEnvelope() as never);
    const onClose = vi.fn();
    const { rerender } = render(<SessionStatsModal open={false} onClose={onClose} />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();

    rerender(<SessionStatsModal open onClose={onClose} />);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
