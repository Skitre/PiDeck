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
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  bindExtensionUi,
  respondExtensionUi,
  cancelAllPending,
} from "./extension-ui-bridge.js";
import type { HostEventName, HostIdentity } from "@pi-desktop/protocol";

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
    delete process.env.PI_DESKTOP_UI_MARKER;
    delete process.env.PI_DESKTOP_UI_NONCE;
    delete process.env.PI_CODING_AGENT_DIR;
  });

  it("DefaultResourceLoader → AgentSession → bind → handler UI marker", async () => {
    root = mkdtempSync(join(tmpdir(), "pi-desktop-ui-c6-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    const marker = join(root, "ui-marker.txt");
    const nonce = `extension-ui-integration-${Date.now()}`;
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(agentDir, "auth.json"), "{}");
    writeFileSync(join(agentDir, "models.json"), "{}");
    writeFileSync(join(agentDir, "settings.json"), "{}");
    writeFileSync(join(agentDir, "trust.json"), "{}");

    const extDest = join(agentDir, "extensions", "ui-blocking-extension.ts");
    cpSync(uiFixtureSrc, extDest);
    expect(existsSync(extDest)).toBe(true);

    process.env.PI_DESKTOP_UI_MARKER = marker;
    process.env.PI_DESKTOP_UI_NONCE = nonce;
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
    const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
    const modelRegistry = ModelRegistry.create(
      authStorage,
      join(agentDir, "models.json"),
    );

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
      authStorage,
      modelRegistry,
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
        if (!req) {
          await new Promise((r) => setTimeout(r, 20));
          continue;
        }
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
    stopRespond = true;
    await Promise.race([
      respondLoop,
      new Promise((r) => setTimeout(r, 200)),
    ]);

    expect(existsSync(marker)).toBe(true);
    const body = readFileSync(marker, "utf8");
    expect(body).toContain("selected=beta");
    expect(body).toContain("confirmed=true");
    expect(body).toContain("typed=typed-value");
    expect(body).toContain("handler=session_start");
    expect(body).toContain("hasUI=true");
    expect(body).toContain(`nonce=${nonce}`);
    expect(events.some((e) => e.e === "extensionUi.request")).toBe(true);
    expect(events.some((e) => e.e === "extensionUi.statusChanged")).toBe(true);

    binding.cleanup();
    try {
      session.dispose?.();
    } catch {
      /* optional */
    }
  }, 60_000);
});
