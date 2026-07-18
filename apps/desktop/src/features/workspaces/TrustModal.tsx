import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import { mergeHostIdentity } from "../../lib/bridge/host-context";

export function TrustModal() {
  const host = useAppStore((s) => s.host);
  const workspace = useAppStore((s) => s.workspace);
  const trustOptions = useAppStore((s) => s.trustOptions);
  const setWorkspace = useAppStore((s) => s.setWorkspace);
  const setSession = useAppStore((s) => s.setSession);
  const setTrustOptions = useAppStore((s) => s.setTrustOptions);
  const pushNotification = useAppStore((s) => s.pushNotification);
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef(0);
  const [pending, setPending] = useState(false);
  const open = Boolean(
    workspace && workspace.trust.decision === "pending" && trustOptions?.length,
  );

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const overlay = overlayRef.current;
    const dialog = dialogRef.current;
    const siblings = overlay?.parentElement
      ? Array.from(overlay.parentElement.children).filter((element) => element !== overlay)
      : [];
    for (const sibling of siblings) {
      sibling.setAttribute("inert", "");
      sibling.setAttribute("aria-hidden", "true");
    }

    const focusable = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    focusable()[0]?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      for (const sibling of siblings) {
        sibling.removeAttribute("inert");
        sibling.removeAttribute("aria-hidden");
      }
      previousFocus?.focus();
    };
  }, [open]);

  if (!workspace || workspace.trust.decision !== "pending" || !trustOptions?.length) {
    return null;
  }

  async function decide(decision: "trustOnce" | "trust" | "deny") {
    if (!host || !workspace || pending) return;
    const request = ++requestRef.current;
    const expectedHostId = host.hostInstanceId;
    const expectedWorkspaceId = workspace.id;
    setPending(true);
    try {
      const res = await hostClient.request(
        "workspace.setTrust",
        {
          expectedHostInstanceId: host.hostInstanceId,
          expectedWorkspaceId: workspace.id,
          expectedWorkspaceRevision: workspace.revision,
        },
        { decision },
        60_000,
      );
      const current = useAppStore.getState();
      if (
        request !== requestRef.current ||
        current.host?.hostInstanceId !== expectedHostId ||
        (current.workspace?.id !== expectedWorkspaceId &&
          current.workspace?.id !== res.workspaceId)
      ) {
        return;
      }
      if (!res.ok) {
        pushNotification(res.error?.message ?? "Trust decision failed", "error");
        return;
      }
      const result = res.result;
      setWorkspace(result.workspace);
      if (result.session) setSession(result.session);
      setTrustOptions(null);
      const currentHost = useAppStore.getState().host;
      if (currentHost) {
        const nextHost = mergeHostIdentity(currentHost, res);
        if (nextHost) useAppStore.getState().setHost({ ...nextHost, phase: "ready" });
      }
    } finally {
      if (request === requestRef.current) setPending(false);
    }
  }

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="trust-title"
        className="w-full max-w-md rounded-lg border border-border bg-surface-raised p-5 shadow-xl"
      >
        <h2 id="trust-title" className="mb-2 text-base font-semibold">
          Trust this project?
        </h2>
        <p className="mb-1 text-sm text-muted">
          This workspace has project-local Pi resources (settings, packages,
          extensions, skills). Trust is required before they load.
        </p>
        <p className="mb-4 truncate font-mono text-xs text-foreground">
          {workspace.canonicalCwd}
        </p>
        <div className="flex flex-col gap-2">
          {trustOptions.map((opt) => (
            <button
              key={opt.id}
              type="button"
              className="rounded-md border border-border px-3 py-2 text-left text-sm hover:bg-surface-overlay disabled:opacity-50"
              disabled={pending}
              onClick={() => void decide(opt.id)}
            >
              <div className="font-medium">{opt.label}</div>
              <div className="text-xs text-muted">
                {opt.persisted ? "Persisted in trust.json" : "Session only"}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
