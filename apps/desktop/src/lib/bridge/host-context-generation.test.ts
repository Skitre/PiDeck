import { describe, expect, it } from "vitest";
import type { HostStatusSnapshot, WorkspaceSnapshot } from "@pideck/protocol";
import {
  captureRequestGeneration,
  captureWorkspaceAuthorization,
  isCurrentWorkspaceAuthorization,
  isExpectedPackageMutationCompletion,
  mergeHostIdentity,
} from "./host-context";

function host(overrides: Partial<HostStatusSnapshot> = {}): HostStatusSnapshot {
  return {
    protocolVersion: 1,
    hostInstanceId: "h1",
    workspaceId: "w1",
    workspaceRevision: 1,
    sessionId: "s1",
    sessionRevision: 1,
    packageRevision: 1,
    sdkVersion: "0.80.7",
    nodeVersion: process.version,
    agentDir: "C:/agent",
    phase: "ready",
    capabilities: { packageUpdateCheck: true, extensionUi: true, sessionExport: true },
    modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
    ...overrides,
  };
}

function workspace(): WorkspaceSnapshot {
  return {
    id: "w1",
    revision: 1,
    cwd: "C:/workspace",
    canonicalCwd: "C:/workspace",
    servicesReady: true,
  };
}

describe("response generation convergence", () => {
  it("accepts a Package mutation when its events already applied the response generation", () => {
    const captured = captureRequestGeneration(host());
    const response = host({ sessionRevision: 2, packageRevision: 2 });
    expect(isExpectedPackageMutationCompletion(response, captured, response)).toBe(true);
    expect(
      isExpectedPackageMutationCompletion(
        host({ sessionId: "other", sessionRevision: 1, packageRevision: 2 }),
        captured,
        response,
      ),
    ).toBe(false);
  });

  it("keeps unrelated Package progress when merging a Session response", () => {
    const current = host({ packageRevision: 3 });
    const merged = mergeHostIdentity(current, host({ sessionRevision: 2, packageRevision: 1 }));
    expect(merged?.sessionRevision).toBe(2);
    expect(merged?.packageRevision).toBe(3);
  });

  it("invalidates project authorization on generation changes", () => {
    const authorization = captureWorkspaceAuthorization(host(), workspace());
    expect(isCurrentWorkspaceAuthorization(host(), workspace(), authorization)).toBe(true);
    expect(
      isCurrentWorkspaceAuthorization(host({ packageRevision: 2 }), workspace(), authorization),
    ).toBe(false);
  });
});
