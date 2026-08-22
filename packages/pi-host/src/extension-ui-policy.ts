import type {
  ExtensionDecisionPresentation,
  ExtensionDialogPresentationOverrides,
  ExtensionDialogPresentationPreference,
  ExtensionUiOrigin,
  ExtensionUiPresentation,
  ExtensionUiRisk,
  ExtensionUiRouteReason,
  HostIdentity,
} from "@pideck/protocol";
import { isTrustedExtensionUiOrigin } from "@pideck/protocol";

export type ExtensionUiOwnerSessionState = "active" | "background" | "candidate" | "stale";

export type DecisionRouteInput = {
  mode: ExtensionDecisionPresentation;
  kind: "select" | "confirm" | "input" | "editor";
  origin: ExtensionUiOrigin;
  presentationHint?: ExtensionUiPresentation;
  riskHint?: ExtensionUiRisk;
  hostRisk?: ExtensionUiRisk;
  hostRiskReason?: "high-risk" | "project-trust";
  hasDestructiveOption: boolean;
  ownerSessionState: ExtensionUiOwnerSessionState;
  inlineSurfaceAvailable: boolean;
  extensionPreference?: ExtensionDialogPresentationPreference;
};

export type DecisionRoute =
  | {
      disposition: "cancel";
      risk: ExtensionUiRisk;
      reason: "stale-owner";
    }
  | {
      disposition: "present";
      presentation: ExtensionUiPresentation;
      risk: ExtensionUiRisk;
      reason: ExtensionUiRouteReason;
    }
  | {
      disposition: "queue";
      presentation: ExtensionUiPresentation;
      risk: ExtensionUiRisk;
      reason: "background-session";
      presentationReason: ExtensionUiRouteReason;
    };

export function classifyHostDecisionRisk(
  origin: ExtensionUiOrigin,
): Pick<DecisionRouteInput, "hostRisk" | "hostRiskReason"> {
  if (origin.invocationKind !== "event") return {};
  if (origin.eventType === "project_trust") {
    return { hostRisk: "high", hostRiskReason: "project-trust" };
  }
  if (origin.eventType === "tool_call") {
    return { hostRisk: "high", hostRiskReason: "high-risk" };
  }
  return {};
}

const SESSION_LIFECYCLE_EVENTS = new Set([
  "session_start",
  "session_before_switch",
  "session_switch",
  "session_shutdown",
]);

function isSessionLifecycle(origin: ExtensionUiOrigin): boolean {
  return (
    origin.invocationKind === "event" &&
    (origin.eventType.startsWith("session_before_") ||
      SESSION_LIFECYCLE_EVENTS.has(origin.eventType))
  );
}

function resolveDecisionRisk(input: DecisionRouteInput): ExtensionUiRisk {
  return input.hostRisk === "high" || input.hasDestructiveOption || input.riskHint === "high"
    ? "high"
    : "normal";
}

export function resolveExtensionDialogPreference(
  origin: ExtensionUiOrigin,
  overrides: ExtensionDialogPresentationOverrides,
): ExtensionDialogPresentationPreference | undefined {
  if (!isTrustedExtensionUiOrigin(origin)) return undefined;
  const preference = overrides[origin.extensionId];
  return preference === "followHost" || preference === "inline" || preference === "modal"
    ? preference
    : undefined;
}

function resolveDecisionPresentation(
  input: DecisionRouteInput,
  risk: ExtensionUiRisk,
): {
  presentation: ExtensionUiPresentation;
  reason: ExtensionUiRouteReason;
} {
  if (risk === "high") {
    const reason =
      input.hostRisk === "high"
        ? (input.hostRiskReason ?? "high-risk")
        : input.hasDestructiveOption
          ? "destructive-option"
          : "high-risk";
    return { presentation: "modal", reason };
  }
  if (isSessionLifecycle(input.origin)) {
    return { presentation: "modal", reason: "session-lifecycle" };
  }
  if (input.ownerSessionState === "candidate" || !input.inlineSurfaceAvailable) {
    return { presentation: "modal", reason: "inline-unavailable" };
  }
  if (isTrustedExtensionUiOrigin(input.origin) && input.extensionPreference === "modal") {
    return { presentation: "modal", reason: "user-extension-modal" };
  }
  if (isTrustedExtensionUiOrigin(input.origin) && input.extensionPreference === "inline") {
    return { presentation: "inline", reason: "user-extension-inline" };
  }
  if (input.mode === "legacy-modal") {
    return { presentation: "modal", reason: "explicit-modal" };
  }
  if (input.presentationHint === "modal") {
    return { presentation: "modal", reason: "explicit-modal" };
  }
  if (input.presentationHint === "inline") {
    return { presentation: "inline", reason: "explicit-inline" };
  }
  if (input.origin.invocationKind === "tool") {
    return { presentation: "inline", reason: "active-tool" };
  }
  if (input.origin.invocationKind === "command") {
    return { presentation: "inline", reason: "active-command" };
  }
  if (input.mode === "inline-first") {
    return { presentation: "inline", reason: "unknown-origin" };
  }
  return { presentation: "modal", reason: "unknown-origin" };
}

export function resolveDecisionRoute(input: DecisionRouteInput): DecisionRoute {
  const risk = resolveDecisionRisk(input);
  if (input.ownerSessionState === "stale") {
    return { disposition: "cancel", risk, reason: "stale-owner" };
  }

  const resolved = resolveDecisionPresentation(input, risk);
  if (input.ownerSessionState === "background") {
    return {
      disposition: "queue",
      presentation: resolved.presentation,
      risk,
      reason: "background-session",
      presentationReason: resolved.reason,
    };
  }

  return {
    disposition: "present",
    presentation: resolved.presentation,
    risk,
    reason: resolved.reason,
  };
}

export function resolveExtensionUiOwnerSessionState(
  bindingIdentity: HostIdentity,
  currentIdentity: HostIdentity,
  readyForEvents: boolean,
): ExtensionUiOwnerSessionState {
  if (
    bindingIdentity.hostInstanceId !== currentIdentity.hostInstanceId ||
    bindingIdentity.workspaceId === null ||
    bindingIdentity.workspaceId !== currentIdentity.workspaceId ||
    bindingIdentity.workspaceRevision !== currentIdentity.workspaceRevision ||
    bindingIdentity.sessionId === null ||
    currentIdentity.sessionId === null
  ) {
    return "stale";
  }
  if (
    bindingIdentity.sessionId !== currentIdentity.sessionId ||
    bindingIdentity.sessionRevision !== currentIdentity.sessionRevision
  ) {
    return "background";
  }
  return readyForEvents ? "active" : "candidate";
}
