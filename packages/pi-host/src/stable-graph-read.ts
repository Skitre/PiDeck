/**
 * withStableGraphRead — R4 stable cwd-bound read under serviceGraphLock.
 */
import { createHostError, type HostError, type HostIdentity } from "@pi-desktop/protocol";
import type { TryMutex } from "./locks.js";
import type { IdentityState } from "./identity.js";

export type StableReadOutcome<T> =
  | { ok: true; result: T; identity: HostIdentity }
  | { ok: false; error: HostError; identity: HostIdentity };

export async function withStableGraphRead<T>(args: {
  requestId: string;
  identity: IdentityState;
  serviceGraphLock: TryMutex;
  precheck?: () => HostError | null;
  /** Run under lock after second identity check; capture generation before await */
  run: () => Promise<T>;
}): Promise<StableReadOutcome<T>> {
  const { requestId, identity, serviceGraphLock } = args;
  if (args.precheck) {
    const e = args.precheck();
    if (e) {
      return { ok: false, error: e, identity: identity.snapshot() };
    }
  }

  if (
    !serviceGraphLock.tryAcquire({
      operationKind: "sdk.read",
      requestId,
    })
  ) {
    return {
      ok: false,
      error: createHostError("SERVICE_GRAPH_BUSY", "Service graph is busy", {
        retryable: true,
        details: {
          operationKind: serviceGraphLock.getOwner()?.operationKind ?? null,
        },
      }),
      identity: identity.snapshot(),
    };
  }

  // Capture identity after lock for response — do not re-label after await
  const captured = identity.snapshot();
  try {
    if (args.precheck) {
      const e = args.precheck();
      if (e) return { ok: false, error: e, identity: captured };
    }
    // Re-check generation still matches capture
    const now = identity.snapshot();
    if (
      now.hostInstanceId !== captured.hostInstanceId ||
      now.workspaceId !== captured.workspaceId ||
      now.workspaceRevision !== captured.workspaceRevision ||
      now.sessionId !== captured.sessionId ||
      now.sessionRevision !== captured.sessionRevision ||
      now.packageRevision !== captured.packageRevision
    ) {
      return {
        ok: false,
        error: createHostError("STALE_REVISION", "Identity changed under lock"),
        identity: now,
      };
    }
    const result = await args.run();
    // After await, if identity moved, return STALE rather than re-label
    const after = identity.snapshot();
    if (
      after.workspaceRevision !== captured.workspaceRevision ||
      after.sessionRevision !== captured.sessionRevision ||
      after.packageRevision !== captured.packageRevision ||
      after.workspaceId !== captured.workspaceId ||
      after.sessionId !== captured.sessionId
    ) {
      return {
        ok: false,
        error: createHostError(
          "STALE_REVISION",
          "Graph replaced during stable read",
          { retryable: true },
        ),
        identity: after,
      };
    }
    return { ok: true, result, identity: captured };
  } catch (err) {
    return {
      ok: false,
      error: createHostError(
        "INTERNAL_ERROR",
        err instanceof Error ? err.message : String(err),
      ),
      identity: identity.snapshot(),
    };
  } finally {
    serviceGraphLock.release(requestId);
  }
}
