import {
  createEvent,
  createFailureResponse,
  createHostError,
  createSuccessResponse,
  parseHostRequest,
  validateEventPayload,
  validateSuccessResult,
  type HostError,
  type HostEventName,
  type HostIdentity,
  type HostMethod,
  type HostPhase,
  type HostStatusSnapshot,
  type ModelConfigHealth,
  type HostCapabilities,
} from "@pideck/protocol";
import { IdentityState } from "./identity.js";
import { AgentOperationLock, TryMutex } from "./locks.js";
import { logger } from "./logger.js";
import { createLineReader } from "./transport.js";

export type HostRuntimeDeps = {
  agentDir: string;
  sdkVersion: string;
  getModelConfigHealth: () => ModelConfigHealth;
  capabilities: HostCapabilities;
  /** Method handlers registered by controllers */
  handlers: Partial<Record<HostMethod, MethodHandler>>;
  /** Optional graceful cleanup before process exit */
  onShutdown?: () => Promise<void>;
};

export type MethodHandler = (
  ctx: HandlerContext,
) => Promise<
  | { result: unknown; identity?: HostIdentity }
  | { error: HostError; identity?: HostIdentity }
>;

export type HandlerContext = {
  id: string;
  method: HostMethod;
  params: unknown;
  context: Record<string, unknown>;
  identity: IdentityState;
  serviceGraphLock: TryMutex;
  agentOperationLock: AgentOperationLock;
  getStatus: () => HostStatusSnapshot;
  setPhase: (phase: HostPhase) => void;
  emit: (event: HostEventName, payload: unknown) => void;
  writeResponse: (body: unknown) => void;
};

export class PiHostServer {
  readonly identity = new IdentityState();
  readonly serviceGraphLock = new TryMutex();
  readonly agentOperationLock = new AgentOperationLock();
  private sequence = 0;
  private phase: HostPhase = "booting";
  private shuttingDown = false;
  private lastError?: HostError;
  private fatalError?: HostError;
  private readonly deps: HostRuntimeDeps;
  private stopReader: (() => void) | null = null;

  constructor(deps: HostRuntimeDeps) {
    this.deps = deps;
  }

  getIdentity(): HostIdentity {
    return this.identity.snapshot();
  }

  setPhase(phase: HostPhase): void {
    this.phase = phase;
  }

  getPhase(): HostPhase {
    return this.phase;
  }

  setLastError(error: HostError | undefined): void {
    this.lastError = error;
  }

  setFatalError(error: HostError): void {
    this.fatalError = error;
    this.phase = "fatal";
  }

  buildStatus(): HostStatusSnapshot {
    return {
      ...this.identity.snapshot(),
      protocolVersion: 1,
      sdkVersion: this.deps.sdkVersion,
      nodeVersion: process.version,
      agentDir: this.deps.agentDir,
      phase: this.phase,
      capabilities: this.deps.capabilities,
      modelConfigHealth: this.deps.getModelConfigHealth(),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.fatalError ? { fatalError: this.fatalError } : {}),
    };
  }

  emit(event: HostEventName, payload: unknown): void {
    this.emitForIdentity(this.identity.snapshot(), event, payload);
  }

  emitForIdentity(identity: HostIdentity, event: HostEventName, payload: unknown): void {
    const current = this.identity.snapshot();
    if (
      identity.hostInstanceId !== current.hostInstanceId ||
      identity.workspaceId !== current.workspaceId ||
      identity.workspaceRevision !== current.workspaceRevision
    ) {
      throw new Error("Cannot emit an event for a stale Host or Workspace identity");
    }
    const validation = validateEventPayload(event, payload);
    if (!validation.ok) {
      const error = createHostError("INTERNAL_ERROR", `Invalid outbound ${event} payload`, {
        details: { event, validation: validation.error.message },
      });
      this.setFatalError(error);
      logger.error("Rejected invalid outbound Host event", {
        event,
        validation: validation.error.message,
      });
      throw new Error(error.message);
    }

    this.sequence += 1;
    const msg = createEvent(
      identity,
      event,
      this.sequence,
      payload as never,
    );
    this.writeLine(msg);
  }

  private writeLine(obj: unknown): void {
    process.stdout.write(JSON.stringify(obj) + "\n");
  }

  writeResponse(body: unknown): void {
    this.writeLine(body);
  }

  async start(): Promise<void> {
    this.phase = "waitingForWorkspace";
    this.emit("host.ready", this.buildStatus());
    logger.info("Pi Host ready", {
      hostInstanceId: this.identity.hostInstanceId,
      sdkVersion: this.deps.sdkVersion,
      agentDir: this.deps.agentDir,
    });

    this.stopReader = createLineReader(process.stdin, (line) => {
      void this.handleLine(line);
    });

    // Exit when the peer closes stdin — otherwise a crashed/killed UI leaves
    // an orphaned host holding the SDK and its child processes (no parent-death
    // signal exists on Windows).
    const onStdinClosed = () => {
      void this.requestShutdown("stdin closed by peer");
    };
    process.stdin.once("end", onStdinClosed);
    process.stdin.once("close", onStdinClosed);
  }

  /** Graceful shutdown for transport loss / signals — mirrors system.shutdown cleanup. */
  async requestShutdown(reason: string): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.phase = "shuttingDown";
    logger.warn("Shutting down Pi Host", { reason });
    const requestId = `shutdown:${reason}`;
    const ownsGraphLock = this.serviceGraphLock.tryAcquire({
      operationKind: "system.shutdown",
      requestId,
    });
    try {
      if (ownsGraphLock && this.deps.onShutdown) {
        await this.deps.onShutdown();
      } else if (!ownsGraphLock) {
        logger.warn("Skipping graph disposal during an active graph mutation", {
          operationKind: this.serviceGraphLock.getOwner()?.operationKind ?? null,
        });
      }
    } catch (err) {
      logger.error("Cleanup during shutdown failed", {
        reason,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (ownsGraphLock) this.serviceGraphLock.release(requestId);
    }
    await this.shutdown();
  }

  async handleLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;

    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      logger.warn("Invalid JSON on stdin", { preview: trimmed.slice(0, 200) });
      this.writeResponse(
        createFailureResponse(
          this.identity.snapshot(),
          "unknown",
          "unknown",
          createHostError("INVALID_REQUEST", "Invalid JSON on stdin"),
        ),
      );
      return;
    }

    let parsed: ReturnType<typeof parseHostRequest>;
    try {
      parsed = parseHostRequest(raw);
    } catch (err) {
      // Validator internal failure must degrade to a protocol error, never an
      // unhandled rejection that kills the host.
      logger.error("parseHostRequest threw", {
        error: err instanceof Error ? err.message : String(err),
      });
      this.writeResponse(
        createFailureResponse(
          this.identity.snapshot(),
          "unknown",
          "unknown",
          createHostError("INTERNAL_ERROR", "Request validation failed internally"),
        ),
      );
      return;
    }
    if (!parsed.ok) {
      const id =
        typeof raw === "object" &&
        raw !== null &&
        "id" in raw &&
        typeof (raw as { id: unknown }).id === "string"
          ? (raw as { id: string }).id
          : "unknown";
      const method =
        typeof raw === "object" &&
        raw !== null &&
        "method" in raw &&
        typeof (raw as { method: unknown }).method === "string"
          ? (raw as { method: string }).method
          : "unknown";
      this.writeResponse(
        createFailureResponse(this.identity.snapshot(), id, method, parsed.error),
      );
      return;
    }

    const { id, method, context, params } = parsed.value;

    if (this.shuttingDown && method !== "system.shutdown") {
      this.writeResponse(
        createFailureResponse(
          this.identity.snapshot(),
          id,
          method,
          createHostError("HOST_SHUTTING_DOWN", "Host is shutting down"),
        ),
      );
      return;
    }

    // Built-in system handlers
    if (method === "system.hello") {
      this.writeResponse(
        createSuccessResponse(this.identity.snapshot(), id, method, this.buildStatus()),
      );
      return;
    }

    if (method === "system.getStatus") {
      const expected = context.expectedHostInstanceId;
      if (expected !== this.identity.hostInstanceId) {
        this.writeResponse(
          createFailureResponse(
            this.identity.snapshot(),
            id,
            method,
            createHostError("STALE_REVISION", "expectedHostInstanceId does not match"),
          ),
        );
        return;
      }
      this.writeResponse(
        createSuccessResponse(this.identity.snapshot(), id, method, this.buildStatus()),
      );
      return;
    }

    if (method === "system.shutdown") {
      const expected = context.expectedHostInstanceId;
      if (expected !== this.identity.hostInstanceId) {
        this.writeResponse(
          createFailureResponse(
            this.identity.snapshot(),
            id,
            method,
            createHostError("STALE_REVISION", "expectedHostInstanceId does not match"),
          ),
        );
        return;
      }
      // C2: cleanup graph/settings/UI BEFORE success response (B-SHUTDOWN-01)
      this.shuttingDown = true;
      this.phase = "shuttingDown";
      const ownsGraphLock = this.serviceGraphLock.tryAcquire({
        operationKind: "system.shutdown",
        requestId: id,
      });
      try {
        if (ownsGraphLock && this.deps.onShutdown) {
          await this.deps.onShutdown();
        } else if (!ownsGraphLock) {
          logger.warn("Skipping graph disposal during an active graph mutation", {
            operationKind: this.serviceGraphLock.getOwner()?.operationKind ?? null,
          });
        }
        this.writeResponse(
          createSuccessResponse(this.identity.snapshot(), id, method, { accepted: true }),
        );
      } catch (err) {
        this.writeResponse(
          createFailureResponse(
            this.identity.snapshot(),
            id,
            method,
            createHostError(
              "INTERNAL_ERROR",
              err instanceof Error ? err.message : "shutdown cleanup failed",
            ),
          ),
        );
      } finally {
        if (ownsGraphLock) this.serviceGraphLock.release(id);
      }
      await this.shutdown();
      return;
    }

    // Identity pre-check for host instance
    if (
      typeof context.expectedHostInstanceId === "string" &&
      context.expectedHostInstanceId !== this.identity.hostInstanceId
    ) {
      this.writeResponse(
        createFailureResponse(
          this.identity.snapshot(),
          id,
          method,
          createHostError("STALE_REVISION", "expectedHostInstanceId does not match"),
        ),
      );
      return;
    }

    const handler = this.deps.handlers[method];
    if (!handler) {
      this.writeResponse(
        createFailureResponse(
          this.identity.snapshot(),
          id,
          method,
          createHostError("UNSUPPORTED_METHOD", `Method not implemented: ${method}`, {
            details: { method },
          }),
        ),
      );
      return;
    }

    const handlerCtx: HandlerContext = {
      id,
      method,
      params,
      context,
      identity: this.identity,
      serviceGraphLock: this.serviceGraphLock,
      agentOperationLock: this.agentOperationLock,
      getStatus: () => this.buildStatus(),
      setPhase: (p) => this.setPhase(p),
      emit: (e, p) => this.emit(e, p),
      writeResponse: (b) => this.writeResponse(b),
    };

    try {
      const outcome = await handler(handlerCtx);
      // Prefer identity captured by stable graph helpers — never re-label old results
      const idForResponse = outcome.identity ?? this.identity.snapshot();
      if (outcome.identity) {
        const cur = this.identity.snapshot();
        if (
          outcome.identity.workspaceRevision !== cur.workspaceRevision ||
          outcome.identity.sessionRevision !== cur.sessionRevision ||
          outcome.identity.packageRevision !== cur.packageRevision ||
          outcome.identity.workspaceId !== cur.workspaceId ||
          outcome.identity.sessionId !== cur.sessionId
        ) {
          // Generation moved after handler finished without capturing correctly
          if ("error" in outcome) {
            this.writeResponse(
              createFailureResponse(cur, id, method, outcome.error),
            );
          } else {
            this.writeResponse(
              createFailureResponse(
                cur,
                id,
                method,
                createHostError("STALE_REVISION", "Graph replaced before response write"),
              ),
            );
          }
          return;
        }
      }
      if ("error" in outcome) {
        this.writeResponse(createFailureResponse(idForResponse, id, method, outcome.error));
      } else {
        const validation = validateSuccessResult(method, outcome.result);
        if (!validation.ok) {
          logger.error("Rejected invalid outbound Host result", {
            method,
            validation: validation.error.message,
          });
          this.writeResponse(
            createFailureResponse(
              idForResponse,
              id,
              method,
              createHostError("INTERNAL_ERROR", `Handler returned invalid ${method} result`, {
                details: { method, validation: validation.error.message },
              }),
            ),
          );
          return;
        }
        this.writeResponse(
          createSuccessResponse(idForResponse, id, method, outcome.result as never),
        );
      }
    } catch (err) {
      logger.error("Handler threw", {
        method,
        error: err instanceof Error ? err.message : String(err),
      });
      this.writeResponse(
        createFailureResponse(
          this.identity.snapshot(),
          id,
          method,
          createHostError(
            "INTERNAL_ERROR",
            err instanceof Error ? err.message : "Internal error",
          ),
        ),
      );
    }
  }

  async shutdown(): Promise<void> {
    logger.info("Pi Host shutting down");
    this.phase = "shuttingDown";
    this.shuttingDown = true;
    // onShutdown may already have run from system.shutdown handler
    this.stopReader?.();
    // Drain stdout fully before exit — no fixed 50ms exit that skips cleanup
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      if (process.stdout.write("")) {
        // schedule microtask so response flush can complete
        setImmediate(done);
      } else {
        process.stdout.once("drain", done);
        setTimeout(done, 500);
      }
    });
    process.exitCode = 0;
    process.exit(0);
  }
}
