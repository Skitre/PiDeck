import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostIdentity } from "@pideck/protocol";
import { PiHostServer } from "./server.js";

const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const ACTIVE_SESSION_ID = "33333333-3333-4333-8333-333333333333";
const BACKGROUND_SESSION_ID = "44444444-4444-4444-8444-444444444444";

function server(): PiHostServer {
  const instance = new PiHostServer({
    agentDir: "C:/agent",
    sdkVersion: "0.80.7",
    getModelConfigHealth: () => ({
      state: "ok",
      source: "ModelRegistry.getError",
    }),
    capabilities: {
      packageUpdateCheck: false,
      extensionUi: true,
      sessionExport: false,
    },
    handlers: {},
  });
  instance.identity.workspaceId = WORKSPACE_ID;
  instance.identity.workspaceRevision = 1;
  instance.identity.sessionId = ACTIVE_SESSION_ID;
  instance.identity.sessionRevision = 2;
  return instance;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PiHostServer.emitForIdentity", () => {
  it("keeps the global sequence while labeling an event with a background Session", async () => {
    const host = server();
    const lines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(
      ((chunk: string | Uint8Array) => {
        lines.push(String(chunk));
        return true;
      }) as typeof process.stdout.write,
    );
    const identity: HostIdentity = {
      ...host.getIdentity(),
      sessionId: BACKGROUND_SESSION_ID,
      sessionRevision: 7,
    };

    host.emitForIdentity(identity, "session.runtimeChanged", {
      sessionId: BACKGROUND_SESSION_ID,
      sessionRevision: 7,
      state: "running",
      updatedAt: 1,
    });
    host.emit("host.statusChanged", host.buildStatus());
    // Writes flush asynchronously through the outbound queue.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    const second = JSON.parse(lines[1]!) as Record<string, unknown>;
    expect(first.sessionId).toBe(BACKGROUND_SESSION_ID);
    expect(first.sessionRevision).toBe(7);
    expect(first.sequence).toBe(1);
    expect(second.sessionId).toBe(ACTIVE_SESSION_ID);
    expect(second.sequence).toBe(2);
  });

  it("rejects identities from another Workspace epoch", () => {
    const host = server();
    expect(() =>
      host.emitForIdentity(
        { ...host.getIdentity(), workspaceRevision: 2 },
        "session.runtimeChanged",
        {
          sessionId: ACTIVE_SESSION_ID,
          sessionRevision: 2,
          state: "idle",
          updatedAt: 1,
        },
      ),
    ).toThrow("stale Host or Workspace identity");
  });
});

describe("PiHostServer shutdown", () => {
  it("does not dispose the graph while a mutation owns the graph lock", async () => {
    const dispose = vi.fn(async () => {});
    const host = new PiHostServer({
      agentDir: "C:/agent",
      sdkVersion: "0.80.7",
      getModelConfigHealth: () => ({
        state: "ok",
        source: "ModelRegistry.getError",
      }),
      capabilities: {
        packageUpdateCheck: false,
        extensionUi: true,
        sessionExport: false,
      },
      handlers: {},
      onShutdown: dispose,
    });
    const shutdown = vi.spyOn(host, "shutdown").mockResolvedValue();
    vi.spyOn(process.stdout, "write").mockImplementation(
      (() => true) as typeof process.stdout.write,
    );
    expect(
      host.serviceGraphLock.tryAcquire({
        operationKind: "package.mutation",
        requestId: "package-request",
      }),
    ).toBe(true);

    await host.handleLine(
      JSON.stringify({
        protocolVersion: 1,
        id: "55555555-5555-4555-8555-555555555555",
        method: "system.shutdown",
        context: { expectedHostInstanceId: host.identity.hostInstanceId },
        params: null,
      }),
    );

    expect(dispose).not.toHaveBeenCalled();
    expect(shutdown).toHaveBeenCalledOnce();
    expect(host.serviceGraphLock.getOwner()).toMatchObject({
      operationKind: "package.mutation",
      requestId: "package-request",
    });
  });
});
