/**
 * Extension UI bridge — R5/C6 public SDK bind only.
 * Uses AgentSession.bindExtensions({ uiContext, mode: "rpc" }).
 * Positional signatures match ExtensionUIContext in 0.80.7.
 * No whole-object `as unknown as ExtensionUIContext` cast (B-EXT-01).
 */
import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import type {
  AgentSession,
  ExtensionUIContext,
  KeybindingsManager as SdkKeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Theme as ThemeClass } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type KeybindingDefinitions,
  KeybindingsManager,
  type OverlayHandle,
  type OverlayOptions,
  TUI,
  TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import {
  createHostError,
  type HostEventName,
  type HostIdentity,
} from "@pideck/protocol";
import type { MethodHandler as ServerMethodHandler } from "./server.js";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";
import { VirtualTerminal } from "./virtual-terminal.js";
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
  timer: ReturnType<typeof setTimeout> | undefined;
};

const pending = new Map<string, PendingUi>();

/** Live ui.custom() panels — routes extensionUi.customInput/customResize to the virtual terminal. */
const activeCustoms = new Map<string, VirtualTerminal>();

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
  registerCleanup?: (cleanup: () => void) => void;
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
 * App-level keybinding definitions mirrored from the SDK's core/keybindings
 * (not exported through the package root). Extensions' custom panels check
 * these via keybindings.matches(); unknown ids simply never match.
 * Suspend is intentionally unbound (no job control in a GUI) and paste maps
 * to the conventional desktop shortcut.
 */
const APP_PANEL_KEYBINDINGS: KeybindingDefinitions = {
  "app.interrupt": { defaultKeys: "escape", description: "Cancel or abort" },
  "app.clear": { defaultKeys: "ctrl+c", description: "Clear editor" },
  "app.exit": { defaultKeys: "ctrl+d", description: "Exit when editor is empty" },
  "app.suspend": { defaultKeys: [], description: "Suspend to background" },
  "app.thinking.cycle": { defaultKeys: "shift+tab", description: "Cycle thinking level" },
  "app.model.cycleForward": { defaultKeys: "ctrl+p", description: "Cycle to next model" },
  "app.model.cycleBackward": { defaultKeys: "shift+ctrl+p", description: "Cycle to previous model" },
  "app.model.select": { defaultKeys: "ctrl+l", description: "Open model selector" },
  "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" },
  "app.thinking.toggle": { defaultKeys: "ctrl+t", description: "Toggle thinking blocks" },
  "app.session.toggleNamedFilter": { defaultKeys: "ctrl+n", description: "Toggle named session filter" },
  "app.editor.external": { defaultKeys: "ctrl+g", description: "Open external editor" },
  "app.message.copy": { defaultKeys: "ctrl+x", description: "Copy message to clipboard" },
  "app.message.followUp": { defaultKeys: "alt+enter", description: "Queue follow-up message" },
  "app.message.dequeue": { defaultKeys: "alt+up", description: "Restore queued messages" },
  "app.clipboard.pasteImage": { defaultKeys: "ctrl+v", description: "Paste image from clipboard" },
  "app.session.new": { defaultKeys: [], description: "Start a new session" },
  "app.session.tree": { defaultKeys: [], description: "Open session tree" },
  "app.session.fork": { defaultKeys: [], description: "Fork current session" },
  "app.session.resume": { defaultKeys: [], description: "Resume a session" },
  "app.tree.foldOrUp": { defaultKeys: ["alt+left", "ctrl+left"], description: "Fold tree branch or move up" },
  "app.tree.unfoldOrDown": { defaultKeys: ["alt+right", "ctrl+right"], description: "Unfold tree branch or move down" },
  "app.tree.editLabel": { defaultKeys: "shift+l", description: "Edit tree label" },
  "app.tree.toggleLabelTimestamp": { defaultKeys: "shift+t", description: "Toggle tree label timestamps" },
  "app.session.togglePath": { defaultKeys: "ctrl+p", description: "Toggle session path display" },
  "app.session.toggleSort": { defaultKeys: "ctrl+s", description: "Toggle session sort mode" },
  "app.session.rename": { defaultKeys: "ctrl+r", description: "Rename session" },
  "app.session.delete": { defaultKeys: "ctrl+d", description: "Delete session" },
  "app.session.deleteNoninvasive": { defaultKeys: "ctrl+backspace", description: "Delete session when query is empty" },
  "app.models.save": { defaultKeys: "ctrl+s", description: "Save model selection" },
  "app.models.enableAll": { defaultKeys: "ctrl+a", description: "Enable all models" },
  "app.models.clearAll": { defaultKeys: "ctrl+x", description: "Clear all models" },
  "app.models.toggleProvider": { defaultKeys: "ctrl+p", description: "Toggle all models for provider" },
  "app.models.reorderUp": { defaultKeys: "alt+up", description: "Move model up in order" },
  "app.models.reorderDown": { defaultKeys: "alt+down", description: "Move model down in order" },
  "app.tree.filter.default": { defaultKeys: "ctrl+d", description: "Tree filter: default view" },
  "app.tree.filter.noTools": { defaultKeys: "ctrl+t", description: "Tree filter: hide tool results" },
  "app.tree.filter.userOnly": { defaultKeys: "ctrl+u", description: "Tree filter: user messages only" },
  "app.tree.filter.labeledOnly": { defaultKeys: "ctrl+l", description: "Tree filter: labeled entries only" },
  "app.tree.filter.all": { defaultKeys: "ctrl+a", description: "Tree filter: show all entries" },
  "app.tree.filter.cycleForward": { defaultKeys: "ctrl+o", description: "Tree filter: cycle forward" },
  "app.tree.filter.cycleBackward": { defaultKeys: "shift+ctrl+o", description: "Tree filter: cycle backward" },
};

const panelKeybindings = new KeybindingsManager({
  ...TUI_KEYBINDINGS,
  ...APP_PANEL_KEYBINDINGS,
}) as SdkKeybindingsManager;

/** Coalesce TUI writes into extensionUi.customFrame events (per differential render burst). */
const CUSTOM_FRAME_FLUSH_MS = 16;
const WIDGET_SNAPSHOT_WIDTH = 80;

type ActiveWidgetFactory = {
  dispose: () => void;
};

/**
 * Build ExtensionUIContext with positional SDK 0.80.7 signatures.
 * Returns a value that structurally satisfies ExtensionUIContext (no whole cast).
 */
export function createExtensionUiContext(
  opts: ExtensionUiBridgeOptions,
): ExtensionUIContext {
  const identityAt = () => opts.getIdentity();
  const desktopTheme = createDesktopStubTheme();
  const activeWidgetFactories = new Map<string, ActiveWidgetFactory>();

  const disposeWidgetFactory = (key: string) => {
    const active = activeWidgetFactories.get(key);
    if (!active) return;
    activeWidgetFactories.delete(key);
    active.dispose();
  };
  const disposeAllWidgetFactories = () => {
    for (const key of [...activeWidgetFactories.keys()]) {
      disposeWidgetFactory(key);
    }
  };
  opts.registerCleanup?.(disposeAllWidgetFactories);

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
    setWidget: (key, content, options?) => {
      const sanitizedKey = stripAnsi(String(key));
      const placement = options?.placement === "belowEditor" ? "belowEditor" : undefined;
      disposeWidgetFactory(sanitizedKey);
      if (typeof content === "function") {
        // A same-key factory replaces the previous widget immediately. Clear
        // the desktop snapshot before construction so a failed factory cannot
        // leave stale content visible indefinitely.
        opts.emit("extensionUi.widgetChanged", {
          key: sanitizedKey,
          widget: null,
          ...(placement ? { placement } : {}),
        });
        const widgetTui = new TUI(
          new VirtualTerminal({
            cols: WIDGET_SNAPSHOT_WIDTH,
            onData: () => {},
          }),
        );
        let widgetComponent: (Component & { dispose?(): void }) | undefined;
        let disposed = false;
        let lastSnapshot: string | undefined;
        let lastRenderError: string | undefined;
        const dispose = () => {
          if (disposed) return;
          disposed = true;
          try {
            widgetTui.stop();
          } catch {
            /* ignore stop errors */
          }
          try {
            widgetComponent?.dispose?.();
          } catch {
            /* ignore dispose errors */
          }
        };
        try {
          widgetComponent = content(widgetTui, desktopTheme);
          const renderBridge: Component = {
            render: (width) => {
              if (disposed || !widgetComponent) return [];
              try {
                const lines = widgetComponent.render(width);
                const sanitizedLines = lines.map((line) => stripAnsi(line));
                const snapshot = JSON.stringify(sanitizedLines);
                if (snapshot !== lastSnapshot) {
                  lastSnapshot = snapshot;
                  opts.emit("extensionUi.widgetChanged", {
                    key: sanitizedKey,
                    widget: sanitizedLines,
                    ...(placement ? { placement } : {}),
                  });
                }
                lastRenderError = undefined;
                return lines;
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                const sanitizedMessage = stripAnsi(message);
                if (lastSnapshot !== undefined) {
                  lastSnapshot = undefined;
                  opts.emit("extensionUi.widgetChanged", {
                    key: sanitizedKey,
                    widget: null,
                    ...(placement ? { placement } : {}),
                  });
                }
                if (sanitizedMessage !== lastRenderError) {
                  lastRenderError = sanitizedMessage;
                  opts.emit("package.diagnostic", {
                    severity: "info",
                    message: `Extension setWidget factory render failed for key=${sanitizedKey}: ${sanitizedMessage}`,
                  });
                }
                return [];
              }
            },
            invalidate: () => widgetComponent?.invalidate(),
          };
          const activeFactory = { dispose };
          activeWidgetFactories.set(sanitizedKey, activeFactory);
          widgetTui.addChild(renderBridge);
          widgetTui.start();
        } catch (err) {
          if (activeWidgetFactories.get(sanitizedKey)?.dispose === dispose) {
            activeWidgetFactories.delete(sanitizedKey);
          }
          dispose();
          const message = err instanceof Error ? err.message : String(err);
          opts.emit("package.diagnostic", {
            severity: "info",
            message: `Extension setWidget factory failed for key=${sanitizedKey}: ${stripAnsi(message)}`,
          });
        }
        return;
      }
      opts.emit("extensionUi.widgetChanged", {
        key: sanitizedKey,
        widget: content === undefined ? null : sanitize(content),
        ...(placement ? { placement } : {}),
      });
    },
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    custom: async <T,>(
      factory: (
        tui: TUI,
        theme: Theme,
        keybindings: SdkKeybindingsManager,
        done: (result: T) => void,
      ) =>
        | (Component & { dispose?(): void })
        | Promise<Component & { dispose?(): void }>,
      options?: {
        overlay?: boolean;
        overlayOptions?: OverlayOptions | (() => OverlayOptions);
        onHandle?: (handle: OverlayHandle) => void;
      },
    ): Promise<T> => {
      if (opts.waitUntilActive) {
        await opts.waitUntilActive();
      }
      if (opts.isDisposed?.()) return undefined as T;
      const requestId = randomUUID();
      const id = identityAt();
      return await new Promise<T>((resolveOuter, rejectOuter) => {
        let frameBuffer = "";
        let flushTimer: ReturnType<typeof setTimeout> | undefined;
        const flushFrames = () => {
          flushTimer = undefined;
          if (!frameBuffer) return;
          const data = frameBuffer;
          frameBuffer = "";
          opts.emit("extensionUi.customFrame", { requestId, data });
        };
        const vt = new VirtualTerminal({
          onData: (data) => {
            frameBuffer += data;
            if (!flushTimer) flushTimer = setTimeout(flushFrames, CUSTOM_FRAME_FLUSH_MS);
          },
        });
        const tui = new TUI(vt);
        let component: (Component & { dispose?(): void }) | undefined;
        let closed = false;
        const teardown = () => {
          closed = true;
          pending.delete(requestId);
          activeCustoms.delete(requestId);
          try {
            tui.stop();
          } catch {
            /* ignore stop errors */
          }
          try {
            component?.dispose?.();
          } catch {
            /* ignore dispose errors */
          }
          flushFrames();
          if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = undefined;
          }
          opts.emit("extensionUi.customClosed", { requestId });
        };
        const finish = (result: unknown) => {
          if (closed) return;
          teardown();
          resolveOuter(result as T);
        };
        const failure = (err: unknown) => {
          if (closed) return;
          teardown();
          rejectOuter(err instanceof Error ? err : new Error(String(err)));
        };

        pending.set(requestId, {
          requestId,
          kind: "custom",
          hostInstanceId: id.hostInstanceId,
          workspaceId: id.workspaceId,
          workspaceRevision: id.workspaceRevision,
          sessionId: id.sessionId,
          sessionRevision: id.sessionRevision,
          resolve: (value) => finish(value),
          reject: (err) => failure(err),
          timer: undefined,
        });
        activeCustoms.set(requestId, vt);

        opts.emit("extensionUi.customStarted", {
          requestId,
          cols: vt.columns,
          rows: vt.rows,
        });
        tui.start();

        const done = (result: T) => finish(result);
        const failFactory = (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn(`Extension custom panel factory failed: ${message}`);
          opts.emit("extensionUi.notification", {
            message: `Extension panel failed: ${stripAnsi(message)}`,
            level: "error",
          });
          failure(err);
        };
        // Call the factory synchronously (CLI-faithful) but capture a sync
        // throw ourselves — inside this Promise executor it would otherwise
        // reject the outer promise and skip teardown entirely.
        let factoryResult:
          | (Component & { dispose?(): void })
          | Promise<Component & { dispose?(): void }>;
        try {
          factoryResult = factory(tui, desktopTheme, panelKeybindings, done);
        } catch (err) {
          failFactory(err);
          return;
        }
        Promise.resolve(factoryResult)
          .then((c) => {
            if (closed) return;
            component = c;
            if (options?.overlay) {
              const resolveOptions = (): OverlayOptions | undefined => {
                if (options.overlayOptions) {
                  return typeof options.overlayOptions === "function"
                    ? options.overlayOptions()
                    : options.overlayOptions;
                }
                const w = (c as { width?: OverlayOptions["width"] }).width;
                return w ? { width: w } : undefined;
              };
              const handle = tui.showOverlay(c, resolveOptions());
              options.onHandle?.(handle);
            } else {
              tui.addChild(c);
              tui.setFocus(c);
            }
            tui.requestRender();
          })
          .catch((err) => {
            if (closed) return;
            failFactory(err);
          });
      });
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
 * Events that carry a blocking extension interaction. These bypass the
 * readyForEvents gate: an extension can block inside session_start on a
 * dialog or custom panel, and bindExtensions() will not settle until it is
 * answered — holding these back would deadlock activation.
 */
const BLOCKING_EXTENSION_EVENTS: ReadonlySet<HostEventName> = new Set([
  "extensionUi.request",
  "extensionUi.customStarted",
  "extensionUi.customFrame",
  "extensionUi.customClosed",
]);

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
  const contextCleanups = new Set<() => void>();
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
  const queueEvent = (event: HostEventName, payload: unknown) => {
    if (event === "extensionUi.widgetChanged") {
      const key = (payload as { key?: unknown }).key;
      for (let i = queuedEvents.length - 1; i >= 0; i -= 1) {
        const queued = queuedEvents[i];
        if (
          queued?.event === event &&
          (queued.payload as { key?: unknown }).key === key
        ) {
          queuedEvents.splice(i, 1);
          break;
        }
      }
    }
    queuedEvents.push({ event, payload });
  };
  const emit = (event: HostEventName, payload: unknown) => {
    if (disposed) return;
    if (!activated || (!readyForEvents && !BLOCKING_EXTENSION_EVENTS.has(event))) {
      queueEvent(event, payload);
      return;
    }
    publishEvent(event, payload);
  };
  const uiContext = createExtensionUiContext({
    emit,
    getIdentity: () => bindingIdentity,
    waitUntilActive: () => activation,
    isDisposed: () => disposed,
    registerCleanup: (cleanup) => contextCleanups.add(cleanup),
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
        const blocking = queuedEvents.filter((queued) =>
          BLOCKING_EXTENSION_EVENTS.has(queued.event),
        );
        for (const queued of blocking) {
          publishEvent(queued.event, queued.payload);
        }
        for (let i = queuedEvents.length - 1; i >= 0; i -= 1) {
          const queued = queuedEvents[i];
          if (queued && BLOCKING_EXTENSION_EVENTS.has(queued.event)) {
            queuedEvents.splice(i, 1);
          }
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
      if (disposed) return;
      disposed = true;
      queuedEvents.length = 0;
      releaseActivation();
      cancelPendingForIdentity(bindingIdentity);
      for (const cleanup of contextCleanups) {
        try {
          cleanup();
        } catch {
          /* ignore Extension UI cleanup errors */
        }
      }
      contextCleanups.clear();
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

/** Route frontend keyboard/paste data into a live custom panel. False if unknown/closed. */
export function injectExtensionCustomInput(requestId: string, data: string): boolean {
  const vt = activeCustoms.get(requestId);
  if (!vt) return false;
  vt.input(data);
  return true;
}

/** Resize a live custom panel's virtual terminal. False if unknown/closed. */
export function resizeExtensionCustom(
  requestId: string,
  cols: number,
  rows: number,
): boolean {
  const vt = activeCustoms.get(requestId);
  if (!vt) return false;
  vt.resize(cols, rows);
  return true;
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
    "extensionUi.customInput": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, {
        requireWorkspace: true,
      });
      if (stale) return { error: stale };

      const params = ctx.params as { requestId: string; data: string };
      if (!injectExtensionCustomInput(params.requestId, params.data)) {
        return {
          error: createHostError(
            "STALE_REVISION",
            "Unknown or closed extension panel requestId",
          ),
        };
      }
      return { result: { accepted: true } };
    },
    "extensionUi.customResize": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, {
        requireWorkspace: true,
      });
      if (stale) return { error: stale };

      const params = ctx.params as { requestId: string; cols: number; rows: number };
      if (!resizeExtensionCustom(params.requestId, params.cols, params.rows)) {
        return {
          error: createHostError(
            "STALE_REVISION",
            "Unknown or closed extension panel requestId",
          ),
        };
      }
      return { result: { accepted: true } };
    },
  };
}
