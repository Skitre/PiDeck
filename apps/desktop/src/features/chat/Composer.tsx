import { useEffect, useRef, useState } from "react";
import { FileText, Plus, Send, Square, X } from "lucide-react";
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

type CompletionItem = { insert: string; label: string; detail?: string };
type CompletionState = {
  kind: "command" | "file";
  /** Index in the draft where the trigger token (incl. `/` or `@`) starts. */
  tokenStart: number;
  query: string;
  items: CompletionItem[];
  selected: number;
};

/** `/name` at the very start of the draft, token touching the caret. */
export function commandTokenAt(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const match = /^\/([\w:-]*)$/.exec(before);
  return match ? { start: 0, query: match[1] } : null;
}

/** `@token` preceded by whitespace/start, token touching the caret. */
export function fileTokenAt(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const match = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!match) return null;
  return { start: before.length - match[2].length - 1, query: match[2] };
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
  const [completion, setCompletion] = useState<CompletionState | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const templatesRef = useRef<{ key: string; items: CompletionItem[] } | null>(null);
  const fileSearchSeq = useRef(0);
  const busy = session ? !session.isIdle : false;
  const sessionId = session?.sessionId ?? null;

  // Attachments are per-conversation; drop them when the session changes.
  useEffect(() => {
    setImages([]);
    setFiles([]);
    setDragOver(false);
    setCompletion(null);
  }, [sessionId]);

  async function loadCommandItems(): Promise<CompletionItem[]> {
    if (!host || !workspace || !session) return [];
    const key = `${session.sessionId}:${session.revision}`;
    if (templatesRef.current?.key === key) return templatesRef.current.items;
    const res = await hostClient.request(
      "session.getPromptTemplates",
      activeSessionContext(host, workspace, session),
      null,
    );
    if (!res.ok) return [];
    const items = res.result.templates.map((template) => ({
      insert: `/${template.name} `,
      label: `/${template.name}`,
      detail: [template.argumentHint, template.description].filter(Boolean).join(" — "),
    }));
    templatesRef.current = { key, items };
    return items;
  }

  function updateCompletion(nextText: string, caret: number) {
    const command = commandTokenAt(nextText, caret);
    if (command) {
      void loadCommandItems().then((all) => {
        const query = command.query.toLocaleLowerCase();
        const items = all
          .filter((item) => item.label.toLocaleLowerCase().startsWith(`/${query}`))
          .slice(0, 8);
        setCompletion(
          items.length > 0
            ? { kind: "command", tokenStart: command.start, query: command.query, items, selected: 0 }
            : null,
        );
      });
      return;
    }
    const file = fileTokenAt(nextText, caret);
    if (file && host && workspace) {
      const seq = ++fileSearchSeq.current;
      const context = {
        expectedHostInstanceId: host.hostInstanceId,
        expectedWorkspaceId: host.workspaceId,
        expectedWorkspaceRevision: host.workspaceRevision,
      };
      window.setTimeout(() => {
        if (seq !== fileSearchSeq.current) return;
        void hostClient
          .request("workspace.searchFiles", context, { query: file.query, limit: 20 })
          .then((res) => {
            if (seq !== fileSearchSeq.current || !res.ok) return;
            const items = res.result.files.map((path) => ({
              insert: `${path} `,
              label: path,
            }));
            setCompletion(
              items.length > 0
                ? { kind: "file", tokenStart: file.start, query: file.query, items, selected: 0 }
                : null,
            );
          })
          .catch(() => undefined);
      }, 120);
      return;
    }
    setCompletion(null);
  }

  function acceptCompletion(state: CompletionState, index: number) {
    const item = state.items[index];
    if (!item || !session) return;
    const caret = textareaRef.current?.selectionStart ?? text.length;
    const nextText = text.slice(0, state.tokenStart) + item.insert + text.slice(caret);
    setSessionDraft(session.sessionId, nextText);
    setCompletion(null);
    const nextCaret = state.tokenStart + item.insert.length;
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCaret, nextCaret);
    });
  }

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
        <div className="relative">
          {completion && (
            <div className="absolute bottom-full left-2 z-30 mb-1 max-h-64 w-[420px] max-w-[90%] overflow-y-auto rounded-md border border-border bg-surface-raised py-1 shadow-lg">
              {completion.items.map((item, index) => (
                <button
                  key={`${item.label}:${index}`}
                  type="button"
                  className={`flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left text-xs ${
                    index === completion.selected
                      ? "bg-surface-overlay text-foreground"
                      : "text-foreground/85 hover:bg-surface-overlay/60"
                  }`}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    acceptCompletion(completion, index);
                  }}
                >
                  <span className="shrink-0 font-medium">{item.label}</span>
                  {item.detail && (
                    <span className="min-w-0 truncate text-muted">{item.detail}</span>
                  )}
                </button>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            className="min-h-[76px] w-full resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted"
            placeholder={disabled ? "Chat unavailable" : "Message Pi  ( / commands · @ files )"}
            value={text}
            disabled={disabled}
            onChange={(event) => {
              if (!session) return;
              setSessionDraft(session.sessionId, event.target.value);
              updateCompletion(
                event.target.value,
                event.target.selectionStart ?? event.target.value.length,
              );
            }}
            onBlur={() => setCompletion(null)}
            onPaste={(event) => {
              const pasted = [...event.clipboardData.items]
                .filter((item) => item.kind === "file")
                .map((item) => item.getAsFile())
                .filter((file): file is File => file !== null);
              if (pasted.length > 0) {
                event.preventDefault();
                void addFiles(pasted);
              }
            }}
            onKeyDown={(event) => {
              if (completion) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const delta = event.key === "ArrowDown" ? 1 : -1;
                  setCompletion((current) =>
                    current
                      ? {
                          ...current,
                          selected:
                            (current.selected + delta + current.items.length) %
                            current.items.length,
                        }
                      : null,
                  );
                  return;
                }
                if (event.key === "Enter" || event.key === "Tab") {
                  event.preventDefault();
                  acceptCompletion(completion, completion.selected);
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setCompletion(null);
                  return;
                }
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
          />
        </div>
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
            <Plus size={16} />
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
