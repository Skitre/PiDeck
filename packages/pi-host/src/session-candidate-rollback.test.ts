import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TryMutex } from "./locks.js";
import { GraphOperationRegistry } from "./operation-lifecycle.js";
import type { PiHostServer } from "./server.js";
import { UserResourceCache } from "./user-resource-cache.js";
import {
  WorkspaceGraphFactory,
  type GraphFactoryDeps,
  type WorkspaceGraph,
} from "./workspace-graph-factory.js";

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const ACTIVE_SESSION_ID = "33333333-3333-4333-8333-333333333333";

const mocks = vi.hoisted(() => ({
  createHostAgentSession: vi.fn(),
  bindForCandidate: vi.fn(),
}));

vi.mock("./agent-session-factory.js", () => ({
  createHostAgentSession: mocks.createHostAgentSession,
}));

vi.mock("./extension-ui-lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./extension-ui-lifecycle.js")>();
  return {
    ...actual,
    bindForCandidate: mocks.bindForCandidate,
  };
});

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  mocks.createHostAgentSession.mockReset();
  mocks.bindForCandidate.mockReset();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fakeSession(sessionId: string) {
  return {
    sessionId,
    isIdle: true,
    messages: [{ role: "user", content: "keep me" }],
    sessionName: "existing",
    subscribe: vi.fn(() => () => {}),
    dispose: vi.fn(),
    abort: vi.fn(),
    extensionRunner: {
      hasHandlers: () => false,
      emit: vi.fn(),
      getRegisteredCommands: () => [],
    },
  };
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "pideck-session-rollback-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const cache = new UserResourceCache(agentDir);
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const originalLoader = { id: "original-loader" };
  const activeSession = fakeSession(ACTIVE_SESSION_ID);
  const identity = {
    hostInstanceId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    workspaceRevision: 1,
    sessionId: ACTIVE_SESSION_ID,
    sessionRevision: 4,
    packageRevision: 1,
  };
  const server = {
    identity,
    getIdentity: () => ({ ...identity }),
    emit: vi.fn(),
    emitForIdentity: vi.fn(),
    serviceGraphLock: new TryMutex(),
    graphOperations: new GraphOperationRegistry(),
  } as unknown as PiHostServer;
  const graph = {
    workspaceId: WORKSPACE_ID,
    cwd,
    canonicalCwd: cwd,
    revision: 1,
    servicesReady: true,
    settingsManager,
    resourceLoader: originalLoader,
    sessionManager: {
      getSessionId: () => ACTIVE_SESSION_ID,
      buildContextEntries: () => [{ type: "message" }],
    },
    agentSession: activeSession,
    extensionsResult: null,
    packageSnapshot: null,
    sessionSnapshot: {
      sessionId: ACTIVE_SESSION_ID,
      sessionPath: join(cwd, "active.jsonl"),
      revision: 4,
    },
    toolRevision: 1,
    resourceIdMap: new Map(),
    unsubscribeAgent: vi.fn(),
    extensionUiActivate: null,
    extensionUiCleanup: vi.fn(),
    extensionUiUpdateIdentity: null,
    extensionUiReplayState: null,
    resourceReloadRequired: true,
    backgroundSessions: new Map(),
  } as unknown as WorkspaceGraph;
  const factory = new WorkspaceGraphFactory({
    agentDir,
    userResourceCache: cache,
    refreshModelHealth: () => ({ state: "ok", source: "test" }),
  } as unknown as GraphFactoryDeps);
  factory.bindServer(server);
  Reflect.set(factory, "graph", graph);
  return { factory, graph, originalLoader, activeSession, cwd };
}

describe("candidate ResourceLoader rollback", () => {
  beforeEach(() => {
    vi.spyOn(SessionManager, "create").mockReturnValue({
      getSessionId: () => "55555555-5555-4555-8555-555555555555",
      newSession: vi.fn(),
      appendSessionInfo: vi.fn(),
    } as never);
  });

  it("keeps the active loader when session create fails", async () => {
    const { factory, graph, originalLoader, activeSession } = createFixture();
    mocks.createHostAgentSession.mockRejectedValue(new Error("session boom"));

    const result = await factory.createSession("req-create-fail");

    expect(result).toMatchObject({ error: { code: "SESSION_SWITCH_FAILED" } });
    expect(graph.resourceLoader).toBe(originalLoader);
    expect(graph.resourceReloadRequired).toBe(true);
    expect(graph.agentSession).toBe(activeSession);
  });

  it("keeps the active loader when Extension bind fails during create", async () => {
    const { factory, graph, originalLoader, activeSession } = createFixture();
    const candidate = fakeSession("55555555-5555-4555-8555-555555555555");
    mocks.createHostAgentSession.mockResolvedValue({
      session: candidate,
      extensionsResult: null,
    });
    mocks.bindForCandidate.mockRejectedValue(new Error("bind boom"));

    const result = await factory.createSession("req-bind-fail");

    expect(result).toMatchObject({ error: { code: "SESSION_SWITCH_FAILED" } });
    expect(graph.resourceLoader).toBe(originalLoader);
    expect(graph.resourceReloadRequired).toBe(true);
    expect(graph.agentSession).toBe(activeSession);
    expect(candidate.dispose).toHaveBeenCalled();
  });

  it("keeps the active loader when session open fails", async () => {
    const { factory, graph, originalLoader, activeSession, cwd } = createFixture();
    const sessionPath = join(cwd, "other.jsonl");
    vi.spyOn(SessionManager, "list").mockResolvedValue([{ path: sessionPath }] as never);
    vi.spyOn(SessionManager, "open").mockReturnValue({
      getSessionId: () => "66666666-6666-4666-8666-666666666666",
      getSessionFile: () => sessionPath,
    } as never);
    mocks.createHostAgentSession.mockRejectedValue(new Error("open boom"));

    const result = await factory.openSession("req-open-fail", sessionPath);

    expect(result).toMatchObject({ error: { code: "SESSION_SWITCH_FAILED" } });
    expect(graph.resourceLoader).toBe(originalLoader);
    expect(graph.resourceReloadRequired).toBe(true);
    expect(graph.agentSession).toBe(activeSession);
  });
});
