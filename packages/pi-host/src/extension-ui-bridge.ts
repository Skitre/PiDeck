/**
 * Extension UI bridge — R5/C6 public SDK bind only.
 * Uses AgentSession.bindExtensions({ uiContext, mode: "rpc" }).
 * Positional signatures match ExtensionUIContext in 0.80.7.
 * No whole-object `as unknown as ExtensionUIContext` cast (B-EXT-01).
 */
import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import type { AgentSession, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { Theme as ThemeClass } from "@earendil-works/pi-coding-agent";
import {
  createHostError,
  type HostEventName,
  type HostIdentity,
} from "@pideck/protocol";
import type { MethodHandler as ServerMethodHandler } from "./server.js";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";
import { logger } from "./logger.js";

type PendingUi = {
  requestId: string;
  kind: string;
  hostInstanceId: string;
  workspaceId: string | null;
  workspaceRevision: number;
  sessionId: string | null;
  sessionRevision: number;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const pending = new Map<string, PendingUi>();

export type ExtensionUiBridgeOptions = {
  emit: (event: HostEventName, payload: unknown) => void;
  emitForIdentity?: (
    identity: HostIdentity,
    event: HostEventName,
    payload: unknown,
  ) => void;
  getIdentity: () => HostIdentity;
  waitUntilActive?: () => Promise<void>;
  isDisposed?: () => boolean;
};

export type ExtensionUiBinding = {
  activate: () => Promise<() => void>;
  cleanup: () => void;
  updateIdentity: (identity: HostIdentity) => void;
};

function stripAnsi(text: string): string {
  return stripVTControlCharacters(text);
}

function sanitize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return stripAnsi(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => sanitize(item, seen));
  if (typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[stripAnsi(key)] = sanitize(item, seen);
    }
    seen.delete(value);
    return out;
  }
  if (value === undefined) return undefined;
  return stripAnsi(String(value));
}

/** Minimal Theme instance for desktop UI adapter (hex colors per SDK Theme constructor). */
function createDesktopStubTheme(): Theme {
  const w = "#e0e0e0";
  const g = "#808080";
  const c = "#00bcd4";
  const gr = "#4caf50";
  const r = "#f44336";
  const y = "#ffeb3b";
  const m = "#e040fb";
  const b = "#2196f3";
  const fg = {
    accent: c,
    border: g,
    borderAccent: c,
    borderMuted: g,
    success: gr,
    error: r,
    warning: y,
    muted: g,
    dim: g,
    text: w,
    thinkingText: g,
    userMessageText: w,
    customMessageText: w,
    customMessageLabel: c,
    toolTitle: w,
    toolOutput: w,
    mdHeading: w,
    mdLink: c,
    mdLinkUrl: c,
    mdCode: w,
    mdCodeBlock: w,
    mdCodeBlockBorder: g,
    mdQuote: g,
    mdQuoteBorder: g,
    mdHr: g,
    mdListBullet: w,
    toolDiffAdded: gr,
    toolDiffRemoved: r,
    toolDiffContext: w,
    syntaxComment: g,
    syntaxKeyword: m,
    syntaxFunction: b,
    syntaxVariable: w,
    syntaxString: gr,
    syntaxNumber: y,
    syntaxType: c,
    syntaxOperator: w,
    syntaxPunctuation: w,
    thinkingOff: g,
    thinkingMinimal: g,
    thinkingLow: g,
    thinkingMedium: y,
    thinkingHigh: y,
    thinkingXhigh: r,
    thinkingMax: r,
    bashMode: gr,
  } as const;
  const bg = {
    selectedBg: "#1565c0",
    userMessageBg: "#000000",
    customMessageBg: "#000000",
    toolPendingBg: "#000000",
    toolSuccessBg: "#000000",
    toolErrorBg: "#000000",
  } as const;
  return new ThemeClass(fg, bg, "256color", { name: "pideck-stub" });
}

/**
 * Build ExtensionUIContext with positional SDK 0.80.7 signatures.
 * Returns a value that structurally satisfies ExtensionUIContext (no whole cast).
 */
export function createExtensionUiContext(
  opts: ExtensionUiBridgeOptions,
): ExtensionUIContext {
  const identityAt = () => opts.getIdentity();
  const desktopTheme = createDesktopStubTheme();

  const requestBlocking = async (
    kind: "select" | "confirm" | "input" | "editor",
    payload: Record<string, unknown>,
    timeoutMs = 120_000,
  ): Promise<unknown> => {
    if (opts.waitUntilActive) {
      await opts.waitUntilActive();
    }
    if (opts.isDisposed?.()) return undefined;
    const requestId = randomUUID();
    const id = identityAt();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        resolve(undefined);
        opts.emit("extensionUi.notification", {
          message: "Extension UI request timed out",
          level: "warning",
        });
      }, timeoutMs);

      pending.set(requestId, {
        requestId,
        kind,
        hostInstanceId: id.hostInstanceId,
        workspaceId: id.workspaceId,
        workspaceRevision: id.workspaceRevision,
        sessionId: id.sessionId,
        sessionRevision: id.sessionRevision,
        resolve,
        reject,
        timer,
      });

      const options = Array.isArray(payload.options)
        ? payload.options.map((option) => {
            const item = option as { id?: unknown; label?: unknown };
            return {
              id: stripAnsi(String(item.id ?? "")),
              label: stripAnsi(String(item.label ?? "")),
            };
          })
        : undefined;
      opts.emit("extensionUi.request", {
        requestId,
        kind,
        title: payload.title === undefined ? undefined : stripAnsi(String(payload.title)),
        message: payload.message === undefined ? undefined : stripAnsi(String(payload.message)),
        options,
        defaultValue:
          payload.defaultValue === undefined
            ? undefined
            : stripAnsi(String(payload.defaultValue)),
        timeoutMs,
      });
    });
  };

  const ui: ExtensionUIContext = {
    select: async (title, options, dialogOpts) => {
      const labels = options.map((o: string) => ({ id: o, label: o }));
      const value = await requestBlocking(
        "select",
        { title, options: labels },
        dialogOpts?.timeout ? Number(dialogOpts.timeout) : 120_000,
      );
      return typeof value === "string" ? value : undefined;
    },
    confirm: async (title, message, dialogOpts) => {
      const value = await requestBlocking(
        "confirm",
        { title, message },
        dialogOpts?.timeout ? Number(dialogOpts.timeout) : 120_000,
      );
      return value === true;
    },
    input: async (title, placeholder, dialogOpts) => {
      const value = await requestBlocking(
        "input",
        { title, message: placeholder, defaultValue: "" },
        dialogOpts?.timeout ? Number(dialogOpts.timeout) : 120_000,
      );
      return typeof value === "string" ? value : undefined;
    },
    notify: (message, type) => {
      opts.emit("extensionUi.notification", {
        message: stripAnsi(String(message ?? "")),
        level: type ?? "info",
      });
    },
    onTerminalInput: () => () => {},
    setStatus: (key, text) => {
      opts.emit("extensionUi.statusChanged", {
        key: stripAnsi(String(key)),
        text: text === undefined ? "" : stripAnsi(String(text)),
      });
    },
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: (key, content, _options?) => {
      const sanitizedKey = stripAnsi(String(key));
      if (typeof content === "function") {
        opts.emit("package.diagnostic", {
          severity: "info",
          message: `Extension setWidget factory unsupported in desktop for key=${sanitizedKey}`,
        });
        return;
      }
      opts.emit("extensionUi.widgetChanged", {
        key: sanitizedKey,
        widget: content === undefined ? null : sanitize(content),
      });
    },
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    custom: async () => {
      // P0: TUI-only API — reject with explicit unsupported error (not silent cast).
      throw new Error(
        "ExtensionUIContext.custom is TUI-only and unsupported in PiDeck",
      );
    },
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => "",
    editor: async (title, prefill) => {
      const value = await requestBlocking("editor", {
        title,
        defaultValue: prefill ?? "",
      });
      return typeof value === "string" ? value : undefined;
    },
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    get theme() {
      return desktopTheme;
    },
    getAllThemes: () => [{ name: "pideck-stub", path: undefined }],
    getTheme: (name) => (name === "pideck-stub" ? desktopTheme : undefined),
    setTheme: () => ({
      success: false,
      error: "Theme switching is unsupported in PiDeck",
    }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  };

  return ui;
}

/**
 * Bind via public API only. Activation is deferred until the candidate session
 * identity is committed, so blocking session_start UI can be answered.
 */
export async function bindExtensionUi(
  session: AgentSession,
  _extensionsResult: unknown,
  opts: ExtensionUiBridgeOptions,
): Promise<ExtensionUiBinding> {
  let bindingIdentity = { ...opts.getIdentity() };
  let activated = false;
  let readyForEvents = false;
  let disposed = false;
  const queuedEvents: Array<{ event: HostEventName; payload: unknown }> = [];
  let releaseActivation!: () => void;
  const activation = new Promise<void>((resolve) => {
    releaseActivation = resolve;
  });
  const publishEvent = (event: HostEventName, payload: unknown) => {
    if (opts.emitForIdentity) {
      opts.emitForIdentity(bindingIdentity, event, payload);
      return;
    }
    opts.emit(event, payload);
  };
  const emit = (event: HostEventName, payload: unknown) => {
    if (disposed) return;
    if (!activated || (!readyForEvents && event !== "extensionUi.request")) {
      queuedEvents.push({ event, payload });
      return;
    }
    publishEvent(event, payload);
  };
  const uiContext = createExtensionUiContext({
    emit,
    getIdentity: () => bindingIdentity,
    waitUntilActive: () => activation,
    isDisposed: () => disposed,
  });
  const ready = session
    .bindExtensions({
      uiContext,
      mode: "rpc",
    })
    .then(() => {
      logger.info("Extension UI bound via bindExtensions({ uiContext, mode: rpc })");
    });

  return {
    activate: async () => {
      if (!activated && !disposed) {
        activated = true;
        releaseActivation();
        const blocking = queuedEvents.filter((queued) => queued.event === "extensionUi.request");
        for (const queued of blocking) {
          publishEvent(queued.event, queued.payload);
        }
        for (let i = queuedEvents.length - 1; i >= 0; i -= 1) {
          if (queuedEvents[i]?.event === "extensionUi.request") queuedEvents.splice(i, 1);
        }
      }
      await ready;
      let published = false;
      return () => {
        if (!disposed && !published) {
          published = true;
          readyForEvents = true;
          for (const queued of queuedEvents.splice(0)) {
            publishEvent(queued.event, queued.payload);
          }
        }
      };
    },
    cleanup: () => {
      disposed = true;
      queuedEvents.length = 0;
      releaseActivation();
      cancelPendingForIdentity(bindingIdentity);
    },
    updateIdentity: (identity) => {
      const next = { ...identity };
      migratePendingIdentity(bindingIdentity, next);
      bindingIdentity = next;
    },
  };
}

function migratePendingIdentity(from: HostIdentity, to: HostIdentity): void {
  for (const pendingRequest of pending.values()) {
    if (
      pendingRequest.hostInstanceId !== from.hostInstanceId ||
      pendingRequest.workspaceId !== from.workspaceId ||
      pendingRequest.workspaceRevision !== from.workspaceRevision ||
      pendingRequest.sessionId !== from.sessionId ||
      pendingRequest.sessionRevision !== from.sessionRevision
    ) {
      continue;
    }
    pendingRequest.hostInstanceId = to.hostInstanceId;
    pendingRequest.workspaceId = to.workspaceId;
    pendingRequest.workspaceRevision = to.workspaceRevision;
    pendingRequest.sessionId = to.sessionId;
    pendingRequest.sessionRevision = to.sessionRevision;
  }
}

export function respondExtensionUi(
  requestId: string,
  status: "resolved" | "cancelled",
  value?: unknown,
  expectedIdentity?: HostIdentity,
): boolean {
  const p = pending.get(requestId);
  if (!p) return false;
  if (expectedIdentity) {
    if (
      p.hostInstanceId !== expectedIdentity.hostInstanceId ||
      p.workspaceId !== expectedIdentity.workspaceId ||
      p.workspaceRevision !== expectedIdentity.workspaceRevision ||
      p.sessionId !== expectedIdentity.sessionId ||
      p.sessionRevision !== expectedIdentity.sessionRevision
    ) {
      clearTimeout(p.timer);
      pending.delete(requestId);
      p.resolve(undefined);
      return false;
    }
  }
  clearTimeout(p.timer);
  pending.delete(requestId);
  if (status === "cancelled") {
    p.resolve(undefined);
  } else {
    p.resolve(value);
  }
  return true;
}

export function cancelPendingForIdentity(identity: HostIdentity): void {
  for (const [requestId, p] of pending) {
    if (
      p.hostInstanceId !== identity.hostInstanceId ||
      p.workspaceId !== identity.workspaceId ||
      p.workspaceRevision !== identity.workspaceRevision ||
      p.sessionId !== identity.sessionId ||
      p.sessionRevision !== identity.sessionRevision
    ) {
      continue;
    }
    clearTimeout(p.timer);
    p.resolve(undefined);
    pending.delete(requestId);
  }
}

export function cancelAllPending(_reason: string): void {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.resolve(undefined);
  }
  pending.clear();
}

export function createExtensionUiHandlers(
  factory: WorkspaceGraphFactory,
): Partial<Record<string, ServerMethodHandler>> {
  return {
    "extensionUi.respond": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, {
        requireWorkspace: true,
      });
      if (stale) return { error: stale };

      const params = ctx.params as {
        requestId: string;
        status: "resolved" | "cancelled";
        value?: unknown;
      };
      const ok = respondExtensionUi(
        params.requestId,
        params.status,
        params.value,
      );
      if (!ok) {
        return {
          error: createHostError(
            "STALE_REVISION",
            "Unknown, expired, or stale Extension UI requestId",
          ),
        };
      }
      return { result: { accepted: true } };
    },
  };
}
