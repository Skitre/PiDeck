import { describe, expect, it } from "vitest";
import { HostClient } from "./host-client.js";
import type { HostEventMessage } from "@pideck/protocol";

describe("HostClient.shouldAcceptEvent", () => {
  const client = new HostClient();

  const baseEvent = (over: Partial<HostEventMessage> = {}): HostEventMessage =>
    ({
      protocolVersion: 1,
      hostInstanceId: "h1",
      workspaceId: "w1",
      workspaceRevision: 2,
      sessionId: "s1",
      sessionRevision: 3,
      packageRevision: 1,
      event: "session.snapshot",
      sequence: 5,
      timestamp: Date.now(),
      payload: null,
      ...over,
    }) as HostEventMessage;

  it("drops mismatched hostInstanceId", () => {
    expect(
      client.shouldAcceptEvent(baseEvent(), {
        hostInstanceId: "other",
      }),
    ).toBe(false);
  });

  it("drops mismatched workspace revision", () => {
    expect(
      client.shouldAcceptEvent(baseEvent(), {
        hostInstanceId: "h1",
        workspaceId: "w1",
        workspaceRevision: 1,
      }),
    ).toBe(false);
  });

  it("accepts matching identity", () => {
    expect(
      client.shouldAcceptEvent(baseEvent(), {
        hostInstanceId: "h1",
        workspaceId: "w1",
        workspaceRevision: 2,
        sessionId: "s1",
        sessionRevision: 3,
      }),
    ).toBe(true);
  });
});

describe("HostClient lifecycle failures", () => {
  it("delivers a Rust synthetic fatal before normal Host epoch filtering", () => {
    const client = new HostClient();
    const transportHandlers: Array<(line: string) => void> = [];
    client.attach({
      send: () => undefined,
      onMessage: (handler) => {
        transportHandlers.push(handler);
        return () => undefined;
      },
    });
    const events: HostEventMessage[] = [];
    client.onEvent((event) => events.push(event));

    transportHandlers[0]!(
      JSON.stringify({
        protocolVersion: 1,
        event: "host.fatal",
        sequence: 1,
        timestamp: Date.now(),
        hostInstanceId: "00000000-0000-4000-8000-000000000001",
        workspaceId: null,
        workspaceRevision: 0,
        sessionId: null,
        sessionRevision: 0,
        packageRevision: 0,
        payload: {
          error: {
            code: "INTERNAL_ERROR",
            message: "Bundled Host failed to start",
            retryable: false,
          },
        },
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("host.fatal");
    expect(client.getHostInstanceId()).toBeNull();
    expect(client.getLastSequence()).toBe(0);
  });
});
