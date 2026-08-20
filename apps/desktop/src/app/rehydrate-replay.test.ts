import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HostEventEnvelope,
  HostStatusSnapshot,
  RehydrateSnapshot,
  SessionSnapshot,
  WorkspaceSnapshot,
} from "@pideck/protocol";
import { hostClient } from "../lib/bridge/host-client";
import { RecoveryEventBuffer } from "../lib/bridge/rehydrate";
import { subscribeValidatedHostEvent } from "../lib/bridge/validated-host-events";
import { useAppStore } from "../lib/stores/app-store";
import { emptySessionCatalog } from "../lib/stores/session-catalog";
import { runFullRehydrate } from "./App";

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";

function host(): HostStatusSnapshot {
  return {
    hostInstanceId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    workspaceRevision: 4,
    sessionId: SESSION_ID,
    sessionRevision: 6,
    packageRevision: 3,
    protocolVersion: 1,
    sdkVersion: "0.84.2",
    nodeVersion: "v22",
    agentDir: "/agent",
    phase: "agentBusy",
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
    revision: 4,
    servicesReady: true,
  };
}

function session(content: string): SessionSnapshot {
  return {
    sessionId: SESSION_ID,
    cwd: "/workspace",
    revision: 6,
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
    messages: [{ role: "assistant", content }],
    tools: {
      revision: 2,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      sessionRevision: 6,
      tools: [],
      active: [],
    },
  };
}

describe("atomic rehydrate replay", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useAppStore.setState({
      host: null,
      workspace: null,
      session: null,
      packages: null,
      tools: null,
      desynchronized: false,
      desyncReason: undefined,
      lastSequence: 0,
      rehydrating: false,
      hostFatal: null,
      sessionCatalog: emptySessionCatalog(),
    });
  });

  it("replays a Session snapshot that arrives after the Host snapshot barrier", async () => {
    let resolveResponse!: (response: unknown) => void;
    const response = new Promise((resolve) => {
      resolveResponse = resolve;
    });
    vi.spyOn(hostClient, "request").mockReturnValue(response as never);

    const recoveryEvents = new RecoveryEventBuffer();
    const requestRecovery = vi.fn();
    const agentEventBuffer = { enqueue: vi.fn(), flush: vi.fn() };
    const replayedEvents: number[] = [];
    const unsubscribe = subscribeValidatedHostEvent(
      "session.snapshot",
      {
        expectedHostInstanceId: HOST_ID,
        expectedWorkspaceId: WORKSPACE_ID,
        expectedWorkspaceRevision: 4,
        expectedSessionId: SESSION_ID,
        expectedSessionRevision: 6,
      },
      (event) => replayedEvents.push(event.sequence),
    );
    const running = runFullRehydrate(HOST_ID, recoveryEvents, requestRecovery, agentEventBuffer);

    const latestSession = session("complete transcript");
    const inFlightEvent = {
      protocolVersion: 1,
      hostInstanceId: HOST_ID,
      workspaceId: WORKSPACE_ID,
      workspaceRevision: 4,
      sessionId: SESSION_ID,
      sessionRevision: 6,
      packageRevision: 3,
      sequence: 11,
      timestamp: 11,
      event: "session.snapshot",
      payload: latestSession,
    } satisfies HostEventEnvelope<"session.snapshot">;
    expect(recoveryEvents.capture(inFlightEvent)).toBe(true);

    const snapshot: RehydrateSnapshot = {
      watermark: 10,
      host: host(),
      workspace: workspace(),
      session: session("partial transcript"),
      tools: session("partial transcript").tools,
      packages: {
        revision: 3,
        workspaceId: WORKSPACE_ID,
        scope: "all",
        configured: [],
        resources: [],
        updateCheck: { supported: false },
        diagnostics: [],
      },
    };
    resolveResponse({ ok: true, result: snapshot });
    try {
      await expect(running).resolves.toBe(true);
    } finally {
      unsubscribe();
    }

    expect(requestRecovery).not.toHaveBeenCalled();
    expect(useAppStore.getState()).toMatchObject({
      lastSequence: 11,
      desynchronized: false,
      rehydrating: false,
    });
    expect(useAppStore.getState().session?.messages).toEqual(latestSession.messages);
    expect(replayedEvents).toEqual([11]);
  });

  it("replays Host entries and leaf even when messages already match the live draft", async () => {
    let resolveResponse!: (response: unknown) => void;
    const response = new Promise((resolve) => {
      resolveResponse = resolve;
    });
    vi.spyOn(hostClient, "request").mockReturnValue(response as never);

    const recoveryEvents = new RecoveryEventBuffer();
    const requestRecovery = vi.fn();
    const agentEventBuffer = { enqueue: vi.fn(), flush: vi.fn() };
    const running = runFullRehydrate(HOST_ID, recoveryEvents, requestRecovery, agentEventBuffer);

    const latestSession = session("streaming transcript");
    latestSession.entries = [
      {
        id: "e-live",
        parentId: null,
        type: "message",
        message: { role: "assistant", content: "streaming transcript" },
      },
      {
        id: "e-tool",
        parentId: "e-live",
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "t1",
          toolName: "search",
          content: [{ type: "text", text: "ok" }],
        },
      },
    ];
    latestSession.leafId = "e-tool";
    latestSession.extensionMessageRenders = {
      "e-host": { version: 1, collapsed: ["new"], expanded: ["new"] },
    };
    const inFlightEvent = {
      protocolVersion: 1,
      hostInstanceId: HOST_ID,
      workspaceId: WORKSPACE_ID,
      workspaceRevision: 4,
      sessionId: SESSION_ID,
      sessionRevision: 6,
      packageRevision: 3,
      sequence: 11,
      timestamp: 11,
      event: "session.snapshot",
      payload: latestSession,
    } satisfies HostEventEnvelope<"session.snapshot">;
    expect(recoveryEvents.capture(inFlightEvent)).toBe(true);

    const staleSession = session("streaming transcript");
    staleSession.entries = [
      {
        id: "e-live",
        parentId: null,
        type: "message",
        message: { role: "assistant", content: "streaming transcript" },
      },
    ];
    staleSession.leafId = "e-live";
    const snapshot: RehydrateSnapshot = {
      watermark: 10,
      host: host(),
      workspace: workspace(),
      session: staleSession,
      tools: staleSession.tools,
      packages: {
        revision: 3,
        workspaceId: WORKSPACE_ID,
        scope: "all",
        configured: [],
        resources: [],
        updateCheck: { supported: false },
        diagnostics: [],
      },
    };
    resolveResponse({ ok: true, result: snapshot });
    await expect(running).resolves.toBe(true);

    expect(requestRecovery).not.toHaveBeenCalled();
    expect(useAppStore.getState().session?.entries).toEqual(latestSession.entries);
    expect(useAppStore.getState().session?.leafId).toBe("e-tool");
    expect(useAppStore.getState().session?.extensionMessageRenders).toEqual(
      latestSession.extensionMessageRenders,
    );
  });

  it("reports overflow as superseded so startup does not continue", async () => {
    const recoveryEvents = new RecoveryEventBuffer(0);
    const requestRecovery = vi.fn((reason: string) => {
      useAppStore.getState().markDesynchronized(reason);
    });
    vi.spyOn(hostClient, "request").mockImplementation(async () => {
      recoveryEvents.capture({
        protocolVersion: 1,
        hostInstanceId: HOST_ID,
        workspaceId: WORKSPACE_ID,
        workspaceRevision: 4,
        sessionId: SESSION_ID,
        sessionRevision: 6,
        packageRevision: 3,
        sequence: 11,
        timestamp: 11,
        event: "session.snapshot",
        payload: session("complete transcript"),
      });
      return {
        ok: true,
        result: {
          watermark: 10,
          host: host(),
          workspace: workspace(),
          session: session("partial transcript"),
          tools: session("partial transcript").tools,
          packages: {
            revision: 3,
            workspaceId: WORKSPACE_ID,
            scope: "all",
            configured: [],
            resources: [],
            updateCheck: { supported: false },
            diagnostics: [],
          },
        },
      } as never;
    });

    const recovered = await runFullRehydrate(HOST_ID, recoveryEvents, requestRecovery, {
      enqueue: vi.fn(),
      flush: vi.fn(),
    });

    expect(recovered).toBe(false);
    expect(requestRecovery).toHaveBeenCalledWith("recovery event buffer overflowed");
    expect(useAppStore.getState().desynchronized).toBe(true);
  });
});
