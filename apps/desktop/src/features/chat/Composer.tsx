import { useCallback, useEffect, useId, useRef, useState, type ClipboardEvent } from "react";
import {
  CircleAlert,
  CircleCheck,
  ClipboardPaste,
  FileText,
  LoaderCircle,
  MessageCircleQuestion,
  Plus,
  Puzzle,
  RefreshCw,
  Send,
  Square,
  Undo2,
  X,
} from "lucide-react";
import { busySendMethod } from "../../lib/busy-send";
import { useAppStore } from "../../lib/stores/app-store";
import { isExtensionDecisionBlockingSession } from "../../lib/stores/extension-ui-state";
import { hostClient } from "../../lib/bridge/host-client";
import {
  MAX_AGENT_ATTACHMENT_BYTES,
  MAX_AGENT_IMAGE_BYTES,
  MAX_AGENT_REQUEST_ATTACHMENT_BYTES,
  MAX_AGENT_REQUEST_ATTACHMENTS,
  MAX_AGENT_REQUEST_IMAGES,
  MAX_PASTED_TEXT_ATTACHMENT_BYTES,
  PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES,
  type AttachmentSnapshot,
  type JsonValue,
  type SerializableImage,
} from "@pideck/protocol";
import { buildAttachedFileBlock } from "./transcript-model";
import { ContextUsageRing, ModelControls } from "./ModelControls";
import { QueuePanel } from "./QueuePanel";
import { ExtensionWidgetsPopover, ExtensionWidgetsButton } from "./ExtensionWidgets";
import { PiMark } from "../../components/PiMark";
import {
  activeSessionContext,
  captureRequestGeneration,
  isCurrentRequestGeneration,
  workspaceContext,
} from "../../lib/bridge/host-context";
import { subscribeValidatedHostEvent } from "../../lib/bridge/validated-host-events";
import { subscribeComposerInsert } from "../../lib/composer-insert";
import { BUILTIN_COMMANDS, matchBuiltinCommand } from "./builtin-commands";
import { abortCompaction, requestCompact } from "./compaction-actions";
import { SessionStatsModal } from "./SessionStatsModal";
import { ForkModal } from "./ForkModal";
import { requestTreePanel } from "../../lib/dock-tree";
import { requestExport } from "../../lib/export-actions";
import { useImeComposition } from "../../lib/use-ime-composition";
import { useLocale, useT, type Translate } from "../../lib/i18n/use-t";
import {
  isDesktopRuntime,
  isDocumentPath,
  pickDesktopAttachmentPaths,
  readDesktopSmallFile,
} from "../../lib/desktop-file-access";
import { contextMenuTrigger, openContextMenu } from "../../lib/context-menu";
import { shouldKeepNativeContextMenu } from "../../lib/context-menu-policy";
import { buildTextContextMenuItems } from "../../lib/text-context-menu";
import { readClipboardText } from "../../lib/desktop-clipboard";
import { draftKeyForTarget, draftTargetFor } from "../../lib/draft-target";
import {
  commitDraftSend,
  deleteDraft,
  editDraft,
  restoreDraftSend,
  stageDraftSend,
} from "../../lib/draft-persistence";

const MAX_FILES = 4;
const MAX_FILE_BYTES = 256 * 1024;

function ExtensionStatusStrip() {
  const statuses = useAppStore((state) => state.extensionStatuses);
  const entries = Object.entries(statuses);
  if (entries.length === 0) return null;
  return (
    <div className="mb-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-2 text-[10px] text-muted">
      {entries.map(([key, text]) => (
        <span key={key} className="flex min-w-0 items-center gap-1.5" title={text}>
          <Puzzle size={11} className="shrink-0 text-accent" />
          <span className="max-w-[18rem] truncate">
            {key !== "default" && <span className="mr-1 text-foreground/70">{key}</span>}
            {text}
          </span>
        </span>
      ))}
    </div>
  );
}

type PendingImage = SerializableImage & { id: string };
type PendingFile = { id: string; name: string; size: number; text: string };
type PasteRecovery = {
  sessionId: string;
  text: string;
  draft: string;
  selectionStart: number;
  selectionEnd: number;
};
type PendingPathDocument = AttachmentSnapshot & {
  kind: "path";
  sourcePath: string;
};
type PendingPastedText = AttachmentSnapshot & {
  kind: "pasted-text";
  remote: boolean;
  recovery: PasteRecovery;
};
type PendingDocument = PendingPathDocument | PendingPastedText;

function localPathName(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path;
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function localizedDocumentError(message: string | undefined, t: Translate): string {
  if (!message) return t("composerDocumentParseFailed");
  if (/100 mib|message limit/iu.test(message)) {
    return t("composerDocumentTotalTooLarge", {
      max: Math.round(MAX_AGENT_REQUEST_ATTACHMENT_BYTES / 1024 / 1024),
    });
  }
  if (/password|encrypted/iu.test(message)) return t("composerDocumentEncrypted");
  if (/scanned|ocr|visible text/iu.test(message)) return t("composerDocumentNeedsOcr");
  if (/genuine|valid docx|only.*pdf|unsupported.*type/iu.test(message)) {
    return t("composerDocumentTypeMismatch");
  }
  if (/damaged|invalid pdf|bad xref|formaterror|structure/iu.test(message)) {
    return t("composerDocumentDamaged");
  }
  if (/exceed|too large|50 mib|100 mib/iu.test(message)) {
    return t("composerDocumentTooLarge", {
      max: Math.round(MAX_AGENT_ATTACHMENT_BYTES / 1024 / 1024),
    });
  }
  return t("composerDocumentParseFailedDetail", { error: message });
}

function documentStatusText(document: PendingDocument, t: Translate): string {
  if (document.status === "copying") {
    return document.kind === "pasted-text"
      ? t("composerPastedTextSaving")
      : t("composerDocumentCopying");
  }
  if (document.status === "parsing") {
    if (document.unitCount !== undefined && document.processedUnits !== undefined) {
      return t("composerDocumentParsingProgress", {
        done: document.processedUnits,
        total: document.unitCount,
      });
    }
    return t("composerDocumentParsing");
  }
  if (document.status === "needs_ocr") return t("composerDocumentNeedsOcr");
  if (document.status === "failed") return localizedDocumentError(document.error, t);
  const count = document.unitCount ?? 0;
  return document.unit === "page"
    ? t("composerDocumentPages", { count })
    : t("composerDocumentChunks", { count });
}

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

function builtinCompletionItems(t: Translate): CompletionItem[] {
  const descriptions = {
    compact: "composerBuiltinCompact",
    session: "composerBuiltinSession",
    tree: "composerBuiltinTree",
    fork: "composerBuiltinFork",
    export: "composerBuiltinExport",
    login: "composerBuiltinLogin",
  } as const;
  return BUILTIN_COMMANDS.map((command) => ({
    insert: `/${command.name} `,
    label: `/${command.name}`,
    detail: [
      command.name === "compact" ? t("composerBuiltinInstructionsHint") : command.argumentHint,
      t(descriptions[command.name as keyof typeof descriptions]),
      `(${t("composerCommandKindBuiltin")})`,
    ]
      .filter(Boolean)
      .join(" — "),
  }));
}
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
export function fileTokenAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const match = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!match) return null;
  return { start: before.length - match[2].length - 1, query: match[2] };
}

/** LiveAgent-style rank: filename prefix < path prefix < filename substring
 * < rest, then shallower, then dirs before files. */
function fileSortKey(
  entry: { path: string; kind: "file" | "dir" },
  query: string,
): [number, number, number] {
  const path = entry.path.toLocaleLowerCase();
  const name = path.slice(path.lastIndexOf("/") + 1);
  const rank = !query
    ? 3
    : name.startsWith(query)
      ? 0
      : path.startsWith(query)
        ? 1
        : name.includes(query)
          ? 2
          : 3;
  return [rank, entry.path.split("/").length, entry.kind === "dir" ? 0 : 1];
}

export function Composer({
  disabled,
  welcomeWorkspaceName,
}: {
  disabled?: boolean;
  welcomeWorkspaceName?: string;
}) {
  const t = useT();
  const locale = useLocale();
  const host = useAppStore((s) => s.host);
  const workspace = useAppStore((s) => s.workspace);
  const session = useAppStore((s) => s.session);
  const busySendBehavior = useAppStore((s) => s.desktopSettings?.busySendBehavior);
  const extensionUiRequest = useAppStore((s) => s.extensionUiRequest);
  const extensionDecisionGroups = useAppStore((s) => s.extensionDecisionGroups);
  const draftTarget = draftTargetFor(workspace, session);
  const draftKey = draftTarget ? draftKeyForTarget(draftTarget) : null;
  const text = useAppStore((s) => (draftKey ? (s.draftTexts[draftKey] ?? "") : ""));
  const extensionWidgetsOpen = useAppStore((s) => s.extensionWidgetsOpen);
  const setExtensionWidgetsOpen = useAppStore((s) => s.setExtensionWidgetsOpen);
  const setSession = useAppStore((s) => s.applySessionSnapshot);
  const pushNotification = useAppStore((s) => s.pushNotification);
  const openSettingsSection = useAppStore((s) => s.openSettingsSection);
  const setAuthBlocked = useAppStore((s) => s.setAuthBlocked);
  const [images, setImages] = useState<PendingImage[]>([]);
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [documents, setDocuments] = useState<PendingDocument[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [completion, setCompletion] = useState<CompletionState | null>(null);
  const [statsOpen, setStatsOpen] = useState(false);
  const [forkOpen, setForkOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previousBlockedSessionRef = useRef<string | null>(null);
  const documentsRef = useRef<PendingDocument[]>([]);
  const recoveringPastedTextRef = useRef(new Set<string>());
  const recoverFailedPastedTextCallbackRef = useRef<
    (document: PendingPastedText, error?: string) => Promise<void>
  >(async () => undefined);
  const addLocalPathsCallbackRef = useRef<(paths: readonly string[]) => Promise<void>>(
    async () => undefined,
  );
  const decisionHintId = useId();
  const extensionWidgetAnchorRef = useRef<HTMLDivElement>(null);
  const templatesRef = useRef<{ key: string; items: CompletionItem[] } | null>(null);
  const fileSnapshotRef = useRef<{
    query: string;
    entries: { path: string; kind: "file" | "dir" }[];
    truncated: boolean;
  } | null>(null);
  const completionGeneration = useRef(0);
  const ime = useImeComposition();
  const busy = session ? !session.isIdle : false;
  const sessionId = session?.sessionId ?? null;
  const decisionBlocked = isExtensionDecisionBlockingSession(
    extensionUiRequest,
    extensionDecisionGroups,
    sessionId,
  );
  const blockedSessionId = decisionBlocked ? sessionId : null;

  const dismissCompletion = useCallback(() => {
    completionGeneration.current += 1;
    setCompletion(null);
  }, []);

  function updateDocuments(
    updater: (current: PendingDocument[]) => PendingDocument[],
  ): PendingDocument[] {
    const next = updater(documentsRef.current);
    documentsRef.current = next;
    setDocuments(next);
    return next;
  }

  function insertRecoveredText(recovery: PasteRecovery) {
    const state = useAppStore.getState();
    if (state.session?.sessionId !== recovery.sessionId) return;
    const target = draftTargetFor(state.workspace, state.session);
    if (!target) return;
    const key = draftKeyForTarget(target);
    const currentDraft = state.draftTexts[key] ?? "";
    const textarea = textareaRef.current;
    const draftIsUnchanged = currentDraft === recovery.draft;
    const start = draftIsUnchanged
      ? recovery.selectionStart
      : (textarea?.selectionStart ?? currentDraft.length);
    const end = draftIsUnchanged ? recovery.selectionEnd : start;
    const next = currentDraft.slice(0, start) + recovery.text + currentDraft.slice(end);
    editDraft(target, next);
    dismissCompletion();
    const caret = start + recovery.text.length;
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(caret, caret);
    });
  }

  useEffect(() => {
    const previousBlockedSessionId = previousBlockedSessionRef.current;
    previousBlockedSessionRef.current = blockedSessionId;
    if (
      !previousBlockedSessionId ||
      blockedSessionId !== null ||
      previousBlockedSessionId !== sessionId ||
      disabled
    ) {
      return;
    }
    const frame = window.requestAnimationFrame(() => textareaRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [blockedSessionId, disabled, sessionId]);

  useEffect(
    () =>
      subscribeComposerInsert((insert) => {
        const current = useAppStore.getState();
        const target = draftTargetFor(current.workspace, current.session);
        if (!target) return false;
        const draft = current.draftTexts[draftKeyForTarget(target)] ?? "";
        const textarea = textareaRef.current;
        const start = textarea?.selectionStart ?? draft.length;
        const end = textarea?.selectionEnd ?? start;
        const before = draft.slice(0, start);
        const after = draft.slice(end);
        const prefix = before && !/\s$/.test(before) ? " " : "";
        const suffix = after && !/^\s/.test(after) ? " " : "";
        const inserted = `${prefix}${insert}${suffix}`;
        const next = before + inserted + after;
        editDraft(target, next);
        const caret = before.length + inserted.length;
        requestAnimationFrame(() => {
          textareaRef.current?.focus();
          textareaRef.current?.setSelectionRange(caret, caret);
        });
        return true;
      }),
    [],
  );

  // Attachments are per-conversation; drop them when the session changes.
  useEffect(() => {
    setImages([]);
    setFiles([]);
    documentsRef.current = [];
    setDocuments([]);
    recoveringPastedTextRef.current.clear();
    setDragOver(false);
    dismissCompletion();
    setStatsOpen(false);
    setForkOpen(false);
    fileSnapshotRef.current = null;
  }, [dismissCompletion, sessionId]);

  useEffect(() => {
    if (!host || !workspace || !session) return;
    return subscribeValidatedHostEvent(
      "attachment.changed",
      activeSessionContext(host, workspace, session),
      (event) => {
        if (event.sessionId !== sessionId) return;
        const current = documentsRef.current.find(
          (document) => document.id === event.payload.attachment.id,
        );
        if (current?.kind === "pasted-text" && event.payload.attachment.status === "failed") {
          void recoverFailedPastedTextCallbackRef.current(current, event.payload.attachment.error);
          return;
        }
        updateDocuments((current) =>
          current.map((document) =>
            document.id === event.payload.attachment.id
              ? { ...document, ...event.payload.attachment }
              : document,
          ),
        );
      },
    );
  }, [host, workspace, session, sessionId]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void isDesktopRuntime()
      .then(async (isDesktop) => {
        if (!isDesktop || cancelled) return;
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        unlisten = await getCurrentWebview().onDragDropEvent((event) => {
          if (cancelled || disabled) return;
          if (event.payload.type === "enter" || event.payload.type === "over") {
            setDragOver(true);
          } else if (event.payload.type === "leave") {
            setDragOver(false);
          } else if (event.payload.type === "drop") {
            setDragOver(false);
            void addLocalPathsCallbackRef.current(event.payload.paths);
          }
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [disabled, sessionId]);

  function closeExtensionWidgets() {
    setExtensionWidgetsOpen(false);
  }

  function toggleExtensionWidgets() {
    setExtensionWidgetsOpen(!extensionWidgetsOpen);
  }

  async function loadCommandItems(): Promise<{
    cacheKey: string | null;
    items: CompletionItem[];
  }> {
    if (!host || !workspace || !session) return { cacheKey: null, items: [] };
    const key = `${locale}:${session.sessionId}:${session.revision}`;
    if (templatesRef.current?.key === key) {
      return { cacheKey: key, items: templatesRef.current.items };
    }
    const res = await hostClient.request(
      "session.getCommands",
      activeSessionContext(host, workspace, session),
      null,
    );
    const builtins = builtinCompletionItems(t);
    if (!res.ok) return { cacheKey: null, items: builtins };
    const kindLabel = {
      template: t("composerCommandKindPrompt"),
      command: t("composerCommandKindExtension"),
      skill: t("composerCommandKindSkill"),
    } as const;
    const items = [
      ...res.result.commands.map((command) => ({
        insert: `/${command.invocation} `,
        label: `/${command.invocation}`,
        detail: [command.argumentHint, command.description, `(${kindLabel[command.kind]})`]
          .filter(Boolean)
          .join(" — "),
      })),
      ...builtins,
    ];
    return { cacheKey: key, items };
  }

  function updateCompletion(nextText: string, caret: number) {
    const generation = ++completionGeneration.current;
    const command = commandTokenAt(nextText, caret);
    if (command) {
      void loadCommandItems()
        .then(({ cacheKey, items: all }) => {
          if (generation !== completionGeneration.current) return;
          if (cacheKey) templatesRef.current = { key: cacheKey, items: all };
          const query = command.query.toLocaleLowerCase();
          // Prefix matches rank first, substring matches anywhere follow
          // (so /con still finds fast-context); stable sort keeps the
          // template/command/skill grouping within each rank.
          const items = all
            .map((item) => {
              const name = item.label.toLocaleLowerCase();
              const rank = !query
                ? 0
                : name.startsWith(`/${query}`)
                  ? 0
                  : name.includes(query)
                    ? 1
                    : 2;
              return { item, rank };
            })
            .filter(({ rank }) => rank < 2)
            .sort((a, b) => a.rank - b.rank)
            .map(({ item }) => item);
          setCompletion(
            items.length > 0
              ? {
                  kind: "command",
                  tokenStart: command.start,
                  query: command.query,
                  items,
                  selected: 0,
                }
              : null,
          );
        })
        .catch(() => {
          if (generation === completionGeneration.current) setCompletion(null);
        });
      return;
    }
    const file = fileTokenAt(nextText, caret);
    if (file && host && workspace) {
      const query = file.query.toLocaleLowerCase();

      const applySnapshot = (snapshot: {
        query: string;
        entries: { path: string; kind: "file" | "dir" }[];
        truncated: boolean;
      }) => {
        if (generation !== completionGeneration.current) return;
        const matches = snapshot.entries
          .filter((entry) => entry.path.toLocaleLowerCase().includes(query))
          .map((entry) => ({ entry, key: fileSortKey(entry, query) }))
          .sort(
            (a, b) =>
              a.key[0] - b.key[0] ||
              a.key[1] - b.key[1] ||
              a.key[2] - b.key[2] ||
              (a.entry.path < b.entry.path ? -1 : 1),
          )
          .slice(0, 30)
          .map(({ entry }) => ({
            // Files replace the whole @token with the bare path; directories
            // keep the @ so the mention stays active for drilling deeper.
            insert: entry.kind === "dir" ? `@${entry.path}/` : `${entry.path} `,
            label: entry.kind === "dir" ? `${entry.path}/` : entry.path,
          }));
        setCompletion(
          matches.length > 0
            ? {
                kind: "file",
                tokenStart: file.start,
                query: file.query,
                items: matches,
                selected: 0,
              }
            : null,
        );
      };

      // Session snapshot: one host fetch per @-session; keystrokes filter the
      // snapshot client-side. Refetch only when the query stops extending the
      // snapshot's query (or the snapshot was truncated).
      const cached = fileSnapshotRef.current;
      if (cached && !cached.truncated && query.startsWith(cached.query)) {
        applySnapshot(cached);
        return;
      }
      const context = workspaceContext(host, workspace);
      void hostClient
        .request("workspace.searchFiles", context, { query: file.query, limit: 3000 })
        .then((res) => {
          if (!res.ok) return;
          if (generation !== completionGeneration.current) return;
          const snapshot = {
            query,
            entries: res.result.files,
            truncated: res.result.truncated,
          };
          fileSnapshotRef.current = snapshot;
          applySnapshot(snapshot);
        })
        .catch(() => undefined);
      return;
    }
    setCompletion(null);
  }

  function acceptCompletion(state: CompletionState, index: number) {
    const item = state.items[index];
    if (!item || !draftTarget) return;
    const caret = textareaRef.current?.selectionStart ?? text.length;
    const nextText = text.slice(0, state.tokenStart) + item.insert + text.slice(caret);
    editDraft(draftTarget, nextText);
    dismissCompletion();
    const nextCaret = state.tokenStart + item.insert.length;
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCaret, nextCaret);
    });
    // Accepting a directory keeps the mention open so the user drills deeper.
    if (state.kind === "file" && item.insert.endsWith("/")) {
      updateCompletion(nextText, nextCaret);
    }
  }

  async function addDocumentPath(path: string) {
    if (!host || !workspace || !session) return;
    if (documentsRef.current.length >= MAX_AGENT_REQUEST_ATTACHMENTS) {
      pushNotification(
        t("composerDocumentLimit", { max: MAX_AGENT_REQUEST_ATTACHMENTS }),
        "warning",
      );
      return;
    }
    const context = activeSessionContext(host, workspace, session);
    const generation = captureRequestGeneration(host);
    try {
      const response = await hostClient.request("attachment.create", context, { path }, 120_000);
      if (!response.ok) {
        pushNotification(localizedDocumentError(response.error?.message, t), "error");
        return;
      }
      if (
        !isCurrentRequestGeneration(useAppStore.getState().host, generation, {
          session: true,
        })
      ) {
        return;
      }
      const totalBytes = documentsRef.current.reduce(
        (total, document) => total + document.sizeBytes,
        response.result.sizeBytes,
      );
      if (totalBytes > MAX_AGENT_REQUEST_ATTACHMENT_BYTES) {
        await hostClient
          .request("attachment.remove", context, { attachmentId: response.result.id })
          .catch(() => undefined);
        pushNotification(
          t("composerDocumentTotalTooLarge", {
            max: Math.round(MAX_AGENT_REQUEST_ATTACHMENT_BYTES / 1024 / 1024),
          }),
          "warning",
        );
        return;
      }
      updateDocuments((current) => [
        ...current,
        { ...response.result, kind: "path", sourcePath: path },
      ]);

      // Parsing can finish before the create response reaches the renderer.
      // Fetch once after insertion so no final state event can be lost.
      void hostClient
        .request("attachment.get", context, { attachmentId: response.result.id })
        .then((latest) => {
          if (!latest.ok) return;
          updateDocuments((current) =>
            current.map((document) =>
              document.id === latest.result.id ? { ...document, ...latest.result } : document,
            ),
          );
        })
        .catch(() => undefined);
    } catch (error) {
      pushNotification(
        localizedDocumentError(error instanceof Error ? error.message : String(error), t),
        "error",
      );
    }
  }

  async function removeDocument(document: PendingDocument): Promise<boolean> {
    if (!host || !workspace || !session) return false;
    try {
      const response = await hostClient.request(
        "attachment.remove",
        activeSessionContext(host, workspace, session),
        { attachmentId: document.id },
      );
      if (!response.ok) {
        pushNotification(response.error?.message ?? t("composerDocumentRemoveFailed"), "error");
        return false;
      }
      updateDocuments((current) => current.filter((item) => item.id !== document.id));
      return true;
    } catch (error) {
      pushNotification(
        error instanceof Error ? error.message : t("composerDocumentRemoveFailed"),
        "error",
      );
      return false;
    }
  }

  async function retryDocument(document: PendingPathDocument) {
    if (!(await removeDocument(document))) return;
    await addDocumentPath(document.sourcePath);
  }

  async function recoverFailedPastedText(
    document: PendingPastedText,
    error?: string,
  ): Promise<void> {
    if (recoveringPastedTextRef.current.has(document.id)) return;
    recoveringPastedTextRef.current.add(document.id);
    try {
      if (document.remote && host && workspace && session) {
        await hostClient
          .request("attachment.remove", activeSessionContext(host, workspace, session), {
            attachmentId: document.id,
          })
          .catch(() => undefined);
      }
      updateDocuments((current) => current.filter((item) => item.id !== document.id));
      insertRecoveredText(document.recovery);
      pushNotification(
        t("composerPastedTextCreateFailed", {
          error: error || t("composerDocumentParseFailed"),
        }),
        "error",
      );
    } finally {
      recoveringPastedTextRef.current.delete(document.id);
    }
  }
  recoverFailedPastedTextCallbackRef.current = recoverFailedPastedText;

  async function restorePastedText(document: PendingPastedText): Promise<void> {
    if (!document.remote) return;
    if (!(await removeDocument(document))) return;
    insertRecoveredText(document.recovery);
  }

  async function addPastedText(recovery: PasteRecovery) {
    if (!host || !workspace || !session) return;
    const localId = crypto.randomUUID();
    const pending: PendingPastedText = {
      id: localId,
      name: t("composerPastedTextName"),
      mediaType: "text/plain",
      sizeBytes: utf8ByteLength(recovery.text),
      status: "copying",
      unit: "chunk",
      kind: "pasted-text",
      remote: false,
      recovery,
    };
    updateDocuments((current) => [...current, pending]);
    const context = activeSessionContext(host, workspace, session);
    const generation = captureRequestGeneration(host);
    const generationIsCurrent = () =>
      isCurrentRequestGeneration(useAppStore.getState().host, generation, {
        session: true,
      });
    try {
      const response = await hostClient.request(
        "attachment.createText",
        context,
        { text: recovery.text },
        120_000,
      );
      if (!response.ok) {
        if (!generationIsCurrent()) {
          updateDocuments((current) => current.filter((item) => item.id !== localId));
          return;
        }
        await recoverFailedPastedText(pending, response.error?.message);
        return;
      }
      if (!generationIsCurrent()) {
        await hostClient
          .request("attachment.remove", context, { attachmentId: response.result.id })
          .catch(() => undefined);
        updateDocuments((current) => current.filter((item) => item.id !== localId));
        return;
      }
      const totalBytes = documentsRef.current.reduce(
        (total, document) => total + (document.id === localId ? 0 : document.sizeBytes),
        response.result.sizeBytes,
      );
      if (totalBytes > MAX_AGENT_REQUEST_ATTACHMENT_BYTES) {
        await hostClient
          .request("attachment.remove", context, { attachmentId: response.result.id })
          .catch(() => undefined);
        updateDocuments((current) => current.filter((item) => item.id !== localId));
        insertRecoveredText(recovery);
        pushNotification(
          t("composerDocumentTotalTooLarge", {
            max: Math.round(MAX_AGENT_REQUEST_ATTACHMENT_BYTES / 1024 / 1024),
          }),
          "warning",
        );
        return;
      }
      const created: PendingPastedText = {
        ...response.result,
        kind: "pasted-text",
        remote: true,
        recovery,
      };
      updateDocuments((current) =>
        current.map((document) => (document.id === localId ? created : document)),
      );

      void hostClient
        .request("attachment.get", context, { attachmentId: created.id })
        .then((latest) => {
          if (!latest.ok) return;
          const current = documentsRef.current.find((document) => document.id === latest.result.id);
          if (current?.kind === "pasted-text" && latest.result.status === "failed") {
            void recoverFailedPastedText(current, latest.result.error);
            return;
          }
          updateDocuments((documents) =>
            documents.map((document) =>
              document.id === latest.result.id ? { ...document, ...latest.result } : document,
            ),
          );
        })
        .catch(() => undefined);
    } catch (error) {
      if (!generationIsCurrent()) {
        updateDocuments((current) => current.filter((item) => item.id !== localId));
        return;
      }
      await recoverFailedPastedText(
        pending,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async function addLocalPaths(paths: readonly string[]) {
    for (const path of paths) {
      if (isDocumentPath(path)) {
        await addDocumentPath(path);
        continue;
      }
      try {
        const file = await readDesktopSmallFile(path);
        if (file.kind === "image") {
          setImages((current) => {
            if (current.length >= MAX_AGENT_REQUEST_IMAGES) {
              pushNotification(
                t("composerImageLimit", { max: MAX_AGENT_REQUEST_IMAGES }),
                "warning",
              );
              return current;
            }
            return [
              ...current,
              {
                id: crypto.randomUUID(),
                mediaType: file.mediaType,
                data: file.data,
              },
            ];
          });
        } else {
          setFiles((current) => {
            if (current.length >= MAX_FILES) {
              pushNotification(t("composerFileLimit", { max: MAX_FILES }), "warning");
              return current;
            }
            return [
              ...current,
              {
                id: crypto.randomUUID(),
                name: file.name,
                size: file.sizeBytes,
                text: file.text,
              },
            ];
          });
        }
      } catch (error) {
        pushNotification(
          t("composerReadFileFailedDetail", {
            name: localPathName(path),
            error: error instanceof Error ? error.message : String(error),
          }),
          "warning",
        );
      }
    }
  }
  addLocalPathsCallbackRef.current = addLocalPaths;

  async function chooseAttachments() {
    try {
      const paths = await pickDesktopAttachmentPaths();
      if (paths === null) {
        fileInputRef.current?.click();
        return;
      }
      await addLocalPaths(paths);
    } catch (error) {
      pushNotification(
        error instanceof Error ? error.message : t("composerFilePickerFailed"),
        "error",
      );
    }
  }

  async function addFiles(incoming: Iterable<File>) {
    const imageFiles: File[] = [];
    const textFiles: File[] = [];
    for (const file of incoming) {
      if (/\.(?:pdf|docx)$/iu.test(file.name)) {
        pushNotification(t("composerDocumentDesktopOnly", { name: file.name }), "warning");
        continue;
      }
      if (file.type.startsWith("image/")) {
        if (file.size > MAX_AGENT_IMAGE_BYTES) {
          pushNotification(
            t("composerImageTooLarge", {
              max: Math.round(MAX_AGENT_IMAGE_BYTES / 1024 / 1024),
            }),
            "warning",
          );
          continue;
        }
        imageFiles.push(file);
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        pushNotification(
          t("composerFileTooLarge", {
            name: file.name,
            max: Math.round(MAX_FILE_BYTES / 1024),
          }),
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
        if (next.length > MAX_AGENT_REQUEST_IMAGES) {
          pushNotification(t("composerImageLimit", { max: MAX_AGENT_REQUEST_IMAGES }), "warning");
        }
        return next.slice(0, MAX_AGENT_REQUEST_IMAGES);
      });
    }

    if (textFiles.length > 0) {
      const loaded: PendingFile[] = [];
      for (const file of textFiles) {
        try {
          const text = await file.text();
          if (looksBinary(text)) {
            pushNotification(t("composerBinaryUnsupported", { name: file.name }), "warning");
            continue;
          }
          loaded.push({
            id: crypto.randomUUID(),
            name: file.name,
            size: file.size,
            text,
          });
        } catch {
          pushNotification(t("composerReadFileFailed", { name: file.name }), "warning");
        }
      }
      if (loaded.length > 0) {
        setFiles((current) => {
          const next = [...current, ...loaded];
          if (next.length > MAX_FILES) {
            pushNotification(t("composerFileLimit", { max: MAX_FILES }), "warning");
          }
          return next.slice(0, MAX_FILES);
        });
      }
    }
  }

  function pasteTextAsAttachment(
    pastedText: string,
    selectionStart: number,
    selectionEnd: number,
  ): boolean {
    const sizeBytes = utf8ByteLength(pastedText);
    if (pastedText.trim().length === 0 || pastedText.includes("\u0000")) {
      pushNotification(t("composerPastedTextInvalid"), "warning");
      return false;
    }
    if (sizeBytes > MAX_PASTED_TEXT_ATTACHMENT_BYTES) {
      pushNotification(
        t("composerPastedTextTooLarge", {
          max: Math.round(MAX_PASTED_TEXT_ATTACHMENT_BYTES / 1024 / 1024),
        }),
        "warning",
      );
      return false;
    }
    if (documentsRef.current.length >= MAX_AGENT_REQUEST_ATTACHMENTS) {
      pushNotification(
        t("composerDocumentLimit", { max: MAX_AGENT_REQUEST_ATTACHMENTS }),
        "warning",
      );
      return false;
    }
    const totalBytes = documentsRef.current.reduce(
      (total, document) => total + document.sizeBytes,
      sizeBytes,
    );
    if (totalBytes > MAX_AGENT_REQUEST_ATTACHMENT_BYTES) {
      pushNotification(
        t("composerDocumentTotalTooLarge", {
          max: Math.round(MAX_AGENT_REQUEST_ATTACHMENT_BYTES / 1024 / 1024),
        }),
        "warning",
      );
      return false;
    }
    if (!session) return false;
    void addPastedText({
      sessionId: session.sessionId,
      text: pastedText,
      draft: text,
      selectionStart,
      selectionEnd,
    });
    return true;
  }

  function handleComposerPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const pastedFiles = [...event.clipboardData.items]
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (pastedFiles.length > 0) {
      event.preventDefault();
      void addFiles(pastedFiles);
      return;
    }

    const pastedText = event.clipboardData.getData("text/plain");
    const sizeBytes = utf8ByteLength(pastedText);
    if (sizeBytes < PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES) return;

    event.preventDefault();
    const selectionStart = event.currentTarget.selectionStart ?? text.length;
    const selectionEnd = event.currentTarget.selectionEnd ?? selectionStart;
    pasteTextAsAttachment(pastedText, selectionStart, selectionEnd);
  }

  async function send() {
    if (!host || !workspace || !session || !draftTarget || disabled || decisionBlocked) return;
    if (
      documents.some((document) => document.status !== "ready") ||
      (!text.trim() && images.length === 0 && files.length === 0 && documents.length === 0)
    ) {
      return;
    }

    const builtin = matchBuiltinCommand(text);
    if (builtin?.name === "session") {
      deleteDraft(draftTarget);
      dismissCompletion();
      setStatsOpen(true);
      return;
    }
    if (builtin?.name === "tree") {
      deleteDraft(draftTarget);
      dismissCompletion();
      requestTreePanel();
      return;
    }
    if (builtin?.name === "fork") {
      deleteDraft(draftTarget);
      dismissCompletion();
      setForkOpen(true);
      return;
    }
    if (builtin?.name === "export") {
      const arg = builtin.args?.trim().toLowerCase();
      if (arg && arg !== "html" && arg !== "jsonl") {
        pushNotification(t("composerExportUsage"), "error");
        return;
      }
      deleteDraft(draftTarget);
      dismissCompletion();
      void requestExport(arg === "jsonl" ? "jsonl" : "html");
      return;
    }
    if (builtin?.name === "compact") {
      if (busy) {
        // requestCompact surfaces the busy notification; keep the draft.
        void requestCompact(builtin.args);
        return;
      }
      const receipt = stageDraftSend(draftTarget);
      dismissCompletion();
      if (!(await requestCompact(builtin.args))) {
        restoreDraftSend(receipt);
      } else {
        commitDraftSend(receipt);
      }
      return;
    }
    if (builtin?.name === "login") {
      // The Pi CLI's /login has no meaning here — without this interception it
      // would go to the model as plain text and, in the no-credentials case,
      // echo back the same "run /login" guidance forever.
      deleteDraft(draftTarget);
      dismissCompletion();
      openSettingsSection("providers");
      pushNotification(t("composerLoginGuidance"), "info");
      return;
    }

    const value = text;
    const sentImages = images;
    const sentFiles = files;
    const sentDocuments = documents;
    const sendReceipt = stageDraftSend(draftTarget);
    dismissCompletion();
    setImages([]);
    setFiles([]);
    documentsRef.current = [];
    setDocuments([]);
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
    const attachmentParams =
      sentDocuments.length > 0
        ? { attachmentIds: sentDocuments.map((document) => document.id) }
        : {};
    const restoreDraft = () => {
      restoreDraftSend(sendReceipt);
      setImages(sentImages);
      setFiles(sentFiles);
      documentsRef.current = sentDocuments;
      setDocuments(sentDocuments);
    };
    // AUTH_REQUIRED gets the persistent banner (with a Providers-settings
    // path) instead of a vanishing toast; anything else keeps the toast.
    const handleSendFailure = (
      error: { code: string; message: string; details?: JsonValue } | undefined,
      fallback: string,
    ) => {
      if (error?.code === "AUTH_REQUIRED") {
        const details = error.details;
        setAuthBlocked({
          providerId:
            details && typeof details === "object" && !Array.isArray(details)
              ? typeof details.providerId === "string"
                ? details.providerId
                : null
              : null,
        });
      } else {
        pushNotification(error?.message ?? fallback, "error");
      }
      restoreDraft();
    };

    try {
      if (busy) {
        const res = await hostClient.request(busySendMethod(busySendBehavior), context, {
          text: outgoingText,
          ...imageParams,
          ...attachmentParams,
        });
        if (!res.ok) {
          handleSendFailure(res.error, t("composerSendFailed"));
        } else {
          commitDraftSend(sendReceipt);
        }
        return;
      }

      const res = await hostClient.request(
        "agent.prompt",
        context,
        { text: outgoingText, ...imageParams, ...attachmentParams },
        null,
      );
      if (!res.ok) {
        handleSendFailure(res.error, t("composerPromptFailed"));
      } else {
        commitDraftSend(sendReceipt);
        // An accepted prompt means credentials resolved; drop any stale banner.
        setAuthBlocked(null);
      }
    } catch (error) {
      pushNotification(error instanceof Error ? error.message : t("composerSendFailed"), "error");
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
    if (!res.ok) {
      pushNotification(res.error?.message ?? t("composerAbortFailed"), "error");
      return;
    }
    setSession(res.result.session);
    if (res.result.error) {
      pushNotification(res.result.error.message, "error");
    }
  }

  const hasDraftContent =
    Boolean(text.trim()) || images.length > 0 || files.length > 0 || documents.length > 0;
  const documentsReady = documents.every((document) => document.status === "ready");
  const canSend = !disabled && !decisionBlocked && documentsReady && hasDraftContent;

  return (
    <div
      className={
        welcomeWorkspaceName
          ? "flex min-h-0 flex-1 flex-col justify-center px-5 pb-14 pt-6"
          : "shrink-0 px-5 pb-5 pt-2"
      }
    >
      {welcomeWorkspaceName && (
        <div className="conversation-content-width new-conversation-copy mx-auto mb-6 flex flex-col items-center text-center">
          <PiMark className="mb-4 size-10" />
          <h2 className="max-w-full truncate text-xl font-medium text-foreground">
            {t("composerStartIn", { workspace: welcomeWorkspaceName })}
          </h2>
          <p className="mt-2 text-sm text-muted">{t("composerQuestion")}</p>
        </div>
      )}
      <QueuePanel />
      <div
        ref={extensionWidgetAnchorRef}
        className="conversation-content-width relative mx-auto w-full"
        data-extension-widget-anchor
      >
        <ExtensionStatusStrip />
        <div
          className={`chat-composer-surface rounded-xl border bg-surface-raised p-2 shadow-sm transition-colors ${
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
          {documents.length > 0 && (
            <div
              className="grid gap-1.5 px-2 pt-1.5 sm:grid-cols-2"
              aria-live="polite"
              aria-label={t("composerDocuments")}
            >
              {documents.map((document) => {
                const active = document.status === "copying" || document.status === "parsing";
                const failed = document.status === "failed" || document.status === "needs_ocr";
                const progress =
                  document.unitCount && document.processedUnits !== undefined
                    ? Math.min(
                        100,
                        Math.round((document.processedUnits / document.unitCount) * 100),
                      )
                    : 0;
                const status = documentStatusText(document, t);
                return (
                  <div
                    key={document.id}
                    className={`relative min-w-0 overflow-hidden rounded-md border bg-surface px-2 py-1.5 text-xs ${
                      failed ? "border-danger/35" : "border-border"
                    }`}
                    title={`${document.name} · ${formatFileSize(document.sizeBytes)} · ${status}`}
                    {...(failed ? { role: "alert" as const } : {})}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      {active ? (
                        <LoaderCircle
                          size={14}
                          className="shrink-0 animate-spin text-accent motion-reduce:animate-none"
                        />
                      ) : failed ? (
                        <CircleAlert size={14} className="shrink-0 text-danger" />
                      ) : (
                        <CircleCheck size={14} className="shrink-0 text-success" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{document.name}</div>
                        <div
                          className={`truncate text-[10px] ${failed ? "text-danger" : "text-muted"}`}
                        >
                          {formatFileSize(document.sizeBytes)} · {status}
                        </div>
                      </div>
                      {document.kind === "path" && document.status === "failed" && (
                        <button
                          type="button"
                          title={t("composerDocumentRetry")}
                          aria-label={t("composerDocumentRetryNamed", { name: document.name })}
                          className="flex size-6 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-overlay hover:text-foreground"
                          onClick={() => void retryDocument(document)}
                        >
                          <RefreshCw size={12} />
                        </button>
                      )}
                      {document.kind === "pasted-text" &&
                        document.remote &&
                        document.status === "ready" && (
                          <button
                            type="button"
                            title={t("composerPastedTextRestore")}
                            aria-label={t("composerPastedTextRestoreNamed", {
                              name: document.name,
                            })}
                            className="flex size-6 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-overlay hover:text-foreground"
                            onClick={() => void restorePastedText(document)}
                          >
                            <Undo2 size={12} />
                          </button>
                        )}
                      <button
                        type="button"
                        title={t("composerRemoveFile")}
                        aria-label={t("composerRemoveNamedFile", { name: document.name })}
                        className="flex size-6 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-overlay hover:text-danger disabled:cursor-not-allowed disabled:opacity-40"
                        disabled={document.kind === "pasted-text" && !document.remote}
                        onClick={() => void removeDocument(document)}
                      >
                        <X size={12} />
                      </button>
                    </div>
                    {active && document.unitCount !== undefined && (
                      <div
                        className="mt-1 h-0.5 overflow-hidden rounded-full bg-surface-overlay"
                        role="progressbar"
                        aria-label={status}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={progress}
                      >
                        <div className="h-full bg-accent" style={{ width: `${progress}%` }} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
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
                    title={t("composerRemoveFile")}
                    aria-label={t("composerRemoveNamedFile", { name: file.name })}
                    className="text-muted hover:text-danger"
                    onClick={() => setFiles((current) => current.filter((it) => it.id !== file.id))}
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
                    alt={t("transcriptAttachmentAlt")}
                    className="size-16 rounded-md border border-border object-cover"
                  />
                  <button
                    type="button"
                    title={t("composerRemoveImage")}
                    aria-label={t("composerRemoveImage")}
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
          {decisionBlocked ? (
            <div
              id={decisionHintId}
              role="status"
              aria-live="polite"
              className="flex min-h-8 items-center gap-1.5 px-2 pb-1 text-xs text-muted"
            >
              <MessageCircleQuestion
                size={13}
                className="shrink-0 text-accent"
                aria-hidden="true"
              />
              <span>{t("composerDecisionPending")}</span>
            </div>
          ) : null}
          <div className="relative">
            {completion && (
              <div
                data-composer-completion
                className="theme-floating-surface absolute bottom-full left-2 z-30 mb-1 max-h-64 w-[420px] max-w-[90%] overflow-y-auto rounded-md border border-border bg-surface-raised py-1 shadow-lg"
              >
                {completion.items.map((item, index) => (
                  <button
                    key={`${item.label}:${index}`}
                    type="button"
                    title={item.detail ? `${item.label}\n${item.detail}` : item.label}
                    ref={(node) => {
                      if (node && index === completion.selected) {
                        node.scrollIntoView({ block: "nearest" });
                      }
                    }}
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
              className="chat-composer-input min-h-[60px] w-full resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted"
              placeholder={disabled ? t("composerUnavailable") : t("composerPlaceholder")}
              value={text}
              disabled={disabled}
              aria-describedby={decisionBlocked ? decisionHintId : undefined}
              onChange={(event) => {
                if (!draftTarget) return;
                editDraft(draftTarget, event.target.value);
                updateCompletion(
                  event.target.value,
                  event.target.selectionStart ?? event.target.value.length,
                );
              }}
              onBlur={dismissCompletion}
              onPaste={handleComposerPaste}
              onContextMenu={(event) => {
                if (shouldKeepNativeContextMenu(event.nativeEvent)) return;
                event.preventDefault();
                event.stopPropagation();
                const selectionStart = event.currentTarget.selectionStart ?? text.length;
                const selectionEnd = event.currentTarget.selectionEnd ?? selectionStart;
                openContextMenu({
                  x: event.clientX,
                  y: event.clientY,
                  trigger: contextMenuTrigger(event.target),
                  items: buildTextContextMenuItems(event.currentTarget, t, [
                    {
                      id: "composer.pasteAsAttachment",
                      label: t("menuPasteAsAttachment"),
                      icon: ClipboardPaste,
                      separatorBefore: true,
                      disabled: disabled || !session,
                      onSelect: async () => {
                        const pastedText = await readClipboardText();
                        pasteTextAsAttachment(pastedText, selectionStart, selectionEnd);
                      },
                    },
                  ]),
                });
              }}
              onCompositionStart={ime.onCompositionStart}
              onCompositionEnd={ime.onCompositionEnd}
              onKeyDown={(event) => {
                if (ime.isImeKey(event)) return;
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
                    dismissCompletion();
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
              accept="image/*,.pdf,.docx,text/*,.md,.mdx,.json,.jsonl,.yaml,.yml,.toml,.csv,.tsv,.xml,.html,.css,.js,.jsx,.ts,.tsx,.py,.rs,.go,.java,.kt,.swift,.c,.h,.cpp,.hpp,.sh,.sql,.log"
              className="hidden"
              onChange={(event) => {
                if (event.target.files) void addFiles(event.target.files);
                event.target.value = "";
              }}
            />
            <button
              type="button"
              title={t("composerAttach")}
              aria-label={t("composerAttach")}
              className="flex size-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground disabled:opacity-40"
              disabled={
                disabled ||
                (images.length >= MAX_AGENT_REQUEST_IMAGES &&
                  files.length >= MAX_FILES &&
                  documents.length >= MAX_AGENT_REQUEST_ATTACHMENTS)
              }
              onClick={() => void chooseAttachments()}
            >
              <Plus size={16} />
            </button>
            <ModelControls />
            <div className="ml-auto flex items-center gap-1.5">
              <ExtensionWidgetsButton
                open={extensionWidgetsOpen}
                onToggle={toggleExtensionWidgets}
              />
              <ContextUsageRing />
              {busy ? (
                canSend ? (
                  <button
                    type="button"
                    title={t("composerQueueMessageShortcut")}
                    aria-label={t("composerQueueMessage")}
                    className="theme-send-control flex size-8 items-center justify-center rounded-md bg-foreground text-surface transition-colors hover:opacity-85"
                    onClick={() => void send()}
                  >
                    <Send size={15} />
                  </button>
                ) : (
                  <button
                    type="button"
                    title={session?.isCompacting ? t("composerStopCompaction") : t("composerStop")}
                    aria-label={
                      session?.isCompacting ? t("composerStopCompaction") : t("composerStop")
                    }
                    className="flex size-8 items-center justify-center rounded-md bg-danger/15 text-danger hover:bg-danger/20"
                    onClick={() => void (session?.isCompacting ? abortCompaction() : abort())}
                  >
                    <Square size={14} fill="currentColor" />
                  </button>
                )
              ) : (
                <button
                  type="button"
                  title={t("composerSend")}
                  aria-label={t("composerSend")}
                  className="theme-send-control flex size-8 items-center justify-center rounded-md bg-foreground text-surface transition-colors hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-30"
                  disabled={!canSend}
                  onClick={() => void send()}
                >
                  <Send size={15} />
                </button>
              )}
            </div>
          </div>
        </div>
        <ExtensionWidgetsPopover
          anchorRef={extensionWidgetAnchorRef}
          open={extensionWidgetsOpen}
          onClose={closeExtensionWidgets}
        />
        <SessionStatsModal open={statsOpen} onClose={() => setStatsOpen(false)} />
        <ForkModal open={forkOpen} onClose={() => setForkOpen(false)} />
      </div>
    </div>
  );
}
