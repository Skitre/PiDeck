import { describe, expect, it } from "vitest";
import { HostClient } from "./host-client.js";
import type { HostEventMessage } from "@pideck/protocol";

const HOST_ID = "00000000-0000-4000-8000-000000000011";
const UNKNOWN_REQUEST_ID = "00000000-0000-4000-8000-000000000099";

const RESPONSE_IDENTITY = {
  hostInstanceId: HOST_ID,
  workspaceId: null,
  workspaceRevision: 0,
  sessionId: null,
  sessionRevision: 0,
  packageRevision: 0,
};

function attachTestTransport(client: HostClient) {
  const sent: Array<{ id: string; method: string; params: unknown }> = [];
  let messageHandler: ((line: string) => void) | null = null;
  client.attach({
    send: (line) => {
      sent.push(JSON.parse(line) as { id: string; method: string; params: unknown });
    },
    onMessage: (handler) => {
      messageHandler = handler;
      return () => {
        messageHandler = null;
      };
    },
  });
  return {
    sent,
    emit(message: unknown) {
      if (!messageHandler) throw new Error("test transport is not attached");
      messageHandler(JSON.stringify(message));
    },
  };
}

describe("HostClient hello configuration", () => {
  it("sends auto when no Extension decision mode is provided", async () => {
    const client = new HostClient();
    const transport = attachTestTransport(client);
    const pending = client.hello();

    expect(transport.sent[0]).toMatchObject({
      method: "system.hello",
      params: {
        clientName: "pideck",
        clientVersion: "0.1.0",
        protocolVersion: 1,
        extensionDecisionPresentation: "auto",
      },
    });
    transport.emit({
      protocolVersion: 1,
      ...RESPONSE_IDENTITY,
      id: transport.sent[0]!.id,
      method: "system.hello",
      ok: true,
      result: {
        protocolVersion: 1,
        ...RESPONSE_IDENTITY,
        sdkVersion: "0.84.2",
        nodeVersion: "v24.18.0",
        agentDir: "/agent",
        phase: "waitingForWorkspace",
        capabilities: {
          packageUpdateCheck: false,
          extensionUi: true,
          sessionExport: true,
        },
        modelConfigHealth: {
          state: "ok",
          source: "ModelRegistry.getError",
        },
        extensionDecisionPresentation: "auto",
      },
    });

    await expect(pending).resolves.toMatchObject({
      extensionDecisionPresentation: "auto",
    });
    client.detach("test cleanup");
  });

  it("sends and accepts the persisted Extension decision mode", async () => {
    const client = new HostClient();
    const transport = attachTestTransport(client);
    const pending = client.hello("pideck", "1.2.3", "inline-first");

    expect(transport.sent[0]).toMatchObject({
      method: "system.hello",
      params: {
        clientName: "pideck",
        clientVersion: "1.2.3",
        protocolVersion: 1,
        extensionDecisionPresentation: "inline-first",
      },
    });
    transport.emit({
      protocolVersion: 1,
      ...RESPONSE_IDENTITY,
      id: transport.sent[0]!.id,
      method: "system.hello",
      ok: true,
      result: {
        protocolVersion: 1,
        ...RESPONSE_IDENTITY,
        sdkVersion: "0.84.2",
        nodeVersion: "v24.18.0",
        agentDir: "/agent",
        phase: "waitingForWorkspace",
        capabilities: {
          packageUpdateCheck: false,
          extensionUi: true,
          sessionExport: true,
        },
        modelConfigHealth: {
          state: "ok",
          source: "ModelRegistry.getError",
        },
        extensionDecisionPresentation: "inline-first",
      },
    });

    await expect(pending).resolves.toMatchObject({
      extensionDecisionPresentation: "inline-first",
    });
    client.detach("test cleanup");
  });
});

describe("HostClient response settlement", () => {
  it("rejects a no-timeout request when its response fails protocol validation", async () => {
    const client = new HostClient();
    const transport = attachTestTransport(client);
    const pending = client.request(
      "system.shutdown",
      { expectedHostInstanceId: HOST_ID },
      null,
      null,
    );
    const outcomePromise = pending.then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );

    transport.emit({
      protocolVersion: 1,
      ...RESPONSE_IDENTITY,
      id: transport.sent[0]!.id,
      method: "system.shutdown",
      ok: true,
      result: { accepted: false },
    });
    const outcome = await Promise.race([
      outcomePromise,
      new Promise<{ status: "pending" }>((resolve) => {
        setTimeout(() => resolve({ status: "pending" }), 0);
      }),
    ]);
    client.detach("test cleanup");

    expect(outcome).toMatchObject({
      status: "rejected",
      error: expect.objectContaining({
        message: "Host protocol mismatch for system.shutdown response: invalid Host response",
      }),
    });
  });

  it("does not settle a live request from invalid messages without its exact id", async () => {
    const client = new HostClient();
    const transport = attachTestTransport(client);
    const pending = client.request(
      "system.shutdown",
      { expectedHostInstanceId: HOST_ID },
      null,
      null,
    );
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    transport.emit({ method: "system.shutdown", ok: true, result: { accepted: false } });
    transport.emit({
      protocolVersion: 1,
      ...RESPONSE_IDENTITY,
      id: UNKNOWN_REQUEST_ID,
      method: "system.shutdown",
      ok: true,
      result: { accepted: false },
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    transport.emit({
      protocolVersion: 1,
      ...RESPONSE_IDENTITY,
      id: transport.sent[0]!.id,
      method: "system.shutdown",
      ok: true,
      result: { accepted: true },
    });
    await expect(pending).resolves.toMatchObject({ result: { accepted: true } });
  });
});

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
  it("normalizes native send failures and reports a transport error", async () => {
    const client = new HostClient();
    client.attach({
      send: async () => Promise.reject("host not running"),
      onMessage: () => () => undefined,
    });
    const errors: Error[] = [];
    client.onTransportError((error) => errors.push(error));

    await expect(
      client.request("system.getStatus", { expectedHostInstanceId: "h1" }, null),
    ).rejects.toThrow("host not running");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    expect(errors[0]?.message).toBe("host not running");
  });

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
