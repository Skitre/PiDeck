import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HostEventEnvelope,
  HostStatusSnapshot,
  SessionSnapshot,
  WorkspaceSnapshot,
} from "@pideck/protocol";
import { useAppStore } from "../lib/stores/app-store";
import { handleHostEvent } from "./App";

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const FIRST_REQUEST_ID = "44444444-4444-4444-8444-444444444444";
const NEXT_REQUEST_ID = "55555555-5555-4555-8555-555555555555";
const GROUP_KEY = "tool:0123456789abcdef";

function host(): HostStatusSnapshot {
  return {
    protocolVersion: 1,
    hostInstanceId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    workspaceRevision: 1,
    sessionId: SESSION_ID,
    sessionRevision: 1,
    packageRevision: 0,
    sdkVersion: "0.84.2",
    nodeVersion: process.version,
    agentDir: "/agent",
    phase: "ready",
    capabilities: {
      packageUpdateCheck: false,
      extensionUi: true,
      sessionExport: false,
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
    revision: 1,
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
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      sessionRevision: 1,
      tools: [],
      active: [],
    },
  };
}

function closeEvent(): HostEventEnvelope<"extensionUi.closed"> {
  return {
    protocolVersion: 1,
    event: "extensionUi.closed",
    hostInstanceId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    workspaceRevision: 1,
    sessionId: SESSION_ID,
    sessionRevision: 1,
    packageRevision: 0,
    sequence: 2,
    timestamp: Date.now(),
    payload: { requestId: FIRST_REQUEST_ID, reason: "aborted" },
  };
}

function requestEvent(): HostEventEnvelope<"extensionUi.request"> {
  return {
    protocolVersion: 1,
    event: "extensionUi.request",
    hostInstanceId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    workspaceRevision: 1,
    sessionId: SESSION_ID,
    sessionRevision: 1,
    packageRevision: 0,
    sequence: 2,
    timestamp: Date.now(),
    payload: {
      requestId: FIRST_REQUEST_ID,
      kind: "confirm",
      origin: {
        invocationKind: "tool",
        extensionId: "ext_0123456789abcdef01234567",
        extensionDisplayName: "Trusted review",
        sourceKind: "package",
        toolName: "review_changes",
        toolCallId: "tool-call-1",
      },
    },
  };
}

function groupClosedEvent(): HostEventEnvelope<"extensionUi.groupClosed"> {
  return {
    protocolVersion: 1,
    event: "extensionUi.groupClosed",
    hostInstanceId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    workspaceRevision: 1,
    sessionId: SESSION_ID,
    sessionRevision: 1,
    packageRevision: 0,
    sequence: 2,
    timestamp: Date.now(),
    payload: { groupKey: GROUP_KEY, status: "completed" },
  };
}

describe("Extension UI closed event handling", () => {
  beforeEach(() => {
    useAppStore.getState().beginHostEpoch(host());
    useAppStore.getState().applyWorkspaceSnapshot(workspace());
    useAppStore.getState().applySessionSnapshot(session());
    useAppStore.setState({ lastSequence: 1, desynchronized: false, rehydrating: false });
    const context = {
      expectedHostInstanceId: HOST_ID,
      expectedWorkspaceId: WORKSPACE_ID,
      expectedWorkspaceRevision: 1,
      expectedSessionId: SESSION_ID,
      expectedSessionRevision: 1,
    };
    useAppStore.getState().setExtensionUiRequest({
      requestId: FIRST_REQUEST_ID,
      kind: "confirm",
      context,
    });
    useAppStore.getState().setExtensionUiRequest({
      requestId: NEXT_REQUEST_ID,
      kind: "input",
      context,
    });
  });

  it("removes the closed request and promotes the next request", () => {
    const requestRecovery = vi.fn();
    const agentEventBuffer = { enqueue: vi.fn(), flush: vi.fn() };

    handleHostEvent(closeEvent(), requestRecovery, agentEventBuffer);

    expect(useAppStore.getState().extensionUiRequest?.requestId).toBe(NEXT_REQUEST_ID);
    expect(useAppStore.getState().extensionUiQueue).toEqual([]);
    expect(agentEventBuffer.flush).toHaveBeenCalledTimes(1);
    expect(requestRecovery).not.toHaveBeenCalled();
  });

  it("retains trusted origin from the Host request event", () => {
    useAppStore.setState({ extensionUiRequest: null, extensionUiQueue: [] });
    const requestRecovery = vi.fn();
    const agentEventBuffer = { enqueue: vi.fn(), flush: vi.fn() };

    handleHostEvent(requestEvent(), requestRecovery, agentEventBuffer);

    expect(useAppStore.getState().extensionUiRequest?.origin).toEqual(
      requestEvent().payload.origin,
    );
    expect(requestRecovery).not.toHaveBeenCalled();
  });

  it("removes an answered group only after the Host closes its invocation", () => {
    useAppStore.setState({ extensionUiRequest: null, extensionUiQueue: [] });
    useAppStore.getState().setExtensionUiRequest({
      requestId: FIRST_REQUEST_ID,
      kind: "confirm",
      groupKey: GROUP_KEY,
      presentation: "inline",
      context: {
        expectedHostInstanceId: HOST_ID,
        expectedWorkspaceId: WORKSPACE_ID,
        expectedWorkspaceRevision: 1,
        expectedSessionId: SESSION_ID,
        expectedSessionRevision: 1,
      },
    });
    useAppStore.getState().closeExtensionUiRequest(FIRST_REQUEST_ID, "answered");
    expect(useAppStore.getState().extensionDecisionGroups[GROUP_KEY]).toBeDefined();

    const requestRecovery = vi.fn();
    const agentEventBuffer = { enqueue: vi.fn(), flush: vi.fn() };
    handleHostEvent(groupClosedEvent(), requestRecovery, agentEventBuffer);

    expect(useAppStore.getState().extensionDecisionGroups[GROUP_KEY]).toBeUndefined();
    expect(requestRecovery).not.toHaveBeenCalled();
  });
});
