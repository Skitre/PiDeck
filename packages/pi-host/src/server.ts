import {
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
  type RehydrateSnapshot,
  type HostStatusSnapshot,
  type ModelConfigHealth,
  type HostCapabilities,
  type ExtensionDecisionPresentation,
  type ExtensionDialogPresentationOverrides,
  isExtensionDialogPresentationOverrides,
} from "@pideck/protocol";
import { IdentityState } from "./identity.js";
import { TryMutex } from "./locks.js";
import { logger } from "./logger.js";
import { GraphOperationRegistry } from "./operation-lifecycle.js";
import { OutboundWriter } from "./outbound-queue.js";
import { createLineReader } from "./transport.js";

export const HOST_SHUTDOWN_QUIESCE_TIMEOUT_MS = 8_000;

const PARKED_WORKSPACE_EVENTS = new Set<HostEventName>([
  "agent.event",
  "session.runtimeChanged",
  "session.infoChanged",
  "agent.queueChanged",
]);

function isParkedWorkspaceEvent(event: HostEventName): boolean {
  return PARKED_WORKSPACE_EVENTS.has(event);
}

async function completesWithin(operation: Promise<void>, timeoutMs: number): Promise<boolean> {
  if (timeoutMs <= 0) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  const completed = operation.then(
    () => ({ kind: "completed" as const }),
    (error: unknown) => ({ kind: "failed" as const, error }),
  );
  const result = await Promise.race([completed, expired]);
  if (timer) clearTimeout(timer);
  if (result === false) return false;
  if (result.kind === "failed") throw result.error;
  return true;
}

export type HostRuntimeDeps = {
  agentDir: string;
  sdkVersion: string;
  getModelConfigHealth: () => ModelConfigHealth;
  capabilities: HostCapabilities;
  /** Method handlers registered by controllers */
  handlers: Partial<Record<HostMethod, MethodHandler>>;
  getRehydrateState?: () => Pick<RehydrateSnapshot, "workspace" | "session" | "tools" | "packages">;
  /** Optional graceful cleanup before process exit */
  onShutdown?: () => Promise<void>;
};

export type MethodHandler = (
  ctx: HandlerContext,
) => Promise<
  { result: unknown; identity?: HostIdentity } | { error: HostError; identity?: HostIdentity }
>;

export type HandlerContext = {
  id: string;
  params: unknown;
  context: Record<string, unknown>;
};

export class PiHostServer {
  readonly identity = new IdentityState();
  readonly serviceGraphLock = new TryMutex();
  readonly graphOperations = new GraphOperationRegistry();
  private readonly shutdownController = new AbortController();
  private sequence = 0;
  private phase: HostPhase = "booting";
  private extensionDecisionPresentation: ExtensionDecisionPresentation = "legacy-modal";
  private extensionDialogPresentationOverrides: ExtensionDialogPresentationOverrides = {};
  private shuttingDown = false;
  private lastError?: HostError;
  private fatalError?: HostError;
  private readonly deps: HostRuntimeDeps;
  private stopReader: (() => void) | null = null;
  private cleanupPromise: Promise<boolean> | null = null;
  private shutdownRequestPromise: Promise<void> | null = null;
  private transportShutdownPromise: Promise<void> | null = null;
  /** Bounded outbound queue (A3) — allocates event sequences at write time. */
  private readonly outbound = new OutboundWriter({
    stream: process.stdout,
    allocateSequence: () => {
      this.sequence += 1;
      return this.sequence;
    },
  });

  constructor(deps: HostRuntimeDeps) {
    this.deps = deps;
  }

  getIdentity(): HostIdentity {
    return this.identity.snapshot();
  }

  getExtensionDecisionPresentation(): ExtensionDecisionPresentation {
    return this.extensionDecisionPresentation;
  }

  getExtensionDialogPresentationOverrides(): ExtensionDialogPresentationOverrides {
    return this.extensionDialogPresentationOverrides;
  }

  setExtensionDecisionPresentation(mode: ExtensionDecisionPresentation): void {
    this.extensionDecisionPresentation = mode;
  }

  setExtensionDialogPresentationOverrides(overrides: ExtensionDialogPresentationOverrides): void {
    this.extensionDialogPresentationOverrides = overrides;
  }

  applyExtensionUiConfigure(params: {
    extensionDecisionPresentation: ExtensionDecisionPresentation;
    extensionDialogPresentationOverrides?: ExtensionDialogPresentationOverrides;
  }): {
    extensionDecisionPresentation: ExtensionDecisionPresentation;
    extensionDialogPresentationOverrides: ExtensionDialogPresentationOverrides;
  } {
    this.extensionDecisionPresentation = params.extensionDecisionPresentation;
    if (params.extensionDialogPresentationOverrides !== undefined) {
      this.extensionDialogPresentationOverrides = params.extensionDialogPresentationOverrides;
    }
    return {
      extensionDecisionPresentation: this.extensionDecisionPresentation,
      extensionDialogPresentationOverrides: this.extensionDialogPresentationOverrides,
    };
  }

  setPhase(phase: HostPhase): void {
    this.phase = phase;
  }

  getPhase(): HostPhase {
    return this.phase;
  }

  getShutdownSignal(): AbortSignal {
    return this.shutdownController.signal;
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
      extensionDecisionPresentation: this.extensionDecisionPresentation,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.fatalError ? { fatalError: this.fatalError } : {}),
    };
  }

  emit(event: HostEventName, payload: unknown): void {
    this.emitForIdentity(this.identity.snapshot(), event, payload);
  }

  emitForIdentity(identity: HostIdentity, event: HostEventName, payload: unknown): void {
    const current = this.identity.snapshot();
    if (identity.hostInstanceId !== current.hostInstanceId) {
      logger.warn("Dropped event for a stale Host identity", { event });
      return;
    }
    const sameWorkspace = identity.workspaceId === current.workspaceId;
    if (sameWorkspace && identity.workspaceRevision !== current.workspaceRevision) {
      logger.warn("Dropped event for a stale Workspace revision", { event });
      return;
    }
    // Parked Workspaces keep streaming under their own identity. Never throw:
    // the SDK delivers these from Agent.processEvents, and a throw becomes an
    // unhandled rejection that quiesces the Host mid-switch.
    if (!sameWorkspace && !isParkedWorkspaceEvent(event)) {
      logger.warn("Dropped event for a parked Workspace", { event });
      return;
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

    this.outbound.enqueueEvent(identity, event, payload);
  }

  writeResponse(body: unknown): void {
    this.outbound.enqueueResponse(body);
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
  async requestShutdown(reason: string, exitCode = 0): Promise<void> {
    if (this.shutdownRequestPromise) return this.shutdownRequestPromise;
    const requestId = `shutdown:${reason}`;
    this.shutdownRequestPromise = (async () => {
      let cleanupCompleted = false;
      try {
        cleanupCompleted = await this.quiesceAndCleanup(reason, requestId);
        if (!cleanupCompleted) {
          logger.error("Shutdown cleanup deadline expired", {
            reason,
            operationKind: this.serviceGraphLock.getOwner()?.operationKind ?? null,
          });
        }
      } catch (err) {
        logger.error("Cleanup during shutdown failed", {
          reason,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      await this.stopTransport(cleanupCompleted ? exitCode : 1);
    })();
    return this.shutdownRequestPromise;
  }

  requestFatalShutdown(error: HostError, reason: string): Promise<void> {
    if (!this.shutdownRequestPromise) {
      this.setFatalError(error);
      try {
        this.emit("host.fatal", { error });
      } catch (emitError) {
        logger.error("Failed to publish fatal Host state", {
          error: emitError instanceof Error ? emitError.message : String(emitError),
        });
      }
    }
    return this.requestShutdown(reason, 1);
  }

  private quiesceAndCleanup(reason: string, requestId: string): Promise<boolean> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.shuttingDown = true;
    this.phase = "shuttingDown";
    this.shutdownController.abort(new Error(`Host shutdown: ${reason}`));
    logger.warn("Quiescing Pi Host", { reason });
    this.cleanupPromise = (async () => {
      const deadline = Date.now() + HOST_SHUTDOWN_QUIESCE_TIMEOUT_MS;
      const active = this.graphOperations.cancelActive(`Host shutdown: ${reason}`);
      if (active) {
        logger.warn("Cancelling active graph operation for shutdown", {
          operationKind: active.operationKind,
          operationId: active.operationId,
        });
        const operationCompleted = await completesWithin(active.completion, deadline - Date.now());
        if (!operationCompleted) return false;
      }

      const ownsGraphLock = await this.serviceGraphLock.acquire(
        { operationKind: "system.shutdown", requestId },
        Math.max(0, deadline - Date.now()),
      );
      if (!ownsGraphLock) return false;
      let releaseGraphLock = true;
      try {
        if (!this.deps.onShutdown) return true;
        const cleanupCompleted = await completesWithin(
          this.deps.onShutdown(),
          deadline - Date.now(),
        );
        if (!cleanupCompleted) releaseGraphLock = false;
        return cleanupCompleted;
      } finally {
        if (releaseGraphLock) this.serviceGraphLock.release(requestId);
      }
    })();
    return this.cleanupPromise;
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
      this.writeResponse(createFailureResponse(this.identity.snapshot(), id, method, parsed.error));
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
      const helloParams = params as {
        extensionDecisionPresentation?: ExtensionDecisionPresentation;
        extensionDialogPresentationOverrides?: ExtensionDialogPresentationOverrides;
      };
      if (helloParams.extensionDecisionPresentation) {
        this.extensionDecisionPresentation = helloParams.extensionDecisionPresentation;
      }
      if (helloParams.extensionDialogPresentationOverrides !== undefined) {
        if (
          !isExtensionDialogPresentationOverrides(helloParams.extensionDialogPresentationOverrides)
        ) {
          this.writeResponse(
            createFailureResponse(
              this.identity.snapshot(),
              id,
              method,
              createHostError("INVALID_REQUEST", "invalid extensionDialogPresentationOverrides"),
            ),
          );
          return;
        }
        this.extensionDialogPresentationOverrides =
          helloParams.extensionDialogPresentationOverrides;
      }
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

    if (method === "system.rehydrate") {
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

      if (
        !this.serviceGraphLock.tryAcquire({
          operationKind: "system.rehydrate",
          requestId: id,
        })
      ) {
        this.writeResponse(
          createFailureResponse(
            this.identity.snapshot(),
            id,
            method,
            createHostError("SERVICE_GRAPH_BUSY", "Service graph is busy", {
              retryable: true,
              details: {
                operationKind: this.serviceGraphLock.getOwner()?.operationKind ?? null,
              },
            }),
          ),
        );
        return;
      }

      try {
        const identity = this.identity.snapshot();
        const host = this.buildStatus();
        const state = this.deps.getRehydrateState?.() ?? {
          workspace: null,
          session: null,
          tools: null,
          packages: null,
        };
        this.outbound.enqueueBarrierResponse((watermark) => {
          const result: RehydrateSnapshot = { watermark, host, ...state };
          const validation = validateSuccessResult(method, result);
          if (!validation.ok) {
            logger.error("Rejected invalid atomic rehydrate snapshot", {
              validation: validation.error.message,
            });
            return createFailureResponse(
              identity,
              id,
              method,
              createHostError("INTERNAL_ERROR", "Host recovery snapshot is inconsistent", {
                details: { validation: validation.error.message },
              }),
            );
          }
          return createSuccessResponse(identity, id, method, result);
        });
      } finally {
        this.serviceGraphLock.release(id);
      }
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
      let cleanupCompleted = false;
      try {
        cleanupCompleted = await this.quiesceAndCleanup("system.shutdown", id);
        if (cleanupCompleted) {
          this.writeResponse(
            createSuccessResponse(this.identity.snapshot(), id, method, { accepted: true }),
          );
        } else {
          this.writeResponse(
            createFailureResponse(
              this.identity.snapshot(),
              id,
              method,
              createHostError(
                "HOST_RESTART_REQUIRED",
                "Host cleanup did not complete before the shutdown deadline",
                { details: { timeoutMs: HOST_SHUTDOWN_QUIESCE_TIMEOUT_MS } },
              ),
            ),
          );
        }
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
      }
      await this.stopTransport(cleanupCompleted ? 0 : 1);
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
      params,
      context,
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
            this.writeResponse(createFailureResponse(cur, id, method, outcome.error));
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
          createHostError("INTERNAL_ERROR", err instanceof Error ? err.message : "Internal error"),
        ),
      );
    }
  }

  async shutdown(exitCode = 0): Promise<void> {
    logger.info("Pi Host shutting down");
    this.phase = "shuttingDown";
    this.shuttingDown = true;
    // onShutdown may already have run from system.shutdown handler
    this.stopReader?.();
    // Drain the outbound queue and stdout before exit, with a hard deadline
    // so a blocked pipe cannot prevent process exit.
    await Promise.race([
      this.outbound.drain(),
      new Promise<void>((resolve) => setTimeout(resolve, 500)),
    ]);
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
    process.exitCode = exitCode;
    process.exit(exitCode);
  }

  private stopTransport(exitCode: number): Promise<void> {
    if (!this.transportShutdownPromise) {
      this.transportShutdownPromise = this.shutdown(exitCode);
    }
    return this.transportShutdownPromise;
  }
}
