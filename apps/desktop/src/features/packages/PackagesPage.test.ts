import { describe, expect, it } from "vitest";
import type { HostStatusSnapshot, WorkspaceSnapshot } from "@pideck/protocol";
import { captureWorkspaceAuthorization } from "../../lib/bridge/host-context";
import {
  reconcileProjectGateAuthorization,
  type PendingProjectMutation,
} from "./PackagesPage";

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
    capabilities: {
      packageUpdateCheck: true,
      extensionUi: true,
      sessionExport: true,
    },
    modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
    ...overrides,
  };
}

function workspace(overrides: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return {
    id: "w1",
    revision: 1,
    cwd: "C:/workspace",
    canonicalCwd: "C:/workspace",
    servicesReady: true,
    ...overrides,
  };
}

function gate(): PendingProjectMutation {
  return {
    method: "package.install",
    params: { source: "C:/fixture", scope: "project" },
    authorization: captureWorkspaceAuthorization(host(), workspace()),
  };
}

describe("project Package confirmation gate", () => {
  it("keeps confirmation valid while the complete generation is unchanged", () => {
    const pending = gate();
    expect(reconcileProjectGateAuthorization(host(), workspace(), pending)).toBe(pending);
  });

  it("closes confirmation after workspace, Session, or Package generation changes", () => {
    const pending = gate();
    expect(
      reconcileProjectGateAuthorization(
        host({ workspaceId: "w2" }),
        workspace({ id: "w2" }),
        pending,
      ),
    ).toBeNull();
    expect(
      reconcileProjectGateAuthorization(host({ sessionRevision: 2 }), workspace(), pending),
    ).toBeNull();
    expect(
      reconcileProjectGateAuthorization(host({ packageRevision: 2 }), workspace(), pending),
    ).toBeNull();
  });
});
