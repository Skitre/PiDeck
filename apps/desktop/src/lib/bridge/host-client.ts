import {
  isHostEvent,
  isHostResponse,
  parseHostEvent,
  parseHostResponse,
  type HostContextMap,
  type HostEventEnvelope,
  type HostEventName,
  type HostMethod,
  type HostRequestParams,
  type HostResponseEnvelope,
  type HostStatusSnapshot,
} from "@pideck/protocol";

export type HostTransport = {
  send: (line: string) => void | Promise<void>;
  onMessage: (handler: (line: string) => void) => () => void;
  /** Tear down transport-owned resources (e.g. native Tauri event listeners). */
  dispose?: () => void;
};

type Pending = {
  resolve: (value: HostResponseEnvelope) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  method: HostMethod | string;
};

export type HostEventMessage = HostEventEnvelope;

/**
 * Typed protocol client for the Node Pi Host.
 * React never imports pi-coding-agent — only this bridge talks JSONL.
 */
export class HostClient {
  private transport: HostTransport | null = null;
  private pending = new Map<string, Pending>();
  private sequence = 0;
  private hostInstanceId: string | null = null;
  private eventHandlers = new Set<(event: HostEventEnvelope) => void>();
  private detached = false;
  private disposeTransport: (() => void) | null = null;
  private retiredHostInstanceIds = new Set<string>();

  attach(transport: HostTransport): void {
    this.disposeTransport?.();
    this.transport?.dispose?.();
    this.rejectAllPending("transport replaced");
    this.transport = transport;
    this.detached = false;
    this.disposeTransport = transport.onMessage((line) => this.handleLine(line));
  }

  detach(reason = "transport detached"): void {
    this.detached = true;
    this.disposeTransport?.();
    this.disposeTransport = null;
    this.transport?.dispose?.();
    this.transport = null;
    this.rejectAllPending(reason);
  }

  /** Reject pending requests without detaching transport (crash/restart epoch). */
  rejectAllPending(reason = "host epoch ended"): void {
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  onEvent(handler: (event: HostEventEnvelope) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  getHostInstanceId(): string | null {
    return this.hostInstanceId;
  }

  getLastSequence(): number {
    return this.sequence;
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }

    if (isHostResponse(msg)) {
      // C3: deep envelope + method result validation at client boundary
      const deep = parseHostResponse(msg);
      if (!deep.ok) {
        return;
      }
      const response = deep.value as HostResponseEnvelope;
      if (
        this.hostInstanceId &&
        response.hostInstanceId !== this.hostInstanceId &&
        response.method !== "system.hello"
      ) {
        return;
      }
      const p = this.pending.get(response.id);
      if (p) {
        if (p.method !== response.method && response.method !== "system.hello") {
          if (p.timer) clearTimeout(p.timer);
          this.pending.delete(response.id);
          p.reject(
            new Error(
              `Response method mismatch: pending=${String(p.method)} got=${String(response.method)}`,
            ),
          );
          return;
        }
        if (p.timer) clearTimeout(p.timer);
        this.pending.delete(response.id);
        p.resolve(response);
      }
      return;
    }

    if (isHostEvent(msg)) {
      const deepEv = parseHostEvent(msg);
      if (!deepEv.ok) {
        return;
      }
      const event = deepEv.value as HostEventEnvelope;
      const syntheticLifecycleFatal =
        event.event === "host.fatal" &&
        event.sequence === 1 &&
        [
          "00000000-0000-4000-8000-000000000001",
          "00000000-0000-4000-8000-000000000002",
          "00000000-0000-4000-8000-000000000003",
        ].includes(event.hostInstanceId);
      if (syntheticLifecycleFatal) {
        if (this.hostInstanceId) this.retiredHostInstanceIds.add(this.hostInstanceId);
        this.hostInstanceId = null;
        this.sequence = 0;
        this.rejectAllPending(event.payload.error.message);
        for (const h of this.eventHandlers) h(event);
        return;
      }
      if (event.event === "host.ready") {
        const nextHostId = event.hostInstanceId;
        if (this.retiredHostInstanceIds.has(nextHostId)) return;
        if (this.hostInstanceId && this.hostInstanceId !== nextHostId) {
          this.retiredHostInstanceIds.add(this.hostInstanceId);
          this.rejectAllPending("host epoch replaced");
        }
        this.hostInstanceId = nextHostId;
        this.sequence = event.sequence;
      } else {
        if (!this.hostInstanceId || event.hostInstanceId !== this.hostInstanceId) return;
        if (event.sequence <= this.sequence) return;
        this.sequence = event.sequence;
      }

      for (const h of this.eventHandlers) h(event);
    }
  }

  async request<M extends HostMethod>(
    method: M,
    context: HostContextMap[M],
    params: HostRequestParams[M],
    timeoutMs: number | null = 30_000,
  ): Promise<HostResponseEnvelope<M>> {
    if (!this.transport || this.detached) {
      throw new Error("Host transport not attached");
    }
    const id = crypto.randomUUID();
    const body = {
      protocolVersion: 1 as const,
      id,
      method,
      context,
      params,
    };

    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs === null
          ? null
          : setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`Request timeout: ${method}`));
            }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (v: HostResponseEnvelope) => void,
        reject,
        timer,
        method,
      });
      void Promise.resolve(this.transport!.send(JSON.stringify(body) + "\n")).catch((err) => {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      });
    }) as Promise<HostResponseEnvelope<M>>;
  }

  async hello(clientName = "pideck", clientVersion = "0.1.0"): Promise<HostStatusSnapshot> {
    const res = await this.request(
      "system.hello",
      {} as HostContextMap["system.hello"],
      { clientName, clientVersion, protocolVersion: 1 },
      10_000,
    );
    if (!res.ok) {
      throw new Error(res.error?.message ?? "hello failed");
    }
    const status = res.result;
    if (this.retiredHostInstanceIds.has(status.hostInstanceId)) {
      throw new Error("hello returned a retired Host instance");
    }
    if (this.hostInstanceId && this.hostInstanceId !== status.hostInstanceId) {
      this.retiredHostInstanceIds.add(this.hostInstanceId);
      this.rejectAllPending("host epoch replaced by hello");
      this.sequence = 0;
    }
    this.hostInstanceId = status.hostInstanceId;
    return status;
  }

  shouldAcceptEvent(
    event: {
      event: HostEventName | string;
      hostInstanceId: string;
      workspaceId: string | null;
      workspaceRevision: number;
      sessionId: string | null;
      sessionRevision: number;
    },
    expected: {
      hostInstanceId: string | null;
      workspaceId?: string | null;
      workspaceRevision?: number;
      sessionId?: string | null;
      sessionRevision?: number;
    },
  ): boolean {
    if (event.event === "host.ready" || event.event === "host.fatal") return true;
    if (expected.hostInstanceId && event.hostInstanceId !== expected.hostInstanceId) {
      return false;
    }
    if (expected.workspaceId !== undefined && event.workspaceId !== expected.workspaceId) {
      return false;
    }
    if (
      expected.workspaceRevision !== undefined &&
      event.workspaceRevision !== expected.workspaceRevision
    ) {
      return false;
    }
    if (
      expected.sessionId !== undefined &&
      event.sessionId !== null &&
      expected.sessionId !== null &&
      event.sessionId !== expected.sessionId
    ) {
      return false;
    }
    if (
      expected.sessionRevision !== undefined &&
      event.sessionId !== null &&
      event.sessionRevision !== expected.sessionRevision
    ) {
      return false;
    }
    return true;
  }
}

export const hostClient = new HostClient();

// re-export for callers
export type { HostEventName, HostStatusSnapshot };
