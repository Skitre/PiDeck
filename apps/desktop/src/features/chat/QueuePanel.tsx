import { useState } from "react";
import { ChevronDown, Pencil, Play, Trash2, ArrowUp, Check, X } from "lucide-react";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import { activeSessionContext } from "../../lib/bridge/host-context";
import type { ActiveSessionContext } from "@pideck/protocol";

/**
 * Waiting queue above the composer. Backed by the SDK queue (visible to the
 * CLI too); reorder/edit/delete are expressed through agent.setQueue's atomic
 * clear-and-rebuild. "Run now" is a hard interrupt: park the queue, abort the
 * current run, prompt the chosen item, restore the rest.
 */

/** Transient conditions worth a short retry — e.g. the operation lock of an
 * aborted run releases a beat after agent.abort responds. */
const RETRYABLE_CODES = new Set(["AGENT_BUSY", "SERVICE_GRAPH_BUSY", "PACKAGE_MUTATION_BUSY"]);

async function setQueueWithRetry(
  context: ActiveSessionContext,
  params: { steering: string[]; followUp: string[] },
) {
  for (let attempt = 0; ; attempt += 1) {
    const res = await hostClient.request("agent.setQueue", context, params);
    if (res.ok || attempt >= 3 || !RETRYABLE_CODES.has(res.error?.code ?? "")) {
      return res;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export function QueuePanel() {
  const host = useAppStore((s) => s.host);
  const workspace = useAppStore((s) => s.workspace);
  const session = useAppStore((s) => s.session);
  const setSession = useAppStore((s) => s.applySessionSnapshot);
  const pushNotification = useAppStore((s) => s.pushNotification);
  const [collapsed, setCollapsed] = useState(false);
  const [busyOp, setBusyOp] = useState(false);
  const [editing, setEditing] = useState<{ index: number; text: string } | null>(null);

  const steering = session?.pending.steering ?? [];
  const followUp = session?.pending.followUp ?? [];
  const total = steering.length + followUp.length;
  if (!session || total === 0) return null;

  async function applyQueue(nextSteering: string[], nextFollowUp: string[]) {
    if (!host || !workspace || !session || busyOp) return;
    setBusyOp(true);
    try {
      const res = await setQueueWithRetry(
        activeSessionContext(host, workspace, session),
        { steering: nextSteering, followUp: nextFollowUp },
      );
      if (!res.ok) {
        pushNotification(res.error?.message ?? "Queue update failed", "error");
      }
    } finally {
      setBusyOp(false);
    }
  }

  async function runNow(index: number) {
    if (!host || !workspace || !session || busyOp) return;
    const item = followUp[index];
    if (!item) return;
    const steeringBefore = [...steering];
    const remaining = followUp.filter((_, i) => i !== index);
    setBusyOp(true);
    try {
      const context = activeSessionContext(host, workspace, session);
      // 1. Park everything so nothing auto-runs when the current run aborts.
      const parked = await setQueueWithRetry(context, {
        steering: [],
        followUp: [],
      });
      if (!parked.ok) {
        pushNotification(parked.error?.message ?? "Queue update failed", "error");
        return;
      }
      // 2. Hard-interrupt the current run.
      const aborted = await hostClient.request("agent.abort", context, null);
      if (!aborted.ok) {
        pushNotification(aborted.error?.message ?? "Abort failed", "error");
        // Undo the park so nothing is lost.
        await setQueueWithRetry(context, {
          steering: steeringBefore,
          followUp: [...followUp],
        });
        return;
      }
      setSession(aborted.result.session);
      // 3. Run the chosen item. The aborted run's operation lock releases a
      // moment after the abort response, so retry briefly on busy errors.
      const current = useAppStore.getState();
      if (!current.host || !current.workspace || !current.session) return;
      const freshContext = activeSessionContext(
        current.host,
        current.workspace,
        current.session,
      );
      let prompted = await hostClient.request(
        "agent.prompt",
        freshContext,
        { text: item },
        null,
      );
      for (
        let attempt = 0;
        !prompted.ok && RETRYABLE_CODES.has(prompted.error?.code ?? "") && attempt < 8;
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        prompted = await hostClient.request(
          "agent.prompt",
          freshContext,
          { text: item },
          null,
        );
      }
      if (!prompted.ok) {
        pushNotification(prompted.error?.message ?? "Run failed", "error");
        // Put the chosen item back at the front so it is not lost.
        await setQueueWithRetry(freshContext, {
          steering: steeringBefore,
          followUp: [item, ...remaining],
        });
        return;
      }
      // 4. Restore the remaining items behind the new run.
      if (remaining.length > 0 || steeringBefore.length > 0) {
        await setQueueWithRetry(freshContext, {
          steering: steeringBefore,
          followUp: remaining,
        });
      }
    } finally {
      setBusyOp(false);
    }
  }

  const itemButton =
    "flex size-6 items-center justify-center rounded text-muted hover:bg-surface-overlay hover:text-foreground disabled:opacity-30";

  return (
    <div className="mx-auto mb-1.5 w-full max-w-3xl rounded-lg border border-border bg-surface-raised/80">
      <button
        type="button"
        className="flex h-8 w-full items-center gap-2 px-3 text-xs text-muted hover:text-foreground"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
      >
        <span className="font-medium">Waiting queue ({total})</span>
        <ChevronDown
          size={13}
          className={`ml-auto transition-transform ${collapsed ? "-rotate-90" : ""}`}
        />
      </button>
      {!collapsed && (
        <ul className="border-t border-border px-1.5 py-1">
          {steering.map((text, index) => (
            <li key={`steer:${index}`} className="group flex items-start gap-2 rounded px-1.5 py-1">
              <span className="mt-0.5 shrink-0 rounded bg-warning/15 px-1 text-[10px] text-warning">
                steer
              </span>
              <span className="min-w-0 flex-1 truncate text-xs" title={text}>
                {text}
              </span>
              <button
                type="button"
                title="Remove"
                className={`${itemButton} opacity-0 group-hover:opacity-100`}
                disabled={busyOp}
                onClick={() =>
                  void applyQueue(steering.filter((_, i) => i !== index), [...followUp])
                }
              >
                <Trash2 size={12} />
              </button>
            </li>
          ))}
          {followUp.map((text, index) =>
            editing?.index === index ? (
              <li key={`edit:${index}`} className="flex items-start gap-1.5 rounded px-1.5 py-1">
                <textarea
                  autoFocus
                  className="min-h-[52px] flex-1 rounded border border-accent bg-surface px-2 py-1 text-xs outline-none"
                  value={editing.text}
                  onChange={(event) => setEditing({ index, text: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      const next = [...followUp];
                      if (editing.text.trim()) next[index] = editing.text;
                      void applyQueue([...steering], next);
                      setEditing(null);
                    }
                    if (event.key === "Escape") setEditing(null);
                  }}
                />
                <button
                  type="button"
                  title="Save"
                  className={itemButton}
                  onClick={() => {
                    const next = [...followUp];
                    if (editing.text.trim()) next[index] = editing.text;
                    void applyQueue([...steering], next);
                    setEditing(null);
                  }}
                >
                  <Check size={13} />
                </button>
                <button
                  type="button"
                  title="Cancel"
                  className={itemButton}
                  onClick={() => setEditing(null)}
                >
                  <X size={13} />
                </button>
              </li>
            ) : (
              <li key={`fu:${index}`} className="group flex items-start gap-2 rounded px-1.5 py-1 hover:bg-surface-overlay/50">
                <span className="mt-1 size-1 shrink-0 rounded-full bg-muted" />
                <span className="min-w-0 flex-1 truncate text-xs" title={text}>
                  {text}
                </span>
                <span className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100">
                  <button
                    type="button"
                    title="Move up"
                    className={itemButton}
                    disabled={busyOp || index === 0}
                    onClick={() => {
                      const next = [...followUp];
                      [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                      void applyQueue([...steering], next);
                    }}
                  >
                    <ArrowUp size={12} />
                  </button>
                  <button
                    type="button"
                    title="Edit"
                    className={itemButton}
                    disabled={busyOp}
                    onClick={() => setEditing({ index, text })}
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    type="button"
                    title="Interrupt current run and run this now"
                    className={itemButton}
                    disabled={busyOp}
                    onClick={() => void runNow(index)}
                  >
                    <Play size={12} />
                  </button>
                  <button
                    type="button"
                    title="Remove"
                    className={itemButton}
                    disabled={busyOp}
                    onClick={() =>
                      void applyQueue([...steering], followUp.filter((_, i) => i !== index))
                    }
                  >
                    <Trash2 size={12} />
                  </button>
                </span>
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}
