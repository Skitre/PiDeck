import { describe, expect, it } from "vitest";
import type { HostIdentity, HostStatusSnapshot } from "@pideck/protocol";
import {
  captureRequestGeneration,
  isCurrentRequestGeneration,
  mergeHostIdentity,
} from "./host-context";

const current: HostStatusSnapshot = {
  protocolVersion: 1,
  hostInstanceId: "11111111-1111-4111-8111-111111111111",
  phase: "ready",
  sdkVersion: "0.80.7",
  nodeVersion: "v24.18.0",
  agentDir: "C:\\temp\\agent",
  modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
  capabilities: {
    packageUpdateCheck: false,
    extensionUi: true,
    sessionExport: true,
  },
  workspaceId: "22222222-2222-4222-8222-222222222222",
  workspaceRevision: 3,
  sessionId: "33333333-3333-4333-8333-333333333333",
  sessionRevision: 8,
  packageRevision: 5,
};

function identity(overrides: Partial<HostIdentity> = {}): HostIdentity {
  return {
    hostInstanceId: current.hostInstanceId,
    workspaceId: current.workspaceId,
    workspaceRevision: current.workspaceRevision,
    sessionId: current.sessionId,
    sessionRevision: current.sessionRevision,
    packageRevision: current.packageRevision,
    ...overrides,
  };
}

describe("mergeHostIdentity", () => {
  it("preserves a newer session generation when a read response carries older closure state", () => {
    const merged = mergeHostIdentity(
      current,
      identity({ sessionRevision: 7, packageRevision: 6 }),
    );

    expect(merged).toMatchObject({
      sessionId: current.sessionId,
      sessionRevision: 8,
      packageRevision: 6,
    });
  });

  it("advances session and package generations from a mutation response", () => {
    const nextSessionId = "44444444-4444-4444-8444-444444444444";
    const merged = mergeHostIdentity(
      current,
      identity({
        sessionId: nextSessionId,
        sessionRevision: 9,
        packageRevision: 6,
      }),
    );

    expect(merged).toMatchObject({
      sessionId: nextSessionId,
      sessionRevision: 9,
      packageRevision: 6,
    });
  });

  it("ignores identities from a retired Host", () => {
    expect(
      mergeHostIdentity(
        current,
        identity({ hostInstanceId: "55555555-5555-4555-8555-555555555555" }),
      ),
    ).toBeNull();
  });
});

describe("request generation guards", () => {
  it("accepts the exact captured session and package generation", () => {
    const generation = captureRequestGeneration(current);
    expect(
      isCurrentRequestGeneration(current, generation, {
        session: true,
        packages: true,
      }),
    ).toBe(true);
  });

  it("rejects a different session with the same numeric revision", () => {
    const generation = captureRequestGeneration(current);
    expect(
      isCurrentRequestGeneration(
        { ...current, sessionId: "44444444-4444-4444-8444-444444444444" },
        generation,
        { session: true },
      ),
    ).toBe(false);
  });

  it("rejects a package completion after another package generation committed", () => {
    const generation = captureRequestGeneration(current);
    expect(
      isCurrentRequestGeneration(
        { ...current, packageRevision: current.packageRevision + 1 },
        generation,
        { session: true, packages: true },
      ),
    ).toBe(false);
  });
});
