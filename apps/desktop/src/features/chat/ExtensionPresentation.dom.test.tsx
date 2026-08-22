/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_EXTENSION_UI_SETTINGS,
  type HostStatusSnapshot,
  type SessionSnapshot,
  type WorkspaceSnapshot,
} from "@pideck/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore } from "../../lib/stores/app-store";
import type { ExtensionUiRequestState } from "../../lib/stores/extension-ui-state";
import { AssistantOrderedContent, ExtensionMessageRow } from "./Transcript";
import { Composer } from "./Composer";
import { ExtensionUiModal } from "./ExtensionUiModal";
import { InlineExtensionUiRequest } from "./InlineExtensionUiRequest";
import type { TranscriptRow } from "./transcript-model";

const CONTEXT = {
  expectedHostInstanceId: "11111111-1111-4111-8111-111111111111",
  expectedWorkspaceId: "22222222-2222-4222-8222-222222222222",
  expectedWorkspaceRevision: 1,
  expectedSessionId: "33333333-3333-4333-8333-333333333333",
  expectedSessionRevision: 1,
};

function hostSnapshot(): HostStatusSnapshot {
  return {
    protocolVersion: 1,
    hostInstanceId: CONTEXT.expectedHostInstanceId,
    workspaceId: CONTEXT.expectedWorkspaceId,
    workspaceRevision: CONTEXT.expectedWorkspaceRevision,
    sessionId: CONTEXT.expectedSessionId,
    sessionRevision: CONTEXT.expectedSessionRevision,
    packageRevision: 0,
    sdkVersion: "0.84.2",
    nodeVersion: process.version,
    agentDir: "/agent",
    phase: "ready",
    capabilities: {
      packageUpdateCheck: true,
      extensionUi: true,
      sessionExport: true,
    },
    modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
  };
}

function workspaceSnapshot(): WorkspaceSnapshot {
  return {
    id: CONTEXT.expectedWorkspaceId,
    cwd: "/workspace",
    canonicalCwd: "/workspace",
    revision: CONTEXT.expectedWorkspaceRevision,
    servicesReady: true,
  };
}

function sessionSnapshot(): SessionSnapshot {
  return {
    sessionId: CONTEXT.expectedSessionId,
    cwd: "/workspace",
    revision: CONTEXT.expectedSessionRevision,
    isStreaming: false,
    isIdle: true,
    isCompacting: false,
    isRetrying: false,
    thinkingLevel: "off",
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    steeringMode: "all",
    followUpMode: "all",
    pending: { revision: 0, steering: [], followUp: [] },
    messages: [{ role: "user", content: "Existing conversation" }],
    tools: {
      revision: 1,
      workspaceId: CONTEXT.expectedWorkspaceId,
      sessionId: CONTEXT.expectedSessionId,
      sessionRevision: CONTEXT.expectedSessionRevision,
      tools: [],
      active: [],
    },
  };
}

let requestSequence = 0;

function setLanguage(language: "en" | "zh") {
  useAppStore.getState().setDesktopSettings({
    theme: "system",
    language,
    restoreLastSession: true,
    autoRestartHostOnce: true,
    extensionDecisionPresentation: "legacy-modal",
    terminalProfile: "auto",
  });
}

function extensionRequest(
  overrides: Partial<ExtensionUiRequestState> = {},
): ExtensionUiRequestState {
  requestSequence += 1;
  return {
    requestId: `44444444-4444-4444-8444-${String(requestSequence).padStart(12, "0")}`,
    kind: "confirm",
    title: "Choose how to continue",
    context: CONTEXT,
    ...overrides,
  };
}

function renderRequestSurfaces() {
  return render(
    <>
      <InlineExtensionUiRequest />
      <ExtensionUiModal />
    </>,
  );
}

describe("Extension presentation surfaces", () => {
  beforeEach(() => {
    requestSequence = 0;
    setLanguage("en");
    useAppStore.setState({
      host: null,
      workspace: null,
      session: null,
      draftTexts: {},
      draftTargets: {},
      draftEditVersions: {},
      draftHydratedWorkspace: null,
      extensionUiRequest: null,
      extensionUiQueue: [],
      extensionDecisionGroups: {},
      notifications: [],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    cleanup();
    useAppStore.getState().setDesktopSettings(null);
  });

  it("opens raw agent protocol from the Agent coordination title row", async () => {
    const user = userEvent.setup();
    const rawProtocol = "Reply with: internal_tool({ action: 'respond' })";
    const row: TranscriptRow = {
      key: "custom:1",
      role: "custom",
      blocks: [{ kind: "text", text: rawProtocol }],
      copyText: rawProtocol,
      customType: "subagent_supervisor_request",
      details: { id: "request-1" },
      extensionPresentation: {
        version: 1,
        extensionId: "pi-subagents",
        sourceLabel: "Subagents",
        audience: "agent",
        kind: "activity",
        correlationId: "request-1",
      },
    };

    render(<ExtensionMessageRow row={row} />);

    const disclosure = screen.getByRole("button", { name: /Agent coordination/ });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Technical details")).not.toBeInTheDocument();
    expect(screen.queryByText(rawProtocol)).not.toBeInTheDocument();
    await user.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(rawProtocol)).toBeVisible();
  });

  it("collects Extension activity inside the execution checklist", async () => {
    const user = userEvent.setup();
    const row: TranscriptRow = {
      key: "custom:trace",
      role: "custom",
      blocks: [{ kind: "text", text: "Internal extension payload" }],
      copyText: "Internal extension payload",
      customType: "subagent_supervisor_request",
      extensionPresentation: {
        version: 1,
        extensionId: "pi-subagents",
        sourceLabel: "Subagents",
        audience: "agent",
        kind: "activity",
        correlationId: "trace-request",
      },
    };

    render(
      <AssistantOrderedContent
        blocks={[
          { kind: "tool", tool: { id: "read-1", name: "read", status: "done" } },
          { kind: "extension", row },
        ]}
        mode="static"
        showCaret={false}
        turnActive={false}
      />,
    );

    const trace = screen.getByRole("button", { name: "2 actions completed" });
    expect(screen.queryByRole("button", { name: /Agent coordination/ })).not.toBeInTheDocument();
    await user.click(trace);
    expect(screen.getByRole("button", { name: /Agent coordination/ })).toBeVisible();
  });

  it("localizes the nested checklist and keeps agent diagnostics behind the second disclosure", async () => {
    setLanguage("zh");
    const user = userEvent.setup();
    const rawProtocol = "Reply with the internal result";
    const agentRow: TranscriptRow = {
      key: "custom:agent-failure",
      role: "custom",
      blocks: [{ kind: "text", text: rawProtocol }],
      copyText: rawProtocol,
      customType: "subagent_supervisor_request",
      details: { id: "request-failed" },
      extensionPresentation: {
        version: 1,
        extensionId: "pi-subagents",
        sourceLabel: "Subagents",
        audience: "agent",
        kind: "activity",
        correlationId: "request-failed",
        status: "failed",
      },
    };
    const fallbackRow: TranscriptRow = {
      key: "custom:unknown-extension",
      role: "custom",
      blocks: [{ kind: "text", text: "Unknown extension payload" }],
      copyText: "Unknown extension payload",
      customType: "unknown-extension",
    };

    render(
      <AssistantOrderedContent
        blocks={[
          { kind: "extension", row: agentRow },
          { kind: "extension", row: fallbackRow },
        ]}
        mode="static"
        showCaret={false}
        turnActive={false}
      />,
    );

    const trace = screen.getByRole("button", { name: "已完成 2 个操作，1 个失败" });
    expect(screen.queryByRole("button", { name: /Agent 协作/ })).not.toBeInTheDocument();
    trace.focus();
    await user.keyboard("{Enter}");

    const agentDisclosure = screen.getByRole("button", { name: /Agent 协作/ });
    expect(screen.getByRole("button", { name: "扩展消息" })).toBeVisible();
    expect(screen.queryByText("Subagents")).not.toBeInTheDocument();
    expect(screen.queryByText(rawProtocol)).not.toBeInTheDocument();

    await user.click(agentDisclosure);

    expect(agentDisclosure).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("原始消息")).toBeVisible();
    expect(screen.getByText("元数据")).toBeVisible();
    expect(screen.getByText(rawProtocol)).toBeVisible();
  });

  it("renders exactly one surface and keeps legacy requests modal", async () => {
    act(() => {
      useAppStore.getState().setExtensionUiRequest(extensionRequest({ presentation: "inline" }));
    });
    renderRequestSurfaces();

    expect(screen.getByRole("region", { name: "Choose how to continue" })).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    act(() => {
      useAppStore.setState({
        extensionUiRequest: extensionRequest({ title: "Legacy modal request" }),
        extensionUiQueue: [],
      });
    });

    expect(await screen.findByRole("dialog", { name: "Legacy modal request" })).toBeVisible();
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  it("prefers Host-trusted Extension origin over an untrusted source hint", () => {
    act(() => {
      useAppStore.getState().setExtensionUiRequest(
        extensionRequest({
          sourceLabel: "Untrusted label",
          origin: {
            invocationKind: "tool",
            extensionId: "ext_0123456789abcdef01234567",
            extensionDisplayName: "Trusted review",
            sourceKind: "package",
            toolName: "review_changes",
            toolCallId: "tool-call-1",
          },
        }),
      );
    });
    renderRequestSurfaces();

    expect(screen.getByText("Trusted review")).toHaveAttribute(
      "title",
      "Trusted review · review_changes",
    );
    expect(screen.queryByText("Untrusted label")).not.toBeInTheDocument();
  });

  it("shows a local failure and lets the same action retry", async () => {
    const hostRequest = vi
      .spyOn(hostClient, "request")
      .mockResolvedValueOnce({
        ok: false,
        error: { message: "Host temporarily unavailable" },
      } as never)
      .mockResolvedValueOnce({ ok: true, result: null } as never);
    act(() => {
      useAppStore.getState().setExtensionUiRequest(extensionRequest({ presentation: "inline" }));
    });
    const user = userEvent.setup();
    renderRequestSurfaces();

    await user.click(screen.getByRole("button", { name: "Confirm" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Host temporarily unavailable");
    expect(useAppStore.getState().extensionUiRequest).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(screen.queryByRole("region")).not.toBeInTheDocument());
    expect(hostRequest).toHaveBeenCalledTimes(2);
    expect(hostRequest).toHaveBeenLastCalledWith(
      "extensionUi.respond",
      CONTEXT,
      expect.objectContaining({ status: "resolved", value: true }),
    );
  });

  it("disables duplicate actions while a response is in flight", async () => {
    let resolveResponse: ((value: unknown) => void) | undefined;
    const hostRequest = vi.spyOn(hostClient, "request").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveResponse = resolve;
        }) as never,
    );
    act(() => {
      useAppStore.getState().setExtensionUiRequest(extensionRequest({ presentation: "inline" }));
    });
    const user = userEvent.setup();
    renderRequestSurfaces();

    await user.click(screen.getByRole("button", { name: "Confirm" }));

    expect(screen.getByRole("button", { name: "Submitting…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(hostRequest).toHaveBeenCalledOnce();

    await act(async () => {
      resolveResponse?.({ ok: true, result: null });
      await Promise.resolve();
    });
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  it("keeps select progress on the option that is being submitted", async () => {
    vi.spyOn(hostClient, "request").mockImplementation(() => new Promise(() => {}) as never);
    act(() => {
      useAppStore.getState().setExtensionUiRequest(
        extensionRequest({
          presentation: "inline",
          kind: "select",
          options: [
            {
              id: "apply",
              label: "Apply the recommendation",
              description: "Use shared semantics.",
            },
            { id: "later", label: "Decide later" },
          ],
          allowFreeform: true,
        }),
      );
    });
    const user = userEvent.setup();
    renderRequestSurfaces();

    const option = screen.getByRole("button", {
      name: "Apply the recommendation. Use shared semantics.",
    });
    await user.click(option);

    expect(option).toBeDisabled();
    expect(option).toHaveTextContent("Submitting…");
    expect(screen.getByRole("status")).toHaveTextContent("Submitting…");
    expect(screen.getByRole("button", { name: "Send response" })).toBeDisabled();
  });

  it("filters a virtualized large option list and submits the original option ID", async () => {
    const hostRequest = vi
      .spyOn(hostClient, "request")
      .mockResolvedValue({ ok: true, result: null } as never);
    const options = Array.from({ length: 150 }, (_, index) => ({
      id: `value-${index}`,
      label: `Option ${index}`,
      description: `Description ${index}`,
    }));
    act(() => {
      useAppStore.getState().setExtensionUiRequest(
        extensionRequest({
          presentation: "inline",
          kind: "select",
          options,
        }),
      );
    });
    const user = userEvent.setup();
    const view = renderRequestSurfaces();

    expect(view.container.querySelector('[data-extension-option-list="virtualized"]')).toBeTruthy();
    const search = screen.getByRole("searchbox", { name: "Search options" });
    await user.type(search, "Option 149");
    expect(screen.getByRole("button", { name: "Option 149. Description 149" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Option 14. Description 14" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Option 149. Description 149" }));
    await waitFor(() => expect(hostRequest).toHaveBeenCalledOnce());
    expect(hostRequest).toHaveBeenCalledWith(
      "extensionUi.respond",
      CONTEXT,
      expect.objectContaining({ status: "resolved", value: "value-149" }),
    );
  });

  it("shows a recoverable empty state when no option matches", async () => {
    act(() => {
      useAppStore.getState().setExtensionUiRequest(
        extensionRequest({
          presentation: "inline",
          kind: "select",
          options: Array.from({ length: 12 }, (_, index) => ({
            id: `value-${index}`,
            label: `Option ${index}`,
          })),
        }),
      );
    });
    const user = userEvent.setup();
    renderRequestSurfaces();

    await user.type(screen.getByRole("searchbox", { name: "Search options" }), "missing");
    expect(screen.getByRole("status")).toHaveTextContent(
      "No matching options. Try another search.",
    );
    await user.click(screen.getByRole("button", { name: "Clear option search" }));
    expect(screen.getByRole("button", { name: "Option 0" })).toBeVisible();
  });

  it("submits a labeled input from the keyboard", async () => {
    const hostRequest = vi
      .spyOn(hostClient, "request")
      .mockResolvedValue({ ok: true, result: null } as never);
    act(() => {
      useAppStore.getState().setExtensionUiRequest(
        extensionRequest({
          presentation: "inline",
          kind: "input",
          title: "Provide a branch name",
        }),
      );
    });
    const user = userEvent.setup();
    renderRequestSurfaces();

    const input = screen.getByRole("textbox", { name: "Your response" });
    await user.type(input, "release-candidate{Enter}");

    await waitFor(() => expect(hostRequest).toHaveBeenCalledOnce());
    expect(hostRequest).toHaveBeenCalledWith(
      "extensionUi.respond",
      CONTEXT,
      expect.objectContaining({ status: "resolved", value: "release-candidate" }),
    );
  });

  it("traps modal focus and lets Escape cancel", async () => {
    vi.spyOn(hostClient, "request").mockResolvedValue({ ok: true, result: null } as never);
    act(() => {
      useAppStore.getState().setExtensionUiRequest(extensionRequest());
    });
    const user = userEvent.setup();
    renderRequestSurfaces();

    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Confirm" })).toHaveFocus();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(hostClient.request).toHaveBeenCalledWith(
      "extensionUi.respond",
      CONTEXT,
      expect.objectContaining({ status: "cancelled" }),
    );
  });

  it("keeps focus in a submitting Modal and restores its opener after success", async () => {
    let resolveResponse: ((value: unknown) => void) | undefined;
    vi.spyOn(hostClient, "request").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveResponse = resolve;
        }) as never,
    );
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Open decision</button>
        <ExtensionUiModal />
      </>,
    );
    const opener = screen.getByRole("button", { name: "Open decision" });
    opener.focus();
    act(() => {
      useAppStore.getState().setExtensionUiRequest(extensionRequest());
    });

    const confirm = await screen.findByRole("button", { name: "Confirm" });
    await user.click(confirm);

    const dialog = screen.getByRole("dialog");
    await waitFor(() => expect(dialog).toHaveFocus());
    expect(dialog).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Submitting…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

    await user.tab();
    expect(dialog).toHaveFocus();
    await user.tab({ shift: true });
    expect(dialog).toHaveFocus();

    await act(async () => {
      resolveResponse?.({ ok: true, result: null });
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });

  it("expires the current request once and advances to the next live request", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const first = extensionRequest({
      presentation: "inline",
      title: "Expiring request",
      expiresAt: now + 100,
    });
    const next = extensionRequest({ title: "Next modal request" });
    act(() => {
      useAppStore.getState().setExtensionUiRequest(first);
      useAppStore.getState().setExtensionUiRequest(next);
    });
    renderRequestSurfaces();

    expect(screen.getByRole("region", { name: "Expiring request" })).toBeVisible();
    await act(async () => {
      vi.advanceTimersByTime(101);
      await Promise.resolve();
    });

    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Next modal request" })).toBeVisible();
    expect(
      useAppStore
        .getState()
        .notifications.filter((item) => item.message === "Extension request expired"),
    ).toHaveLength(1);
  });

  it("keeps one Inline group shell across sequential select and input requests", async () => {
    vi.spyOn(hostClient, "request").mockResolvedValue({ ok: true, result: null } as never);
    useAppStore.setState({
      session: {
        sessionId: CONTEXT.expectedSessionId,
        revision: CONTEXT.expectedSessionRevision,
      } as never,
    });
    const groupKey = "tool:0123456789abcdef";
    const first = extensionRequest({
      kind: "select",
      title: "Choose a direction",
      options: [
        { id: "alpha", label: "Alpha" },
        { id: "beta", label: "Beta" },
      ],
      groupKey,
      presentation: "inline",
    });
    act(() => useAppStore.getState().setExtensionUiRequest(first));
    const user = userEvent.setup();
    const view = renderRequestSurfaces();

    expect(view.container.querySelector(`[data-extension-ui-group="${groupKey}"]`)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Alpha" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Waiting for the next question"),
    );

    const second = extensionRequest({
      kind: "input",
      title: "Add context",
      groupKey,
      presentation: "inline",
    });
    act(() => useAppStore.getState().setExtensionUiRequest(second));

    expect(screen.getByText("1 answered")).toBeVisible();
    expect(screen.getByRole("region", { name: "Add context" })).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(view.container.querySelectorAll("[data-extension-ui-surface]")).toHaveLength(1);
  });

  it("blocks Composer submission through group waiting and restores focus after group close", async () => {
    const hostRequest = vi
      .spyOn(hostClient, "request")
      .mockResolvedValue({ ok: true, result: null } as never);
    useAppStore.setState({
      host: hostSnapshot(),
      workspace: workspaceSnapshot(),
      session: sessionSnapshot(),
    });
    const groupKey = "tool:composer-block";
    const request = extensionRequest({
      groupKey,
      presentation: "inline",
    });
    act(() => useAppStore.getState().setExtensionUiRequest(request));
    const user = userEvent.setup();
    render(
      <>
        <InlineExtensionUiRequest />
        <Composer />
      </>,
    );

    const composer = screen.getByRole("textbox");
    await user.type(composer, "Keep this draft{Enter}");
    expect(composer).toHaveValue("Keep this draft");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.getByRole("status", { name: "" })).toHaveTextContent(
      "Answer the Extension question above before sending a message.",
    );
    expect(hostRequest).not.toHaveBeenCalledWith(
      "agent.prompt",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );

    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(screen.getByText("Waiting for the next question…")).toBeVisible());
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(composer).not.toHaveFocus();

    act(() => useAppStore.getState().closeExtensionDecisionGroup(groupKey, "completed"));
    await waitFor(() => expect(composer).toHaveFocus());
    expect(composer).toHaveValue("Keep this draft");
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  });

  it("does not remount a published Host-final request when Settings later prefers Modal", () => {
    act(() => {
      useAppStore.getState().setExtensionUiRequest(extensionRequest({ presentation: "inline" }));
    });
    renderRequestSurfaces();
    expect(screen.getByRole("region", { name: "Choose how to continue" })).toBeVisible();

    act(() => {
      const current = useAppStore.getState().desktopSettings;
      useAppStore.getState().setDesktopSettings({
        theme: "system",
        language: "en",
        restoreLastSession: true,
        autoRestartHostOnce: true,
        extensionDecisionPresentation: "auto",
        terminalProfile: "auto",
        ...current,
        extensionUi: {
          ...DEFAULT_EXTENSION_UI_SETTINGS,
          presentations: {
            ext_review: { blockingDialog: { home: { kind: "modal" } } },
          },
        },
      });
    });

    expect(screen.getByRole("region", { name: "Choose how to continue" })).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(useAppStore.getState().extensionUiRequest?.presentation).toBe("inline");
  });

  it("parks a published request when switching sessions without changing the global profile", () => {
    act(() => {
      useAppStore.getState().setDesktopSettings({
        theme: "system",
        language: "en",
        restoreLastSession: true,
        autoRestartHostOnce: true,
        extensionDecisionPresentation: "auto",
        terminalProfile: "auto",
        extensionUi: {
          ...DEFAULT_EXTENSION_UI_SETTINGS,
          presentations: {
            ext_review: { blockingDialog: { home: { kind: "inline" } } },
          },
        },
      });
      useAppStore.getState().setExtensionUiRequest(extensionRequest({ presentation: "inline" }));
    });
    renderRequestSurfaces();
    expect(screen.getByRole("region")).toBeVisible();

    act(() => {
      useAppStore.getState().applySessionSnapshot({
        ...sessionSnapshot(),
        sessionId: "55555555-5555-4555-8555-555555555555",
        revision: 1,
      });
    });

    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      useAppStore.getState().desktopSettings?.extensionUi?.presentations.ext_review?.blockingDialog
        ?.home,
    ).toEqual({ kind: "inline" });
  });
});

describe("registered Extension message renderer output", () => {
  afterEach(() => cleanup());

  it("shows compact output and expands only when the full rendering differs", async () => {
    const user = userEvent.setup();
    const row: TranscriptRow = {
      key: "custom:renderer",
      role: "custom",
      blocks: [{ kind: "text", text: "raw fallback" }],
      copyText: "raw fallback",
      customType: "subagent-slash-result",
      extensionMessageRender: {
        version: 1,
        collapsed: ["Subagents doctor report"],
        expanded: ["Subagents doctor report", "Runtime: ok"],
      },
    };

    render(<ExtensionMessageRow row={row} />);

    const name = screen.getByText("Subagents doctor report");
    expect(name).toBeVisible();
    expect(screen.queryByText(/raw fallback/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Runtime: ok/)).not.toBeInTheDocument();
    const disclosure = screen.getByRole("button", { name: /Subagents doctor report/ });
    expect(disclosure).toHaveAttribute("title", "Show full Extension output");
    await user.click(name);
    expect(screen.getByText(/Runtime: ok/)).toBeVisible();
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(disclosure).toHaveAttribute("title", "Show compact Extension output");

    await user.click(name);
    expect(screen.queryByText(/Runtime: ok/)).not.toBeInTheDocument();
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
  });
});
