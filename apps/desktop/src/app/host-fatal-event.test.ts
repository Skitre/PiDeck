import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostEventEnvelope } from "@pideck/protocol";
import { HostClient, type HostTransport } from "../lib/bridge/host-client";
import { useAppStore } from "../lib/stores/app-store";
import { handleHostEvent } from "./App";

const ACTIVE_HOST_ID = "10000000-0000-4000-8000-000000000001";
const PROCESS_EXIT_SENTINEL = "00000000-0000-4000-8000-000000000002";

function identity(hostInstanceId: string) {
  return {
    hostInstanceId,
    workspaceId: null,
    workspaceRevision: 0,
    sessionId: null,
    sessionRevision: 0,
    packageRevision: 0,
  };
}

function ready(hostInstanceId: string): string {
  return JSON.stringify({
    protocolVersion: 1,
    event: "host.ready",
    sequence: 1,
    timestamp: Date.now(),
    ...identity(hostInstanceId),
    payload: {
      protocolVersion: 1,
      ...identity(hostInstanceId),
      sdkVersion: "0.84.2",
      nodeVersion: process.version,
      agentDir: "/agent",
      phase: "waitingForWorkspace",
      capabilities: {
        packageUpdateCheck: true,
        extensionUi: true,
        sessionExport: true,
      },
      modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
    },
  });
}

function fatal(hostInstanceId: string, message: string): string {
  return JSON.stringify({
    protocolVersion: 1,
    event: "host.fatal",
    sequence: 1,
    timestamp: Date.now(),
    ...identity(hostInstanceId),
    payload: {
      error: {
        code: "INTERNAL_ERROR",
        message,
        retryable: false,
      },
    },
  });
}

function transportFixture(): { transport: HostTransport; emit: (line: string) => void } {
  let handler: ((line: string) => void) | null = null;
  return {
    transport: {
      send: vi.fn(),
      onMessage: (next) => {
        handler = next;
        return () => {
          handler = null;
        };
      },
    },
    emit(line) {
      if (!handler) throw new Error("transport is not attached");
      handler(line);
    },
  };
}

function eventBuffer() {
  return {
    enqueue: vi.fn(),
    flush: vi.fn(),
  };
}

describe("App Host fatal event handling", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    useAppStore.setState({
      lastSequence: 7,
      desynchronized: false,
      rehydrating: false,
      hostFatal: null,
      notifications: [],
      connecting: true,
    });
  });

  it("surfaces a Rust process-exit fatal after the Host sequence has advanced", async () => {
    const client = new HostClient();
    const wire = transportFixture();
    client.attach(wire.transport);
    wire.emit(ready(ACTIVE_HOST_ID));

    const requestRecovery = vi.fn();
    const agentEvents = eventBuffer();
    client.onEvent((event) => handleHostEvent(event, requestRecovery, agentEvents));
    const pending = client.request(
      "system.getStatus",
      { expectedHostInstanceId: ACTIVE_HOST_ID },
      null,
      null,
    );

    wire.emit(fatal(PROCESS_EXIT_SENTINEL, "Pi Host exited unexpectedly"));

    await expect(pending).rejects.toThrow("Pi Host exited unexpectedly");
    expect(useAppStore.getState()).toMatchObject({
      lastSequence: 7,
      hostFatal: "Pi Host failed: Pi Host exited unexpectedly",
      connecting: false,
    });
    expect(useAppStore.getState().notifications.at(-1)).toMatchObject({
      message: "Host unavailable: Pi Host failed: Pi Host exited unexpectedly",
      level: "error",
    });
    expect(agentEvents.flush).toHaveBeenCalledTimes(1);
    expect(requestRecovery).not.toHaveBeenCalled();
    client.detach();
  });

  it("still drops a stale Host-originated fatal", () => {
    const requestRecovery = vi.fn();
    const agentEvents = eventBuffer();
    const event = JSON.parse(
      fatal(ACTIVE_HOST_ID, "stale real Host fatal"),
    ) as HostEventEnvelope<"host.fatal">;

    handleHostEvent(event, requestRecovery, agentEvents);

    expect(useAppStore.getState()).toMatchObject({
      lastSequence: 7,
      hostFatal: null,
      connecting: true,
      notifications: [],
    });
    expect(agentEvents.flush).not.toHaveBeenCalled();
    expect(requestRecovery).not.toHaveBeenCalled();
  });

  it("settles a fatal that arrives while desynchronized so startup can complete", () => {
    useAppStore.setState({
      desynchronized: true,
      desyncReason: "sequence gap 7 -> 9",
      rehydrating: true,
      connecting: true,
    });
    const requestRecovery = vi.fn();
    const agentEvents = eventBuffer();
    const event = JSON.parse(
      fatal(ACTIVE_HOST_ID, "host died mid-recovery"),
    ) as HostEventEnvelope<"host.fatal">;
    event.sequence = 8;

    handleHostEvent(event, requestRecovery, agentEvents);

    const state = useAppStore.getState();
    expect(state.hostFatal).toContain("host died mid-recovery");
    expect(state).toMatchObject({
      connecting: false,
      rehydrating: false,
      desynchronized: false,
    });
    expect(state.desyncReason).toBeUndefined();
  });
});
