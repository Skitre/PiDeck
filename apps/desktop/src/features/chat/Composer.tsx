import { useEffect, useRef, useState } from "react";
import { FileText, ImagePlus, Send, Square, X } from "lucide-react";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import type { SerializableImage } from "@pideck/protocol";
import { buildAttachedFileBlock } from "./transcript-model";
import {
  activeSessionContext,
  captureRequestGeneration,
  isCurrentRequestGeneration,
} from "../../lib/bridge/host-context";

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 4;
const MAX_FILE_BYTES = 256 * 1024;

type PendingImage = SerializableImage & { id: string };
type PendingFile = { id: string; name: string; size: number; text: string };

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

/** UTF-8 decoded content that still contains NULs or a high density of
 * replacement chars is binary, not text. */
function looksBinary(text: string): boolean {
  if (text.includes("\u0000")) return true;
  let bad = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 0xfffd) bad += 1;
  }
  return text.length > 0 && bad / text.length > 0.02;
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
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const busy = session ? !session.isIdle : false;
  const sessionId = session?.sessionId ?? null;

  // Attachments are per-conversation; drop them when the session changes.
  useEffect(() => {
    setImages([]);
    setFiles([]);
    setDragOver(false);
  }, [sessionId]);

  async function addFiles(incoming: Iterable<File>) {
    const imageFiles: File[] = [];
    const textFiles: File[] = [];
    for (const file of incoming) {
      if (file.type.startsWith("image/")) {
        if (file.size > MAX_IMAGE_BYTES) {
          pushNotification(
            `Image too large (max ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB)`,
            "warning",
          );
          continue;
        }
        imageFiles.push(file);
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        pushNotification(
          `${file.name}: file too large (max ${Math.round(MAX_FILE_BYTES / 1024)} KB)`,
          "warning",
        );
        continue;
      }
      textFiles.push(file);
    }

    if (imageFiles.length > 0) {
      const loaded = (await Promise.all(imageFiles.map(fileToImage))).filter(
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

    if (textFiles.length > 0) {
      const loaded: PendingFile[] = [];
      for (const file of textFiles) {
        try {
          const text = await file.text();
          if (looksBinary(text)) {
            pushNotification(`${file.name}: binary files are not supported`, "warning");
            continue;
          }
          loaded.push({
            id: crypto.randomUUID(),
            name: file.name,
            size: file.size,
            text,
          });
        } catch {
          pushNotification(`${file.name}: could not read file`, "warning");
        }
      }
      if (loaded.length > 0) {
        setFiles((current) => {
          const next = [...current, ...loaded];
          if (next.length > MAX_FILES) {
            pushNotification(`Up to ${MAX_FILES} files per message`, "warning");
          }
          return next.slice(0, MAX_FILES);
        });
      }
    }
  }

  async function send() {
    if (!host || !workspace || !session || disabled) return;
    if (!text.trim() && images.length === 0 && files.length === 0) return;
    const value = text;
    const sentImages = images;
    const sentFiles = files;
    const targetSessionId = session.sessionId;
    setSessionDraft(targetSessionId, "");
    setImages([]);
    setFiles([]);
    const context = activeSessionContext(host, workspace, session);
    const outgoingText =
      sentFiles.length > 0
        ? [value.trimEnd(), ...sentFiles.map((f) => buildAttachedFileBlock(f.name, f.text))]
            .filter(Boolean)
            .join("\n\n")
        : value;
    const imageParams =
      sentImages.length > 0
        ? { images: sentImages.map(({ mediaType, data }) => ({ mediaType, data })) }
        : {};
    const restoreDraft = () => {
      setSessionDraft(targetSessionId, value);
      setImages(sentImages);
      setFiles(sentFiles);
    };

    try {
      if (busy) {
        const res =
          streamMode === "steer"
            ? await hostClient.request("agent.steer", context, {
                text: outgoingText,
                ...imageParams,
              })
            : await hostClient.request("agent.followUp", context, {
                text: outgoingText,
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
        { text: outgoingText, ...imageParams },
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

  const canSend =
    !disabled && (Boolean(text.trim()) || images.length > 0 || files.length > 0);

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
        {files.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-2 pt-1.5">
            {files.map((file) => (
              <div
                key={file.id}
                className="group flex h-7 items-center gap-1.5 rounded-md border border-border bg-surface px-2 text-xs"
                title={`${file.name} · ${Math.max(1, Math.round(file.size / 1024))} KB`}
              >
                <FileText size={12} className="shrink-0 text-muted" />
                <span className="max-w-40 truncate">{file.name}</span>
                <button
                  type="button"
                  title="Remove file"
                  aria-label={`Remove ${file.name}`}
                  className="text-muted hover:text-danger"
                  onClick={() =>
                    setFiles((current) => current.filter((it) => it.id !== file.id))
                  }
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
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
            multiple
            className="hidden"
            onChange={(event) => {
              if (event.target.files) void addFiles(event.target.files);
              event.target.value = "";
            }}
          />
          <button
            type="button"
            title="Attach image or text file"
            aria-label="Attach image or text file"
            className="flex size-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground disabled:opacity-40"
            disabled={disabled || (images.length >= MAX_IMAGES && files.length >= MAX_FILES)}
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
