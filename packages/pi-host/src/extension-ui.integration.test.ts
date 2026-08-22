/**
 * C6 Extension UI integration (B-EXT-RUNTIME-01):
 * Real path only:
 *   DefaultResourceLoader (fixture in agentDir)
 *     -> createAgentSession (loads extension via SDK)
 *     -> bindExtensions({ uiContext, mode: "rpc" })
 *     -> post-bind session_start re-emit (public extensionRunner)
 *     -> fixture handler uses ctx.ui (marker written only in handler)
 *
 * Forbidden: manual import() of fixture, direct handler call, harness-written marker.
 */
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
  cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { describe, it, expect, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createTestModelServices } from "./test-helpers/model-runtime.js";
import {
  bindExtensionUi,
  respondExtensionUi,
  cancelAllPending,
  injectExtensionCustomInput,
  type ExtensionUiBinding,
} from "./extension-ui-bridge.js";
import type { HostEventName, HostIdentity } from "@pideck/protocol";

const __dirname = dirname(fileURLToPath(import.meta.url));
const uiFixtureSrc = join(
  __dirname,
  "../../../test-fixtures/pi-packages/ui-extension/extensions/ui-blocking-extension.ts",
);

describe("extension UI real loader + bindExtensions path", () => {
  let root: string | undefined;

  afterAll(() => {
    cancelAllPending("test cleanup");
    if (root) {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    delete process.env.PIDECK_UI_MARKER;
    delete process.env.PIDECK_UI_NONCE;
    delete process.env.PI_CODING_AGENT_DIR;
  });

  it("DefaultResourceLoader → AgentSession → bind → handler UI marker", async () => {
    root = mkdtempSync(join(tmpdir(), "pideck-ui-c6-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    const marker = join(root, "ui-marker.txt");
    const nonce = `extension-ui-integration-${Date.now()}`;
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(agentDir, "auth.json"), "{}");
    writeFileSync(join(agentDir, "models.json"), "{}");
    writeFileSync(join(agentDir, "settings.json"), "{}");

    const extDest = join(agentDir, "extensions", "ui-blocking-extension.ts");
    cpSync(uiFixtureSrc, extDest);
    expect(existsSync(extDest)).toBe(true);

    process.env.PIDECK_UI_MARKER = marker;
    process.env.PIDECK_UI_NONCE = nonce;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    // Harness must never create the success marker
    expect(existsSync(marker)).toBe(false);

    const identity: HostIdentity = {
      hostInstanceId: "h-ui",
      workspaceId: "w-ui",
      workspaceRevision: 1,
      sessionId: "s-ui",
      sessionRevision: 1,
      packageRevision: 0,
    };
    type Tracked = { e: HostEventName; p: unknown; done?: boolean };
    const events: Tracked[] = [];

    const settingsManager = SettingsManager.create(cwd, agentDir, {
      projectTrusted: true,
    });
    const { modelRuntime } = await createTestModelServices(agentDir);

    // Real loader discovers fixture under agentDir/extensions
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
    });
    await resourceLoader.reload();

    const sessionManager = SessionManager.create(cwd);
    // Same agentDir + resourceLoader — SDK loads the fixture extension
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      settingsManager,
      resourceLoader,
      sessionManager,
    });

    // Respond to Extension UI requests while bind re-emits session_start
    let stopRespond = false;
    const respondLoop = (async () => {
      const deadline = Date.now() + 40_000;
      while (!stopRespond && Date.now() < deadline) {
        const req = events.find((x) => x.e === "extensionUi.request" && !x.done);
        const custom = events.find((x) => x.e === "extensionUi.customStarted" && !x.done);
        if (!req && !custom) {
          await new Promise((r) => setTimeout(r, 20));
          continue;
        }
        if (req) {
          req.done = true;
          const payload = req.p as { requestId: string; kind: string };
          let value: unknown;
          if (payload.kind === "select") value = "beta";
          else if (payload.kind === "confirm") value = true;
          else if (payload.kind === "input" || payload.kind === "editor") {
            value = "typed-value";
          }
          respondExtensionUi(payload.requestId, "resolved", value, identity);
        }
        if (custom) {
          custom.done = true;
          const payload = custom.p as { requestId: string };
          // Wait for the component to gain focus and the first frame to flush,
          // then pick the second option: down arrow + enter.
          await new Promise((r) => setTimeout(r, 100));
          injectExtensionCustomInput(payload.requestId, "\x1b[B", identity);
          await new Promise((r) => setTimeout(r, 50));
          injectExtensionCustomInput(payload.requestId, "\r", identity);
        }
      }
    })();

    // Production path: bindExtensions + public extensionRunner session_start re-emit
    const binding = await bindExtensionUi(session, null, {
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => identity,
    });
    expect(typeof binding.cleanup).toBe("function");
    expect(events.some((e) => e.e === "extensionUi.request")).toBe(false);
    const publish = await binding.activate();
    expect(events.some((e) => e.e === "extensionUi.statusChanged")).toBe(false);
    publish();

    // Wait for handler-written marker (must not be created by this test)
    const markerDeadline = Date.now() + 40_000;
    while (!existsSync(marker) && Date.now() < markerDeadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const firstRequests = events.filter((event) => event.e === "extensionUi.request");
    expect(firstRequests).toHaveLength(3);
    const firstOrigins = firstRequests.map(
      (event) =>
        (
          event.p as {
            origin: {
              invocationKind: string;
              extensionId: string;
              eventType: string;
            };
          }
        ).origin,
    );
    for (const origin of firstOrigins) {
      expect(origin).toMatchObject({
        invocationKind: "event",
        eventType: "session_start",
      });
      expect(origin.extensionId).toMatch(/^ext_[0-9a-f]{24}$/);
    }

    // The SDK replaces ExtensionRunner on reload. Stored bindings must install
    // the invocation runner before the replacement emits its session_start.
    await session.reload();
    const allRequests = events.filter((event) => event.e === "extensionUi.request");
    expect(allRequests).toHaveLength(6);
    const reloadOrigins = allRequests.slice(3).map(
      (event) =>
        (
          event.p as {
            origin: {
              invocationKind: string;
              extensionId: string;
              eventType: string;
            };
          }
        ).origin,
    );
    expect(reloadOrigins).toHaveLength(3);
    for (const origin of reloadOrigins) {
      expect(origin).toMatchObject({
        invocationKind: "event",
        extensionId: firstOrigins[0]!.extensionId,
        eventType: "session_start",
      });
    }

    stopRespond = true;
    await Promise.race([respondLoop, new Promise((r) => setTimeout(r, 200))]);

    expect(existsSync(marker)).toBe(true);
    const body = readFileSync(marker, "utf8");
    expect(body).toContain("selected=beta");
    expect(body).toContain("confirmed=true");
    expect(body).toContain("typed=typed-value");
    expect(body).toContain("customPicked=two");
    expect(body).toContain("handler=session_start");
    expect(body).toContain("hasUI=true");
    expect(body).toContain(`nonce=${nonce}`);
    expect(events.some((e) => e.e === "extensionUi.request")).toBe(true);
    expect(events.some((e) => e.e === "extensionUi.statusChanged")).toBe(true);
    expect(events.some((e) => e.e === "extensionUi.customStarted")).toBe(true);
    const frameData = events
      .filter((e) => e.e === "extensionUi.customFrame")
      .map((e) => (e.p as { data: string }).data)
      .join("");
    expect(frameData).toContain("one");
    expect(events.some((e) => e.e === "extensionUi.customClosed")).toBe(true);

    binding.cleanup();
    try {
      session.dispose?.();
    } catch {
      /* optional */
    }
  }, 60_000);

  it("rebuilds a retained Runner before restoring a Todo-like factory widget", async () => {
    const retainedRoot = mkdtempSync(join(tmpdir(), "pideck-ui-retained-"));
    const agentDir = join(retainedRoot, "agent");
    const cwd = join(retainedRoot, "project");
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(agentDir, "auth.json"), "{}");
    writeFileSync(join(agentDir, "models.json"), "{}");
    writeFileSync(join(agentDir, "settings.json"), "{}");
    writeFileSync(
      join(agentDir, "todo-like-state.js"),
      [
        'let activeSession = "";',
        "export const getActiveSession = () => activeSession;",
        "export const setActiveSession = (sessionId) => { activeSession = sessionId; };",
        'export const clearActiveSession = () => { activeSession = ""; };',
      ].join("\n"),
    );
    writeFileSync(
      join(agentDir, "extensions", "todo-like-extension.js"),
      [
        'import { clearActiveSession, getActiveSession, setActiveSession } from "../todo-like-state.js";',
        "export default function (pi) {",
        "  let overlayCreated = false;",
        "  let registered = false;",
        "  let boundUi;",
        '  pi.on("session_start", (_event, ctx) => {',
        "    const sessionId = ctx.sessionManager.getSessionId();",
        "    if (!ctx.hasUI) return;",
        "    if (!overlayCreated) {",
        "      overlayCreated = true;",
        "      setActiveSession(sessionId);",
        "    }",
        "    if (sessionId !== getActiveSession()) return;",
        "    if (boundUi !== ctx.ui) {",
        "      boundUi = ctx.ui;",
        "      registered = false;",
        "    }",
        "    if (registered) return;",
        '    ctx.ui.setWidget("todo-like", () => ({',
        "      render: () => [`todos:${sessionId}`],",
        "      invalidate: () => {},",
        "    }));",
        "    registered = true;",
        "  });",
        '  pi.on("session_shutdown", (_event, ctx) => {',
        "    const sessionId = ctx.sessionManager.getSessionId();",
        "    if (sessionId !== getActiveSession()) return;",
        "    overlayCreated = false;",
        "    registered = false;",
        "    clearActiveSession();",
        "  });",
        "}",
      ].join("\n"),
    );

    const bindings: ExtensionUiBinding[] = [];
    const sessions: AgentSession[] = [];
    try {
      const settingsManager = SettingsManager.create(cwd, agentDir, {
        projectTrusted: true,
      });
      const { modelRuntime } = await createTestModelServices(agentDir);
      const createSessionWithLoader = async (): Promise<AgentSession> => {
        const resourceLoader = new DefaultResourceLoader({
          cwd,
          agentDir,
          settingsManager,
        });
        await resourceLoader.reload();
        const created = await createAgentSession({
          cwd,
          agentDir,
          modelRuntime,
          settingsManager,
          resourceLoader,
          sessionManager: SessionManager.create(cwd),
        });
        sessions.push(created.session);
        return created.session;
      };
      const identityFor = (sessionId: string, revision: number): HostIdentity => ({
        hostInstanceId: "h-retained",
        workspaceId: "w-retained",
        workspaceRevision: 1,
        sessionId,
        sessionRevision: revision,
        packageRevision: 0,
      });
      const bindAndPublish = async (
        session: AgentSession,
        identity: HostIdentity,
        events: Array<{ e: HostEventName; p: unknown }>,
      ): Promise<ExtensionUiBinding> => {
        const binding = await bindExtensionUi(session, null, {
          emit: (e, p) => events.push({ e, p }),
          getIdentity: () => identity,
        });
        bindings.push(binding);
        const publish = await binding.activate();
        publish();
        await new Promise((resolve) => setTimeout(resolve, 30));
        return binding;
      };

      const first = await createSessionWithLoader();
      const firstSessionId = first.sessionId;
      const firstEvents: Array<{ e: HostEventName; p: unknown }> = [];
      const firstBinding = await bindAndPublish(first, identityFor(firstSessionId, 1), firstEvents);
      expect(firstEvents.some((event) => event.e === "extensionUi.widgetChanged")).toBe(true);
      firstBinding.cleanup();

      const second = await createSessionWithLoader();
      const secondEvents: Array<{ e: HostEventName; p: unknown }> = [];
      await bindAndPublish(second, identityFor(second.sessionId, 2), secondEvents);
      expect(secondEvents.some((event) => event.e === "extensionUi.widgetChanged")).toBe(true);

      const staleEvents: Array<{ e: HostEventName; p: unknown }> = [];
      const staleBinding = await bindAndPublish(first, identityFor(firstSessionId, 3), staleEvents);
      expect(staleEvents.some((event) => event.e === "extensionUi.widgetChanged")).toBe(false);
      staleBinding.cleanup();

      const restoredEvents: Array<{ e: HostEventName; p: unknown }> = [];
      const restoredBinding = await bindExtensionUi(first, null, {
        emit: (e, p) => restoredEvents.push({ e, p }),
        getIdentity: () => identityFor(firstSessionId, 4),
      });
      bindings.push(restoredBinding);
      await first.reload();
      const publishRestored = await restoredBinding.activate();
      publishRestored();
      await new Promise((resolve) => setTimeout(resolve, 30));

      const restoredWidget = restoredEvents.find(
        (event) => event.e === "extensionUi.widgetChanged",
      )?.p;
      expect(restoredWidget).toMatchObject({
        key: "todo-like",
        widget: [`todos:${firstSessionId}`],
      });
    } finally {
      for (const binding of bindings.reverse()) binding.cleanup();
      for (const session of sessions.reverse()) session.dispose();
      rmSync(retainedRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
