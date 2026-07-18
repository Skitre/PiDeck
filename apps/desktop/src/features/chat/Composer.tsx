import { useState } from "react";
import { Send, Square } from "lucide-react";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import {
  activeSessionContext,
  captureRequestGeneration,
  isCurrentRequestGeneration,
} from "../../lib/bridge/host-context";

export function Composer({ disabled }: { disabled?: boolean }) {
  const host = useAppStore((s) => s.host);
  const workspace = useAppStore((s) => s.workspace);
  const session = useAppStore((s) => s.session);
  const text = useAppStore((s) =>
    session ? (s.sessionDrafts[session.sessionId] ?? "") : "",
  );
  const setSession = useAppStore((s) => s.applySessionSnapshot);
  const setSessionDraft = useAppStore((s) => s.setSessionDraft);
  const pushNotification = useAppStore((s) => s.pushNotification);
  const [streamMode, setStreamMode] = useState<"steer" | "followUp">("followUp");
  const busy = session ? !session.isIdle : false;

  async function send() {
    if (!host || !workspace || !session || !text.trim() || disabled) return;
    const value = text;
    const targetSessionId = session.sessionId;
    setSessionDraft(targetSessionId, "");
    const context = activeSessionContext(host, workspace, session);

    try {
      if (busy) {
        const res =
          streamMode === "steer"
            ? await hostClient.request("agent.steer", context, { text: value })
            : await hostClient.request("agent.followUp", context, { text: value });
        if (!res.ok) {
          pushNotification(res.error?.message ?? "Send failed", "error");
          setSessionDraft(targetSessionId, value);
        }
        return;
      }

      const res = await hostClient.request(
        "agent.prompt",
        context,
        { text: value },
        null,
      );
      if (!res.ok) {
        pushNotification(res.error?.message ?? "Prompt failed", "error");
        setSessionDraft(targetSessionId, value);
      }
    } catch (error) {
      pushNotification(error instanceof Error ? error.message : "Send failed", "error");
      setSessionDraft(targetSessionId, value);
    }
  }

  async function abort() {
    if (!host || !workspace || !session) return;
    const generation = captureRequestGeneration(host);
    const res = await hostClient.request(
      "agent.abort",
      activeSessionContext(host, workspace, session),
      null,
    );
    if (
      !isCurrentRequestGeneration(useAppStore.getState().host, generation, {
        session: true,
      })
    ) {
      return;
    }
    if (res.ok) setSession(res.result.session);
  }

  return (
    <div className="shrink-0 px-5 pb-5 pt-2">
      <div className="mx-auto max-w-3xl rounded-lg border border-border bg-surface-raised p-2 shadow-sm">
        <textarea
          className="min-h-[76px] w-full resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted"
          placeholder={disabled ? "Chat unavailable" : "Message Pi"}
          value={text}
          disabled={disabled}
          onChange={(event) => {
            if (session) setSessionDraft(session.sessionId, event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div className="flex h-8 items-center gap-2 px-1">
          {busy && (
            <>
              <select
                className="h-7 rounded-md border border-border bg-surface px-2 text-xs"
                value={streamMode}
                onChange={(event) =>
                  setStreamMode(event.target.value as "steer" | "followUp")
                }
                title="Message behavior while Pi is running"
              >
                <option value="followUp">Follow-up</option>
                <option value="steer">Steer</option>
              </select>
              {(session?.pending.steering.length || session?.pending.followUp.length) ? (
                <span className="text-[11px] text-muted">
                  {session.pending.steering.length + session.pending.followUp.length} queued
                </span>
              ) : null}
            </>
          )}
          <div className="ml-auto">
            {busy ? (
              <button
                type="button"
                title="Stop"
                aria-label="Stop"
                className="flex size-8 items-center justify-center rounded-md bg-danger/15 text-danger hover:bg-danger/20"
                onClick={() => void abort()}
              >
                <Square size={14} fill="currentColor" />
              </button>
            ) : (
              <button
                type="button"
                title="Send"
                aria-label="Send"
                className="flex size-8 items-center justify-center rounded-md bg-foreground text-surface transition-colors hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-30"
                disabled={disabled || !text.trim()}
                onClick={() => void send()}
              >
                <Send size={15} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
