import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createAgentSession,
  createExtensionRuntime,
  DefaultResourceLoader,
  ExtensionRunner,
  SessionManager,
  SettingsManager,
  wrapRegisteredTool,
  type Extension,
  type ExtensionInvocationMetadata,
  type ExtensionInvocationRunner,
  type AgentSession,
  type SourceInfo,
} from "@earendil-works/pi-coding-agent";
import type { HostEventName, HostIdentity } from "@pideck/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createExtensionUiContext, respondExtensionUi } from "./extension-ui-bridge.js";
import {
  createExtensionInvocationRunner,
  getActiveExtensionInvocation,
} from "./extension-invocation-context.js";
import { PIDECK_NO_MODEL } from "./no-model.js";
import { createTestModelServices } from "./test-helpers/model-runtime.js";
import { createTempAgentLayout, type TempAgentLayout } from "./test-helpers/temp-agent.js";

const EVENT_TYPES = [
  "session_start",
  "message_end",
  "tool_result",
  "tool_call",
  "user_bash",
  "context",
  "before_provider_request",
  "before_provider_headers",
  "before_agent_start",
  "resources_discover",
  "input",
] as const;

function sourceInfo(name: string): SourceInfo {
  return {
    path: `/packages/${name}/extensions/index.ts`,
    source: `npm:@pideck/${name}@1.0.0`,
    scope: "user",
    origin: "package",
    baseDir: `/packages/${name}`,
  };
}

function extension(name: string, handler: () => void | Promise<void>): Extension {
  return {
    path: sourceInfo(name).path,
    resolvedPath: sourceInfo(name).path,
    sourceInfo: sourceInfo(name),
    handlers: new Map(
      EVENT_TYPES.map((eventType) => [eventType, [handler]]),
    ) as Extension["handlers"],
    tools: new Map(),
    messageRenderers: new Map(),
    entryRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  };
}

function runnerWithExtensions(extensions: Extension[]): {
  runner: ExtensionRunner;
  runtime: ReturnType<typeof createExtensionRuntime>;
} {
  const runtime = createExtensionRuntime();
  runtime.getActiveTools = () => [];
  return {
    runner: new ExtensionRunner(extensions, runtime, "/workspace", {} as never, {} as never),
    runtime,
  };
}

async function emitEveryEvent(runner: ExtensionRunner): Promise<void> {
  await runner.emit({ type: "session_start", reason: "startup" });
  await runner.emitMessageEnd({
    type: "message_end",
    message: { role: "user", content: "hello", timestamp: Date.now() },
  } as never);
  await runner.emitToolResult({
    type: "tool_result",
    toolName: "read",
    toolCallId: "tool-call-result",
    content: [],
    details: {},
    isError: false,
  } as never);
  await runner.emitToolCall({
    type: "tool_call",
    toolName: "read",
    toolCallId: "tool-call-start",
    input: {},
  } as never);
  await runner.emitUserBash({ type: "user_bash", command: "pwd", cwd: "/workspace" } as never);
  await runner.emitContext([]);
  await runner.emitBeforeProviderRequest({ model: "test" });
  await runner.emitBeforeProviderHeaders({} as never);
  await runner.emitBeforeAgentStart("prompt", undefined, "system", { cwd: "/workspace" });
  await runner.emitResourcesDiscover("/workspace", "startup");
  await runner.emitInput("hello", undefined, "interactive");
}

describe("SDK Extension invocation runner patch", () => {
  it("keeps direct callback behavior when no runner is bound", async () => {
    let calls = 0;
    const { runner } = runnerWithExtensions([
      extension("direct", () => {
        calls += 1;
      }),
    ]);
    await runner.emit({ type: "session_start", reason: "startup" });
    expect(calls).toBe(1);
  });

  it("wraps all 11 event paths per Extension with distinct trusted source info", async () => {
    const first = extension("first", () => {});
    const second = extension("second", () => {});
    const { runner } = runnerWithExtensions([first, second]);
    const captured: ExtensionInvocationMetadata[] = [];
    const invocationRunner: ExtensionInvocationRunner = async <T>(
      metadata: ExtensionInvocationMetadata,
      invoke: () => T | Promise<T>,
    ) => {
      captured.push(metadata);
      return await invoke();
    };
    runner.setInvocationRunner(invocationRunner);

    await emitEveryEvent(runner);

    expect(captured).toHaveLength(EVENT_TYPES.length * 2);
    expect(captured.map((metadata) => metadata.kind)).toEqual(
      Array(EVENT_TYPES.length * 2).fill("event"),
    );
    expect(
      captured.map((metadata) => (metadata.kind === "event" ? metadata.eventType : "tool")),
    ).toEqual(EVENT_TYPES.flatMap((eventType) => [eventType, eventType]));
    for (let index = 0; index < EVENT_TYPES.length; index += 1) {
      expect(captured[index * 2]!.sourceInfo).toBe(first.sourceInfo);
      expect(captured[index * 2 + 1]!.sourceInfo).toBe(second.sourceInfo);
    }
    expect(
      captured.find((metadata) => metadata.kind === "event" && metadata.eventType === "tool_call"),
    ).toMatchObject({ toolName: "read", toolCallId: "tool-call-start" });
    expect(
      captured.find(
        (metadata) => metadata.kind === "event" && metadata.eventType === "tool_result",
      ),
    ).toMatchObject({ toolName: "read", toolCallId: "tool-call-result" });
  });

  it("wraps Extension tool execution without bypassing the original context factory", async () => {
    const owner = extension("tools", () => {});
    const { runner } = runnerWithExtensions([owner]);
    const captured: ExtensionInvocationMetadata[] = [];
    runner.setInvocationRunner(
      async <T>(metadata: ExtensionInvocationMetadata, invoke: () => T | Promise<T>) => {
        captured.push(metadata);
        return await invoke();
      },
    );
    let contextCwd: string | undefined;
    const tool = wrapRegisteredTool(
      {
        sourceInfo: owner.sourceInfo,
        definition: {
          name: "ask_user_question",
          label: "Ask user",
          description: "Ask for a decision",
          parameters: { type: "object", properties: {} } as never,
          execute: async (_toolCallId, _params, _signal, _onUpdate, context) => {
            contextCwd = context.cwd;
            return { content: [{ type: "text", text: "ok" }], details: {} };
          },
        },
      },
      runner,
    );
    const controller = new AbortController();

    await tool.execute("tool-call-1", {}, controller.signal, undefined);

    expect(contextCwd).toBe("/workspace");
    expect(captured).toEqual([
      {
        kind: "tool",
        sourceInfo: owner.sourceInfo,
        toolName: "ask_user_question",
        toolCallId: "tool-call-1",
        signal: controller.signal,
      },
    ]);
  });

  it("carries a generic Extension tool origin through the Host blocking UI bridge", async () => {
    const owner = extension("ask-user", () => {});
    const { runner } = runnerWithExtensions([owner]);
    const session = {} as AgentSession;
    const identity: HostIdentity = {
      hostInstanceId: "host",
      workspaceId: "workspace",
      workspaceRevision: 1,
      sessionId: "session",
      sessionRevision: 1,
      packageRevision: 0,
    };
    const events: Array<{ event: HostEventName; payload: unknown }> = [];
    runner.setUIContext(
      createExtensionUiContext({
        emit: (event, payload) => events.push({ event, payload }),
        getIdentity: () => identity,
        getActiveInvocation: () => getActiveExtensionInvocation(session),
      }),
      "rpc",
    );
    runner.setInvocationRunner(createExtensionInvocationRunner(session));
    const tool = wrapRegisteredTool(
      {
        sourceInfo: owner.sourceInfo,
        definition: {
          name: "ask_user_question",
          label: "Ask user",
          description: "Ask for a decision",
          parameters: { type: "object", properties: {} } as never,
          execute: async (_toolCallId, _params, _signal, _onUpdate, context) => {
            const confirmed = await context.ui.confirm("Continue?", "Proceed with the task?");
            return {
              content: [{ type: "text", text: String(confirmed) }],
              details: { confirmed },
            };
          },
        },
      },
      runner,
    );

    const running = tool.execute("tool-call-ask", {}, undefined, undefined);
    await Promise.resolve();
    const request = events.find((event) => event.event === "extensionUi.request")!.payload as {
      requestId: string;
      origin: unknown;
      groupKey?: string;
    };
    expect(request.origin).toMatchObject({
      invocationKind: "tool",
      extensionDisplayName: "@pideck/ask-user",
      sourceKind: "package",
      toolName: "ask_user_question",
      toolCallId: "tool-call-ask",
    });
    expect(request.groupKey).toMatch(/^tool:[0-9a-f]{32}$/);
    respondExtensionUi(request.requestId, "resolved", true, identity);

    await expect(running).resolves.toMatchObject({ details: { confirmed: true } });
    expect(events.filter((event) => event.event === "extensionUi.groupClosed")).toEqual([
      {
        event: "extensionUi.groupClosed",
        payload: { groupKey: request.groupKey, status: "completed" },
      },
    ]);
    expect(getActiveExtensionInvocation(session)).toBeUndefined();
  });
});

describe("SDK AgentSession invocation bind and reload", () => {
  const layouts: TempAgentLayout[] = [];
  const sessions: AgentSession[] = [];

  afterEach(() => {
    for (const session of sessions.splice(0)) {
      try {
        session.dispose();
      } catch {
        /* optional */
      }
    }
    for (const layout of layouts.splice(0)) layout.cleanup();
  });

  it("rebinds invocationRunner onto the replacement Runner after reload", async () => {
    const layout = createTempAgentLayout("pideck-invocation-bind-reload-");
    layouts.push(layout);
    const extensionPath = join(layout.root, "invocation-bind-reload.js");
    writeFileSync(
      extensionPath,
      ["export default function (pi) {", '  pi.on("session_start", async () => {});', "}"].join(
        "\n",
      ),
    );

    const settingsManager = SettingsManager.create(layout.projectDir, layout.agentDir, {
      projectTrusted: true,
    });
    const { modelRuntime } = await createTestModelServices(layout.agentDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd: layout.projectDir,
      agentDir: layout.agentDir,
      settingsManager,
      additionalExtensionPaths: [extensionPath],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();
    expect(resourceLoader.getExtensions().errors).toEqual([]);
    expect(resourceLoader.getExtensions().extensions).toHaveLength(1);

    const { session } = await createAgentSession({
      cwd: layout.projectDir,
      agentDir: layout.agentDir,
      model: PIDECK_NO_MODEL,
      modelRuntime,
      settingsManager,
      resourceLoader,
      sessionManager: SessionManager.inMemory(layout.projectDir),
    });
    sessions.push(session);

    const captured: ExtensionInvocationMetadata[] = [];
    const invocationRunner: ExtensionInvocationRunner = async <T>(
      metadata: ExtensionInvocationMetadata,
      invoke: () => T | Promise<T>,
    ) => {
      captured.push(metadata);
      return await invoke();
    };
    // Bind only the invocation runner so hasBindings depends on the P8 field,
    // not uiContext. Direct ExtensionRunner.setInvocationRunner tests cannot
    // catch a missing bindExtensions save or reload rebind.
    await session.bindExtensions({ invocationRunner });

    const sessionStarts = () =>
      captured.filter(
        (metadata) => metadata.kind === "event" && metadata.eventType === "session_start",
      );
    expect(sessionStarts()).toHaveLength(1);
    expect(sessionStarts()[0]!.sourceInfo.path.replaceAll("\\", "/")).toContain(
      "invocation-bind-reload.js",
    );

    const runnerAtBind = session.extensionRunner;
    await session.reload();
    expect(session.extensionRunner).not.toBe(runnerAtBind);
    expect(sessionStarts()).toHaveLength(2);
    expect(sessionStarts()[1]!.sourceInfo.path.replaceAll("\\", "/")).toContain(
      "invocation-bind-reload.js",
    );

    await session.extensionRunner.emit({ type: "session_start", reason: "startup" });
    expect(sessionStarts()).toHaveLength(3);
    expect(sessionStarts()[2]!.sourceInfo).toBe(sessionStarts()[1]!.sourceInfo);
  });
});
