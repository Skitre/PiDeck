/**
 * Integration tests for Pi Host using temporary PI_CODING_AGENT_DIR.
 * Never touches real ~/.pi/agent.
 */
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const hostEntry = join(__dirname, "main.ts");
const uiExtensionFixture = join(
  __dirname,
  "../../../test-fixtures/pi-packages/ui-extension/extensions/ui-blocking-extension.ts",
);

function createTempAgent(): { agentDir: string; projectDir: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "pideck-test-"));
  const agentDir = join(root, "agent");
  const projectDir = join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(agentDir, "auth.json"), "{}");
  writeFileSync(join(agentDir, "models.json"), "{}");
  writeFileSync(join(agentDir, "settings.json"), "{}");
  writeFileSync(join(agentDir, "trust.json"), "{}");
  return { agentDir, projectDir, root };
}

class HostProcess {
  proc: ChildProcessWithoutNullStreams;
  private buffer = "";
  private lines: string[] = [];
  private waiters: Array<(line: string) => void> = [];

  constructor(agentDir: string, extraEnv: Record<string, string> = {}) {
    this.proc = spawn(
      process.execPath,
      ["--import", "tsx", hostEntry, `--agent-dir=${agentDir}`],
      {
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, ...extraEnv },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        if (!line.trim()) continue;
        this.lines.push(line);
        const w = this.waiters.shift();
        if (w) w(line);
      }
    });
    this.proc.stderr.on("data", () => {
      /* host logs — ignore in tests */
    });
  }

  async nextLine(timeoutMs = 15_000): Promise<string> {
    if (this.lines.length) return this.lines.shift()!;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for host line")), timeoutMs);
      this.waiters.push((line) => {
        clearTimeout(timer);
        resolve(line);
      });
    });
  }

  async waitForEvent(event: string, timeoutMs = 15_000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const line = await this.nextLine(deadline - Date.now());
      const msg = JSON.parse(line) as Record<string, unknown>;
      if (msg.event === event) return msg;
      if (msg.ok !== undefined) {
        // response — keep looking for event, stash not needed
      }
    }
    throw new Error(`timeout waiting for event ${event}`);
  }

  send(obj: unknown): void {
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  async request(
    method: string,
    context: Record<string, unknown>,
    params: unknown,
    timeoutMs = 20_000,
  ): Promise<Record<string, unknown>> {
    const id = randomUUID();
    this.send({ protocolVersion: 1, id, method, context, params });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const line = await this.nextLine(deadline - Date.now());
      const msg = JSON.parse(line) as Record<string, unknown>;
      if (msg.id === id) return msg;
    }
    throw new Error(`timeout waiting for response ${method}`);
  }

  async kill(): Promise<void> {
    if (!this.proc.killed) {
      this.proc.kill();
    }
  }
}

function respondToExtensionUi(host: HostProcess, msg: Record<string, unknown>): boolean {
  if (msg.event !== "extensionUi.request") return false;
  expect(msg.workspaceId).toEqual(expect.any(String));
  expect(msg.sessionId).toEqual(expect.any(String));
  const payload = msg.payload as { requestId: string; kind: string };
  const value =
    payload.kind === "select"
      ? "beta"
      : payload.kind === "confirm"
        ? true
        : "typed-value";
  host.send({
    protocolVersion: 1,
    id: randomUUID(),
    method: "extensionUi.respond",
    context: {
      expectedHostInstanceId: msg.hostInstanceId,
      expectedWorkspaceId: msg.workspaceId,
      expectedWorkspaceRevision: msg.workspaceRevision,
      expectedSessionId: msg.sessionId,
      expectedSessionRevision: msg.sessionRevision,
    },
    params: { requestId: payload.requestId, status: "resolved", value },
  });
  return true;
}

describe("Pi Host integration", () => {
  let root: string;
  let agentDir: string;
  let projectDir: string;
  let host: HostProcess;

  beforeAll(async () => {
    const t = createTempAgent();
    root = t.root;
    agentDir = t.agentDir;
    projectDir = t.projectDir;
    host = new HostProcess(agentDir);
    await host.waitForEvent("host.ready");
  }, 30_000);

  afterAll(async () => {
    await host.kill();
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("system.hello returns HostStatusSnapshot with sdk 0.80.7", async () => {
    const res = await host.request("system.hello", {}, {
      clientName: "test",
      clientVersion: "0.0.0",
      protocolVersion: 1,
    });
    expect(res.ok).toBe(true);
    const result = res.result as {
      sdkVersion: string;
      hostInstanceId: string;
      phase: string;
      agentDir: string;
    };
    expect(result.sdkVersion).toBe("0.80.7");
    expect(result.hostInstanceId).toBeTruthy();
    expect(result.phase).toBe("waitingForWorkspace");
    expect(result.agentDir).toBe(agentDir);
  });

  it("rejects stale host instance", async () => {
    const res = await host.request(
      "system.getStatus",
      { expectedHostInstanceId: "00000000-0000-4000-8000-000000000099" },
      null,
    );
    expect(res.ok).toBe(false);
    expect((res.error as { code: string }).code).toBe("STALE_REVISION");
  });

  it("workspace.setCurrent without trust resources becomes ready", async () => {
    const hello = await host.request("system.hello", {}, {
      clientName: "test",
      clientVersion: "0.0.0",
      protocolVersion: 1,
    });
    const hostId = (hello.result as { hostInstanceId: string }).hostInstanceId;

    const res = await host.request(
      "workspace.setCurrent",
      {
        expectedHostInstanceId: hostId,
        expectedWorkspaceId: null,
        expectedWorkspaceRevision: 0,
      },
      { cwd: projectDir },
      60_000,
    );
    expect(res.ok).toBe(true);
    const result = res.result as {
      workspace: { servicesReady: boolean; trust: { decision: string }; id: string };
    };
    // Empty project typically notRequired
    expect(["notRequired", "pending", "trusted", "denied"]).toContain(
      result.workspace.trust.decision,
    );
    if (result.workspace.trust.decision === "notRequired") {
      expect(result.workspace.servicesReady).toBe(true);

      const renamed = await host.request(
        "session.setName",
        {
          expectedHostInstanceId: res.hostInstanceId,
          expectedWorkspaceId: res.workspaceId,
          expectedWorkspaceRevision: res.workspaceRevision,
          expectedSessionId: res.sessionId,
          expectedSessionRevision: res.sessionRevision,
        },
        { name: "Integration session" },
      );
      expect(renamed.ok).toBe(true);
      expect((renamed.result as { name?: string }).name).toBe("Integration session");

      const stillAlive = await host.request(
        "system.getStatus",
        { expectedHostInstanceId: res.hostInstanceId },
        null,
      );
      expect(stillAlive.ok).toBe(true);
    }
  }, 90_000);

  it("commits candidate identity before blocking Extension UI", async () => {
    const local = createTempAgent();
    const extensionsDir = join(local.agentDir, "extensions");
    mkdirSync(extensionsDir, { recursive: true });
    copyFileSync(uiExtensionFixture, join(extensionsDir, "ui-blocking-extension.ts"));
    const marker = join(local.root, "ui-marker.txt");
    const nonce = randomUUID();
    const uiHost = new HostProcess(local.agentDir, {
      PIDECK_UI_MARKER: marker,
      PIDECK_UI_NONCE: nonce,
    });

    try {
      await uiHost.waitForEvent("host.ready", 30_000);
      const hello = await uiHost.request("system.hello", {}, {
        clientName: "test",
        clientVersion: "0.0.0",
        protocolVersion: 1,
      });
      const hostId = (hello.result as { hostInstanceId: string }).hostInstanceId;
      const setCurrentId = randomUUID();
      uiHost.send({
        protocolVersion: 1,
        id: setCurrentId,
        method: "workspace.setCurrent",
        context: {
          expectedHostInstanceId: hostId,
          expectedWorkspaceId: null,
          expectedWorkspaceRevision: 0,
        },
        params: { cwd: local.projectDir },
      });

      let setCurrentResponse: Record<string, unknown> | null = null;
      const publishedEvents: string[] = [];
      const deadline = Date.now() + 60_000;
      while (!setCurrentResponse && Date.now() < deadline) {
        const msg = JSON.parse(await uiHost.nextLine(deadline - Date.now())) as Record<string, unknown>;
        if (typeof msg.event === "string") publishedEvents.push(msg.event);
        if (respondToExtensionUi(uiHost, msg)) continue;
        if (msg.id === setCurrentId) {
          setCurrentResponse = msg;
        }
      }

      expect(setCurrentResponse?.ok).toBe(true);
      expect(publishedEvents.indexOf("extensionUi.statusChanged")).toBeGreaterThan(
        publishedEvents.indexOf("session.snapshot"),
      );
      expect(publishedEvents.indexOf("extensionUi.notification")).toBeGreaterThan(
        publishedEvents.indexOf("session.snapshot"),
      );
      const markerDeadline = Date.now() + 5_000;
      while (!existsSync(marker) && Date.now() < markerDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(existsSync(marker)).toBe(true);
      const markerBody = readFileSync(marker, "utf8");
      expect(markerBody).toContain("selected=beta");
      expect(markerBody).toContain("confirmed=true");
      expect(markerBody).toContain("typed=typed-value");
      expect(markerBody).toContain(`nonce=${nonce}`);
      expect(markerBody).toContain("invocationCount=1");
      expect(markerBody).toContain("runtimeActive=true");

      const createId = randomUUID();
      uiHost.send({
        protocolVersion: 1,
        id: createId,
        method: "session.create",
        context: {
          expectedHostInstanceId: setCurrentResponse!.hostInstanceId,
          expectedWorkspaceId: setCurrentResponse!.workspaceId,
          expectedWorkspaceRevision: setCurrentResponse!.workspaceRevision,
          expectedSessionId: setCurrentResponse!.sessionId,
          expectedSessionRevision: setCurrentResponse!.sessionRevision,
        },
        params: {},
      });

      let createResponse: Record<string, unknown> | null = null;
      const createDeadline = Date.now() + 60_000;
      while (!createResponse && Date.now() < createDeadline) {
        const msg = JSON.parse(
          await uiHost.nextLine(createDeadline - Date.now()),
        ) as Record<string, unknown>;
        if (respondToExtensionUi(uiHost, msg)) continue;
        if (msg.id === createId) createResponse = msg;
      }
      expect(createResponse?.ok).toBe(true);
      const secondMarker = readFileSync(marker, "utf8");
      expect(secondMarker).toContain("invocationCount=2");
      expect(secondMarker).toContain("runtimeActive=true");

      const createdSession = createResponse!.result as { sessionPath: string };
      const reopened = await uiHost.request(
        "session.open",
        {
          expectedHostInstanceId: createResponse!.hostInstanceId,
          expectedWorkspaceId: createResponse!.workspaceId,
          expectedWorkspaceRevision: createResponse!.workspaceRevision,
          expectedSessionId: createResponse!.sessionId,
          expectedSessionRevision: createResponse!.sessionRevision,
        },
        { sessionPath: createdSession.sessionPath },
      );
      expect(reopened.ok).toBe(true);
      expect(reopened.sessionId).toBe(createResponse!.sessionId);
      expect(reopened.sessionRevision).toBe(createResponse!.sessionRevision);
      expect(readFileSync(marker, "utf8")).toContain("invocationCount=2");
    } finally {
      await uiHost.kill();
      rmSync(local.root, { recursive: true, force: true });
    }
  }, 90_000);

  it("system.shutdown accepts", async () => {
    const hello = await host.request("system.hello", {}, {
      clientName: "test",
      clientVersion: "0.0.0",
      protocolVersion: 1,
    });
    const hostId = (hello.result as { hostInstanceId: string }).hostInstanceId;
    const res = await host.request(
      "system.shutdown",
      { expectedHostInstanceId: hostId },
      null,
    );
    expect(res.ok).toBe(true);
  });
});

describe("Pi Host transport lifecycle", () => {
  it("exits when stdin closes without system.shutdown", async () => {
    const t = createTempAgent();
    const eofHost = new HostProcess(t.agentDir);
    try {
      await eofHost.waitForEvent("host.ready");

      const exited = new Promise<number | null>((resolve) => {
        eofHost.proc.once("exit", (code) => resolve(code));
      });
      eofHost.proc.stdin.end();

      const code = await Promise.race([
        exited,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("host did not exit after stdin EOF")), 15_000),
        ),
      ]);
      expect(code).toBe(0);
    } finally {
      await eofHost.kill();
      rmSync(t.root, { recursive: true, force: true });
    }
  }, 30_000);
});
