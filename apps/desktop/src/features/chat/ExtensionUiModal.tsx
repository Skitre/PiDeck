import type { JsonValue } from "@pideck/protocol";
import { useEffect, useId, useRef, useState } from "react";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";

export function ExtensionUiModal() {
  const request = useAppStore((s) => s.extensionUiRequest);
  const setRequest = useAppStore((s) => s.setExtensionUiRequest);
  const pushNotification = useAppStore((s) => s.pushNotification);
  const [input, setInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!request) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setInput(request.defaultValue ?? "");
    setSubmitting(false);
    window.setTimeout(() => {
      dialogRef.current
        ?.querySelector<HTMLElement>("button, textarea, input, select, [tabindex]:not([tabindex='-1'])")
        ?.focus();
    }, 0);
    return () => previousFocus?.focus();
  }, [request?.requestId]);

  useEffect(() => {
    if (!request?.expiresAt) return;
    const delay = Math.max(0, request.expiresAt - Date.now());
    const timer = window.setTimeout(() => {
      pushNotification("Extension request expired", "warning");
      setRequest(null);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [request?.requestId, request?.expiresAt, pushNotification, setRequest]);

  if (!request) return null;

  async function respond(status: "resolved" | "cancelled", value?: JsonValue) {
    if (!request || submitting) return;
    setSubmitting(true);
    try {
      const res = await hostClient.request(
        "extensionUi.respond",
        request.context,
        { requestId: request.requestId, status, value },
      );
      if (!res.ok) {
        pushNotification(res.error?.message ?? "UI response failed", "error");
        return; // keep modal open on failure
      }
      setRequest(null);
      setInput("");
    } catch (err) {
      pushNotification(err instanceof Error ? err.message : "UI response failed", "error");
    } finally {
      setSubmitting(false);
    }
  }

  function handleDialogKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      void respond("cancelled");
      return;
    }
    if (event.key !== "Tab" || !dialogRef.current) return;
    const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(
      "button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])",
    )];
    if (focusable.length === 0) return;
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
        onKeyDown={handleDialogKeyDown}
        className="w-full max-w-md rounded-lg border border-border bg-surface-raised p-5 shadow-xl"
      >
        <h2 id={titleId} className="mb-2 text-base font-semibold">
          {request.title ?? "Extension request"}
        </h2>
        {request.message && (
          <p className="mb-3 text-sm text-muted">{request.message}</p>
        )}

        {request.kind === "confirm" && (
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="rounded-md border border-border px-3 py-1.5 text-sm"
              onClick={() => void respond("cancelled")}
            >
              Cancel
            </button>
            <button
              type="button"
              className="rounded-md bg-accent px-3 py-1.5 text-sm text-white"
              onClick={() => void respond("resolved", true)}
            >
              Confirm
            </button>
          </div>
        )}

        {request.kind === "select" && (
          <ul className="mb-3 max-h-60 overflow-auto">
            {(request.options ?? []).map((opt) => (
              <li key={opt.id}>
                <button
                  type="button"
                  className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-surface-overlay"
                  onClick={() => void respond("resolved", opt.id)}
                >
                  {opt.label}
                </button>
              </li>
            ))}
          </ul>
        )}

        {(request.kind === "input" || request.kind === "editor") && (
          <div className="flex flex-col gap-2">
            <textarea
              key={request.requestId}
              className={`w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm ${
                request.kind === "editor" ? "min-h-[160px]" : "min-h-[40px]"
              }`}
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="rounded-md border border-border px-3 py-1.5 text-sm"
                onClick={() => void respond("cancelled")}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded-md bg-accent px-3 py-1.5 text-sm text-white"
                onClick={() => void respond("resolved", input)}
              >
                OK
              </button>
            </div>
          </div>
        )}

        {request.kind === "select" && (
          <button
            type="button"
            className="text-xs text-muted underline"
            onClick={() => void respond("cancelled")}
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
