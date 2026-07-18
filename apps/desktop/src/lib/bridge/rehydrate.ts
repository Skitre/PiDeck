/**
 * Full rehydrate sequence (R2/R7):
 * system.getStatus → workspace.getCurrent → session.getSnapshot →
 * agent.getTools (if session) → package.list
 */
import type {
  HostStatusSnapshot,
  PackageSnapshot,
  SessionSnapshot,
  ToolSnapshot,
  WorkspaceSnapshot,
} from "@pi-desktop/protocol";
import { hostClient } from "./host-client";
import { activeSessionContext, workspaceContext } from "./host-context";

export type RehydrateResult = {
  host: HostStatusSnapshot;
  workspace: WorkspaceSnapshot | null;
  session: SessionSnapshot | null;
  packages: PackageSnapshot | null;
  tools: ToolSnapshot | null;
};

export async function fullRehydrate(): Promise<RehydrateResult> {
  const hostId = hostClient.getHostInstanceId();
  if (!hostId) {
    throw new Error("No hostInstanceId — call hello first");
  }

  const statusRes = await hostClient.request(
    "system.getStatus",
    { expectedHostInstanceId: hostId },
    null,
    15_000,
  );
  if (!statusRes.ok) {
    throw new Error(statusRes.error?.message ?? "getStatus failed");
  }
  const host = statusRes.result;

  // workspace.getCurrent uses workspace-scoped context; when none selected, ids are null/0
  const wsRes = await hostClient.request(
    "workspace.getCurrent",
    {
      expectedHostInstanceId: host.hostInstanceId,
      expectedWorkspaceId: host.workspaceId,
      expectedWorkspaceRevision: host.workspaceRevision,
    },
    null,
  );
  if (!wsRes.ok) {
    throw new Error(wsRes.error?.message ?? "getCurrent workspace failed");
  }
  const workspace = wsRes.result;

  let session: SessionSnapshot | null = null;
  let tools: ToolSnapshot | null = null;
  let packages: PackageSnapshot | null = null;

  if (workspace?.servicesReady) {
    const snapRes = await hostClient.request(
      "session.getSnapshot",
      workspaceContext(host, workspace),
      null,
    );
    if (!snapRes.ok) {
      throw new Error(snapRes.error?.message ?? "session.getSnapshot failed");
    }
    session = snapRes.result;
    tools = session?.tools ?? null;

    if (session) {
      const toolsRes = await hostClient.request(
        "agent.getTools",
        activeSessionContext(host, workspace, session),
        null,
      );
      if (!toolsRes.ok) {
        throw new Error(toolsRes.error?.message ?? "agent.getTools failed");
      }
      tools = toolsRes.result;
    }

    const pkgRes = await hostClient.request(
      "package.list",
      workspaceContext(host, workspace),
      { scope: "all", includeResources: true },
      60_000,
    );
    if (!pkgRes.ok) {
      throw new Error(pkgRes.error?.message ?? "package.list failed");
    }
    packages = pkgRes.result;
  }

  return { host, workspace, session, packages, tools };
}
