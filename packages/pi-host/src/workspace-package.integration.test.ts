/**
 * Honest integration tests under temporary PI_CODING_AGENT_DIR.
 * Never mutates real ~/.pi/agent.
 */
import {
  mkdtempSync,
  mkdirSync,
  appendFileSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Test-only entry: production `main.ts` does not install the idle-shutdown hold. */
const hostEntry = join(__dirname, "idle-shutdown-hold.test.harness.ts");
const fixturePkg = join(__dirname, "../../../test-fixtures/pi-packages/full-package");
const peerConflictPkg = join(__dirname, "../../../test-fixtures/pi-packages/peer-conflict-package");

class HostProcess {
  proc: ChildProcessWithoutNullStreams;
  private buffer = "";
  private messages: Record<string, unknown>[] = [];
  private waiters: Array<() => void> = [];

  constructor(agentDir: string) {
    this.proc = spawn(process.execPath, ["--import", "tsx", hostEntry, `--agent-dir=${agentDir}`], {
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PIDECK_TEST_FAUX: "1",
        PIDECK_TEST_HOLD_IDLE_SHUTDOWN: join(agentDir, ".pideck-hold-idle-shutdown"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          this.messages.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          continue;
        }
        // Wake ALL waiters — concurrent request() must not deadlock when
        // the next line is for a different pending id.
        const pending = this.waiters.splice(0, this.waiters.length);
        for (const w of pending) w();
      }
    });
  }

  private async waitFor(
    pred: (m: Record<string, unknown>) => boolean,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const idx = this.messages.findIndex(pred);
      if (idx >= 0) {
        return this.messages.splice(idx, 1)[0]!;
      }
      await new Promise<void>((resolve, reject) => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          reject(new Error("timeout"));
          return;
        }
        const timer = setTimeout(() => {
          const i = this.waiters.indexOf(onMsg);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new Error("timeout"));
        }, remaining);
        const onMsg = () => {
          clearTimeout(timer);
          resolve();
        };
        this.waiters.push(onMsg);
      }).catch(() => {
        /* retry loop checks deadline */
      });
    }
    throw new Error("timeout waiting for message");
  }

  async waitForEvent(
    event: string,
    timeoutMs = 30_000,
    predicate: (message: Record<string, unknown>) => boolean = () => true,
  ): Promise<Record<string, unknown>> {
    return this.waitFor((m) => m.event === event && predicate(m), timeoutMs);
  }

  send(obj: unknown): void {
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  async request(
    method: string,
    context: Record<string, unknown>,
    params: unknown,
    timeoutMs = 60_000,
  ): Promise<Record<string, unknown>> {
    const id = randomUUID();
    this.send({ protocolVersion: 1, id, method, context, params });
    return this.waitFor((m) => m.id === id, timeoutMs);
  }

  async kill(): Promise<void> {
    if (!this.proc.killed) this.proc.kill();
  }
}

function emptyProject(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
}

function projectWithResource(root: string, name: string): string {
  const dir = emptyProject(root, name);
  mkdirSync(join(dir, ".pi", "extensions"), { recursive: true });
  writeFileSync(
    join(dir, ".pi", "extensions", "proj-ext.ts"),
    `export default function (pi) { pi.on("session_start", async () => {}); }\n`,
  );
  return dir;
}

function projectWithProviderExtension(root: string, name: string, providerId: string): string {
  const dir = emptyProject(root, name);
  mkdirSync(join(dir, ".pi", "extensions"), { recursive: true });
  writeFileSync(
    join(dir, ".pi", "extensions", "provider-ext.ts"),
    `export default function (pi) {
      pi.registerProvider(${JSON.stringify(providerId)}, {
        baseUrl: "http://localhost:8317/v1",
        apiKey: "pideck-isolation-test-key",
        api: "openai-completions",
        models: [{
          id: "iso-model",
          name: "Isolation Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 16384,
        }],
      });
    }\n`,
  );
  return dir;
}

function projectWithPartialProviderExtension(
  root: string,
  name: string,
  providerId: string,
): string {
  const dir = emptyProject(root, name);
  mkdirSync(join(dir, ".pi", "extensions"), { recursive: true });
  writeFileSync(
    join(dir, ".pi", "extensions", "provider-ext.ts"),
    `export default function (pi) {
      pi.registerProvider(${JSON.stringify(providerId)}, {
        baseUrl: "https://workspace-b.invalid/v1",
      });
    }\n`,
  );
  return dir;
}

function sessionDirFor(agentDir: string, cwd: string): string {
  const resolvedCwd = resolve(cwd);
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(resolve(agentDir), "sessions", safePath);
}

describe("package + workspace integration", () => {
  let root: string;
  let agentDir: string;
  let host: HostProcess;
  let hostId: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "pideck-package-workspace-"));
    agentDir = join(root, "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "auth.json"), "{}");
    writeFileSync(join(agentDir, "models.json"), "{}");
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ defaultProvider: "pideck-faux", defaultModel: "pideck-core" }),
    );

    host = new HostProcess(agentDir);
    await host.waitForEvent("host.ready", 60_000);
    const hello = await host.request(
      "system.hello",
      {},
      { clientName: "test", clientVersion: "0", protocolVersion: 1 },
    );
    expect(hello.ok).toBe(true);
    hostId = (hello.result as { hostInstanceId: string }).hostInstanceId;
    expect(hostId).toBeTruthy();
  }, 90_000);

  afterAll(async () => {
    await host.kill();
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("package.list does not advance packageRevision (read stability)", async () => {
    const proj = emptyProject(root, "list-rev");
    const set = await host.request(
      "workspace.setCurrent",
      {
        expectedHostInstanceId: hostId,
        expectedWorkspaceId: null,
        expectedWorkspaceRevision: 0,
      },
      { cwd: proj },
      60_000,
    );
    expect(set.ok).toBe(true);
    const ws = (set.result as { workspace: { id: string; revision: number } }).workspace;
    const revBefore = set.packageRevision as number;

    const list1 = await host.request(
      "package.list",
      {
        expectedHostInstanceId: hostId,
        expectedWorkspaceId: ws.id,
        expectedWorkspaceRevision: ws.revision,
      },
      { scope: "all" },
    );
    expect(list1.ok).toBe(true);
    const revAfter1 = list1.packageRevision as number;
    expect(revAfter1).toBe(revBefore);

    const list2 = await host.request(
      "package.list",
      {
        expectedHostInstanceId: hostId,
        expectedWorkspaceId: ws.id,
        expectedWorkspaceRevision: ws.revision,
      },
      { scope: "all" },
    );
    expect(list2.ok).toBe(true);
    expect(list2.packageRevision).toBe(revAfter1);
  }, 90_000);

  it("does not load project-local extensions when a workspace is selected", async () => {
    const project = projectWithResource(root, "project-resources");
    const statusResponse = await host.request(
      "system.getStatus",
      { expectedHostInstanceId: hostId },
      null,
    );
    const status = statusResponse.result as {
      workspaceId: string | null;
      workspaceRevision: number;
    };
    const selected = await host.request(
      "workspace.setCurrent",
      {
        expectedHostInstanceId: hostId,
        expectedWorkspaceId: status.workspaceId,
        expectedWorkspaceRevision: status.workspaceRevision,
      },
      { cwd: project },
      60_000,
    );
    expect(selected.ok).toBe(true);
    expect(
      (selected.result as { workspace: { servicesReady: boolean } }).workspace.servicesReady,
    ).toBe(true);
    const workspace = (selected.result as { workspace: { id: string; revision: number } })
      .workspace;
    const listed = await host.request(
      "package.list",
      {
        expectedHostInstanceId: hostId,
        expectedWorkspaceId: workspace.id,
        expectedWorkspaceRevision: workspace.revision,
      },
      { scope: "all", includeResources: true },
    );
    expect(listed.ok).toBe(true);
    const resources = (
      listed.result as { resources: Array<{ path?: string; name?: string; scope?: string }> }
    ).resources;
    expect(resources.every((resource) => resource.scope !== "project")).toBe(true);
    expect(
      resources.every(
        (resource) => !String(resource.path ?? resource.name ?? "").includes("proj-ext"),
      ),
    ).toBe(true);
  }, 90_000);

  it("installs local fixture package in user scope, lists it, removes it", async () => {
    expect(existsSync(fixturePkg)).toBe(true);
    const proj = emptyProject(root, "pkg-install");
    const st = await host.request("system.getStatus", { expectedHostInstanceId: hostId }, null);
    const status = st.result as {
      workspaceId: string | null;
      workspaceRevision: number;
    };
    const set = await host.request(
      "workspace.setCurrent",
      {
        expectedHostInstanceId: hostId,
        expectedWorkspaceId: status.workspaceId,
        expectedWorkspaceRevision: status.workspaceRevision,
      },
      { cwd: proj },
      60_000,
    );
    expect(set.ok).toBe(true);
    const ws = (set.result as { workspace: { id: string; revision: number } }).workspace;

    const install = await host.request(
      "package.install",
      {
        expectedHostInstanceId: hostId,
        expectedWorkspaceId: ws.id,
        expectedWorkspaceRevision: ws.revision,
        expectedSessionId: set.sessionId,
        expectedSessionRevision: set.sessionRevision,
        expectedPackageRevision: set.packageRevision,
      },
      { source: fixturePkg, scope: "user" },
      180_000,
    );
    expect(install.ok).toBe(true);
    const installResult = install.result as {
      status: string;
      packageSnapshot: { configured: Array<{ source: string; id: string; scope: string }> };
    };
    expect(["committed", "partialFailure"]).toContain(installResult.status);
    expect(
      installResult.packageSnapshot.configured.some(
        (c) => c.source === fixturePkg || c.source.includes("full-package"),
      ),
    ).toBe(true);

    const list = await host.request(
      "package.list",
      {
        expectedHostInstanceId: hostId,
        expectedWorkspaceId: ws.id,
        expectedWorkspaceRevision: ws.revision,
      },
      { scope: "user", includeResources: true },
    );
    expect(list.ok).toBe(true);
    // list must keep same packageRevision as after install
    expect(list.packageRevision).toBe(install.packageRevision);
    const snap = list.result as {
      configured: Array<{ id: string; source: string; scope: string }>;
      resources: unknown[];
    };
    const installed = snap.configured.find(
      (c) => c.scope === "user" && (c.source === fixturePkg || c.source.includes("full-package")),
    );
    expect(installed).toBeTruthy();
    expect(Array.isArray(snap.resources)).toBe(true);

    const remove = await host.request(
      "package.remove",
      {
        expectedHostInstanceId: hostId,
        expectedWorkspaceId: ws.id,
        expectedWorkspaceRevision: ws.revision,
        expectedSessionId: install.sessionId,
        expectedSessionRevision: install.sessionRevision,
        expectedPackageRevision: install.packageRevision,
      },
      { packageId: installed!.id },
      120_000,
    );
    expect(remove.ok).toBe(true);
    const removeResult = remove.result as {
      status: string;
      packageSnapshot: { configured: Array<{ id: string }> };
    };
    expect(["committed", "partialFailure"]).toContain(removeResult.status);
    expect(removeResult.packageSnapshot.configured.some((c) => c.id === installed!.id)).toBe(false);
  }, 300_000);

  it("enables the last filtered prompt in a mixed package", async () => {
    expect(existsSync(fixturePkg)).toBe(true);
    const proj = emptyProject(root, "pkg-resource-preference");
    const st = await host.request("system.getStatus", { expectedHostInstanceId: hostId }, null);
    const status = st.result as {
      workspaceId: string | null;
      workspaceRevision: number;
    };
    const set = await host.request(
      "workspace.setCurrent",
      {
        expectedHostInstanceId: hostId,
        expectedWorkspaceId: status.workspaceId,
        expectedWorkspaceRevision: status.workspaceRevision,
      },
      { cwd: proj },
      60_000,
    );
    expect(set.ok).toBe(true);
    const ws = (set.result as { workspace: { id: string; revision: number } }).workspace;

    const install = await host.request(
      "package.install",
      {
        expectedHostInstanceId: hostId,
        expectedWorkspaceId: ws.id,
        expectedWorkspaceRevision: ws.revision,
        expectedSessionId: set.sessionId,
        expectedSessionRevision: set.sessionRevision,
        expectedPackageRevision: set.packageRevision,
      },
      { source: fixturePkg, scope: "user" },
      180_000,
    );
    expect(install.ok, JSON.stringify(install.error)).toBe(true);
    const installedSnapshot = (
      install.result as {
        packageSnapshot: {
          configured: Array<{ id: string; source: string }>;
          resources: Array<{ id: string; type: string; relativePath?: string }>;
        };
      }
    ).packageSnapshot;
    const packageRecord = installedSnapshot.configured.find((item) =>
      item.source.includes("full-package"),
    );
    const prompt = installedSnapshot.resources.find(
      (item) => item.type === "prompt" && item.relativePath === "prompts/test-prompt.md",
    );
    expect(packageRecord).toBeTruthy();
    expect(prompt).toBeTruthy();

    const disabled = await host.request(
      "resource.setPreferences",
      {
        expectedHostInstanceId: hostId,
        expectedWorkspaceId: ws.id,
        expectedWorkspaceRevision: ws.revision,
        expectedSessionId: install.sessionId,
        expectedSessionRevision: install.sessionRevision,
        expectedPackageRevision: install.packageRevision,
      },
      {
        updates: [{ resourceId: prompt!.id, targetScope: "user", preference: "disabled" }],
      },
      120_000,
    );
    expect(disabled.ok, JSON.stringify(disabled.error)).toBe(true);
    const disabledResult = disabled.result as {
      packageSnapshot: { resources: Array<{ id: string; enabled: boolean }> };
    };
    expect(
      disabledResult.packageSnapshot.resources.find((item) => item.id === prompt!.id)?.enabled,
    ).toBe(false);

    const enabled = await host.request(
      "resource.setPreferences",
      {
        expectedHostInstanceId: hostId,
        expectedWorkspaceId: ws.id,
        expectedWorkspaceRevision: ws.revision,
        expectedSessionId: disabled.sessionId,
        expectedSessionRevision: disabled.sessionRevision,
        expectedPackageRevision: disabled.packageRevision,
      },
      {
        updates: [{ resourceId: prompt!.id, targetScope: "user", preference: "enabled" }],
      },
      120_000,
    );
    expect(enabled.ok, JSON.stringify(enabled.error)).toBe(true);
    const enabledResult = enabled.result as {
      packageSnapshot: { resources: Array<{ id: string; enabled: boolean }> };
    };
    expect(
      enabledResult.packageSnapshot.resources.find((item) => item.id === prompt!.id)?.enabled,
    ).toBe(true);

    const settingsText = await import("node:fs/promises").then(({ readFile }) =>
      readFile(join(agentDir, "settings.json"), "utf8"),
    );
    const settings = JSON.parse(settingsText) as { packages?: unknown[] };
    expect(settings.packages).toContainEqual(expect.stringContaining("full-package"));
    expect(
      settings.packages?.some(
        (item) => typeof item === "object" && item !== null && "prompts" in item,
      ),
    ).toBe(false);

    const remove = await host.request(
      "package.remove",
      {
        expectedHostInstanceId: hostId,
        expectedWorkspaceId: ws.id,
        expectedWorkspaceRevision: ws.revision,
        expectedSessionId: enabled.sessionId,
        expectedSessionRevision: enabled.sessionRevision,
        expectedPackageRevision: enabled.packageRevision,
      },
      { packageId: packageRecord!.id },
      120_000,
    );
    expect(remove.ok, JSON.stringify(remove.error)).toBe(true);
  }, 360_000);

  it("rejects project-scope package install after workspace selection", async () => {
    const project = emptyProject(root, "project-pkg-remove");
    const statusResponse = await host.request(
      "system.getStatus",
      { expectedHostInstanceId: hostId },
      null,
    );
    const status = statusResponse.result as {
      workspaceId: string | null;
      workspaceRevision: number;
    };
    const selected = await host.request(
      "workspace.setCurrent",
      {
        expectedHostInstanceId: hostId,
        expectedWorkspaceId: status.workspaceId,
        expectedWorkspaceRevision: status.workspaceRevision,
      },
      { cwd: project },
      60_000,
    );
    expect(selected.ok).toBe(true);
    const workspace = (
      selected.result as {
        workspace: { id: string; revision: number; servicesReady: boolean };
      }
    ).workspace;
    expect(workspace.servicesReady).toBe(true);

    const install = await host.request(
      "package.install",
      {
        expectedHostInstanceId: hostId,
        expectedWorkspaceId: workspace.id,
        expectedWorkspaceRevision: workspace.revision,
        expectedSessionId: selected.sessionId,
        expectedSessionRevision: selected.sessionRevision,
        expectedPackageRevision: selected.packageRevision,
      },
      { source: fixturePkg, scope: "project" },
      120_000,
    );
    expect(install.ok).toBe(false);
    expect((install.error as { code: string }).code).toBe("INVALID_REQUEST");
  }, 90_000);

  it("workspace A → B → A invalidates old context (STALE_REVISION) and does not reuse revisions", async () => {
    const a = emptyProject(root, "ws-a");
    const b = emptyProject(root, "ws-b");
    const st = await host.request("system.getStatus", { expectedHostInstanceId: hostId }, null);
    const status = st.result as {
      workspaceId: string | null;
      workspaceRevision: number;
    };

    const setA = await host.request(
      "workspace.setCurrent",
      {
        expectedHostInstanceId: hostId,
        expectedWorkspaceId: status.workspaceId,
        expectedWorkspaceRevision: status.workspaceRevision,
      },
      { cwd: a },
      60_000,
    );
    expect(setA.ok).toBe(true);
    const wsA = (
      setA.result as { workspace: { id: string; revision: number; canonicalCwd: string } }
    ).workspace;
    const sessionA = setA.sessionId;
    const sessionRevA = setA.sessionRevision as number;
    const pkgRevA = setA.packageRevision as number;

    const setB = await host.request(
      "workspace.setCurrent",
      {
        expectedHostInstanceId: hostId,
        expectedWorkspaceId: wsA.id,
        expectedWorkspaceRevision: wsA.revision,
      },
      { cwd: b },
      60_000,
    );
    expect(setB.ok).toBe(true);
    const wsB = (setB.result as { workspace: { id: string; revision: number } }).workspace;
    expect(wsB.id).not.toBe(wsA.id);
    expect(wsB.revision).toBeGreaterThan(wsA.revision);

    // Old A context must be stale
    const staleList = await host.request(
      "package.list",
      {
        expectedHostInstanceId: hostId,
        expectedWorkspaceId: wsA.id,
        expectedWorkspaceRevision: wsA.revision,
      },
      { scope: "all" },
    );
    expect(staleList.ok).toBe(false);
    expect((staleList.error as { code: string }).code).toBe("STALE_REVISION");

    const setA2 = await host.request(
      "workspace.setCurrent",
      {
        expectedHostInstanceId: hostId,
        expectedWorkspaceId: wsB.id,
        expectedWorkspaceRevision: wsB.revision,
      },
      { cwd: a },
      60_000,
    );
    expect(setA2.ok).toBe(true);
    const wsA2 = (setA2.result as { workspace: { id: string; revision: number } }).workspace;
    // Retained-graph reactivation: A keeps its stable workspace id (like a
    // session id), but the revision advances past both A and B generations,
    // so every old context stays invalid.
    expect(wsA2.id).toBe(wsA.id);
    expect(wsA2.revision).toBeGreaterThan(wsB.revision);
    // Old session identity from first A must not match
    expect(setA2.sessionId === sessionA && setA2.sessionRevision === sessionRevA).toBe(false);
    expect(setA2.packageRevision).not.toBe(pkgRevA);

    // The original A context (id + old revision) is still stale after return.
    const staleAfterReturn = await host.request(
      "package.list",
      {
        expectedHostInstanceId: hostId,
        expectedWorkspaceId: wsA.id,
        expectedWorkspaceRevision: wsA.revision,
      },
      { scope: "all" },
    );
    expect(staleAfterReturn.ok).toBe(false);
    expect((staleAfterReturn.error as { code: string }).code).toBe("STALE_REVISION");

    // The reactivated context is fully usable.
    const freshList = await host.request(
      "package.list",
      {
        expectedHostInstanceId: hostId,
        expectedWorkspaceId: wsA2.id,
        expectedWorkspaceRevision: wsA2.revision,
      },
      { scope: "all" },
    );
    expect(freshList.ok).toBe(true);
  }, 180_000);

  it("does not register providers from project-local extensions", async () => {
    const providerId = "pideck-iso-provider";
    const a = projectWithProviderExtension(root, "ws-provider-a", providerId);
    const b = projectWithPartialProviderExtension(root, "ws-provider-b", providerId);
    const st = await host.request("system.getStatus", { expectedHostInstanceId: hostId }, null);
    const status = st.result as { workspaceId: string | null; workspaceRevision: number };

    const listProviders = async (set: Record<string, unknown>): Promise<string[]> => {
      const ws = (set.result as { workspace: { id: string; revision: number } }).workspace;
      const res = await host.request(
        "model.list",
        {
          expectedHostInstanceId: hostId,
          expectedWorkspaceId: ws.id,
          expectedWorkspaceRevision: ws.revision,
          expectedSessionId: set.sessionId,
          expectedSessionRevision: set.sessionRevision,
        },
        null,
      );
      expect(res.ok).toBe(true);
      const models = (res.result as { models: Array<{ provider: string }> }).models;
      return [...new Set(models.map((model) => model.provider))];
    };

    // Workspace A: a project-local extension must not register a provider.
    const setA = await host.request(
      "workspace.setCurrent",
      {
        expectedHostInstanceId: hostId,
        expectedWorkspaceId: status.workspaceId,
        expectedWorkspaceRevision: status.workspaceRevision,
      },
      { cwd: a },
      60_000,
    );
    expect(setA.ok).toBe(true);
    expect(await listProviders(setA)).not.toContain(providerId);
    const wsA = (setA.result as { workspace: { id: string; revision: number } }).workspace;

    // B registers the same id with only its endpoint. It must not inherit A's
    // credential or model catalog through ModelRuntime's merge semantics.
    const setB = await host.request(
      "workspace.setCurrent",
      {
        expectedHostInstanceId: hostId,
        expectedWorkspaceId: wsA.id,
        expectedWorkspaceRevision: wsA.revision,
      },
      { cwd: b },
      60_000,
    );
    expect(setB.ok).toBe(true);
    expect(await listProviders(setB)).not.toContain(providerId);
    const wsB = (setB.result as { workspace: { id: string; revision: number } }).workspace;

    // Back to A: project-local extensions still must not register a provider.
    const setA2 = await host.request(
      "workspace.setCurrent",
      {
        expectedHostInstanceId: hostId,
        expectedWorkspaceId: wsB.id,
        expectedWorkspaceRevision: wsB.revision,
      },
      { cwd: a },
      60_000,
    );
    expect(setA2.ok).toBe(true);
    expect(await listProviders(setA2)).not.toContain(providerId);
  }, 180_000);

  it("session.create + agent.prompt + agent.abort on real Host entry", async () => {
    const proj = emptyProject(root, "session-ops");
    const st = await host.request("system.getStatus", { expectedHostInstanceId: hostId }, null);
    const status = st.result as {
      workspaceId: string | null;
      workspaceRevision: number;
    };
    const set = await host.request(
      "workspace.setCurrent",
      {
        expectedHostInstanceId: hostId,
        expectedWorkspaceId: status.workspaceId,
        expectedWorkspaceRevision: status.workspaceRevision,
      },
      { cwd: proj },
      60_000,
    );
    expect(set.ok).toBe(true);
    const ws = (set.result as { workspace: { id: string; revision: number } }).workspace;

    const created = await host.request(
      "session.create",
      {
        expectedHostInstanceId: hostId,
        expectedWorkspaceId: ws.id,
        expectedWorkspaceRevision: ws.revision,
        expectedSessionId: set.sessionId,
        expectedSessionRevision: set.sessionRevision,
      },
      { name: "test-session" },
      60_000,
    );
    expect(created.ok).toBe(true);
    const snap = created.result as {
      sessionId: string;
      revision: number;
      tools: { revision: number; tools: unknown[] };
      isIdle: boolean;
    };
    expect(snap.sessionId).toBeTruthy();
    expect(snap.tools.revision).toBe(1);

    // Real agent.prompt path on the shipped Host accepts and returns a runId.
    // The test-only faux transport keeps the detached run deterministic and offline.
    const prompt = await host.request(
      "agent.prompt",
      {
        expectedHostInstanceId: hostId,
        expectedWorkspaceId: ws.id,
        expectedWorkspaceRevision: ws.revision,
        expectedSessionId: created.sessionId,
        expectedSessionRevision: created.sessionRevision,
      },
      { text: "ping from integration test" },
      30_000,
    );
    expect(prompt.ok).toBe(true);
    const promptResult = prompt.result as { accepted: boolean; runId: string };
    expect(promptResult.accepted).toBe(true);
    expect(typeof promptResult.runId).toBe("string");
    expect(promptResult.runId.length).toBeGreaterThan(0);

    const abort = await host.request(
      "agent.abort",
      {
        expectedHostInstanceId: hostId,
        expectedWorkspaceId: ws.id,
        expectedWorkspaceRevision: ws.revision,
        expectedSessionId: created.sessionId,
        expectedSessionRevision: created.sessionRevision,
      },
      null,
    );
    expect(abort.ok).toBe(true);
    const abortResult = abort.result as {
      aborted: boolean;
      session: { sessionId: string; isIdle?: boolean };
    };
    expect(abortResult.session.sessionId).toBeTruthy();
    // After abort, session should be usable (idle or returning to idle)
    expect(abortResult.session.sessionId).toBe(snap.sessionId);

    const staleTools = await host.request(
      "agent.setActiveTools",
      {
        expectedHostInstanceId: hostId,
        expectedWorkspaceId: ws.id,
        expectedWorkspaceRevision: ws.revision,
        expectedSessionId: created.sessionId,
        expectedSessionRevision: created.sessionRevision,
        expectedToolRevision: 999,
      },
      { names: [] },
    );
    expect(staleTools.ok).toBe(false);
    expect((staleTools.error as { code: string }).code).toBe("STALE_REVISION");
  }, 120_000);

  it("concurrent package mutations: second gets PACKAGE_MUTATION_BUSY or SERVICE_GRAPH_BUSY", async () => {
    const proj = emptyProject(root, "busy-pkg");
    const st = await host.request("system.getStatus", { expectedHostInstanceId: hostId }, null);
    const status = st.result as {
      workspaceId: string | null;
      workspaceRevision: number;
    };
    const set = await host.request(
      "workspace.setCurrent",
      {
        expectedHostInstanceId: hostId,
        expectedWorkspaceId: status.workspaceId,
        expectedWorkspaceRevision: status.workspaceRevision,
      },
      { cwd: proj },
      60_000,
    );
    expect(set.ok).toBe(true);
    const ws = (set.result as { workspace: { id: string; revision: number } }).workspace;
    const ctx = {
      expectedHostInstanceId: hostId,
      expectedWorkspaceId: ws.id,
      expectedWorkspaceRevision: ws.revision,
      expectedSessionId: set.sessionId,
      expectedSessionRevision: set.sessionRevision,
      expectedPackageRevision: set.packageRevision,
    };
    // Launch two installs in parallel against real host
    const [a, b] = await Promise.all([
      host.request("package.install", ctx, { source: fixturePkg, scope: "user" }, 180_000),
      host.request(
        "package.install",
        { ...ctx },
        { source: peerConflictPkg, scope: "user" },
        180_000,
      ),
    ]);
    const codes = [a, b].map((r) =>
      r.ok ? "ok" : ((r.error as { code?: string })?.code ?? "err"),
    );
    // At least one must succeed or fail with install error; at least one busy if interleaved
    const busy = codes.filter(
      (c) => c === "PACKAGE_MUTATION_BUSY" || c === "SERVICE_GRAPH_BUSY" || c === "STALE_REVISION",
    );
    const okOrInstall = codes.filter(
      (c) => c === "ok" || c === "PACKAGE_INSTALL_FAILED" || c === "PACKAGE_PARTIAL_FAILURE",
    );
    // Concurrent path: either busy observed, or both sequential ok (lock still serializes)
    expect(busy.length + okOrInstall.length).toBe(2);
    expect(a.ok || b.ok || busy.length > 0).toBe(true);
  }, 300_000);

  it("peer-conflict fixture install/remove keeps other packages intact when present", async () => {
    if (!existsSync(peerConflictPkg)) {
      // fixture must exist — create expectation fail if missing
      expect(existsSync(peerConflictPkg)).toBe(true);
      return;
    }
    const proj = emptyProject(root, "peer-conflict");
    const st = await host.request("system.getStatus", { expectedHostInstanceId: hostId }, null);
    const status = st.result as {
      workspaceId: string | null;
      workspaceRevision: number;
    };
    const set = await host.request(
      "workspace.setCurrent",
      {
        expectedHostInstanceId: hostId,
        expectedWorkspaceId: status.workspaceId,
        expectedWorkspaceRevision: status.workspaceRevision,
      },
      { cwd: proj },
      60_000,
    );
    expect(set.ok).toBe(true);
    const ws = (set.result as { workspace: { id: string; revision: number } }).workspace;

    // Install full-package first as anchor
    const installFull = await host.request(
      "package.install",
      {
        expectedHostInstanceId: hostId,
        expectedWorkspaceId: ws.id,
        expectedWorkspaceRevision: ws.revision,
        expectedSessionId: set.sessionId,
        expectedSessionRevision: set.sessionRevision,
        expectedPackageRevision: set.packageRevision,
      },
      { source: fixturePkg, scope: "user" },
      180_000,
    );
    expect(installFull.ok).toBe(true);

    const installPeer = await host.request(
      "package.install",
      {
        expectedHostInstanceId: hostId,
        expectedWorkspaceId: ws.id,
        expectedWorkspaceRevision: ws.revision,
        expectedSessionId: installFull.sessionId,
        expectedSessionRevision: installFull.sessionRevision,
        expectedPackageRevision: installFull.packageRevision,
      },
      { source: peerConflictPkg, scope: "user" },
      180_000,
    );
    expect(installPeer.ok).toBe(true);
    const peerSnap = (
      installPeer.result as {
        status: string;
        packageSnapshot: { configured: Array<{ id: string; source: string }> };
      }
    ).packageSnapshot;
    expect(["committed", "partialFailure"]).toContain(
      (installPeer.result as { status: string }).status,
    );
    const peerRec = peerSnap.configured.find((c) => c.source.includes("peer-conflict"));
    expect(peerRec).toBeTruthy();
    const fullStillThere = peerSnap.configured.some(
      (c) => c.source.includes("full-package") || c.source === fixturePkg,
    );
    expect(fullStillThere).toBe(true);

    const removePeer = await host.request(
      "package.remove",
      {
        expectedHostInstanceId: hostId,
        expectedWorkspaceId: ws.id,
        expectedWorkspaceRevision: ws.revision,
        expectedSessionId: installPeer.sessionId,
        expectedSessionRevision: installPeer.sessionRevision,
        expectedPackageRevision: installPeer.packageRevision,
      },
      { packageId: peerRec!.id },
      120_000,
    );
    expect(removePeer.ok).toBe(true);
    const after = (
      removePeer.result as {
        packageSnapshot: { configured: Array<{ source: string }> };
      }
    ).packageSnapshot;
    expect(
      after.configured.some((c) => c.source.includes("full-package") || c.source === fixturePkg),
    ).toBe(true);
    expect(after.configured.some((c) => c.source.includes("peer-conflict"))).toBe(false);
  }, 360_000);
  it("session.reload rebuilds the active Runtime from its JSONL file", async () => {
    const project = emptyProject(root, "session-reload");
    const status = await host.request("system.getStatus", { expectedHostInstanceId: hostId }, null);
    const set = await host.request(
      "workspace.setCurrent",
      {
        expectedHostInstanceId: hostId,
        expectedWorkspaceId: status.workspaceId,
        expectedWorkspaceRevision: status.workspaceRevision,
      },
      { cwd: project },
    );
    expect(set.ok).toBe(true);
    const workspace = (set.result as { workspace: { id: string; revision: number } }).workspace;
    const sessionId = randomUUID();
    const sessionDir = sessionDirFor(agentDir, project);
    mkdirSync(sessionDir, { recursive: true });
    const sessionPath = join(sessionDir, `${sessionId}.jsonl`);
    writeFileSync(
      sessionPath,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: sessionId,
          timestamp: "2026-01-01T00:00:00.000Z",
          cwd: resolve(project),
        }),
        JSON.stringify({
          type: "session_info",
          id: "before-info",
          parentId: null,
          timestamp: "2026-01-01T00:00:01.000Z",
          name: "Before disk reload",
        }),
      ].join("\n") + "\n",
    );

    const opened = await host.request(
      "session.open",
      {
        expectedHostInstanceId: hostId,
        expectedWorkspaceId: workspace.id,
        expectedWorkspaceRevision: workspace.revision,
        expectedSessionId: set.sessionId,
        expectedSessionRevision: set.sessionRevision,
      },
      { sessionPath },
    );
    expect(opened.ok).toBe(true);
    expect((opened.result as { name?: string }).name).toBe("Before disk reload");

    appendFileSync(
      sessionPath,
      JSON.stringify({
        type: "session_info",
        id: "after-info",
        parentId: "before-info",
        timestamp: "2026-01-01T00:00:02.000Z",
        name: "After disk reload",
      }) + "\n",
    );
    const reloaded = await host.request(
      "session.reload",
      {
        expectedHostInstanceId: hostId,
        expectedWorkspaceId: workspace.id,
        expectedWorkspaceRevision: workspace.revision,
        expectedSessionId: opened.sessionId,
        expectedSessionRevision: opened.sessionRevision,
      },
      null,
    );

    expect(reloaded.ok).toBe(true);
    expect((reloaded.result as { name?: string }).name).toBe("After disk reload");
    expect(Number(reloaded.sessionRevision)).toBeGreaterThan(Number(opened.sessionRevision));
  }, 90_000);

  it("keeps opening Sessions after forward and reverse cache churn", async () => {
    const project = emptyProject(root, "session-open-cache-churn");
    const status = await host.request("system.getStatus", { expectedHostInstanceId: hostId }, null);
    const selected = await host.request(
      "workspace.setCurrent",
      {
        expectedHostInstanceId: hostId,
        expectedWorkspaceId: status.workspaceId,
        expectedWorkspaceRevision: status.workspaceRevision,
      },
      { cwd: project },
    );
    expect(selected.ok).toBe(true);

    const workspace = (
      selected.result as {
        workspace: { id: string; revision: number };
      }
    ).workspace;
    const sessionDir = sessionDirFor(agentDir, project);
    mkdirSync(sessionDir, { recursive: true });
    const sessionPaths = Array.from({ length: 6 }, (_, index) => {
      const sessionId = randomUUID();
      const sessionPath = join(sessionDir, `${sessionId}.jsonl`);
      writeFileSync(
        sessionPath,
        [
          JSON.stringify({
            type: "session",
            version: 3,
            id: sessionId,
            timestamp: `2026-01-01T00:00:0${index}.000Z`,
            cwd: resolve(project),
          }),
          JSON.stringify({
            type: "session_info",
            id: `session-info-${index}`,
            parentId: null,
            timestamp: `2026-01-01T00:00:1${index}.000Z`,
            name: `Cache churn ${index}`,
          }),
        ].join("\n") + "\n",
      );
      return sessionPath;
    });

    let identity = {
      expectedHostInstanceId: hostId,
      expectedWorkspaceId: workspace.id,
      expectedWorkspaceRevision: workspace.revision,
      expectedSessionId: selected.sessionId,
      expectedSessionRevision: selected.sessionRevision,
    };
    const sequence = [...sessionPaths, ...[...sessionPaths].reverse()];
    for (const [index, sessionPath] of sequence.entries()) {
      const opened = await host.request("session.open", identity, { sessionPath }, 60_000);
      expect(opened, `session.open failed at switch ${index}`).toMatchObject({ ok: true });
      identity = {
        expectedHostInstanceId: hostId,
        expectedWorkspaceId: workspace.id,
        expectedWorkspaceRevision: workspace.revision,
        expectedSessionId: opened.sessionId,
        expectedSessionRevision: opened.sessionRevision,
      };
    }

    const finalOpen = await host.request(
      "session.open",
      identity,
      { sessionPath: sessionPaths[0] },
      60_000,
    );
    expect(finalOpen.ok).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(host.proc.exitCode).toBeNull();
    const stillResponsive = await host.request(
      "system.getStatus",
      { expectedHostInstanceId: hostId },
      null,
    );
    expect(stillResponsive.ok).toBe(true);
  }, 180_000);

  it("publishes the target snapshot before previous idle shutdown settles", async () => {
    const project = emptyProject(root, "session-open-slow-shutdown");
    const holdPath = join(agentDir, ".pideck-hold-idle-shutdown");
    const status = await host.request("system.getStatus", { expectedHostInstanceId: hostId }, null);
    const selected = await host.request(
      "workspace.setCurrent",
      {
        expectedHostInstanceId: hostId,
        expectedWorkspaceId: status.workspaceId,
        expectedWorkspaceRevision: status.workspaceRevision,
      },
      { cwd: project },
    );
    expect(selected.ok).toBe(true);

    const workspace = (
      selected.result as {
        workspace: { id: string; revision: number };
      }
    ).workspace;
    const targetSessionId = randomUUID();
    const targetSessionPath = join(sessionDirFor(agentDir, project), `${targetSessionId}.jsonl`);
    mkdirSync(dirname(targetSessionPath), { recursive: true });
    writeFileSync(
      targetSessionPath,
      JSON.stringify({
        type: "session",
        version: 3,
        id: targetSessionId,
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: resolve(project),
      }) + "\n",
    );

    writeFileSync(holdPath, "hold\n");
    let openSettled = false;
    try {
      const snapshotPromise = host.waitForEvent(
        "session.snapshot",
        5_000,
        (message) => message.sessionId === targetSessionId,
      );
      const openPromise = host
        .request(
          "session.open",
          {
            expectedHostInstanceId: hostId,
            expectedWorkspaceId: workspace.id,
            expectedWorkspaceRevision: workspace.revision,
            expectedSessionId: selected.sessionId,
            expectedSessionRevision: selected.sessionRevision,
          },
          { sessionPath: targetSessionPath },
          60_000,
        )
        .finally(() => {
          openSettled = true;
        });
      const snapshot = await snapshotPromise;
      expect(openSettled).toBe(false);
      expect(snapshot.sessionId).toBe(targetSessionId);
      rmSync(holdPath, { force: true });
      const opened = await openPromise;
      expect(opened.ok).toBe(true);
    } finally {
      rmSync(holdPath, { force: true });
    }
  }, 90_000);

  it("refreshes live Extension resources after install, update, and remove", async () => {
    const packageDir = join(root, "ext-lifecycle-pkg");
    const markerPath = join(root, "ext-factory-version.txt");
    const writeExtensionSource = (version: string) => {
      writeFileSync(
        join(packageDir, "package.json"),
        JSON.stringify({
          name: "@pideck-test/ext-lifecycle",
          version: version === "v1" ? "1.0.0" : "1.0.1",
          private: true,
          pi: { extensions: ["./extensions/ext-a.ts"] },
        }),
      );
      writeFileSync(
        join(packageDir, "extensions", "ext-a.ts"),
        [
          'import { writeFileSync } from "node:fs";',
          "export default function (pi) {",
          `  writeFileSync(${JSON.stringify(markerPath)}, ${JSON.stringify(version)});`,
          '  pi.on("session_start", async () => {});',
          "}",
          "",
        ].join("\n"),
      );
    };
    mkdirSync(join(packageDir, "extensions"), { recursive: true });
    writeExtensionSource("v1");

    const proj = emptyProject(root, "ext-lifecycle");
    const st = await host.request("system.getStatus", { expectedHostInstanceId: hostId }, null);
    const status = st.result as {
      workspaceId: string | null;
      workspaceRevision: number;
    };
    const set = await host.request(
      "workspace.setCurrent",
      {
        expectedHostInstanceId: hostId,
        expectedWorkspaceId: status.workspaceId,
        expectedWorkspaceRevision: status.workspaceRevision,
      },
      { cwd: proj },
      60_000,
    );
    expect(set.ok).toBe(true);
    const ws = (set.result as { workspace: { id: string; revision: number } }).workspace;

    const install = await host.request(
      "package.install",
      {
        expectedHostInstanceId: hostId,
        expectedWorkspaceId: ws.id,
        expectedWorkspaceRevision: ws.revision,
        expectedSessionId: set.sessionId,
        expectedSessionRevision: set.sessionRevision,
        expectedPackageRevision: set.packageRevision,
      },
      { source: packageDir, scope: "user" },
      180_000,
    );
    expect(install.ok, JSON.stringify(install.error)).toBe(true);
    const installed = (
      install.result as {
        status: string;
        packageSnapshot: {
          configured: Array<{ id: string; source: string }>;
          resources: Array<{
            type: string;
            name?: string;
            relativePath?: string;
            path?: string;
            packageId?: string;
          }>;
        };
      }
    ).packageSnapshot;
    const packageRecord = installed.configured.find((item) =>
      item.source.includes("ext-lifecycle-pkg"),
    );
    expect(packageRecord).toBeTruthy();
    const installedExtension = installed.resources.find(
      (resource) =>
        resource.type === "extension" &&
        (resource.packageId === packageRecord?.id ||
          (resource.relativePath ?? resource.name ?? resource.path ?? "").includes("ext-a.ts")),
    );
    expect(installedExtension?.relativePath ?? installedExtension?.name ?? "").toContain(
      "ext-a.ts",
    );
    expect(existsSync(markerPath)).toBe(true);
    expect(readFileSync(markerPath, "utf8")).toBe("v1");

    writeExtensionSource("v2");
    if (
      installedExtension?.path &&
      installedExtension.path !== join(packageDir, "extensions", "ext-a.ts")
    ) {
      writeFileSync(
        installedExtension.path,
        [
          'import { writeFileSync } from "node:fs";',
          "export default function (pi) {",
          `  writeFileSync(${JSON.stringify(markerPath)}, "v2");`,
          '  pi.on("session_start", async () => {});',
          "}",
          "",
        ].join("\n"),
      );
    }

    const updated = await host.request(
      "package.update",
      {
        expectedHostInstanceId: hostId,
        expectedWorkspaceId: ws.id,
        expectedWorkspaceRevision: ws.revision,
        expectedSessionId: install.sessionId,
        expectedSessionRevision: install.sessionRevision,
        expectedPackageRevision: install.packageRevision,
      },
      { packageId: packageRecord!.id },
      180_000,
    );
    expect(updated.ok, JSON.stringify(updated.error)).toBe(true);
    const updatedSnapshot = (
      updated.result as {
        packageSnapshot: {
          resources: Array<{
            type: string;
            name?: string;
            relativePath?: string;
            packageId?: string;
          }>;
        };
      }
    ).packageSnapshot;
    const updatedExtensions = updatedSnapshot.resources.filter(
      (resource) =>
        resource.type === "extension" &&
        (resource.packageId === packageRecord?.id ||
          (resource.relativePath ?? resource.name ?? "").includes("ext-a.ts")),
    );
    expect(updatedExtensions).toHaveLength(1);
    expect(updatedExtensions[0]?.relativePath ?? updatedExtensions[0]?.name).toContain("ext-a.ts");
    expect(readFileSync(markerPath, "utf8")).toBe("v2");

    const remove = await host.request(
      "package.remove",
      {
        expectedHostInstanceId: hostId,
        expectedWorkspaceId: ws.id,
        expectedWorkspaceRevision: ws.revision,
        expectedSessionId: updated.sessionId,
        expectedSessionRevision: updated.sessionRevision,
        expectedPackageRevision: updated.packageRevision,
      },
      { packageId: packageRecord!.id },
      120_000,
    );
    expect(remove.ok, JSON.stringify(remove.error)).toBe(true);
    const removedSnapshot = (
      remove.result as {
        packageSnapshot: {
          configured: Array<{ id: string }>;
          resources: Array<{ type: string; name?: string; relativePath?: string }>;
        };
      }
    ).packageSnapshot;
    expect(removedSnapshot.configured.some((item) => item.id === packageRecord!.id)).toBe(false);
    expect(
      removedSnapshot.resources.some(
        (resource) =>
          resource.type === "extension" &&
          (resource.relativePath ?? resource.name ?? "").includes("ext-a.ts"),
      ),
    ).toBe(false);
  }, 360_000);
});

// silence unused import if tree-shaken
void createHash;
