import type { JsonValue, SerializableImage } from "@pideck/protocol";
import { useAppStore } from "./stores/app-store";
import { hostClient } from "./bridge/host-client";
import {
  activeSessionContext,
  captureRequestGeneration,
  isCurrentRequestGeneration,
} from "./bridge/host-context";
import { requestWithRetry } from "./bridge/request-retry";
import { tCurrent } from "./i18n/use-t";
import { editDraft } from "./draft-persistence";
import { draftTargetFor } from "./draft-target";

export type NavigateTreeOutcome = { applied: false } | { applied: true; editorText?: string };

/**
 * Move the current session leaf to `targetId` (same session file). A user
 * message target typically returns `editorText` for the composer.
 */
export async function requestNavigateTree(
  targetId: string,
  options: { restoreDraft?: boolean } = {},
): Promise<NavigateTreeOutcome> {
  const restoreDraft = options.restoreDraft !== false;
  const { host, workspace, session, pushNotification, applySessionSnapshot } =
    useAppStore.getState();
  if (!host || !workspace || !session) return { applied: false };
  if (!session.isIdle) {
    pushNotification(tCurrent("notifNavigateWait"), "info");
    return { applied: false };
  }
  const generation = captureRequestGeneration(host);
  try {
    const res = await requestWithRetry(() =>
      hostClient.request("agent.navigateTree", activeSessionContext(host, workspace, session), {
        targetId,
      }),
    );
    if (!res) return { applied: false };
    if (
      !isCurrentRequestGeneration(useAppStore.getState().host, generation, {
        session: true,
      })
    ) {
      return { applied: false };
    }
    if (!res.ok) {
      pushNotification(res.error?.message ?? tCurrent("dockTreeSwitchFailed"), "error");
      return { applied: false };
    }
    if (res.result.cancelled) {
      pushNotification(tCurrent("dockTreeSwitchCancelled"), "info");
      return { applied: false };
    }
    applySessionSnapshot(res.result.session);
    const editorText = res.result.editorText;
    if (restoreDraft && editorText !== undefined) {
      const latest = useAppStore.getState();
      const target =
        latest.workspace && latest.session
          ? draftTargetFor(latest.workspace, latest.session)
          : null;
      if (target) editDraft(target, editorText);
    }
    return editorText !== undefined ? { applied: true, editorText } : { applied: true };
  } catch (error) {
    pushNotification(
      error instanceof Error ? error.message : tCurrent("dockTreeSwitchFailed"),
      "error",
    );
    return { applied: false };
  }
}

/**
 * Navigate to a user entry and prompt in one Host round-trip so a tree
 * refetch cannot take the service-graph lock between the two steps.
 */
export async function requestPromptFromEntry(
  entryId: string,
  options: {
    text: string;
    images?: SerializableImage[];
    attachmentIds?: string[];
  } = { text: "" },
): Promise<boolean> {
  const text = options.text.trim();
  const images = options.images ?? [];
  const attachmentIds = options.attachmentIds ?? [];
  if (!text && images.length === 0 && attachmentIds.length === 0) {
    useAppStore.getState().pushNotification(tCurrent("notifRegenerateEmpty"), "info");
    return false;
  }

  const { host, workspace, session, pushNotification, applySessionSnapshot, setAuthBlocked } =
    useAppStore.getState();
  if (!host || !workspace || !session) return false;
  if (!session.isIdle) {
    pushNotification(tCurrent("notifNavigateWait"), "info");
    return false;
  }
  const generation = captureRequestGeneration(host);
  const restorePromptDraft = () => {
    const latest = useAppStore.getState();
    const target =
      latest.workspace && latest.session ? draftTargetFor(latest.workspace, latest.session) : null;
    if (target) editDraft(target, text);
  };

  try {
    const res = await requestWithRetry(() =>
      hostClient.request(
        "agent.prompt",
        activeSessionContext(host, workspace, session),
        {
          text,
          fromEntryId: entryId,
          ...(images.length > 0 ? { images } : {}),
          ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
        },
        null,
      ),
    );
    if (!res) return false;
    if (
      !isCurrentRequestGeneration(useAppStore.getState().host, generation, {
        session: true,
      })
    ) {
      return false;
    }
    if (!res.ok) {
      if (res.error?.code === "AUTH_REQUIRED") {
        setAuthBlocked({ providerId: authProviderId(res.error.details) });
      } else {
        pushNotification(res.error?.message ?? tCurrent("notifRegenerateFailed"), "error");
      }
      restorePromptDraft();
      return false;
    }
    if (res.result.session) applySessionSnapshot(res.result.session);
    setAuthBlocked(null);
    return true;
  } catch (error) {
    pushNotification(
      error instanceof Error ? error.message : tCurrent("notifRegenerateFailed"),
      "error",
    );
    restorePromptDraft();
    return false;
  }
}

export async function requestRegenerateInSession(
  entryId: string,
  options: {
    fallbackText?: string;
    images?: SerializableImage[];
    attachmentIds?: string[];
  } = {},
): Promise<boolean> {
  return requestPromptFromEntry(entryId, {
    text: options.fallbackText ?? "",
    images: options.images,
    attachmentIds: options.attachmentIds,
  });
}

function authProviderId(details: JsonValue | undefined): string | null {
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  return typeof details.providerId === "string" ? details.providerId : null;
}
