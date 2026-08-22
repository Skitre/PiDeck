import { describe, expect, it, vi } from "vitest";
import {
  bindExtensionUi,
  createExtensionUiContext,
  createExtensionUiHandlers,
  respondExtensionUi,
  cancelPendingForIdentity,
  cancelAllPending,
  injectExtensionCustomInput,
} from "./extension-ui-bridge.js";
import {
  MAX_EXTENSION_UI_CORRELATION_ID_LENGTH,
  MAX_EXTENSION_UI_DEFAULT_VALUE_LENGTH,
  MAX_EXTENSION_UI_MESSAGE_LENGTH,
  MAX_EXTENSION_UI_OPTION_DESCRIPTION_LENGTH,
  MAX_EXTENSION_UI_OPTION_ID_LENGTH,
  MAX_EXTENSION_UI_OPTION_LABEL_LENGTH,
  MAX_EXTENSION_UI_OPTIONS,
  MAX_EXTENSION_UI_SOURCE_LABEL_LENGTH,
  MAX_EXTENSION_UI_TITLE_LENGTH,
  validateEventPayload,
  type HostEventName,
  type HostIdentity,
} from "@pideck/protocol";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  createExtensionInvocationRunner,
  getActiveExtensionInvocation,
  type ExtensionInvocationContext,
  type ResolvedExtensionCommandInvocation,
  withExtensionCommandOrigin,
} from "./extension-invocation-context.js";

const id: HostIdentity = {
  hostInstanceId: "h",
  workspaceId: "w",
  workspaceRevision: 1,
  sessionId: "s",
  sessionRevision: 1,
  packageRevision: 0,
};

const COMMAND_RUN_ID = "00000000-0000-4000-8000-000000000006";
const NEXT_COMMAND_RUN_ID = "00000000-0000-4000-8000-000000000007";
const UNKNOWN_ORIGIN = { invocationKind: "unknown" } as const;

function commandInvocation(invocation: string): ResolvedExtensionCommandInvocation {
  return {
    invocation,
    command: {
      name: invocation,
      invocationName: invocation,
      sourceInfo: {
        path: `/packages/review/extensions/${invocation}.ts`,
        source: "npm:@pideck/review-extension@1.0.0",
        scope: "user",
        origin: "package",
        baseDir: "/packages/review",
      },
      handler: async () => {},
    },
  };
}

function targetContext(identity: HostIdentity = id) {
  return {
    expectedHostInstanceId: identity.hostInstanceId,
    expectedWorkspaceId: identity.workspaceId,
    expectedWorkspaceRevision: identity.workspaceRevision,
    expectedSessionId: identity.sessionId,
    expectedSessionRevision: identity.sessionRevision,
  };
}

function extensionUiHandlers() {
  const checkIdentity = vi.fn((_context: unknown, requirements: { requireSession?: boolean }) =>
    requirements.requireSession
      ? {
          code: "STALE_REVISION",
          message: "Target Session is not active",
          retryable: true,
        }
      : null,
  );
  return {
    checkIdentity,
    handlers: createExtensionUiHandlers({ checkIdentity } as never),
  };
}

describe("Extension UI configuration handler", () => {
  it("applies and returns the server-owned mode idempotently", async () => {
    let mode: "legacy-modal" | "auto" | "inline-first" = "legacy-modal";
    let overrides: Record<string, "followHost" | "inline" | "modal"> = {};
    const server = {
      applyExtensionUiConfigure: vi.fn(
        (params: {
          extensionDecisionPresentation: typeof mode;
          extensionDialogPresentationOverrides?: typeof overrides;
        }) => {
          mode = params.extensionDecisionPresentation;
          if (params.extensionDialogPresentationOverrides !== undefined) {
            overrides = params.extensionDialogPresentationOverrides;
          }
          return {
            extensionDecisionPresentation: mode,
            extensionDialogPresentationOverrides: overrides,
          };
        },
      ),
    };
    const handlers = createExtensionUiHandlers({
      getServer: () => server,
    } as never);

    const configure = (
      params: Record<string, unknown> = { extensionDecisionPresentation: "inline-first" },
    ) =>
      handlers["extensionUi.configure"]!({
        params,
      } as never);
    await expect(configure()).resolves.toEqual({
      result: {
        extensionDecisionPresentation: "inline-first",
        extensionDialogPresentationOverrides: {},
      },
    });
    await expect(
      configure({
        extensionDecisionPresentation: "auto",
        extensionDialogPresentationOverrides: { ext_review: "inline" },
      }),
    ).resolves.toEqual({
      result: {
        extensionDecisionPresentation: "auto",
        extensionDialogPresentationOverrides: { ext_review: "inline" },
      },
    });
    await expect(configure()).resolves.toEqual({
      result: {
        extensionDecisionPresentation: "inline-first",
        extensionDialogPresentationOverrides: { ext_review: "inline" },
      },
    });
    expect(server.applyExtensionUiConfigure).toHaveBeenCalledTimes(3);
  });

  it("rejects illegal override maps without applying configure", async () => {
    const server = {
      applyExtensionUiConfigure: vi.fn(),
    };
    const handlers = createExtensionUiHandlers({
      getServer: () => server,
    } as never);

    await expect(
      handlers["extensionUi.configure"]!({
        params: {
          extensionDecisionPresentation: "auto",
          extensionDialogPresentationOverrides: { ext_review: "dock" },
        },
      } as never),
    ).resolves.toMatchObject({
      error: { message: "invalid extensionDialogPresentationOverrides" },
    });
    expect(server.applyExtensionUiConfigure).not.toHaveBeenCalled();
  });

  it("replaces the override map when an empty object is sent", async () => {
    let overrides: Record<string, "followHost" | "inline" | "modal"> = {
      ext_review: "inline",
    };
    const server = {
      applyExtensionUiConfigure: vi.fn(
        (params: {
          extensionDecisionPresentation: "legacy-modal" | "auto" | "inline-first";
          extensionDialogPresentationOverrides?: typeof overrides;
        }) => {
          if (params.extensionDialogPresentationOverrides !== undefined) {
            overrides = params.extensionDialogPresentationOverrides;
          }
          return {
            extensionDecisionPresentation: params.extensionDecisionPresentation,
            extensionDialogPresentationOverrides: overrides,
          };
        },
      ),
    };
    const handlers = createExtensionUiHandlers({
      getServer: () => server,
    } as never);

    await expect(
      handlers["extensionUi.configure"]!({
        params: {
          extensionDecisionPresentation: "auto",
          extensionDialogPresentationOverrides: {},
        },
      } as never),
    ).resolves.toEqual({
      result: {
        extensionDecisionPresentation: "auto",
        extensionDialogPresentationOverrides: {},
      },
    });
  });
});

describe("extension-ui-bridge", () => {
  it("select uses positional title/options and returns option string", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    const ui = createExtensionUiContext({
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
    });
    const p = ui.select("Pick", ["alpha", "beta"]);
    expect(events.some((x) => x.e === "extensionUi.request")).toBe(true);
    const req = events.find((x) => x.e === "extensionUi.request")!.p as {
      requestId: string;
      kind: string;
      origin: unknown;
    };
    expect(req.kind).toBe("select");
    expect(req.origin).toEqual({ invocationKind: "unknown" });
    respondExtensionUi(req.requestId, "resolved", "beta", id);
    await expect(p).resolves.toBe("beta");
  });

  it("bounds blocking payloads while preserving selected SDK option values", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    const ui = createExtensionUiContext({
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
    });
    const sharedPrefix = "x".repeat(MAX_EXTENSION_UI_OPTION_ID_LENGTH);
    const firstLongValue = `${sharedPrefix}a`;
    const secondLongValue = `${sharedPrefix}b`;
    const values = [
      "described",
      firstLongValue,
      secondLongValue,
      ...Array.from({ length: MAX_EXTENSION_UI_OPTIONS }, (_, index) => `option-${index}`),
    ];
    const pendingSelect = ui.select("t".repeat(MAX_EXTENSION_UI_TITLE_LENGTH + 1), values, {
      pideck: {
        sourceLabel: "s".repeat(MAX_EXTENSION_UI_SOURCE_LABEL_LENGTH + 1),
        correlationId: "c".repeat(MAX_EXTENSION_UI_CORRELATION_ID_LENGTH + 1),
        optionDetails: [
          {
            id: "described",
            description: "d".repeat(MAX_EXTENSION_UI_OPTION_DESCRIPTION_LENGTH + 1),
          },
        ],
      },
    } as never);
    const selectRequest = events.at(-1)?.p as {
      requestId: string;
      title: string;
      sourceLabel: string;
      correlationId: string;
      options: Array<{ id: string; label: string; description?: string }>;
    };

    expect(selectRequest.title).toHaveLength(MAX_EXTENSION_UI_TITLE_LENGTH);
    expect(selectRequest.sourceLabel).toHaveLength(MAX_EXTENSION_UI_SOURCE_LABEL_LENGTH);
    expect(selectRequest.correlationId).toHaveLength(MAX_EXTENSION_UI_CORRELATION_ID_LENGTH);
    expect(selectRequest.options).toHaveLength(MAX_EXTENSION_UI_OPTIONS);
    expect(selectRequest.options[0]?.description).toHaveLength(
      MAX_EXTENSION_UI_OPTION_DESCRIPTION_LENGTH,
    );
    expect(selectRequest.options[1]?.id).toHaveLength(MAX_EXTENSION_UI_OPTION_ID_LENGTH);
    expect(selectRequest.options[1]?.label).toHaveLength(MAX_EXTENSION_UI_OPTION_LABEL_LENGTH);
    expect(selectRequest.options[2]?.id).not.toBe(selectRequest.options[1]?.id);
    expect(selectRequest.options[2]?.id.length).toBeLessThanOrEqual(
      MAX_EXTENSION_UI_OPTION_ID_LENGTH,
    );
    expect(validateEventPayload("extensionUi.request", selectRequest).ok).toBe(true);

    respondExtensionUi(selectRequest.requestId, "resolved", selectRequest.options[2]?.id, id);
    await expect(pendingSelect).resolves.toBe(secondLongValue);

    const pendingConfirm = ui.confirm("title", "m".repeat(MAX_EXTENSION_UI_MESSAGE_LENGTH + 1));
    const confirmRequest = events.at(-1)?.p as { requestId: string; message: string };
    expect(confirmRequest.message).toHaveLength(MAX_EXTENSION_UI_MESSAGE_LENGTH);
    respondExtensionUi(confirmRequest.requestId, "cancelled", undefined, id);
    await expect(pendingConfirm).resolves.toBe(false);

    const pendingEditor = ui.editor("title", "d".repeat(MAX_EXTENSION_UI_DEFAULT_VALUE_LENGTH + 1));
    const editorRequest = events.at(-1)?.p as { requestId: string; defaultValue: string };
    expect(editorRequest.defaultValue).toHaveLength(MAX_EXTENSION_UI_DEFAULT_VALUE_LENGTH);
    respondExtensionUi(editorRequest.requestId, "cancelled", undefined, id);
    await expect(pendingEditor).resolves.toBeUndefined();
  });

  it("publishes trusted origin with the default auto decision", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    const activeInvocation: ExtensionInvocationContext = {
      session: {} as ExtensionInvocationContext["session"],
      invocationId: "00000000-0000-4000-8000-000000000008",
      origin: {
        invocationKind: "tool",
        extensionId: "ext_0123456789abcdef01234567",
        extensionDisplayName: "Trusted review",
        sourceKind: "package",
        toolName: "review_changes",
        toolCallId: "tool-call-1",
      },
      active: true,
      widgetAttentionRequested: false,
    };
    const ui = createExtensionUiContext({
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
      getActiveInvocation: () => activeInvocation,
      getExtensionDecisionPresentation: () => "auto",
    });
    const pending = ui.confirm("Continue?", "Review changes", {
      pideck: { sourceLabel: "Untrusted label" },
    });
    const request = events.find((event) => event.e === "extensionUi.request")!.p as {
      requestId: string;
      sourceLabel: string;
      presentation?: string;
      risk?: string;
      routeReason?: string;
      origin: unknown;
    };
    expect(request).toMatchObject({
      sourceLabel: "Untrusted label",
      origin: activeInvocation.origin,
      presentation: "inline",
      risk: "normal",
      routeReason: "active-tool",
    });
    respondExtensionUi(request.requestId, "cancelled", undefined, id);
    await expect(pending).resolves.toBe(false);
  });

  it("normalizes namespaced PiDeck presentation metadata", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    const ui = createExtensionUiContext({
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
    });
    const pendingSelect = ui.select("Pick", ["keep", "delete"], {
      timeout: 5_000,
      pideck: {
        presentation: "inline",
        sourceLabel: "\u001b[31mReview\u001b[0m",
        correlationId: "review-1",
        risk: "high",
        allowFreeform: true,
        optionDetails: [
          {
            id: "delete",
            description: "\u001b[2KCannot be undone",
            destructive: true,
          },
          { id: "missing", description: "ignored" },
        ],
      },
    } as never);

    const request = events.find((event) => event.e === "extensionUi.request")?.p as {
      requestId: string;
      presentationHint?: string;
      riskHint?: string;
      presentation?: string;
      sourceLabel?: string;
      correlationId?: string;
      risk?: string;
      routeReason?: string;
      allowFreeform?: boolean;
      options?: Array<{
        id: string;
        label: string;
        description?: string;
        destructive?: boolean;
      }>;
    };
    expect(request).toMatchObject({
      presentationHint: "inline",
      riskHint: "high",
      presentation: "modal",
      sourceLabel: "Review",
      correlationId: "review-1",
      risk: "high",
      routeReason: "destructive-option",
      allowFreeform: true,
      options: [
        { id: "keep", label: "keep" },
        {
          id: "delete",
          label: "delete",
          description: "Cannot be undone",
          destructive: true,
        },
      ],
    });
    respondExtensionUi(request.requestId, "cancelled", undefined, id);
    await expect(pendingSelect).resolves.toBeUndefined();
  });

  it("routes an ordinary active tool inline in auto mode", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    const activeInvocation: ExtensionInvocationContext = {
      session: {} as ExtensionInvocationContext["session"],
      invocationId: "00000000-0000-4000-8000-000000000018",
      origin: {
        invocationKind: "tool",
        extensionId: "ext_0123456789abcdef01234567",
        extensionDisplayName: "Trusted review",
        sourceKind: "package",
        toolName: "review_changes",
        toolCallId: "tool-call-auto",
      },
      active: true,
      widgetAttentionRequested: false,
    };
    const ui = createExtensionUiContext({
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
      getCurrentIdentity: () => id,
      getExtensionDecisionPresentation: () => "auto",
      isInlineSurfaceAvailable: () => true,
      getActiveInvocation: () => activeInvocation,
    });

    const pending = ui.confirm("Continue?", "Review changes");
    const request = events.find((event) => event.e === "extensionUi.request")!.p as {
      requestId: string;
      presentation: string;
      risk: string;
      routeReason: string;
    };
    expect(request).toMatchObject({
      presentation: "inline",
      risk: "normal",
      routeReason: "active-tool",
    });
    respondExtensionUi(request.requestId, "cancelled", undefined, id);
    await expect(pending).resolves.toBe(false);
  });

  it("forces a trusted tool-call permission decision to high-risk Modal", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    const activeInvocation: ExtensionInvocationContext = {
      session: {} as ExtensionInvocationContext["session"],
      invocationId: "00000000-0000-4000-8000-000000000020",
      origin: {
        invocationKind: "event",
        extensionId: "ext_0123456789abcdef01234567",
        extensionDisplayName: "Permission guard",
        sourceKind: "package",
        eventType: "tool_call",
        toolName: "bash",
        toolCallId: "tool-call-guarded",
      },
      active: true,
      widgetAttentionRequested: false,
    };
    const ui = createExtensionUiContext({
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
      getCurrentIdentity: () => id,
      getExtensionDecisionPresentation: () => "auto",
      isInlineSurfaceAvailable: () => true,
      getActiveInvocation: () => activeInvocation,
    });

    const pending = ui.select("Allow command?", ["Allow", "Block"], {
      pideck: { presentation: "inline", risk: "normal" },
    } as never);
    const request = events.find((event) => event.e === "extensionUi.request")!.p as {
      requestId: string;
      presentation: string;
      risk: string;
      routeReason: string;
    };
    expect(request).toMatchObject({
      presentation: "modal",
      risk: "high",
      routeReason: "high-risk",
    });
    respondExtensionUi(request.requestId, "resolved", "Block", id);
    await expect(pending).resolves.toBe("Block");
  });

  it("publishes one Host-owned group for sequential tool dialogs", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    const session = {} as AgentSession;
    const runner = createExtensionInvocationRunner(session);
    const ui = createExtensionUiContext({
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
      getCurrentIdentity: () => id,
      getExtensionDecisionPresentation: () => "auto",
      isInlineSurfaceAvailable: () => true,
      getActiveInvocation: () => getActiveExtensionInvocation(session),
    });

    await runner(
      {
        kind: "tool",
        sourceInfo: {
          path: "/packages/questions/extensions/index.ts",
          source: "npm:@pideck/questions@1.0.0",
          scope: "user",
          origin: "package",
          baseDir: "/packages/questions",
        },
        toolName: "ask_user_question",
        toolCallId: "provider-call-sensitive",
      },
      async () => {
        const firstPending = ui.select("Pick", ["alpha", "beta"]);
        const first = events.find((event) => event.e === "extensionUi.request")!.p as {
          requestId: string;
          groupKey?: string;
        };
        expect(first.groupKey).toMatch(/^tool:[0-9a-f]{32}$/);
        expect(first.groupKey).not.toContain("provider-call-sensitive");
        respondExtensionUi(first.requestId, "resolved", "alpha", id);
        await expect(firstPending).resolves.toBe("alpha");

        const secondPending = ui.input("Explain", "Details");
        const requests = events.filter((event) => event.e === "extensionUi.request");
        const second = requests.at(-1)!.p as {
          requestId: string;
          groupKey?: string;
        };
        expect(second.groupKey).toBe(first.groupKey);
        respondExtensionUi(second.requestId, "resolved", "because", id);
        await expect(secondPending).resolves.toBe("because");
        expect(events.some((event) => event.e === "extensionUi.groupClosed")).toBe(false);
      },
    );

    expect(events.filter((event) => event.e === "extensionUi.groupClosed")).toEqual([
      {
        e: "extensionUi.groupClosed",
        p: {
          groupKey: expect.stringMatching(/^tool:[0-9a-f]{32}$/),
          status: "completed",
        },
      },
    ]);
  });

  it("keeps a background tool request on its owner and records the queue route", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    const foreground = { ...id, sessionId: "foreground", sessionRevision: 2 };
    const activeInvocation: ExtensionInvocationContext = {
      session: {} as ExtensionInvocationContext["session"],
      invocationId: "00000000-0000-4000-8000-000000000019",
      origin: {
        invocationKind: "tool",
        extensionId: "ext_0123456789abcdef01234567",
        extensionDisplayName: "Trusted review",
        sourceKind: "package",
        toolName: "review_changes",
        toolCallId: "tool-call-background",
      },
      active: true,
      widgetAttentionRequested: false,
    };
    const ui = createExtensionUiContext({
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
      getCurrentIdentity: () => foreground,
      getExtensionDecisionPresentation: () => "auto",
      isInlineSurfaceAvailable: () => true,
      getActiveInvocation: () => activeInvocation,
    });

    const pending = ui.input("Background", "value");
    const request = events.find((event) => event.e === "extensionUi.request")!.p as {
      requestId: string;
      presentation: string;
      routeReason: string;
    };
    expect(request).toMatchObject({
      presentation: "inline",
      routeReason: "background-session",
    });
    expect(respondExtensionUi(request.requestId, "resolved", "done", id)).toBe(true);
    await expect(pending).resolves.toBe("done");
  });

  it("cancels a stale owner without publishing or allocating a request", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    const ui = createExtensionUiContext({
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
      getCurrentIdentity: () => ({ ...id, workspaceRevision: 2 }),
      getExtensionDecisionPresentation: () => "auto",
      isInlineSurfaceAvailable: () => true,
    });

    await expect(ui.confirm("Stale", "Ignore")).resolves.toBe(false);
    expect(events).toEqual([]);
  });

  it("confirm returns boolean; cancel yields false", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    const ui = createExtensionUiContext({
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
    });
    const p = ui.confirm("Sure?", "Really");
    const req = events.find((x) => x.e === "extensionUi.request")!.p as {
      requestId: string;
    };
    respondExtensionUi(req.requestId, "resolved", true, id);
    await expect(p).resolves.toBe(true);

    const p2 = ui.confirm("Sure?", "Really");
    const req2 = events.filter((x) => x.e === "extensionUi.request").at(-1)!.p as {
      requestId: string;
    };
    respondExtensionUi(req2.requestId, "cancelled", undefined, id);
    await expect(p2).resolves.toBe(false);
  });

  it("keeps missing and zero timeouts pending without timers", async () => {
    vi.useFakeTimers();
    try {
      const events: Array<{ e: HostEventName; p: unknown }> = [];
      const ui = createExtensionUiContext({
        emit: (e, p) => events.push({ e, p }),
        getIdentity: () => id,
      });
      const missingTimeout = ui.input("Missing timeout", "");
      const zeroTimeout = ui.editor("Zero timeout", "", { timeout: 0 });
      const requests = events
        .filter((event) => event.e === "extensionUi.request")
        .map((event) => event.p as { requestId: string; timeoutMs?: number });

      expect(requests).toHaveLength(2);
      expect(requests.map((request) => request.timeoutMs)).toEqual([undefined, undefined]);
      expect(vi.getTimerCount()).toBe(0);

      let settled = false;
      void Promise.all([missingTimeout, zeroTimeout]).then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(settled).toBe(false);

      for (const request of requests) {
        expect(respondExtensionUi(request.requestId, "cancelled", undefined, id)).toBe(true);
      }
      await expect(missingTimeout).resolves.toBeUndefined();
      await expect(zeroTimeout).resolves.toBeUndefined();
      expect(events.filter((event) => event.e === "extensionUi.closed")).toEqual([]);
    } finally {
      cancelAllPending("missing/zero timeout test cleanup");
      vi.useRealTimers();
    }
  });

  it("times out once and publishes an authoritative close", async () => {
    vi.useFakeTimers();
    try {
      const events: Array<{ e: HostEventName; p: unknown }> = [];
      const ui = createExtensionUiContext({
        emit: (e, p) => events.push({ e, p }),
        getIdentity: () => id,
      });
      const pendingConfirm = ui.confirm("Timeout", "Wait?", { timeout: 1_000 });
      const request = events.find((event) => event.e === "extensionUi.request")?.p as {
        requestId: string;
        timeoutMs?: number;
      };
      expect(request.timeoutMs).toBe(1_000);
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pendingConfirm).resolves.toBe(false);
      expect(events.filter((event) => event.e === "extensionUi.closed")).toEqual([
        {
          e: "extensionUi.closed",
          p: { requestId: request.requestId, reason: "timed-out" },
        },
      ]);
      expect(respondExtensionUi(request.requestId, "resolved", true, id)).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(events.filter((event) => event.e === "extensionUi.closed")).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      cancelAllPending("positive timeout test cleanup");
      vi.useRealTimers();
    }
  });

  it("honors pre-aborted and later-aborted dialog signals", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    const ui = createExtensionUiContext({
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
    });
    const preAborted = new AbortController();
    preAborted.abort();
    await expect(
      ui.input("Already aborted", "", { signal: preAborted.signal }),
    ).resolves.toBeUndefined();
    expect(events).toEqual([]);

    const controller = new AbortController();
    const pendingSelect = ui.select("Abort later", ["one"], {
      signal: controller.signal,
    });
    const request = events.find((event) => event.e === "extensionUi.request")?.p as {
      requestId: string;
    };
    controller.abort();

    await expect(pendingSelect).resolves.toBeUndefined();
    expect(events.filter((event) => event.e === "extensionUi.closed")).toEqual([
      {
        e: "extensionUi.closed",
        p: { requestId: request.requestId, reason: "aborted" },
      },
    ]);
    controller.abort();
    expect(respondExtensionUi(request.requestId, "resolved", "one", id)).toBe(false);
    expect(events.filter((event) => event.e === "extensionUi.closed")).toHaveLength(1);
  });

  it("inherits the active tool signal when an Extension omits dialog options", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    const controller = new AbortController();
    const invocation: ExtensionInvocationContext = {
      session: {} as AgentSession,
      invocationId: "00000000-0000-4000-8000-000000000099",
      origin: {
        invocationKind: "tool",
        extensionId: "ext_0123456789abcdef01234567",
        extensionDisplayName: "Abortable tool",
        sourceKind: "package",
        toolName: "ask_user_question",
        toolCallId: "tool-call-abort",
      },
      signal: controller.signal,
      active: true,
      widgetAttentionRequested: false,
    };
    const ui = createExtensionUiContext({
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
      getActiveInvocation: () => invocation,
    });
    const pendingSelect = ui.select("Abort inherited", ["one"]);
    const request = events.find((event) => event.e === "extensionUi.request")?.p as {
      requestId: string;
    };

    controller.abort();

    await expect(pendingSelect).resolves.toBeUndefined();
    expect(events.filter((event) => event.e === "extensionUi.closed")).toEqual([
      {
        e: "extensionUi.closed",
        p: { requestId: request.requestId, reason: "aborted" },
      },
    ]);
    expect(respondExtensionUi(request.requestId, "resolved", "one", id)).toBe(false);
  });

  it("rolls back pending state when request emission throws", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      let requestId = "";
      const ui = createExtensionUiContext({
        emit: (event, payload) => {
          if (event !== "extensionUi.request") return;
          requestId = (payload as { requestId: string }).requestId;
          throw new Error("request transport failed");
        },
        getIdentity: () => id,
      });

      await expect(
        ui.input("Emit failure", "", {
          timeout: 5_000,
          signal: controller.signal,
        }),
      ).rejects.toThrow("request transport failed");
      expect(requestId).toBeTruthy();
      expect(vi.getTimerCount()).toBe(0);
      controller.abort();
      expect(respondExtensionUi(requestId, "resolved", "late", id)).toBe(false);
    } finally {
      cancelAllPending("emit failure test cleanup");
      vi.useRealTimers();
    }
  });

  it("cancelAllPending resolves pending without hang", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    const ui = createExtensionUiContext({
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
    });
    const p = ui.input("Name", "type here");
    cancelAllPending("test");
    await expect(p).resolves.toBeUndefined();
    const request = events.find((event) => event.e === "extensionUi.request")?.p as {
      requestId: string;
    };
    expect(events.filter((event) => event.e === "extensionUi.closed")).toEqual([
      {
        e: "extensionUi.closed",
        p: { requestId: request.requestId, reason: "disposed" },
      },
    ]);
  });

  it("cancels only the matching session generation", async () => {
    const nextId: HostIdentity = {
      ...id,
      sessionId: "s-next",
      sessionRevision: 2,
    };
    const firstEvents: Array<{ e: HostEventName; p: unknown }> = [];
    const secondEvents: Array<{ e: HostEventName; p: unknown }> = [];
    const first = createExtensionUiContext({
      emit: (e, p) => firstEvents.push({ e, p }),
      getIdentity: () => id,
    });
    const second = createExtensionUiContext({
      emit: (e, p) => secondEvents.push({ e, p }),
      getIdentity: () => nextId,
    });
    const firstPending = first.input("First", "");
    const secondPending = second.input("Second", "");
    const firstRequest = firstEvents.find((event) => event.e === "extensionUi.request")?.p as {
      requestId: string;
    };
    const secondRequest = secondEvents.find((event) => event.e === "extensionUi.request")?.p as {
      requestId: string;
    };

    cancelPendingForIdentity(id);
    await expect(firstPending).resolves.toBeUndefined();
    expect(firstEvents.filter((event) => event.e === "extensionUi.closed")).toEqual([
      {
        e: "extensionUi.closed",
        p: { requestId: firstRequest.requestId, reason: "stale" },
      },
    ]);
    expect(secondEvents.filter((event) => event.e === "extensionUi.closed")).toEqual([]);

    let secondSettled = false;
    void secondPending.then(() => {
      secondSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(secondSettled).toBe(false);

    cancelPendingForIdentity(nextId);
    await expect(secondPending).resolves.toBeUndefined();
    expect(secondEvents.filter((event) => event.e === "extensionUi.closed")).toEqual([
      {
        e: "extensionUi.closed",
        p: { requestId: secondRequest.requestId, reason: "stale" },
      },
    ]);
  });

  it("accepts a background dialog only from its captured target identity", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    const ui = createExtensionUiContext({
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
    });
    const pendingInput = ui.input("Background", "value");
    const request = events.find((event) => event.e === "extensionUi.request")?.p as {
      requestId: string;
    };
    const { checkIdentity, handlers } = extensionUiHandlers();
    const wrongIdentity = {
      ...targetContext(),
      expectedSessionId: NEXT_COMMAND_RUN_ID,
      expectedSessionRevision: 9,
    };

    const rejected = await handlers["extensionUi.respond"]!({
      id: "wrong-dialog",
      context: wrongIdentity,
      params: { requestId: request.requestId, status: "resolved", value: "wrong" },
    } as never);
    expect("error" in rejected && rejected.error.code).toBe("STALE_REVISION");
    let settled = false;
    void pendingInput.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    const accepted = await handlers["extensionUi.respond"]!({
      id: "correct-dialog",
      context: targetContext(),
      params: { requestId: request.requestId, status: "resolved", value: "done" },
    } as never);
    expect("error" in accepted).toBe(false);
    await expect(pendingInput).resolves.toBe("done");
    expect(checkIdentity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ requireSession: true }),
    );
  });

  it("notify is non-blocking", () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    const ui = createExtensionUiContext({
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
    });
    ui.notify("hello", "info");
    expect(events.some((x) => x.e === "extensionUi.notification")).toBe(true);
  });

  it("publishes latest-wins registered message renderer updates", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    let ui: ReturnType<typeof createExtensionUiContext> | undefined;
    let renderState = "running";
    let sessionListener: (() => void) | undefined;
    const entries = [
      {
        id: "custom-renderer-1",
        type: "custom_message",
        customType: "dynamic-result",
        content: "Running...",
        display: true,
        timestamp: "2026-08-01T00:00:00.000Z",
      },
    ];
    const session = {
      sessionManager: { buildContextEntries: () => entries },
      extensionRunner: {
        getMessageRenderer: () => (_message: unknown, options: { expanded: boolean }) => ({
          render: () => [options.expanded ? `${renderState}: full` : renderState],
          invalidate: () => undefined,
        }),
      },
      subscribe: (listener: () => void) => {
        sessionListener = listener;
        return () => {
          sessionListener = undefined;
        };
      },
      bindExtensions: async ({ uiContext }: { uiContext: typeof ui }) => {
        ui = uiContext;
      },
    };
    const binding = await bindExtensionUi(session as never, null, {
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
    });
    const publish = await binding.activate();
    publish();

    expect(events.filter((event) => event.e === "extensionUi.messageRendered")).toEqual([
      {
        e: "extensionUi.messageRendered",
        p: {
          entryId: "custom-renderer-1",
          render: {
            version: 1,
            collapsed: ["running"],
            expanded: ["running: full"],
            messageIndex: 0,
          },
        },
      },
    ]);

    renderState = "complete";
    ui!.setStatus("dynamic", undefined);
    await Promise.resolve();
    await Promise.resolve();
    expect(events.filter((event) => event.e === "extensionUi.messageRendered").at(-1)).toEqual({
      e: "extensionUi.messageRendered",
      p: {
        entryId: "custom-renderer-1",
        render: {
          version: 1,
          collapsed: ["complete"],
          expanded: ["complete: full"],
          messageIndex: 0,
        },
      },
    });

    const count = events.filter((event) => event.e === "extensionUi.messageRendered").length;
    sessionListener?.();
    await Promise.resolve();
    expect(events.filter((event) => event.e === "extensionUi.messageRendered")).toHaveLength(count);
    binding.cleanup();
    expect(sessionListener).toBeUndefined();
  });

  it("preserves below-editor widget placement", () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    const ui = createExtensionUiContext({
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
    });

    ui.setWidget("progress", ["working"], { placement: "belowEditor" });

    expect(events.at(-1)).toEqual({
      e: "extensionUi.widgetChanged",
      p: {
        key: "progress",
        widget: ["working"],
        placement: "belowEditor",
        origin: UNKNOWN_ORIGIN,
      },
    });
  });

  it("requests attention once when an extension command writes a static widget", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    let ui: ReturnType<typeof createExtensionUiContext> | undefined;
    const session = {
      bindExtensions: async ({ uiContext }: { uiContext: typeof ui }) => {
        ui = uiContext;
      },
    };
    const binding = await bindExtensionUi(session as never, null, {
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
    });
    const publish = await binding.activate();
    publish();

    // A nano-context-style lifecycle refresh is not command-originated.
    ui!.setWidget("nano-context", ["usage"]);
    await withExtensionCommandOrigin(
      session as never,
      COMMAND_RUN_ID,
      commandInvocation("brainstorm"),
      async () => {
        ui!.setWidget("brainstorm", ["active"]);
        ui!.setWidget("brainstorm-details", ["more"]);
        ui!.setWidget("brainstorm", undefined);
      },
    );

    const attention = events.filter((event) => event.e === "extensionUi.widgetAttentionRequested");
    expect(attention).toEqual([
      {
        e: "extensionUi.widgetAttentionRequested",
        p: {
          key: "brainstorm",
          runId: COMMAND_RUN_ID,
          invocation: "brainstorm",
        },
      },
    ]);
    const brainstormWrite = events.findIndex(
      (event) =>
        event.e === "extensionUi.widgetChanged" &&
        (event.p as { key?: string }).key === "brainstorm" &&
        (event.p as { widget?: unknown }).widget !== null,
    );
    const attentionIndex = events.findIndex(
      (event) => event.e === "extensionUi.widgetAttentionRequested",
    );
    expect(attentionIndex).toBeGreaterThan(brainstormWrite);
    binding.cleanup();
  });

  it("passes commandContextActions through to bindExtensions", async () => {
    let received: { commandContextActions?: unknown } | undefined;
    const session = {
      bindExtensions: async (bindings: { commandContextActions?: unknown }) => {
        received = bindings;
      },
    };
    const commandContextActions = { marker: "host-actions" };
    const binding = await bindExtensionUi(session as never, null, {
      emit: () => undefined,
      getIdentity: () => id,
      commandContextActions: commandContextActions as never,
    });

    expect(received?.commandContextActions).toBe(commandContextActions);
    binding.cleanup();
  });

  it("surfaces extension handler errors via extensionUi.notification", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    let onError:
      ((error: { extensionPath: string; event: string; error: string }) => void) | undefined;
    const session = {
      bindExtensions: async (bindings: { onError?: typeof onError }) => {
        onError = bindings.onError;
      },
    };
    const binding = await bindExtensionUi(session as never, null, {
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
    });
    const publish = await binding.activate();
    publish();

    expect(onError).toBeTypeOf("function");
    onError!({
      extensionPath: "/packages/handoff/extensions/index.ts",
      event: "session_start",
      error: "boom",
    });

    const notification = events.find((event) => event.e === "extensionUi.notification");
    expect(notification).toBeDefined();
    expect(notification?.p).toMatchObject({ level: "error" });
    const message = (notification?.p as { message: string }).message;
    expect(message).toContain("index.ts");
    expect(message).toContain("session_start");
    expect(message).toContain("boom");
    binding.cleanup();
  });

  it("clears a prior same-key widget when a replacement factory fails", () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    const ui = createExtensionUiContext({
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
    });

    ui.setWidget("progress", ["old"]);
    ui.setWidget("progress", () => {
      throw new Error("factory failed");
    });

    const widgets = events
      .filter((event) => event.e === "extensionUi.widgetChanged")
      .map((event) => event.p);
    expect(widgets).toEqual([
      { key: "progress", widget: ["old"], origin: UNKNOWN_ORIGIN },
      { key: "progress", widget: null, origin: UNKNOWN_ORIGIN },
    ]);
    expect(
      events.some(
        (event) =>
          event.e === "package.diagnostic" &&
          String((event.p as { message?: unknown }).message).includes("factory failed"),
      ),
    ).toBe(true);
  });

  it("strips VT controls from requests, status, widget keys, and nested content", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    const ui = createExtensionUiContext({
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
    });
    const select = ui.select("\u001b]0;title\u0007Pick", ["\u001b[2Kalpha"]);
    const editor = ui.editor("\u001b[33mEdit\u001b[0m", "\u001b[1Gprefill");
    ui.setStatus("\u001b[31mstatus\u001b[0m", "\u001b]0;ignored\u0007ready");
    ui.setWidget("\u001b[35mansi\u001b[0m", {
      "\u001b]8;;https://example.com\u0007label\u001b]8;;\u0007": "\u001b[2Jwidget",
    } as never);

    const requests = events
      .filter((event) => event.e === "extensionUi.request")
      .map(
        (event) =>
          event.p as {
            title?: string;
            options?: Array<{ id: string; label: string }>;
            defaultValue?: string;
          },
      );
    expect(requests[0]?.title).toBe("Pick");
    expect(requests[0]?.options?.[0]).toEqual({ id: "alpha", label: "alpha" });
    expect(requests[1]?.title).toBe("Edit");
    expect(requests[1]?.defaultValue).toBe("prefill");
    const status = events.find((event) => event.e === "extensionUi.statusChanged")?.p as {
      key?: string;
      text?: string;
    };
    expect(status).toEqual({ key: "status", text: "ready", origin: UNKNOWN_ORIGIN });
    const widget = events.find((event) => event.e === "extensionUi.widgetChanged")?.p as {
      key?: string;
      widget?: Record<string, string>;
    };
    expect(widget.key).toBe("ansi");
    expect(widget.widget).toEqual({ label: "widget" });

    cancelAllPending("test cleanup");
    await expect(select).resolves.toBeUndefined();
    await expect(editor).resolves.toBeUndefined();
  });

  it("releases blocking candidate requests during activation and waits for bind completion", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    const session = {
      bindExtensions: async ({
        uiContext,
      }: {
        uiContext: ReturnType<typeof createExtensionUiContext>;
      }) => {
        await uiContext.input("Startup", "value");
      },
    };
    const binding = await bindExtensionUi(session as never, null, {
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
    });

    const activation = binding.activate();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const request = events.find((event) => event.e === "extensionUi.request")?.p as {
      requestId: string;
    };
    expect(request.requestId).toBeTruthy();
    respondExtensionUi(request.requestId, "resolved", "ok", id);
    const publish = await activation;
    expect(publish).toBeTypeOf("function");
    publish();
    binding.cleanup();
  });

  it("publishes candidate abort closure before the binding is ready", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    const controller = new AbortController();
    const session = {
      bindExtensions: async ({
        uiContext,
      }: {
        uiContext: ReturnType<typeof createExtensionUiContext>;
      }) => {
        await uiContext.input("Startup", "value", { signal: controller.signal });
      },
    };
    const binding = await bindExtensionUi(session as never, null, {
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
    });

    const activation = binding.activate();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const request = events.find((event) => event.e === "extensionUi.request")?.p as {
      requestId: string;
    };
    controller.abort();
    const publish = await activation;

    expect(events).toEqual([
      { e: "extensionUi.request", p: expect.objectContaining({ requestId: request.requestId }) },
      {
        e: "extensionUi.closed",
        p: { requestId: request.requestId, reason: "aborted" },
      },
    ]);
    publish();
    binding.cleanup();
  });

  it("publishes disposal closure before disabling the binding emitter", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    let ui: ReturnType<typeof createExtensionUiContext> | undefined;
    const session = {
      bindExtensions: async ({ uiContext }: { uiContext: typeof ui }) => {
        ui = uiContext;
      },
    };
    const binding = await bindExtensionUi(session as never, null, {
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
    });
    const publish = await binding.activate();
    publish();
    const pendingInput = ui!.input("Dispose", "value");
    await Promise.resolve();
    const request = events.find((event) => event.e === "extensionUi.request")?.p as {
      requestId: string;
    };
    expect(request.requestId).toBeTruthy();

    binding.cleanup();

    await expect(pendingInput).resolves.toBeUndefined();
    expect(events.filter((event) => event.e === "extensionUi.closed")).toEqual([
      {
        e: "extensionUi.closed",
        p: { requestId: request.requestId, reason: "disposed" },
      },
    ]);
    binding.cleanup();
    expect(events.filter((event) => event.e === "extensionUi.closed")).toHaveLength(1);
  });

  it("propagates bind failure from activation", async () => {
    const session = {
      bindExtensions: async () => {
        throw new Error("bind failed");
      },
    };
    const binding = await bindExtensionUi(session as never, null, {
      emit: () => {},
      getIdentity: () => id,
    });

    await expect(binding.activate()).rejects.toThrow("bind failed");
    binding.cleanup();
  });

  it("handles bind failure before delayed activation", async () => {
    let rejectBind!: (reason: unknown) => void;
    const bindReady = new Promise<void>((_resolve, reject) => {
      rejectBind = reject;
    });
    const session = {
      bindExtensions: () => bindReady,
    };
    const binding = await bindExtensionUi(session as never, null, {
      emit: () => {},
      getIdentity: () => id,
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      const failure = new Error("bind failed before activation");
      rejectBind(failure);
      await new Promise((resolve) => setTimeout(resolve, 0));

      await expect(binding.activate()).rejects.toBe(failure);
      expect(unhandled).not.toContain(failure);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      binding.cleanup();
    }
  });

  it("buffers non-blocking events until the candidate generation is published", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    const session = {
      bindExtensions: async ({
        uiContext,
      }: {
        uiContext: ReturnType<typeof createExtensionUiContext>;
      }) => {
        uiContext.setStatus("startup", "loading");
        uiContext.setWidget("startup", ["loading"]);
        uiContext.setWidget("startup", ["ready"]);
        uiContext.notify("candidate ready", "info");
      },
    };

    const binding = await bindExtensionUi(session as never, null, {
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
    });

    expect(events).toEqual([]);
    const publish = await binding.activate();
    expect(events).toEqual([]);
    publish();
    expect(events.map((event) => event.e)).toEqual([
      "extensionUi.statusChanged",
      "extensionUi.widgetChanged",
      "extensionUi.notification",
    ]);
    expect(events[1]?.p).toEqual({
      key: "startup",
      widget: ["ready"],
      origin: UNKNOWN_ORIGIN,
    });
    publish();
    expect(events).toHaveLength(3);
    binding.cleanup();
  });

  it("replays the latest widget and status state after identity promotion", async () => {
    const promoted = { ...id, sessionRevision: id.sessionRevision + 1 };
    const events: Array<{ identity: HostIdentity; e: HostEventName; p: unknown }> = [];
    let ui: ReturnType<typeof createExtensionUiContext> | undefined;
    const session = {
      bindExtensions: async ({ uiContext }: { uiContext: typeof ui }) => {
        ui = uiContext;
      },
    };
    const binding = await bindExtensionUi(session as never, null, {
      emit: () => {},
      emitForIdentity: (identity, e, p) => events.push({ identity, e, p }),
      getIdentity: () => id,
    });
    const publish = await binding.activate();
    publish();

    ui!.setWidget("todos", ["first"]);
    ui!.setWidget("todos", ["latest"], { placement: "belowEditor" });
    ui!.setWidget("removed", ["old"]);
    ui!.setWidget("removed", undefined);
    ui!.setStatus("todo-status", "running");
    ui!.setStatus("cleared-status", "old");
    ui!.setStatus("cleared-status", undefined);
    ui!.notify("do not replay", "info");

    events.length = 0;
    binding.updateIdentity(promoted);
    binding.replayState();

    expect(events).toEqual([
      {
        identity: promoted,
        e: "extensionUi.widgetChanged",
        p: {
          key: "todos",
          widget: ["latest"],
          placement: "belowEditor",
          origin: UNKNOWN_ORIGIN,
        },
      },
      {
        identity: promoted,
        e: "extensionUi.statusChanged",
        p: { key: "todo-status", text: "running", origin: UNKNOWN_ORIGIN },
      },
    ]);
    binding.cleanup();
  });

  it("migrates pending requests and future events to a promoted Session identity", async () => {
    const promoted = { ...id, sessionRevision: id.sessionRevision + 1 };
    const events: Array<{ identity: HostIdentity; e: HostEventName; p: unknown }> = [];
    let ui: ReturnType<typeof createExtensionUiContext> | undefined;
    const session = {
      bindExtensions: async ({ uiContext }: { uiContext: typeof ui }) => {
        ui = uiContext;
      },
    };
    const binding = await bindExtensionUi(session as never, null, {
      emit: () => {},
      emitForIdentity: (identity, e, p) => events.push({ identity, e, p }),
      getIdentity: () => id,
    });
    const publish = await binding.activate();
    publish();

    const pendingInput = ui!.input("Promote", "value");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const request = events.find((event) => event.e === "extensionUi.request")?.p as {
      requestId: string;
    };
    binding.updateIdentity(promoted);
    ui!.notify("promoted", "info");

    expect(events.at(-1)?.identity.sessionRevision).toBe(promoted.sessionRevision);
    expect(respondExtensionUi(request.requestId, "resolved", "stale", id)).toBe(false);
    expect(respondExtensionUi(request.requestId, "resolved", "done", promoted)).toBe(true);
    await expect(pendingInput).resolves.toBe("done");
    binding.cleanup();
  });

  it("migrates custom panel ownership to a promoted Session identity", async () => {
    const promoted = { ...id, sessionRevision: id.sessionRevision + 1 };
    const events: Array<{ identity: HostIdentity; e: HostEventName; p: unknown }> = [];
    const received: string[] = [];
    let ui: ReturnType<typeof createExtensionUiContext> | undefined;
    const session = {
      bindExtensions: async ({ uiContext }: { uiContext: typeof ui }) => {
        ui = uiContext;
      },
    };
    const binding = await bindExtensionUi(session as never, null, {
      emit: () => {},
      emitForIdentity: (identity, e, p) => events.push({ identity, e, p }),
      getIdentity: () => id,
    });
    const publish = await binding.activate();
    publish();

    const panel = ui!.custom<string>((_tui, _theme, _keybindings, done) => ({
      render: () => ["waiting"],
      invalidate: () => {},
      handleInput: (data: string) => {
        received.push(data);
        done(data);
      },
    }));
    await Promise.resolve();
    const started = events.find((event) => event.e === "extensionUi.customStarted")?.p as {
      requestId: string;
    };
    const { handlers } = extensionUiHandlers();

    binding.updateIdentity(promoted);
    const staleResize = await handlers["extensionUi.customResize"]!({
      id: "stale-resize-after-promotion",
      context: targetContext(id),
      params: { requestId: started.requestId, cols: 100, rows: 30 },
    } as never);
    const staleInput = await handlers["extensionUi.customInput"]!({
      id: "stale-input-after-promotion",
      context: targetContext(id),
      params: { requestId: started.requestId, data: "stale" },
    } as never);
    expect("error" in staleResize && staleResize.error.code).toBe("STALE_REVISION");
    expect("error" in staleInput && staleInput.error.code).toBe("STALE_REVISION");
    expect(received).toEqual([]);

    const promotedResize = await handlers["extensionUi.customResize"]!({
      id: "promoted-resize",
      context: targetContext(promoted),
      params: { requestId: started.requestId, cols: 120, rows: 40 },
    } as never);
    const promotedInput = await handlers["extensionUi.customInput"]!({
      id: "promoted-input",
      context: targetContext(promoted),
      params: { requestId: started.requestId, data: "accepted" },
    } as never);
    expect("error" in promotedResize).toBe(false);
    expect("error" in promotedInput).toBe(false);
    await expect(panel).resolves.toBe("accepted");
    binding.cleanup();
  });

  it("custom() drives a TUI over a virtual terminal: started → frames → done → closed", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    const ui = createExtensionUiContext({
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
    });
    let doneFn: ((result: string) => void) | undefined;
    const received: string[] = [];
    const panel = ui.custom<string>((tui, theme, keybindings, done) => {
      expect(theme).toBeTruthy();
      expect(keybindings.matches("\r", "tui.select.confirm")).toBe(true);
      expect(keybindings.matches("\x1b", "app.interrupt")).toBe(true);
      doneFn = done;
      return {
        render: () => ["hello panel"],
        invalidate: () => {},
        handleInput: (data: string) => {
          received.push(data);
          done(`picked:${data}`);
        },
      };
    });

    const started = events.find((x) => x.e === "extensionUi.customStarted")?.p as {
      requestId: string;
      cols: number;
      rows: number;
    };
    expect(started).toBeTruthy();
    expect(started.cols).toBe(100);
    expect(started.rows).toBe(32);
    expect(doneFn).toBeTypeOf("function"); // factory invoked synchronously, like the CLI

    // Wait past the frame flush interval for the first differential render.
    await new Promise((resolve) => setTimeout(resolve, 80));
    const frames = events
      .filter((x) => x.e === "extensionUi.customFrame")
      .map((x) => (x.p as { requestId: string; data: string }).data)
      .join("");
    expect(frames).toContain("hello panel");
    expect(
      events
        .filter((x) => x.e === "extensionUi.customFrame")
        .every((x) => (x.p as { requestId: string }).requestId === started.requestId),
    ).toBe(true);

    // Input injected through the handler path reaches the focused component.
    const okInput = injectExtensionCustomInput(started.requestId, "\r", id);
    expect(okInput).toBe(true);
    expect(received).toEqual(["\r"]);
    await expect(panel).resolves.toBe("picked:\r");
    expect(events.some((x) => x.e === "extensionUi.customClosed")).toBe(true);

    // Panel is gone — further input is rejected.
    expect(injectExtensionCustomInput(started.requestId, "x", id)).toBe(false);
  });

  it("rejects custom input and resize from a different target Session", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    const received: string[] = [];
    const ui = createExtensionUiContext({
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
    });
    const panel = ui.custom((_tui, _theme, _keybindings, done) => ({
      render: () => ["waiting"],
      invalidate: () => {},
      handleInput: (data: string) => {
        received.push(data);
        done(undefined);
      },
    }));
    await Promise.resolve();
    const started = events.find((event) => event.e === "extensionUi.customStarted")?.p as {
      requestId: string;
    };
    const { handlers } = extensionUiHandlers();
    const wrongIdentity = {
      ...targetContext(),
      expectedSessionId: NEXT_COMMAND_RUN_ID,
      expectedSessionRevision: 9,
    };

    const inputRejected = await handlers["extensionUi.customInput"]!({
      id: "wrong-input",
      context: wrongIdentity,
      params: { requestId: started.requestId, data: "wrong" },
    } as never);
    const resizeRejected = await handlers["extensionUi.customResize"]!({
      id: "wrong-resize",
      context: wrongIdentity,
      params: { requestId: started.requestId, cols: 120, rows: 40 },
    } as never);
    expect("error" in inputRejected && inputRejected.error.code).toBe("STALE_REVISION");
    expect("error" in resizeRejected && resizeRejected.error.code).toBe("STALE_REVISION");
    expect(received).toEqual([]);

    const inputAccepted = await handlers["extensionUi.customInput"]!({
      id: "correct-input",
      context: targetContext(),
      params: { requestId: started.requestId, data: "correct" },
    } as never);
    expect("error" in inputAccepted).toBe(false);
    expect(received).toEqual(["correct"]);
    await expect(panel).resolves.toBeUndefined();
  });

  it("custom() cancels via identity cleanup and emits customClosed", async () => {
    const cancelId: HostIdentity = { ...id, sessionId: "s-cancel" };
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    const ui = createExtensionUiContext({
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => cancelId,
    });
    const panel = ui.custom(() => ({
      render: () => ["waiting"],
      invalidate: () => {},
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    cancelPendingForIdentity(cancelId);
    await expect(panel).resolves.toBeUndefined();
    expect(events.some((x) => x.e === "extensionUi.customClosed")).toBe(true);
  });

  it("custom() cancels via protocol response without terminal input", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    const ui = createExtensionUiContext({
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
    });
    const panel = ui.custom(() => ({
      render: () => ["waiting"],
      invalidate: () => {},
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const started = events.find((x) => x.e === "extensionUi.customStarted")?.p as {
      requestId: string;
    };

    expect(respondExtensionUi(started.requestId, "cancelled", undefined, id)).toBe(true);
    await expect(panel).resolves.toBeUndefined();
    expect(events.some((x) => x.e === "extensionUi.customClosed")).toBe(true);
  });

  it("custom input runs extension-owned close callbacks", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    const ui = createExtensionUiContext({
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
    });
    const extensionFlow = new Promise<void>((resolve) => {
      void ui.custom((_tui, _theme, _keybindings, done) => ({
        render: () => ["waiting"],
        invalidate: () => {},
        handleInput: (data: string) => {
          if (data !== "\u0003") return;
          done(undefined);
          resolve();
        },
      }));
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const started = events.find((x) => x.e === "extensionUi.customStarted")?.p as {
      requestId: string;
    };

    expect(injectExtensionCustomInput(started.requestId, "\u0003", id)).toBe(true);
    await expect(extensionFlow).resolves.toBeUndefined();
    expect(events.some((x) => x.e === "extensionUi.customClosed")).toBe(true);
  });

  it("custom() rejects and notifies when the factory throws", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    const ui = createExtensionUiContext({
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
    });
    const panel = ui.custom(() => {
      throw new Error("factory boom");
    });
    await expect(panel).rejects.toThrow("factory boom");
    expect(events.some((x) => x.e === "extensionUi.customClosed")).toBe(true);
    const notification = events.find((x) => x.e === "extensionUi.notification")?.p as {
      message: string;
      level: string;
    };
    expect(notification.level).toBe("error");
    expect(notification.message).toContain("factory boom");
  });

  it("setWidget factory publishes live snapshots and disposes when cleared", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    const ui = createExtensionUiContext({
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
    });
    let text = "line one";
    let requestRender: (() => void) | undefined;
    let disposed = false;
    ui.setWidget("tasks", (tui) => {
      requestRender = () => tui.requestRender();
      return {
        render: () => [`\x1b[32m${text}\x1b[0m`, "line two"],
        invalidate: () => {},
        dispose: () => {
          disposed = true;
        },
      };
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    let widget = events.filter((x) => x.e === "extensionUi.widgetChanged").at(-1)?.p as {
      key: string;
      widget: string[];
    };
    expect(widget.key).toBe("tasks");
    expect(widget.widget).toEqual(["line one", "line two"]);

    text = "updated";
    requestRender?.();
    requestRender?.();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const updates = events.filter((x) => x.e === "extensionUi.widgetChanged");
    expect(updates).toHaveLength(2);
    expect(updates[0]?.p).toEqual({
      key: "tasks",
      widget: ["line one", "line two"],
      origin: UNKNOWN_ORIGIN,
    });
    widget = updates.at(-1)?.p as { key: string; widget: string[] };
    expect(widget.widget).toEqual(["updated", "line two"]);

    ui.setWidget("tasks", ["static replacement"]);
    expect(disposed).toBe(true);
    expect(events.at(-1)).toEqual({
      e: "extensionUi.widgetChanged",
      p: { key: "tasks", widget: ["static replacement"], origin: UNKNOWN_ORIGIN },
    });

    requestRender?.();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(events.filter((x) => x.e === "extensionUi.widgetChanged")).toHaveLength(3);

    ui.setWidget("tasks", undefined);
    expect(events.at(-1)).toEqual({
      e: "extensionUi.widgetChanged",
      p: { key: "tasks", widget: null, origin: UNKNOWN_ORIGIN },
    });
    expect(events.filter((x) => x.e === "extensionUi.widgetChanged")).toHaveLength(4);
  });

  it("replaces a live widget factory without a transient clear", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    const ui = createExtensionUiContext({
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
    });
    let disposed = false;

    ui.setWidget("nano-context", () => ({
      render: () => ["old context"],
      invalidate: () => {},
      dispose: () => {
        disposed = true;
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 30));

    ui.setWidget("nano-context", () => ({
      render: () => ["new context"],
      invalidate: () => {},
    }));
    expect(disposed).toBe(true);
    expect(events.filter((event) => event.e === "extensionUi.widgetChanged")).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(
      events.filter((event) => event.e === "extensionUi.widgetChanged").map((event) => event.p),
    ).toEqual([
      { key: "nano-context", widget: ["old context"], origin: UNKNOWN_ORIGIN },
      { key: "nano-context", widget: ["new context"], origin: UNKNOWN_ORIGIN },
    ]);
  });

  it("clears a prior widget when a replacement factory first render fails", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    const ui = createExtensionUiContext({
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
    });

    ui.setWidget("progress", ["old"]);
    ui.setWidget("progress", () => ({
      render: () => {
        throw new Error("render failed");
      },
      invalidate: () => {},
    }));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(
      events.filter((event) => event.e === "extensionUi.widgetChanged").map((event) => event.p),
    ).toEqual([
      { key: "progress", widget: ["old"], origin: UNKNOWN_ORIGIN },
      { key: "progress", widget: null, origin: UNKNOWN_ORIGIN },
    ]);
  });

  it("captures command origin until a widget factory first renders successfully", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    let ui: ReturnType<typeof createExtensionUiContext> | undefined;
    const session = {
      bindExtensions: async ({ uiContext }: { uiContext: typeof ui }) => {
        ui = uiContext;
      },
    };
    const binding = await bindExtensionUi(session as never, null, {
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
    });
    const publish = await binding.activate();
    publish();

    let failRender = true;
    let text = "ready";
    let requestRender: (() => void) | undefined;
    await withExtensionCommandOrigin(
      session as never,
      COMMAND_RUN_ID,
      commandInvocation("brainstorm"),
      async () => {
        ui!.setWidget("brainstorm-live", (tui) => {
          requestRender = () => tui.requestRender();
          return {
            render: () => {
              if (failRender) throw new Error("not ready");
              return [text];
            },
            invalidate: () => {},
          };
        });
        await new Promise((resolve) => setTimeout(resolve, 30));
      },
    );
    expect(
      events.filter((event) => event.e === "extensionUi.widgetAttentionRequested"),
    ).toHaveLength(0);

    failRender = false;
    requestRender?.();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(events.filter((event) => event.e === "extensionUi.widgetAttentionRequested")).toEqual([
      {
        e: "extensionUi.widgetAttentionRequested",
        p: {
          key: "brainstorm-live",
          runId: COMMAND_RUN_ID,
          invocation: "brainstorm",
        },
      },
    ]);

    text = "refreshed";
    requestRender?.();
    requestRender?.();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(
      events.filter((event) => event.e === "extensionUi.widgetAttentionRequested"),
    ).toHaveLength(1);
    binding.cleanup();
  });

  it("attributes an existing live widget redraw to the command that requested it", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    let ui: ReturnType<typeof createExtensionUiContext> | undefined;
    const session = {
      bindExtensions: async ({ uiContext }: { uiContext: typeof ui }) => {
        ui = uiContext;
      },
    };
    const binding = await bindExtensionUi(session as never, null, {
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
    });
    const publish = await binding.activate();
    publish();

    let text = "idle";
    let requestRender: (() => void) | undefined;
    ui!.setWidget("existing-live", (tui) => {
      requestRender = () => tui.requestRender();
      return {
        render: () => [text],
        invalidate: () => {},
      };
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(
      events.filter((event) => event.e === "extensionUi.widgetAttentionRequested"),
    ).toHaveLength(0);

    await withExtensionCommandOrigin(
      session as never,
      COMMAND_RUN_ID,
      commandInvocation("brainstorm"),
      async () => {
        text = "command update";
        requestRender?.();
        await new Promise((resolve) => setTimeout(resolve, 30));

        text = "same command update";
        requestRender?.();
        await new Promise((resolve) => setTimeout(resolve, 30));
      },
    );
    expect(events.filter((event) => event.e === "extensionUi.widgetAttentionRequested")).toEqual([
      {
        e: "extensionUi.widgetAttentionRequested",
        p: {
          key: "existing-live",
          runId: COMMAND_RUN_ID,
          invocation: "brainstorm",
        },
      },
    ]);

    await withExtensionCommandOrigin(
      session as never,
      NEXT_COMMAND_RUN_ID,
      commandInvocation("brainstorm"),
      async () => {
        text = "next command update";
        requestRender?.();
        await new Promise((resolve) => setTimeout(resolve, 30));
      },
    );
    expect(events.filter((event) => event.e === "extensionUi.widgetAttentionRequested")).toEqual([
      {
        e: "extensionUi.widgetAttentionRequested",
        p: {
          key: "existing-live",
          runId: COMMAND_RUN_ID,
          invocation: "brainstorm",
        },
      },
      {
        e: "extensionUi.widgetAttentionRequested",
        p: {
          key: "existing-live",
          runId: NEXT_COMMAND_RUN_ID,
          invocation: "brainstorm",
        },
      },
    ]);

    text = "background refresh";
    requestRender?.();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(
      events.filter((event) => event.e === "extensionUi.widgetAttentionRequested"),
    ).toHaveLength(2);
    binding.cleanup();
  });

  it("binding cleanup disposes live setWidget factories", async () => {
    let disposed = false;
    const session = {
      bindExtensions: async ({
        uiContext,
      }: {
        uiContext: ReturnType<typeof createExtensionUiContext>;
      }) => {
        uiContext.setWidget("live", () => ({
          render: () => ["live"],
          invalidate: () => {},
          dispose: () => {
            disposed = true;
          },
        }));
      },
    };
    const binding = await bindExtensionUi(session as never, null, {
      emit: () => {},
      getIdentity: () => id,
    });
    const publish = await binding.activate();
    publish();
    binding.cleanup();
    expect(disposed).toBe(true);
  });
});

describe("Extension Deck origin capture", () => {
  const trustedToolOrigin = {
    invocationKind: "tool" as const,
    extensionId: "ext_review",
    extensionDisplayName: "Review",
    sourceKind: "package" as const,
    toolName: "ask",
    toolCallId: "call-1",
  };
  const trustedPackageOrigin = {
    invocationKind: "background" as const,
    extensionId: "ext_pkg",
    extensionDisplayName: "Package",
    sourceKind: "package" as const,
  };

  it("attaches active invocation origin to widget, status, and custom start", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    const ui = createExtensionUiContext({
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
      getActiveInvocation: () =>
        ({
          origin: trustedToolOrigin,
          active: true,
        }) as never,
    });
    ui.setWidget("fleet", ["rows"]);
    ui.setStatus("slash", "ready");
    const started = ui.custom(() => ({ render: () => [], invalidate: () => {} }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      events.filter((event) => event.e === "extensionUi.widgetChanged").at(-1)?.p,
    ).toMatchObject({ origin: trustedToolOrigin });
    expect(
      events.filter((event) => event.e === "extensionUi.statusChanged").at(-1)?.p,
    ).toMatchObject({ origin: trustedToolOrigin });
    expect(
      events.filter((event) => event.e === "extensionUi.customStarted").at(-1)?.p,
    ).toMatchObject({ origin: trustedToolOrigin });
    const request = events.find((event) => event.e === "extensionUi.customStarted")?.p as {
      requestId: string;
    };
    respondExtensionUi(request.requestId, "cancelled", undefined, id);
    await started;
  });

  it("uses trusted package fallback and unknown fallback without guessing", () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    const withPackage = createExtensionUiContext({
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
      getTrustedPackageOrigin: () => trustedPackageOrigin,
    });
    withPackage.setWidget("fleet", ["rows"]);
    expect(events.at(-1)?.p).toMatchObject({ origin: trustedPackageOrigin });

    const unknownEvents: Array<{ e: HostEventName; p: unknown }> = [];
    const unknown = createExtensionUiContext({
      emit: (e, p) => unknownEvents.push({ e, p }),
      getIdentity: () => id,
    });
    unknown.setWidget("guessed-from-key", ["rows"]);
    expect(unknownEvents.at(-1)?.p).toMatchObject({ origin: UNKNOWN_ORIGIN });
  });

  it("replays and clears widgets with the origin captured at mutation time", async () => {
    const events: Array<{ identity: HostIdentity; e: HostEventName; p: unknown }> = [];
    let ui: ReturnType<typeof createExtensionUiContext> | undefined;
    const session = {
      bindExtensions: async ({ uiContext }: { uiContext: typeof ui }) => {
        ui = uiContext;
      },
    };
    const binding = await bindExtensionUi(session as never, null, {
      emit: () => {},
      emitForIdentity: (identity, e, p) => events.push({ identity, e, p }),
      getIdentity: () => id,
      getActiveInvocation: () =>
        ({
          origin: trustedToolOrigin,
          active: true,
        }) as never,
    });
    const publish = await binding.activate();
    publish();
    ui!.setWidget("fleet", ["live"]);
    ui!.setStatus("slash", "ready");
    events.length = 0;
    binding.replayState();
    expect(events.map((event) => event.p)).toEqual([
      { key: "fleet", widget: ["live"], origin: trustedToolOrigin },
      { key: "slash", text: "ready", origin: trustedToolOrigin },
    ]);

    ui!.setWidget("fleet", undefined);
    ui!.setStatus("slash", undefined);
    expect(
      events.filter((event) => event.e === "extensionUi.widgetChanged").at(-1)?.p,
    ).toMatchObject({ key: "fleet", widget: null, origin: trustedToolOrigin });
    expect(
      events.filter((event) => event.e === "extensionUi.statusChanged").at(-1)?.p,
    ).toMatchObject({ key: "slash", text: "", origin: trustedToolOrigin });
    binding.cleanup();
  });

  it("does not read a later active invocation during deferred factory render", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    let currentOrigin: unknown = trustedPackageOrigin;
    const ui = createExtensionUiContext({
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
      getActiveInvocation: () =>
        currentOrigin
          ? ({
              origin: currentOrigin,
              active: true,
            } as never)
          : undefined,
    });
    let requestRender: (() => void) | undefined;
    ui.setWidget("fleet", (tui) => {
      requestRender = () => tui.requestRender();
      return {
        render: () => ["one"],
        invalidate: () => {},
      };
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    currentOrigin = trustedToolOrigin;
    requestRender?.();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const payloads = events
      .filter((event) => event.e === "extensionUi.widgetChanged")
      .map((event) => event.p);
    expect(
      payloads.every(
        (payload) =>
          (payload as { origin?: { extensionId?: string } }).origin?.extensionId === "ext_pkg",
      ),
    ).toBe(true);
  });

  it("copies custom overlay true and false onto customStarted", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    const ui = createExtensionUiContext({
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
    });
    const overlayTrue = ui.custom(() => ({ render: () => [], invalidate: () => {} }), {
      overlay: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const first = events.find((event) => event.e === "extensionUi.customStarted")?.p as {
      requestId: string;
      overlay?: boolean;
    };
    expect(first.overlay).toBe(true);
    respondExtensionUi(first.requestId, "cancelled", undefined, id);
    await overlayTrue;

    events.length = 0;
    const overlayFalse = ui.custom(() => ({ render: () => [], invalidate: () => {} }), {
      overlay: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = events.find((event) => event.e === "extensionUi.customStarted")?.p as {
      requestId: string;
      overlay?: boolean;
    };
    expect(second.overlay).toBe(false);
    respondExtensionUi(second.requestId, "cancelled", undefined, id);
    await overlayFalse;
  });
});
