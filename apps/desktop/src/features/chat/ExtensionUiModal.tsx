import { useEffect, useId, useRef } from "react";
import { useBrowserOcclusion } from "../../lib/browser-occlusion";
import { useAppStore } from "../../lib/stores/app-store";
import { ExtensionUiRequestContent } from "./ExtensionUiRequestContent";
import { useExtensionUiResponse } from "./use-extension-ui-response";

const FOCUSABLE_SELECTOR =
  "button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])";

export function ExtensionUiModal() {
  const activeRequest = useAppStore((state) => state.extensionUiRequest);
  const request = activeRequest?.presentation === "inline" ? null : activeRequest;
  const controller = useExtensionUiResponse(request);
  const dialogRef = useRef<HTMLDivElement>(null);
  const wasSubmittingRef = useRef(false);
  const titleId = useId();
  const requestId = request?.requestId ?? null;
  useBrowserOcclusion("extension-ui-modal", requestId !== null);

  useEffect(() => {
    if (!requestId) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const timer = window.setTimeout(() => {
      dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus();
    }, 0);
    return () => {
      window.clearTimeout(timer);
      previousFocus?.focus();
    };
  }, [requestId]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (controller.submitting) {
      dialog.focus();
    } else if (wasSubmittingRef.current && document.activeElement === dialog) {
      dialog.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus();
    }
    wasSubmittingRef.current = controller.submitting;
  }, [controller.submitting]);

  if (!request) return null;

  function handleDialogKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      void controller.respond("cancelled");
      return;
    }
    if (event.key !== "Tab" || !dialogRef.current) return;
    const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
    if (focusable.length === 0) {
      event.preventDefault();
      dialogRef.current.focus();
      return;
    }
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={controller.submitting}
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
        className="theme-floating-surface max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto overscroll-contain rounded-lg border border-border bg-surface-raised p-5 shadow-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
        data-extension-ui-surface="modal"
      >
        <ExtensionUiRequestContent
          request={request}
          controller={controller}
          titleId={titleId}
          variant="modal"
        />
      </div>
    </div>
  );
}
