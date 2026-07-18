import { randomUUID } from "node:crypto";
import type { HostIdentity } from "@pideck/protocol";

export class IdentityState {
  readonly hostInstanceId: string = randomUUID();
  workspaceId: string | null = null;
  workspaceRevision = 0;
  sessionId: string | null = null;
  sessionRevision = 0;
  packageRevision = 0;

  snapshot(): HostIdentity {
    return {
      hostInstanceId: this.hostInstanceId,
      workspaceId: this.workspaceId,
      workspaceRevision: this.workspaceRevision,
      sessionId: this.sessionId,
      sessionRevision: this.sessionRevision,
      packageRevision: this.packageRevision,
    };
  }

  bumpWorkspaceRevision(): number {
    this.workspaceRevision += 1;
    return this.workspaceRevision;
  }

  bumpSessionRevision(): number {
    this.sessionRevision += 1;
    return this.sessionRevision;
  }

  bumpPackageRevision(): number {
    this.packageRevision += 1;
    return this.packageRevision;
  }
}
