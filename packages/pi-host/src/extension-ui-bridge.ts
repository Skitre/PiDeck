/**
 * Extension UI bridge — R5/C6 public SDK bind only.
 * Uses AgentSession.bindExtensions({ uiContext, mode: "rpc" }).
 * Positional signatures match the SDK ExtensionUIContext; the absence of a
 * whole-object cast means typecheck is what proves it, not a pinned version.
 * No whole-object `as unknown as ExtensionUIContext` cast (B-EXT-01).
 * `opts.pideck` is a Host module augmentation, not an SDK patch.
 */
import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import type {
  AgentSession,
  ExtensionCommandContextActions,
  ExtensionUIContext,
  ExtensionUIDialogOptions,
  KeybindingsManager as SdkKeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type KeybindingDefinitions,
  KeybindingsManager,
  type OverlayHandle,
  type OverlayOptions,
  type TUI,
  TuiMainScreen,
  TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import {
  createHostError,
  MAX_EXTENSION_UI_CORRELATION_ID_LENGTH,
  MAX_EXTENSION_UI_DEFAULT_VALUE_LENGTH,
  MAX_EXTENSION_UI_MESSAGE_LENGTH,
  MAX_EXTENSION_UI_OPTION_DESCRIPTION_LENGTH,
  MAX_EXTENSION_UI_OPTION_ID_LENGTH,
  MAX_EXTENSION_UI_OPTION_LABEL_LENGTH,
  MAX_EXTENSION_UI_OPTIONS,
  MAX_EXTENSION_UI_SOURCE_LABEL_LENGTH,
  MAX_EXTENSION_UI_TITLE_LENGTH,
  type ExtensionDecisionPresentation,
  type ExtensionUiClosedReason,
  type ExtensionUiOrigin,
  type HostEventName,
  type HostIdentity,
  type SessionTargetContext,
  type ExtensionMessageRenderSnapshot,
} from "@pideck/protocol";
import type { MethodHandler as ServerMethodHandler } from "./server.js";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";
import { VirtualTerminal } from "./virtual-terminal.js";
import { logger } from "./logger.js";
import {
  claimExtensionCommandWidgetAttention,
  createExtensionInvocationRunner,
  getActiveExtensionInvocation,
  type ExtensionCommandOrigin,
  type ExtensionInvocationContext,
} from "./extension-invocation-context.js";
import {
  classifyHostDecisionRisk,
  resolveDecisionRoute,
  resolveExtensionUiOwnerSessionState,
} from "./extension-ui-policy.js";
import { ExtensionUiGroupRegistry } from "./extension-ui-groups.js";
import { createDesktopExtensionTheme } from "./extension-rendering-theme.js";
import {
  extensionMessageRenderEqual,
  renderExtensionMessageEntries,
} from "./extension-message-renderer.js";

type PendingUi = {
  requestId: string;
  kind: string;
  owner: ExtensionUiOwner;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  cleanup?: () => void;
  emitClosed?: (reason: ExtensionUiClosedReason) => void;
};

export type ExtensionUiOwner = Pick<
  HostIdentity,
  "hostInstanceId" | "workspaceId" | "workspaceRevision" | "sessionId" | "sessionRevision"
>;

type ActiveCustom = {
  terminal: VirtualTerminal;
  owner: ExtensionUiOwner;
};

const pending = new Map<string, PendingUi>();

type PendingSettlement =
  | {
      status: "resolved";
      value: unknown;
      closeReason?: ExtensionUiClosedReason;
    }
  | { status: "rejected"; error: Error };

function settlePending(requestId: string, settlement: PendingSettlement): boolean {
  const entry = pending.get(requestId);
  if (!entry) return false;

  pending.delete(requestId);
  if (entry.timer !== undefined) clearTimeout(entry.timer);
  entry.cleanup?.();

  if (settlement.status === "resolved" && settlement.closeReason && entry.emitClosed) {
    try {
      entry.emitClosed(settlement.closeReason);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`Extension UI close event failed for requestId=${requestId}: ${message}`);
    }
  }

  if (settlement.status === "rejected") entry.reject(settlement.error);
  else entry.resolve(settlement.value);
  return true;
}

/** Live ui.custom() panels — routes extensionUi.customInput/customResize to the virtual terminal. */
const activeCustoms = new Map<string, ActiveCustom>();

function ownerFromIdentity(identity: HostIdentity): ExtensionUiOwner {
  return {
    hostInstanceId: identity.hostInstanceId,
    workspaceId: identity.workspaceId,
    workspaceRevision: identity.workspaceRevision,
    sessionId: identity.sessionId,
    sessionRevision: identity.sessionRevision,
  };
}

function ownerFromTargetContext(context: SessionTargetContext): ExtensionUiOwner {
  return {
    hostInstanceId: context.expectedHostInstanceId,
    workspaceId: context.expectedWorkspaceId,
    workspaceRevision: context.expectedWorkspaceRevision,
    sessionId: context.expectedSessionId,
    sessionRevision: context.expectedSessionRevision,
  };
}

function ownerMatches(left: ExtensionUiOwner, right: ExtensionUiOwner): boolean {
  return (
    left.hostInstanceId === right.hostInstanceId &&
    left.workspaceId === right.workspaceId &&
    left.workspaceRevision === right.workspaceRevision &&
    left.sessionId === right.sessionId &&
    left.sessionRevision === right.sessionRevision
  );
}

function replaceOwner(target: ExtensionUiOwner, identity: HostIdentity): void {
  Object.assign(target, ownerFromIdentity(identity));
}

export type ExtensionUiBridgeOptions = {
  emit: (event: HostEventName, payload: unknown) => void;
  emitForIdentity?: (identity: HostIdentity, event: HostEventName, payload: unknown) => void;
  getIdentity: () => HostIdentity;
  getCurrentIdentity?: () => HostIdentity;
  getExtensionDecisionPresentation?: () => ExtensionDecisionPresentation;
  isInlineSurfaceAvailable?: () => boolean;
  waitUntilActive?: () => Promise<void>;
  isDisposed?: () => boolean;
  registerCleanup?: (cleanup: () => void) => void;
  getActiveInvocation?: () => ExtensionInvocationContext | undefined;
  onRendererActivity?: () => void;
  /**
   * Host session-lifecycle implementations for ctx.newSession()/fork()/
   * navigateTree()/switchSession()/reload(). When absent the SDK defaults
   * silently no-op — callers should always pass these (see
   * extension-command-actions.ts).
   */
  commandContextActions?: ExtensionCommandContextActions;
};

export type ExtensionUiBinding = {
  activate: () => Promise<() => void>;
  cleanup: () => void;
  updateIdentity: (identity: HostIdentity) => void;
  replayState: () => void;
  refreshMessageRenderers: () => void;
};

function stripAnsi(text: string): string {
  return stripVTControlCharacters(text);
}

type PiDeckDialogOptionDetails = {
  description?: string;
  destructive?: boolean;
};

type NormalizedPiDeckDialogMetadata = {
  presentationHint?: "inline" | "modal";
  sourceLabel?: string;
  correlationId?: string;
  riskHint?: "normal" | "high";
  allowFreeform?: boolean;
  optionDetails: Map<string, PiDeckDialogOptionDetails>;
};

function plainRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedSanitizedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const sanitized = stripAnsi(value).slice(0, maxLength);
  return sanitized.trim() ? sanitized : undefined;
}

function boundedSanitizedText(value: unknown, maxLength: number): string {
  return stripAnsi(String(value)).slice(0, maxLength);
}

type PreparedSelectOption = {
  id: string;
  label: string;
  metadataId: string;
};

function prepareSelectOptions(values: string[]): {
  options: PreparedSelectOption[];
  responseValues: Map<string, string>;
} {
  const usedIds = new Set<string>();
  const responseValues = new Map<string, string>();
  const options = values.slice(0, MAX_EXTENSION_UI_OPTIONS).map((value, index) => {
    const sanitizedValue = stripAnsi(String(value));
    const baseId = sanitizedValue.slice(0, MAX_EXTENSION_UI_OPTION_ID_LENGTH);
    let id = baseId;
    let attempt = 0;
    while (usedIds.has(id)) {
      attempt += 1;
      const suffix = `~${index + 1}-${attempt}`;
      id = `${baseId.slice(0, MAX_EXTENSION_UI_OPTION_ID_LENGTH - suffix.length)}${suffix}`;
    }
    usedIds.add(id);
    responseValues.set(id, sanitizedValue);
    return { id, label: sanitizedValue, metadataId: sanitizedValue };
  });
  return { options, responseValues };
}

function piDeckMetadataFromDialogOptions(options: unknown): unknown {
  return plainRecord(options)?.pideck;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;

function normalizeDialogTimeout(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(MAX_TIMER_DELAY_MS, Math.max(1, Math.floor(value)));
}

function normalizePiDeckDialogMetadata(value: unknown): NormalizedPiDeckDialogMetadata {
  const source = plainRecord(value);
  const normalized: NormalizedPiDeckDialogMetadata = { optionDetails: new Map() };
  if (!source) return normalized;

  if (source.presentation === "inline" || source.presentation === "modal") {
    normalized.presentationHint = source.presentation;
  }
  const sourceLabel = boundedSanitizedString(
    source.sourceLabel,
    MAX_EXTENSION_UI_SOURCE_LABEL_LENGTH,
  );
  if (sourceLabel) normalized.sourceLabel = sourceLabel;
  const correlationId = boundedSanitizedString(
    source.correlationId,
    MAX_EXTENSION_UI_CORRELATION_ID_LENGTH,
  );
  if (correlationId) normalized.correlationId = correlationId;
  if (source.risk === "normal" || source.risk === "high") {
    normalized.riskHint = source.risk;
  }
  if (typeof source.allowFreeform === "boolean") {
    normalized.allowFreeform = source.allowFreeform;
  }
  if (Array.isArray(source.optionDetails)) {
    for (const rawItem of source.optionDetails.slice(0, MAX_EXTENSION_UI_OPTIONS)) {
      const item = plainRecord(rawItem);
      if (!item) continue;
      const id = boundedSanitizedString(item.id, MAX_EXTENSION_UI_OPTION_ID_LENGTH);
      if (!id) continue;
      const description = boundedSanitizedString(
        item.description,
        MAX_EXTENSION_UI_OPTION_DESCRIPTION_LENGTH,
      );
      const destructive = typeof item.destructive === "boolean" ? item.destructive : undefined;
      if (description === undefined && destructive === undefined) continue;
      normalized.optionDetails.set(id, {
        ...(description ? { description } : {}),
        ...(destructive !== undefined ? { destructive } : {}),
      });
    }
  }
  return normalized;
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
  "app.model.cycleBackward": {
    defaultKeys: "shift+ctrl+p",
    description: "Cycle to previous model",
  },
  "app.model.select": { defaultKeys: "ctrl+l", description: "Open model selector" },
  "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" },
  "app.thinking.toggle": { defaultKeys: "ctrl+t", description: "Toggle thinking blocks" },
  "app.session.toggleNamedFilter": {
    defaultKeys: "ctrl+n",
    description: "Toggle named session filter",
  },
  "app.editor.external": { defaultKeys: "ctrl+g", description: "Open external editor" },
  "app.message.copy": { defaultKeys: "ctrl+x", description: "Copy message to clipboard" },
  "app.message.followUp": { defaultKeys: "alt+enter", description: "Queue follow-up message" },
  "app.message.dequeue": { defaultKeys: "alt+up", description: "Restore queued messages" },
  "app.clipboard.pasteImage": { defaultKeys: "ctrl+v", description: "Paste image from clipboard" },
  "app.session.new": { defaultKeys: [], description: "Start a new session" },
  "app.session.tree": { defaultKeys: [], description: "Open session tree" },
  "app.session.fork": { defaultKeys: [], description: "Fork current session" },
  "app.session.resume": { defaultKeys: [], description: "Resume a session" },
  "app.tree.foldOrUp": {
    defaultKeys: ["alt+left", "ctrl+left"],
    description: "Fold tree branch or move up",
  },
  "app.tree.unfoldOrDown": {
    defaultKeys: ["alt+right", "ctrl+right"],
    description: "Unfold tree branch or move down",
  },
  "app.tree.editLabel": { defaultKeys: "shift+l", description: "Edit tree label" },
  "app.tree.toggleLabelTimestamp": {
    defaultKeys: "shift+t",
    description: "Toggle tree label timestamps",
  },
  "app.session.togglePath": { defaultKeys: "ctrl+p", description: "Toggle session path display" },
  "app.session.toggleSort": { defaultKeys: "ctrl+s", description: "Toggle session sort mode" },
  "app.session.rename": { defaultKeys: "ctrl+r", description: "Rename session" },
  "app.session.delete": { defaultKeys: "ctrl+d", description: "Delete session" },
  "app.session.deleteNoninvasive": {
    defaultKeys: "ctrl+backspace",
    description: "Delete session when query is empty",
  },
  "app.models.save": { defaultKeys: "ctrl+s", description: "Save model selection" },
  "app.models.enableAll": { defaultKeys: "ctrl+a", description: "Enable all models" },
  "app.models.clearAll": { defaultKeys: "ctrl+x", description: "Clear all models" },
  "app.models.toggleProvider": {
    defaultKeys: "ctrl+p",
    description: "Toggle all models for provider",
  },
  "app.models.reorderUp": { defaultKeys: "alt+up", description: "Move model up in order" },
  "app.models.reorderDown": { defaultKeys: "alt+down", description: "Move model down in order" },
  "app.tree.filter.default": { defaultKeys: "ctrl+d", description: "Tree filter: default view" },
  "app.tree.filter.noTools": {
    defaultKeys: "ctrl+t",
    description: "Tree filter: hide tool results",
  },
  "app.tree.filter.userOnly": {
    defaultKeys: "ctrl+u",
    description: "Tree filter: user messages only",
  },
  "app.tree.filter.labeledOnly": {
    defaultKeys: "ctrl+l",
    description: "Tree filter: labeled entries only",
  },
  "app.tree.filter.all": { defaultKeys: "ctrl+a", description: "Tree filter: show all entries" },
  "app.tree.filter.cycleForward": {
    defaultKeys: "ctrl+o",
    description: "Tree filter: cycle forward",
  },
  "app.tree.filter.cycleBackward": {
    defaultKeys: "shift+ctrl+o",
    description: "Tree filter: cycle backward",
  },
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
 * Build ExtensionUIContext with the SDK positional signatures.
 * Returns a value that structurally satisfies ExtensionUIContext (no whole cast).
 */
export function createExtensionUiContext(opts: ExtensionUiBridgeOptions): ExtensionUIContext {
  const identityAt = () => opts.getIdentity();
  const activeInvocation = () => opts.getActiveInvocation?.();
  const activeCommandOrigin = (): ExtensionCommandOrigin | undefined => {
    const context = activeInvocation();
    return context?.origin.invocationKind === "command"
      ? (context as ExtensionCommandOrigin)
      : undefined;
  };
  const decisionGroups = new ExtensionUiGroupRegistry((payload) =>
    opts.emit("extensionUi.groupClosed", payload),
  );
  opts.registerCleanup?.(() => decisionGroups.closeAll("cancelled"));
  const desktopTheme = createDesktopExtensionTheme();
  const activeWidgetFactories = new Map<string, ActiveWidgetFactory>();
  const publishedWidgetKeys = new Set<string>();

  const publishWidget = (key: string, widget: unknown, placement: "belowEditor" | undefined) => {
    if (widget === null || widget === undefined) publishedWidgetKeys.delete(key);
    else publishedWidgetKeys.add(key);
    opts.emit("extensionUi.widgetChanged", {
      key,
      widget,
      ...(placement ? { placement } : {}),
    });
  };

  const requestWidgetAttention = (key: string, origin: ExtensionCommandOrigin | undefined) => {
    if (!origin) return;
    const invocation = stripAnsi(origin.invocation);
    if (!key || !invocation || !claimExtensionCommandWidgetAttention(origin)) return;
    opts.emit("extensionUi.widgetAttentionRequested", {
      key,
      runId: origin.runId,
      invocation,
    });
  };

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
    dialogOpts?: { timeout?: number; signal?: AbortSignal },
  ): Promise<unknown> => {
    if (opts.waitUntilActive) {
      await opts.waitUntilActive();
    }
    if (opts.isDisposed?.()) return undefined;
    const invocation = activeInvocation();
    const signals = [
      ...new Set(
        [dialogOpts?.signal, invocation?.signal].filter(
          (signal): signal is AbortSignal => signal !== undefined,
        ),
      ),
    ];
    if (signals.some((signal) => signal.aborted)) return undefined;
    const timeoutMs = normalizeDialogTimeout(dialogOpts?.timeout);
    const id = identityAt();
    const origin: ExtensionUiOrigin = invocation?.origin ?? {
      invocationKind: "unknown",
    };
    const { optionDetails, presentationHint, riskHint, ...requestMetadata } =
      normalizePiDeckDialogMetadata(payload.pideck);
    const options = Array.isArray(payload.options)
      ? payload.options.slice(0, MAX_EXTENSION_UI_OPTIONS).map((option) => {
          const item = option as { id?: unknown; label?: unknown; metadataId?: unknown };
          const optionId = boundedSanitizedText(item.id ?? "", MAX_EXTENSION_UI_OPTION_ID_LENGTH);
          const metadataId = boundedSanitizedText(
            item.metadataId ?? item.id ?? "",
            MAX_EXTENSION_UI_OPTION_ID_LENGTH,
          );
          const details = optionDetails.get(metadataId);
          return {
            id: optionId,
            label: boundedSanitizedText(item.label ?? "", MAX_EXTENSION_UI_OPTION_LABEL_LENGTH),
            ...(details?.description ? { description: details.description } : {}),
            ...(details?.destructive !== undefined ? { destructive: details.destructive } : {}),
          };
        })
      : undefined;
    const inlineSurfaceAvailable = opts.isInlineSurfaceAvailable?.() ?? true;
    const ownerSessionState = resolveExtensionUiOwnerSessionState(
      id,
      opts.getCurrentIdentity?.() ?? id,
      inlineSurfaceAvailable,
    );
    const route = resolveDecisionRoute({
      mode: opts.getExtensionDecisionPresentation?.() ?? "auto",
      kind,
      origin,
      ...classifyHostDecisionRisk(origin),
      ...(presentationHint ? { presentationHint } : {}),
      ...(riskHint ? { riskHint } : {}),
      hasDestructiveOption: options?.some((option) => option.destructive === true) ?? false,
      ownerSessionState,
      inlineSurfaceAvailable,
    });
    if (route.disposition === "cancel") return undefined;
    const groupKey = decisionGroups.groupForRequest(invocation, id);

    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const entry: PendingUi = {
        requestId,
        kind,
        owner: ownerFromIdentity(id),
        resolve,
        reject,
        timer: undefined,
        emitClosed: (reason) => opts.emit("extensionUi.closed", { requestId, reason }),
      };
      pending.set(requestId, entry);

      if (signals.length > 0) {
        const onAbort = () => {
          settlePending(requestId, {
            status: "resolved",
            value: undefined,
            closeReason: "aborted",
          });
        };
        for (const signal of signals) {
          signal.addEventListener("abort", onAbort, { once: true });
        }
        entry.cleanup = () => {
          for (const signal of signals) signal.removeEventListener("abort", onAbort);
        };
        if (signals.some((signal) => signal.aborted)) {
          onAbort();
          return;
        }
      }

      if (timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          if (
            !settlePending(requestId, {
              status: "resolved",
              value: undefined,
              closeReason: "timed-out",
            })
          ) {
            return;
          }
          opts.emit("extensionUi.notification", {
            message: "Extension UI request timed out",
            level: "warning",
          });
        }, timeoutMs);
      }

      try {
        opts.emit("extensionUi.request", {
          requestId,
          kind,
          title:
            payload.title === undefined
              ? undefined
              : boundedSanitizedText(payload.title, MAX_EXTENSION_UI_TITLE_LENGTH),
          message:
            payload.message === undefined
              ? undefined
              : boundedSanitizedText(payload.message, MAX_EXTENSION_UI_MESSAGE_LENGTH),
          options,
          defaultValue:
            payload.defaultValue === undefined
              ? undefined
              : boundedSanitizedText(payload.defaultValue, MAX_EXTENSION_UI_DEFAULT_VALUE_LENGTH),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          origin,
          ...requestMetadata,
          ...(presentationHint ? { presentationHint } : {}),
          ...(riskHint ? { riskHint } : {}),
          presentation: route.presentation,
          risk: route.risk,
          routeReason: route.reason,
          ...(groupKey ? { groupKey } : {}),
        });
      } catch (err) {
        settlePending(requestId, {
          status: "rejected",
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    });
  };

  const ui: ExtensionUIContext = {
    select: async (title, options, dialogOpts) => {
      const prepared = prepareSelectOptions(options);
      const value = await requestBlocking(
        "select",
        {
          title,
          options: prepared.options,
          pideck: piDeckMetadataFromDialogOptions(dialogOpts),
        },
        dialogOpts,
      );
      return typeof value === "string" ? prepared.responseValues.get(value) : undefined;
    },
    confirm: async (title, message, dialogOpts) => {
      const value = await requestBlocking(
        "confirm",
        { title, message, pideck: piDeckMetadataFromDialogOptions(dialogOpts) },
        dialogOpts,
      );
      return value === true;
    },
    input: async (title, placeholder, dialogOpts) => {
      const value = await requestBlocking(
        "input",
        {
          title,
          message: placeholder,
          defaultValue: "",
          pideck: piDeckMetadataFromDialogOptions(dialogOpts),
        },
        dialogOpts,
      );
      return typeof value === "string" ? value : undefined;
    },
    notify: (message, type) => {
      opts.emit("extensionUi.notification", {
        message: stripAnsi(String(message ?? "")),
        level: type ?? "info",
      });
      opts.onRendererActivity?.();
    },
    onTerminalInput: () => () => {},
    setStatus: (key, text) => {
      opts.emit("extensionUi.statusChanged", {
        key: stripAnsi(String(key)),
        text: text === undefined ? "" : stripAnsi(String(text)),
      });
      opts.onRendererActivity?.();
    },
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: (key, content, options?) => {
      const sanitizedKey = stripAnsi(String(key));
      const placement = options?.placement === "belowEditor" ? "belowEditor" : undefined;
      const commandOrigin = activeCommandOrigin();
      let replacingPublishedWidget = publishedWidgetKeys.has(sanitizedKey);
      disposeWidgetFactory(sanitizedKey);
      if (typeof content === "function") {
        // Keep the prior snapshot visible until the replacement publishes its
        // first frame. A failed replacement clears it explicitly below.
        const widgetTui = new TuiMainScreen(
          new VirtualTerminal({
            cols: WIDGET_SNAPSHOT_WIDTH,
            onData: () => {},
          }),
        );
        let widgetComponent: (Component & { dispose?(): void }) | undefined;
        let disposed = false;
        let lastSnapshot: string | undefined;
        let lastRenderError: string | undefined;
        let initialRenderOrigin = commandOrigin;
        let pendingRenderOrigin: ExtensionCommandOrigin | undefined;
        const requestRender = widgetTui.requestRender.bind(widgetTui);
        widgetTui.requestRender = (force = false) => {
          pendingRenderOrigin = activeCommandOrigin() ?? pendingRenderOrigin;
          requestRender(force);
        };
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
                const renderOrigin =
                  activeCommandOrigin() ?? pendingRenderOrigin ?? initialRenderOrigin;
                const lines = widgetComponent.render(width);
                const sanitizedLines = lines.map((line) => stripAnsi(line));
                const snapshot = JSON.stringify(sanitizedLines);
                if (snapshot !== lastSnapshot) {
                  lastSnapshot = snapshot;
                  publishWidget(sanitizedKey, sanitizedLines, placement);
                  replacingPublishedWidget = false;
                  requestWidgetAttention(sanitizedKey, renderOrigin);
                }
                pendingRenderOrigin = undefined;
                initialRenderOrigin = undefined;
                lastRenderError = undefined;
                return lines;
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                const sanitizedMessage = stripAnsi(message);
                if (lastSnapshot !== undefined || replacingPublishedWidget) {
                  lastSnapshot = undefined;
                  replacingPublishedWidget = false;
                  publishWidget(sanitizedKey, null, placement);
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
          if (publishedWidgetKeys.has(sanitizedKey)) {
            replacingPublishedWidget = false;
            publishWidget(sanitizedKey, null, placement);
          }
          const message = err instanceof Error ? err.message : String(err);
          opts.emit("package.diagnostic", {
            severity: "info",
            message: `Extension setWidget factory failed for key=${sanitizedKey}: ${stripAnsi(message)}`,
          });
        }
        return;
      }
      const widget = content === undefined ? null : sanitize(content);
      publishWidget(sanitizedKey, widget, placement);
      if (widget !== null && widget !== undefined) {
        requestWidgetAttention(sanitizedKey, commandOrigin);
      }
      opts.onRendererActivity?.();
    },
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    custom: async <T>(
      factory: (
        tui: TUI,
        theme: Theme,
        keybindings: SdkKeybindingsManager,
        done: (result: T) => void,
      ) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
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
      const owner = ownerFromIdentity(id);
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
        const tui = new TuiMainScreen(vt);
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
          owner,
          resolve: (value) => finish(value),
          reject: (err) => failure(err),
          timer: undefined,
        });
        activeCustoms.set(requestId, { terminal: vt, owner });

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
          (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>;
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
    editor: async (title: string, prefill?: string, dialogOpts?: ExtensionUIDialogOptions) => {
      const value = await requestBlocking(
        "editor",
        {
          title,
          defaultValue: prefill ?? "",
          pideck: piDeckMetadataFromDialogOptions(dialogOpts),
        },
        dialogOpts,
      );
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
  "extensionUi.closed",
  "extensionUi.groupClosed",
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
  const replayableState = new Map<string, { event: HostEventName; payload: unknown }>();
  let lastMessageRenders: Record<string, ExtensionMessageRenderSnapshot> = {};
  let rendererRefreshQueued = false;
  const refreshMessageRenderers = () => {
    if (disposed) return;
    const sessionManager = session.sessionManager;
    if (!sessionManager || typeof sessionManager.buildContextEntries !== "function") return;
    const next = renderExtensionMessageEntries(
      session,
      sessionManager.buildContextEntries(),
      (entry, error) => {
        emit("package.diagnostic", {
          severity: "info",
          message: `Extension message renderer failed for ${String(entry.customType ?? "custom")}: ${stripAnsi(error instanceof Error ? error.message : String(error))}`,
        });
      },
    );
    const entryIds = new Set([...Object.keys(lastMessageRenders), ...Object.keys(next)]);
    for (const entryId of entryIds) {
      if (extensionMessageRenderEqual(lastMessageRenders[entryId], next[entryId])) continue;
      emit("extensionUi.messageRendered", {
        entryId,
        render: next[entryId] ?? null,
      });
    }
    lastMessageRenders = next;
  };
  const scheduleMessageRendererRefresh = () => {
    if (disposed || rendererRefreshQueued) return;
    rendererRefreshQueued = true;
    queueMicrotask(() => {
      rendererRefreshQueued = false;
      refreshMessageRenderers();
    });
  };
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
        if (queued?.event === event && (queued.payload as { key?: unknown }).key === key) {
          queuedEvents.splice(i, 1);
          break;
        }
      }
    }
    queuedEvents.push({ event, payload });
  };
  const updateReplayableState = (event: HostEventName, payload: unknown) => {
    if (event === "extensionUi.widgetChanged") {
      const widget = payload as { key?: unknown; widget?: unknown };
      const stateKey = `widget:${String(widget.key ?? "")}`;
      if (widget.widget === null || widget.widget === undefined) {
        replayableState.delete(stateKey);
      } else {
        replayableState.set(stateKey, { event, payload });
      }
      return;
    }
    if (event === "extensionUi.statusChanged") {
      const status = payload as { key?: unknown; text?: unknown };
      const stateKey = `status:${String(status.key ?? "")}`;
      if (status.text === null || status.text === undefined || status.text === "") {
        replayableState.delete(stateKey);
      } else {
        replayableState.set(stateKey, { event, payload });
      }
      return;
    }
    if (event === "extensionUi.messageRendered") {
      const rendered = payload as { entryId?: unknown; render?: unknown };
      const stateKey = `message-renderer:${String(rendered.entryId ?? "")}`;
      if (rendered.render === null || rendered.render === undefined) {
        replayableState.delete(stateKey);
      } else {
        replayableState.set(stateKey, { event, payload });
      }
    }
  };
  const emit = (event: HostEventName, payload: unknown) => {
    if (disposed) return;
    updateReplayableState(event, payload);
    if (!activated || (!readyForEvents && !BLOCKING_EXTENSION_EVENTS.has(event))) {
      queueEvent(event, payload);
      return;
    }
    publishEvent(event, payload);
  };
  const uiContext = createExtensionUiContext({
    emit,
    getIdentity: () => bindingIdentity,
    getCurrentIdentity: opts.getCurrentIdentity,
    getExtensionDecisionPresentation: opts.getExtensionDecisionPresentation,
    isInlineSurfaceAvailable: opts.isInlineSurfaceAvailable ?? (() => readyForEvents),
    waitUntilActive: () => activation,
    isDisposed: () => disposed,
    registerCleanup: (cleanup) => contextCleanups.add(cleanup),
    getActiveInvocation: opts.getActiveInvocation ?? (() => getActiveExtensionInvocation(session)),
    onRendererActivity: scheduleMessageRendererRefresh,
  });
  const unsubscribeRendererEvents =
    typeof session.subscribe === "function"
      ? session.subscribe(() => scheduleMessageRendererRefresh())
      : undefined;
  if (unsubscribeRendererEvents) contextCleanups.add(unsubscribeRendererEvents);
  const ready = session
    .bindExtensions({
      uiContext,
      mode: "rpc",
      invocationRunner: createExtensionInvocationRunner(session),
      ...(opts.commandContextActions !== undefined
        ? { commandContextActions: opts.commandContextActions }
        : {}),
      onError: (error) => {
        // Extension handler failures inside agent turns otherwise surface
        // nowhere — log for diagnostics and notify via the same channel the
        // frontend already renders as toasts.
        logger.error("Extension handler failed", {
          extensionPath: error.extensionPath,
          event: error.event,
          error: error.error,
          stack: error.stack,
        });
        const extensionName = error.extensionPath.split(/[\\/]/).pop() ?? error.extensionPath;
        emit("extensionUi.notification", {
          message: `Extension error (${extensionName}, ${error.event}): ${error.error}`,
          level: "error",
        });
      },
    })
    .then(() => {
      logger.info("Extension UI bound via bindExtensions({ uiContext, mode: rpc })");
    });
  // Candidate activation may be delayed or skipped; activation still awaits the original promise.
  void ready.catch(() => undefined);

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
      refreshMessageRenderers();
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
      cancelPendingForIdentity(bindingIdentity, "disposed");
      for (const cleanup of contextCleanups) {
        try {
          cleanup();
        } catch {
          /* ignore Extension UI cleanup errors */
        }
      }
      contextCleanups.clear();
      disposed = true;
      queuedEvents.length = 0;
      replayableState.clear();
      lastMessageRenders = {};
      releaseActivation();
    },
    updateIdentity: (identity) => {
      const next = { ...identity };
      migrateExtensionUiIdentity(bindingIdentity, next);
      bindingIdentity = next;
    },
    replayState: () => {
      if (disposed || !activated || !readyForEvents) return;
      for (const state of replayableState.values()) {
        publishEvent(state.event, state.payload);
      }
    },
    refreshMessageRenderers,
  };
}

function migrateExtensionUiIdentity(from: HostIdentity, to: HostIdentity): void {
  const fromOwner = ownerFromIdentity(from);
  const owners = new Set<ExtensionUiOwner>();
  for (const pendingRequest of pending.values()) owners.add(pendingRequest.owner);
  for (const activeCustom of activeCustoms.values()) owners.add(activeCustom.owner);
  for (const owner of owners) {
    if (ownerMatches(owner, fromOwner)) replaceOwner(owner, to);
  }
}

export function respondExtensionUi(
  requestId: string,
  status: "resolved" | "cancelled",
  value: unknown | undefined,
  expectedOwner: ExtensionUiOwner,
): boolean {
  const p = pending.get(requestId);
  if (!p) return false;
  if (!ownerMatches(p.owner, expectedOwner)) return false;
  return settlePending(requestId, {
    status: "resolved",
    value: status === "cancelled" ? undefined : value,
  });
}

export function cancelPendingForIdentity(
  identity: HostIdentity,
  reason: ExtensionUiClosedReason = "stale",
): void {
  const owner = ownerFromIdentity(identity);
  for (const [requestId, p] of pending) {
    if (!ownerMatches(p.owner, owner)) continue;
    settlePending(requestId, {
      status: "resolved",
      value: undefined,
      closeReason: reason,
    });
  }
}

export function cancelAllPending(_reason: string): void {
  for (const requestId of [...pending.keys()]) {
    settlePending(requestId, {
      status: "resolved",
      value: undefined,
      closeReason: "disposed",
    });
  }
}

/** Route frontend keyboard/paste data into a live custom panel. False if unknown/closed. */
export function injectExtensionCustomInput(
  requestId: string,
  data: string,
  expectedOwner: ExtensionUiOwner,
): boolean {
  const active = activeCustoms.get(requestId);
  if (!active || !ownerMatches(active.owner, expectedOwner)) return false;
  active.terminal.input(data);
  return true;
}

/** Resize a live custom panel's virtual terminal. False if unknown/closed. */
function resizeExtensionCustom(
  requestId: string,
  cols: number,
  rows: number,
  expectedOwner: ExtensionUiOwner,
): boolean {
  const active = activeCustoms.get(requestId);
  if (!active || !ownerMatches(active.owner, expectedOwner)) return false;
  active.terminal.resize(cols, rows);
  return true;
}

export function createExtensionUiHandlers(
  factory: WorkspaceGraphFactory,
): Partial<Record<string, ServerMethodHandler>> {
  return {
    "extensionUi.configure": async (ctx) => {
      const params = ctx.params as {
        extensionDecisionPresentation: ExtensionDecisionPresentation;
      };
      const server = factory.getServer();
      if (!server) {
        return {
          error: createHostError("INTERNAL_ERROR", "Pi Host server is not bound"),
        };
      }
      server.setExtensionDecisionPresentation(params.extensionDecisionPresentation);
      return {
        result: {
          extensionDecisionPresentation: server.getExtensionDecisionPresentation(),
        },
      };
    },
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
        ownerFromTargetContext(ctx.context as SessionTargetContext),
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
      if (
        !injectExtensionCustomInput(
          params.requestId,
          params.data,
          ownerFromTargetContext(ctx.context as SessionTargetContext),
        )
      ) {
        return {
          error: createHostError("STALE_REVISION", "Unknown or closed extension panel requestId"),
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
      if (
        !resizeExtensionCustom(
          params.requestId,
          params.cols,
          params.rows,
          ownerFromTargetContext(ctx.context as SessionTargetContext),
        )
      ) {
        return {
          error: createHostError("STALE_REVISION", "Unknown or closed extension panel requestId"),
        };
      }
      return { result: { accepted: true } };
    },
  };
}
