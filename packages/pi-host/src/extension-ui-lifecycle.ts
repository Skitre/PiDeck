import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { HostIdentity } from "@pideck/protocol";
import {
  bindExtensionUi,
  type ExtensionUiBinding,
} from "./extension-ui-bridge.js";
import type { PiHostServer } from "./server.js";

export type ExtensionUiSlots = {
  extensionUiActivate: (() => Promise<() => void>) | null;
  extensionUiCleanup: (() => void) | null;
  extensionUiUpdateIdentity: ((identity: HostIdentity) => void) | null;
};

/** Bind the existing bridge to a not-yet-committed Host identity. */
export function bindForCandidate(
  session: AgentSession,
  extensionsResult: unknown,
  server: PiHostServer,
  candidateIdentity: HostIdentity,
): Promise<ExtensionUiBinding> {
  return bindExtensionUi(session, extensionsResult, {
    emit: (event, payload) =>
      server.emitForIdentity(candidateIdentity, event, payload),
    emitForIdentity: (identity, event, payload) =>
      server.emitForIdentity(identity, event, payload),
    getIdentity: () => candidateIdentity,
  });
}

/** Activate a prepared binding exactly once. Transaction rollback stays with the caller. */
export async function activateOnce(slots: ExtensionUiSlots): Promise<() => void> {
  const activate = slots.extensionUiActivate;
  slots.extensionUiActivate = null;
  if (!activate) return () => {};
  try {
    return await activate();
  } catch (error) {
    clearSlots(slots);
    throw error;
  }
}

/** Dispose a binding and clear every Extension UI lifecycle slot. */
export function clearSlots(slots: ExtensionUiSlots): void {
  slots.extensionUiActivate = null;
  try {
    slots.extensionUiCleanup?.();
  } finally {
    slots.extensionUiCleanup = null;
    slots.extensionUiUpdateIdentity = null;
  }
}
