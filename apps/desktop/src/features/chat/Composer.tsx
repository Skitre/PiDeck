import { useEffect, useRef, useState } from "react";
import { ImagePlus, Send, Square, X } from "lucide-react";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import type { SerializableImage } from "@pideck/protocol";
import {
  activeSessionContext,
  captureRequestGeneration,
  isCurrentRequestGeneration,
} from "../../lib/bridge/host-context";

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

type PendingImage = SerializableImage & { id: string };

function fileToImage(file: File): Promise<PendingImage | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve(null);
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const base64 = result.slice(result.indexOf(",") + 1);
      if (!base64) return resolve(null);
      resolve({
        id: crypto.randomUUID(),
        mediaType: file.type,
        data: base64,
      });
    };
    reader.readAsDataURL(file);
  });
}

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
  const [images, setImages] = useState<PendingImage[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const busy = session ? !session.isIdle : false;
  const sessionId = session?.sessionId ?? null;

  // Attachments are per-conversation; drop them when the session changes.
  useEffect(() => {
    setImages([]);
    setDragOver(false);
  }, [sessionId]);

  async function addFiles(files: Iterable<File>) {
    const accepted: File[] = [];
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      if (file.size > MAX_IMAGE_BYTES) {
        pushNotification(
          `Image too large (max ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB)`,
          "warning",
        );
        continue;
      }
      accepted.push(file);
    }
    if (accepted.length === 0) return;
    const loaded = (await Promise.all(accepted.map(fileToImage))).filter(
      (image): image is PendingImage => image !== null,
    );
    setImages((current) => {
      const next = [...current, ...loaded];
      if (next.length > MAX_IMAGES) {
        pushNotification(`Up to ${MAX_IMAGES} images per message`, "warning");
      }
      return next.slice(0, MAX_IMAGES);
    });
  }

  async function send() {
    if (!host || !workspace || !session || disabled) return;
    if (!text.trim() && images.length === 0) return;
    const value = text;
    const sentImages = images;
    const targetSessionId = session.sessionId;
    setSessionDraft(targetSessionId, "");
    setImages([]);
    const context = activeSessionContext(host, workspace, session);
    const imageParams =
      sentImages.length > 0
        ? { images: sentImages.map(({ mediaType, data }) => ({ mediaType, data })) }
        : {};
    const restoreDraft = () => {
      setSessionDraft(targetSessionId, value);
      setImages(sentImages);
    };

    try {
      if (busy) {
        const res =
          streamMode === "steer"
            ? await hostClient.request("agent.steer", context, { text: value, ...imageParams })
            : await hostClient.request("agent.followUp", context, {
                text: value,
                ...imageParams,
              });
        if (!res.ok) {
          pushNotification(res.error?.message ?? "Send failed", "error");
          restoreDraft();
        }
        return;
      }

      const res = await hostClient.request(
        "agent.prompt",
        context,
        { text: value, ...imageParams },
        null,
      );
      if (!res.ok) {
        pushNotification(res.error?.message ?? "Prompt failed", "error");
        restoreDraft();
      }
    } catch (error) {
      pushNotification(error instanceof Error ? error.message : "Send failed", "error");
      restoreDraft();
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

  const canSend = !disabled && (Boolean(text.trim()) || images.length > 0);

  return (
    <div className="shrink-0 px-5 pb-5 pt-2">
      <div
        className={`mx-auto max-w-3xl rounded-lg border bg-surface-raised p-2 shadow-sm transition-colors ${
          dragOver ? "border-accent" : "border-border"
        }`}
        onDragOver={(event) => {
          if (disabled) return;
          if ([...event.dataTransfer.items].some((item) => item.kind === "file")) {
            event.preventDefault();
            setDragOver(true);
          }
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => {
          if (disabled) return;
          event.preventDefault();
          setDragOver(false);
          void addFiles(event.dataTransfer.files);
        }}
      >
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2 px-2 pt-1.5">
            {images.map((image) => (
              <div key={image.id} className="group relative">
                <img
                  src={`data:${image.mediaType};base64,${image.data}`}
                  alt="attachment"
                  className="size-16 rounded-md border border-border object-cover"
                />
                <button
                  type="button"
                  title="Remove image"
                  aria-label="Remove image"
                  className="absolute -right-1.5 -top-1.5 hidden size-5 items-center justify-center rounded-full border border-border bg-surface-raised text-muted shadow group-hover:flex hover:text-danger"
                  onClick={() =>
                    setImages((current) => current.filter((it) => it.id !== image.id))
                  }
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          className="min-h-[76px] w-full resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted"
          placeholder={disabled ? "Chat unavailable" : "Message Pi"}
          value={text}
          disabled={disabled}
          onChange={(event) => {
            if (session) setSessionDraft(session.sessionId, event.target.value);
          }}
          onPaste={(event) => {
            const files = [...event.clipboardData.items]
              .filter((item) => item.kind === "file")
              .map((item) => item.getAsFile())
              .filter((file): file is File => file !== null);
            if (files.length > 0) {
              event.preventDefault();
              void addFiles(files);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div className="flex h-8 items-center gap-2 px-1">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(event) => {
              if (event.target.files) void addFiles(event.target.files);
              event.target.value = "";
            }}
          />
          <button
            type="button"
            title="Attach image"
            aria-label="Attach image"
            className="flex size-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground disabled:opacity-40"
            disabled={disabled || images.length >= MAX_IMAGES}
            onClick={() => fileInputRef.current?.click()}
          >
            <ImagePlus size={15} />
          </button>
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
                disabled={!canSend}
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
