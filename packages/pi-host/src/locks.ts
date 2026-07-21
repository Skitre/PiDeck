/**
 * Concurrency primitives for Pi Host — PROJECT_SPEC §16.1
 */

export type GraphOperationKind =
  | "system.shutdown"
  | "workspace.setCurrent"
  | "session.create"
  | "session.open"
  | "session.reload"
  | "session.setName"
  | "session.rename"
  | "session.archive"
  | "session.restore"
  | "session.delete"
  | "session.cleanup"
  | "agent.setActiveTools"
  | "model.setCurrent"
  | "provider.mutation"
  | "package.mutation"
  | "package.reload"
  | "resource.setTopLevelEnabled"
  | "piSettings.patch"
  | "sdk.read";

export type LockOwner = {
  operationKind: GraphOperationKind;
  requestId: string;
  operationId?: string;
  startedAt: number;
};

export class TryMutex {
  private owner: LockOwner | null = null;

  tryAcquire(owner: Omit<LockOwner, "startedAt">): boolean {
    if (this.owner) return false;
    this.owner = { ...owner, startedAt: Date.now() };
    return true;
  }

  release(requestId?: string): void {
    if (requestId && this.owner && this.owner.requestId !== requestId) {
      return;
    }
    this.owner = null;
  }

  isHeld(): boolean {
    return this.owner !== null;
  }

  getOwner(): LockOwner | null {
    return this.owner;
  }
}

export class AgentOperationLock {
  private active = false;
  private requestId: string | null = null;

  tryAcquire(requestId: string): boolean {
    if (this.active) return false;
    this.active = true;
    this.requestId = requestId;
    return true;
  }

  release(requestId?: string): void {
    if (requestId && this.requestId && this.requestId !== requestId) return;
    this.active = false;
    this.requestId = null;
  }

  isHeld(): boolean {
    return this.active;
  }
}
