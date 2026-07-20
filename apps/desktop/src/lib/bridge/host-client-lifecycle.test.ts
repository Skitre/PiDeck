import { describe, expect, it } from "vitest";
import { HostClient, type HostTransport } from "./host-client";

const identity = (hostInstanceId: string) => ({
  hostInstanceId,
  workspaceId: null,
  workspaceRevision: 0,
  sessionId: null,
  sessionRevision: 0,
  packageRevision: 0,
});

function ready(hostInstanceId: string, timestamp = Date.now()) {
  return JSON.stringify({
    protocolVersion: 1,
    event: "host.ready",
    sequence: 1,
    timestamp,
    ...identity(hostInstanceId),
    payload: {
      protocolVersion: 1,
      ...identity(hostInstanceId),
      sdkVersion: "0.80.7",
      nodeVersion: process.version,
      agentDir: "C:/isolated-agent",
      phase: "waitingForWorkspace",
      capabilities: {
        packageUpdateCheck: true,
        extensionUi: true,
        projectTrust: true,
        sessionExport: true,
      },
      modelConfigHealth: {
        state: "ok",
        source: "ModelRegistry.getError",
      },
    },
  });
}

function lifecycleFatal(hostInstanceId: string, message: string, timestamp = Date.now()) {
  return JSON.stringify({
    protocolVersion: 1,
    event: "host.fatal",
    sequence: 1,
    timestamp,
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

function transportFixture() {
  let handler: ((line: string) => void) | null = null;
  const sent: string[] = [];
  let disposed = 0;
  const transport: HostTransport = {
    send: (line) => {
      sent.push(line);
    },
    onMessage: (next) => {
      handler = next;
      return () => {
        handler = null;
      };
    },
    dispose: () => {
      disposed += 1;
    },
  };
  return {
    transport,
    sent,
    disposedCount: () => disposed,
    emit(line: string) {
      if (!handler) throw new Error("transport is not attached");
      handler(line);
    },
  };
}

describe("HostClient Rust lifecycle epochs", () => {
  for (const [name, sentinel] of [
    ["startup failure", "00000000-0000-4000-8000-000000000001"],
    ["process exit", "00000000-0000-4000-8000-000000000002"],
    ["auto-restart failure", "00000000-0000-4000-8000-000000000003"],
  ] as const) {
    it(`retires the active epoch, rejects pending work, and accepts recovery after ${name}`, async () => {
      const client = new HostClient();
      const wire = transportFixture();
      const events: string[] = [];
      client.attach(wire.transport);
      client.onEvent((event) => events.push(event.event));

      const activeId = "10000000-0000-4000-8000-000000000001";
      const replacementId = "20000000-0000-4000-8000-000000000001";
      wire.emit(ready(activeId));
      expect(client.getHostInstanceId()).toBe(activeId);

      const pending = client.request(
        "system.getStatus",
        { expectedHostInstanceId: activeId },
        null,
        null,
      );
      expect(wire.sent).toHaveLength(1);

      wire.emit(lifecycleFatal(sentinel, `${name} sentinel`));
      await expect(pending).rejects.toThrow(`${name} sentinel`);
      expect(client.getHostInstanceId()).toBeNull();
      expect(events.at(-1)).toBe("host.fatal");

      wire.emit(ready(replacementId));
      expect(client.getHostInstanceId()).toBe(replacementId);
      expect(events.at(-1)).toBe("host.ready");
      client.detach();
    });
  }

  it("ignores a lifecycle fatal delivered after a newer Host is ready", () => {
    const client = new HostClient();
    const wire = transportFixture();
    const events: string[] = [];
    client.attach(wire.transport);
    client.onEvent((event) => events.push(event.event));

    const replacementId = "20000000-0000-4000-8000-000000000001";
    wire.emit(ready(replacementId, 200));
    wire.emit(
      lifecycleFatal(
        "00000000-0000-4000-8000-000000000002",
        "stale process exit",
        100,
      ),
    );

    expect(client.getHostInstanceId()).toBe(replacementId);
    expect(events).toEqual(["host.ready"]);
    client.detach();
  });
});

describe("HostClient transport disposal", () => {
  it("disposes the transport on detach", () => {
    const client = new HostClient();
    const wire = transportFixture();
    client.attach(wire.transport);
    expect(wire.disposedCount()).toBe(0);

    client.detach();
    expect(wire.disposedCount()).toBe(1);
  });

  it("disposes the previous transport when a replacement attaches", () => {
    const client = new HostClient();
    const first = transportFixture();
    const second = transportFixture();
    client.attach(first.transport);
    client.attach(second.transport);

    expect(first.disposedCount()).toBe(1);
    expect(second.disposedCount()).toBe(0);

    client.detach();
    expect(first.disposedCount()).toBe(1);
    expect(second.disposedCount()).toBe(1);
  });
});
