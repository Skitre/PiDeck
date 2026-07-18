import { describe, expect, it } from "vitest";
import type { HandlerContext } from "./server.js";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";
import { IdentityState } from "./identity.js";
import { TryMutex } from "./locks.js";
import { createSessionHandlers } from "./session-controller.js";

const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const ACTIVE_SESSION_ID = "33333333-3333-4333-8333-333333333333";
const BACKGROUND_SESSION_ID = "44444444-4444-4444-8444-444444444444";

describe("session.list runtime metadata", () => {
  it("includes the active and retained background Runtime states", async () => {
    const identity = new IdentityState();
    identity.workspaceId = WORKSPACE_ID;
    identity.workspaceRevision = 1;
    identity.sessionId = ACTIVE_SESSION_ID;
    identity.sessionRevision = 5;
    const serviceGraphLock = new TryMutex();
    const runtimes = new Map([
      [ACTIVE_SESSION_ID, { runtimeState: "idle" as const, sessionRevision: 5 }],
      [BACKGROUND_SESSION_ID, { runtimeState: "running" as const, sessionRevision: 3 }],
    ]);
    const factory = {
      getServer: () => ({ identity, serviceGraphLock }),
      checkIdentity: () => null,
      getGraph: () => ({ workspaceId: WORKSPACE_ID }),
      listSessions: async () => [
        {
          id: ACTIVE_SESSION_ID,
          path: "C:/sessions/active.jsonl",
          name: "Active",
          cwd: "C:/workspace",
          modified: new Date(10),
          messageCount: 2,
        },
        {
          id: BACKGROUND_SESSION_ID,
          path: "C:/sessions/background.jsonl",
          name: "Background",
          cwd: "C:/workspace",
          modified: new Date(20),
          messageCount: 4,
        },
      ],
      getSessionRuntimeInfo: (sessionId: string) => runtimes.get(sessionId) ?? null,
    } as unknown as WorkspaceGraphFactory;
    const handler = createSessionHandlers(factory)["session.list"]!;

    const response = await handler({
      id: "55555555-5555-4555-8555-555555555555",
      method: "session.list",
      params: null,
      context: {},
    } as HandlerContext);

    expect(response).toHaveProperty("result");
    if (!("result" in response)) return;
    expect(response.result).toEqual({
      workspaceId: WORKSPACE_ID,
      items: [
        expect.objectContaining({
          sessionId: ACTIVE_SESSION_ID,
          runtimeState: "idle",
          sessionRevision: 5,
        }),
        expect.objectContaining({
          sessionId: BACKGROUND_SESSION_ID,
          runtimeState: "running",
          sessionRevision: 3,
        }),
      ],
    });
  });
});
