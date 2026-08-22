import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  wrapRegisteredTool,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { HostEventName, HostIdentity } from "@pideck/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  bindExtensionUi,
  cancelAllPending,
  injectExtensionCustomInput,
  respondExtensionUi,
  type ExtensionUiBinding,
} from "./extension-ui-bridge.js";
import {
  resolveExtensionCommandInvocation,
  withExtensionCommandOrigin,
} from "./extension-invocation-context.js";
import { createTestModelServices } from "./test-helpers/model-runtime.js";
import { createTempAgentLayout, type TempAgentLayout } from "./test-helpers/temp-agent.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const MATRIX_EXTENSION = join(
  currentDir,
  "../../../test-fixtures/pi-packages/extension-compat-matrix/extensions/compat-matrix-extension.ts",
);

type EmittedEvent = { event: HostEventName; payload: unknown };

type LoadedMatrix = {
  binding: ExtensionUiBinding;
  busEvents: Map<string, unknown[]>;
  events: EmittedEvent[];
  identity: HostIdentity;
  layout: TempAgentLayout;
  session: AgentSession;
  setForegroundSession: (sessionId: string) => void;
  cleanup: () => void;
};

function matrixIdentity(sessionId = "session-matrix"): HostIdentity {
  return {
    hostInstanceId: "host-matrix",
    workspaceId: "workspace-matrix",
    workspaceRevision: 1,
    sessionId,
    sessionRevision: 1,
    packageRevision: 0,
  };
}

async function loadMatrix(): Promise<LoadedMatrix> {
  const layout = createTempAgentLayout("pideck-extension-matrix-");
  const eventBus = createEventBus();
  const busEvents = new Map<string, unknown[]>();
  for (const channel of [
    "pideck:matrix:shutdown",
    "pideck:matrix:background-result",
    "pideck:matrix:plan-result",
    "pideck:matrix:large-result",
  ]) {
    eventBus.on(channel, (payload) => {
      const entries = busEvents.get(channel) ?? [];
      entries.push(payload);
      busEvents.set(channel, entries);
    });
  }

  const settingsManager = SettingsManager.create(layout.projectDir, layout.agentDir, {
    projectTrusted: true,
  });
  const { modelRuntime } = await createTestModelServices(layout.agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: layout.projectDir,
    agentDir: layout.agentDir,
    settingsManager,
    eventBus,
    additionalExtensionPaths: [MATRIX_EXTENSION],
  });
  await resourceLoader.reload();
  expect(resourceLoader.getExtensions().errors).toEqual([]);

  const { session } = await createAgentSession({
    cwd: layout.projectDir,
    agentDir: layout.agentDir,
    modelRuntime,
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.inMemory(),
  });
  const events: EmittedEvent[] = [];
  const owner = matrixIdentity();
  let current = owner;
  const binding = await bindExtensionUi(session, null, {
    emit: (event, payload) => events.push({ event, payload }),
    getIdentity: () => owner,
    getCurrentIdentity: () => current,
    getExtensionDecisionPresentation: () => "auto",
    isInlineSurfaceAvailable: () => true,
  });
  const publish = await binding.activate();
  publish();

  return {
    binding,
    busEvents,
    events,
    identity: owner,
    layout,
    session,
    setForegroundSession: (sessionId) => {
      current = matrixIdentity(sessionId);
    },
    cleanup: () => {
      binding.cleanup();
      session.dispose();
      eventBus.clear();
      layout.cleanup();
    },
  };
}

async function waitForEvent<T>(
  events: EmittedEvent[],
  eventName: HostEventName,
  predicate: (payload: T) => boolean = () => true,
): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const match = events.find(
      (event) => event.event === eventName && predicate(event.payload as T),
    );
    if (match) return match.payload as T;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${eventName}`);
}

function askTool(session: AgentSession) {
  const registered = session.extensionRunner
    .getAllRegisteredTools()
    .find((tool) => tool.definition.name === "matrix_subagent");
  expect(registered).toBeDefined();
  return wrapRegisteredTool(registered!, session.extensionRunner);
}

async function runCommand(matrix: LoadedMatrix, commandName: string): Promise<void> {
  const resolved = resolveExtensionCommandInvocation(matrix.session, `/${commandName}`);
  expect(resolved).toBeDefined();
  await withExtensionCommandOrigin(matrix.session, randomUUID(), resolved!, () =>
    resolved!.command.handler("", matrix.session.extensionRunner.createCommandContext()),
  );
}

afterEach(() => {
  cancelAllPending("extension compatibility matrix cleanup");
});

describe("Extension behavior-class compatibility matrix", () => {
  it("loads persistent widgets, renderers, provider-only registration, and shutdown cleanup", async () => {
    const matrix = await loadMatrix();
    try {
      const widgets = matrix.events
        .filter((event) => event.event === "extensionUi.widgetChanged")
        .map((event) => event.payload as { key: string; widget: unknown; placement?: string });
      expect(widgets).toEqual([
        expect.objectContaining({
          key: "matrix-persistent",
          widget: ["Matrix widget: ready"],
          placement: "belowEditor",
        }),
      ]);
      expect(matrix.events.some((event) => event.event === "extensionUi.request")).toBe(false);
      expect(matrix.session.extensionRunner.getMessageRenderer("matrix-message")).toBeDefined();
      expect(matrix.session.extensionRunner.getEntryRenderer("matrix-entry")).toBeDefined();
      expect(
        matrix.session.extensionRunner.getModelRegistry().find("matrix-provider", "matrix-model"),
      ).toMatchObject({ id: "matrix-model", provider: "matrix-provider" });

      await matrix.session.extensionRunner.emit({
        type: "session_shutdown",
        reason: "quit",
      });
      expect(matrix.busEvents.get("pideck:matrix:shutdown")).toEqual([{ cleaned: true }]);
      expect(
        matrix.events.filter((event) => event.event === "extensionUi.widgetChanged").at(-1)
          ?.payload,
      ).toMatchObject({ key: "matrix-persistent", widget: null });
      expect(
        matrix.events.filter((event) => event.event === "extensionUi.statusChanged").at(-1)
          ?.payload,
      ).toMatchObject({ key: "matrix-watcher", text: "" });
    } finally {
      matrix.cleanup();
    }
  });

  it("projects a dynamic registered message renderer through the real loader", async () => {
    const matrix = await loadMatrix();
    try {
      await runCommand(matrix, "matrix-renderer");
      const rendered = await waitForEvent<{
        entryId: string;
        render: { collapsed: string[]; expanded: string[] } | null;
      }>(
        matrix.events,
        "extensionUi.messageRendered",
        (payload) => payload.render?.collapsed[0] === "Matrix renderer complete",
      );
      expect(rendered.render).toEqual({
        version: 1,
        collapsed: ["Matrix renderer complete"],
        expanded: ["Matrix renderer complete: full report"],
        messageIndex: 0,
      });

      const entries = matrix.session.sessionManager.getBranch();
      expect(entries.find((entry) => entry.id === rendered.entryId)).toMatchObject({
        type: "custom_message",
        customType: "matrix-message",
        display: true,
      });
      expect(
        entries.some(
          (entry) =>
            entry.type === "custom_message" &&
            entry.customType === "matrix-message" &&
            entry.display === false,
        ),
      ).toBe(true);
    } finally {
      matrix.cleanup();
    }
  });

  it("runs a subagent-style dialog, widget, activity, and custom terminal", async () => {
    const matrix = await loadMatrix();
    try {
      const running = askTool(matrix.session).execute(
        "tool-call-matrix-subagent",
        {},
        undefined,
        undefined,
      );
      type Request = {
        requestId: string;
        title?: string;
        origin: { invocationKind: string; toolName?: string; toolCallId?: string };
        presentation: string;
        routeReason: string;
        groupKey?: string;
      };
      const request = await waitForEvent<Request>(
        matrix.events,
        "extensionUi.request",
        (payload) => payload.title === "Subagent next step",
      );
      expect(request).toMatchObject({
        presentation: "inline",
        routeReason: "active-tool",
        origin: {
          invocationKind: "tool",
          toolName: "matrix_subagent",
          toolCallId: "tool-call-matrix-subagent",
        },
      });
      expect(request.groupKey).toMatch(/^tool:[0-9a-f]{32}$/);
      expect(
        respondExtensionUi(request.requestId, "resolved", "Open terminal", matrix.identity),
      ).toBe(true);

      const custom = await waitForEvent<{ requestId: string }>(
        matrix.events,
        "extensionUi.customStarted",
      );
      expect(injectExtensionCustomInput(custom.requestId, "\r", matrix.identity)).toBe(true);
      await expect(running).resolves.toMatchObject({
        details: { next: "Open terminal", terminalResult: "terminal-complete" },
      });
      expect(
        matrix.events.some(
          (event) =>
            event.event === "extensionUi.notification" &&
            (event.payload as { message?: string }).message === "Matrix subagent activity",
        ),
      ).toBe(true);
      expect(matrix.events.filter((event) => event.event === "extensionUi.customClosed")).toEqual([
        {
          event: "extensionUi.customClosed",
          payload: { requestId: custom.requestId },
        },
      ]);
      expect(matrix.events.filter((event) => event.event === "extensionUi.groupClosed")).toEqual([
        {
          event: "extensionUi.groupClosed",
          payload: { groupKey: request.groupKey, status: "completed" },
        },
      ]);
      expect(
        matrix.events
          .filter(
            (event) =>
              event.event === "extensionUi.widgetChanged" &&
              (event.payload as { key?: string }).key === "matrix-subagent",
          )
          .at(-1)?.payload,
      ).toMatchObject({ key: "matrix-subagent", widget: null });
    } finally {
      matrix.cleanup();
    }
  });

  it("keeps permission and repository guards on Host-final Modal routes", async () => {
    const matrix = await loadMatrix();
    try {
      type Request = {
        requestId: string;
        title?: string;
        origin: { invocationKind: string; eventType?: string };
        presentation: string;
        risk: string;
        routeReason: string;
      };
      const permissionRun = matrix.session.extensionRunner.emitToolCall({
        type: "tool_call",
        toolName: "bash",
        toolCallId: "tool-call-matrix-guard",
        input: { command: "matrix-danger --apply" },
      } as never);
      const permission = await waitForEvent<Request>(
        matrix.events,
        "extensionUi.request",
        (payload) => payload.title === "Allow guarded command?",
      );
      expect(permission).toMatchObject({
        origin: { invocationKind: "event", eventType: "tool_call" },
        presentation: "modal",
        risk: "high",
        routeReason: "high-risk",
      });
      respondExtensionUi(permission.requestId, "resolved", "Block", matrix.identity);
      await expect(permissionRun).resolves.toMatchObject({
        block: true,
        reason: "Blocked by matrix permission guard",
      });

      const repositoryRun = matrix.session.extensionRunner.emit({
        type: "session_before_switch",
        reason: "new",
      });
      const repository = await waitForEvent<Request>(
        matrix.events,
        "extensionUi.request",
        (payload) => payload.title === "Leave this repository state?",
      );
      expect(repository).toMatchObject({
        origin: { invocationKind: "event", eventType: "session_before_switch" },
        presentation: "modal",
        risk: "normal",
        routeReason: "session-lifecycle",
      });
      respondExtensionUi(repository.requestId, "resolved", false, matrix.identity);
      await expect(repositoryRun).resolves.toEqual({ cancel: true });
    } finally {
      matrix.cleanup();
    }
  });

  it("keeps planning and large-selector commands grouped with exact values", async () => {
    const matrix = await loadMatrix();
    try {
      type Request = {
        requestId: string;
        kind: string;
        title?: string;
        options?: Array<{ id: string; label: string }>;
        origin: { invocationKind: string; commandName?: string };
        presentation: string;
        routeReason: string;
        groupKey?: string;
      };
      const planRun = runCommand(matrix, "matrix-plan");
      const select = await waitForEvent<Request>(
        matrix.events,
        "extensionUi.request",
        (payload) => payload.title === "Plan next step",
      );
      expect(select).toMatchObject({
        kind: "select",
        origin: { invocationKind: "command", commandName: "matrix-plan" },
        presentation: "inline",
        routeReason: "active-command",
      });
      respondExtensionUi(select.requestId, "resolved", "Edit plan", matrix.identity);
      const editor = await waitForEvent<Request>(
        matrix.events,
        "extensionUi.request",
        (payload) => payload.title === "Edit matrix plan",
      );
      expect(editor.kind).toBe("editor");
      expect(editor.groupKey).toBe(select.groupKey);
      respondExtensionUi(editor.requestId, "resolved", "Reviewed matrix plan", matrix.identity);
      await planRun;
      expect(matrix.busEvents.get("pideck:matrix:plan-result")).toEqual([
        { next: "Edit plan", plan: "Reviewed matrix plan" },
      ]);

      const largeRun = runCommand(matrix, "matrix-large-select");
      const large = await waitForEvent<Request>(
        matrix.events,
        "extensionUi.request",
        (payload) => payload.title === "Choose a matrix option",
      );
      expect(large.options).toHaveLength(150);
      const selected = large.options![148]!;
      respondExtensionUi(large.requestId, "resolved", selected.id, matrix.identity);
      await largeRun;
      expect(matrix.busEvents.get("pideck:matrix:large-result")).toEqual([
        { selected: "Matrix option 149" },
      ]);
    } finally {
      matrix.cleanup();
    }
  });

  it("keeps a watcher decision owned by its background Session", async () => {
    const matrix = await loadMatrix();
    try {
      matrix.setForegroundSession("session-foreground");
      const backgroundRun = matrix.session.extensionRunner.emit({
        type: "turn_end",
        message: { role: "assistant", content: [], timestamp: Date.now() },
        toolResults: [],
      } as never);
      const request = await waitForEvent<{
        requestId: string;
        title?: string;
        origin: { invocationKind: string; eventType?: string };
        presentation: string;
        routeReason: string;
      }>(
        matrix.events,
        "extensionUi.request",
        (payload) => payload.title === "Background watcher approval",
      );
      expect(request).toMatchObject({
        origin: { invocationKind: "event", eventType: "turn_end" },
        presentation: "modal",
        routeReason: "background-session",
      });
      expect(
        respondExtensionUi(
          request.requestId,
          "resolved",
          true,
          matrixIdentity("session-foreground"),
        ),
      ).toBe(false);
      expect(respondExtensionUi(request.requestId, "resolved", true, matrix.identity)).toBe(true);
      await backgroundRun;
      expect(matrix.busEvents.get("pideck:matrix:background-result")).toEqual([
        { confirmed: true },
      ]);
    } finally {
      matrix.cleanup();
    }
  });
});
