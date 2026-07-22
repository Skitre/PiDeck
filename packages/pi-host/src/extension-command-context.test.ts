import { describe, expect, it } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  getActiveExtensionCommandOrigin,
  resolveExtensionCommandInvocation,
  withExtensionCommandOrigin,
} from "./extension-command-context.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function sessionWithCommands(names: string[]): AgentSession {
  return {
    extensionRunner: {
      getCommand: (name: string) => (names.includes(name) ? { invocationName: name } : undefined),
    },
  } as unknown as AgentSession;
}

describe("extension command context", () => {
  it("mirrors the SDK's exact leading slash command parsing", () => {
    const session = sessionWithCommands(["brainstorm", "plan:2"]);
    expect(resolveExtensionCommandInvocation(session, "/brainstorm topic")).toBe(
      "brainstorm",
    );
    expect(resolveExtensionCommandInvocation(session, "/plan:2")).toBe("plan:2");
    expect(resolveExtensionCommandInvocation(session, " /brainstorm")).toBeUndefined();
    expect(resolveExtensionCommandInvocation(session, "/unknown")).toBeUndefined();
  });

  it("keeps concurrent session command origins isolated across awaits", async () => {
    const first = sessionWithCommands([]);
    const second = sessionWithCommands([]);
    const firstGate = deferred();
    const secondGate = deferred();
    const seen: string[] = [];

    const firstRun = withExtensionCommandOrigin(
      first,
      "00000000-0000-4000-8000-000000000001",
      "brainstorm",
      async () => {
        seen.push(getActiveExtensionCommandOrigin(first)?.invocation ?? "missing-first");
        expect(getActiveExtensionCommandOrigin(second)).toBeUndefined();
        await firstGate.promise;
        seen.push(getActiveExtensionCommandOrigin(first)?.invocation ?? "missing-first");
      },
    );
    const secondRun = withExtensionCommandOrigin(
      second,
      "00000000-0000-4000-8000-000000000002",
      "plan",
      async () => {
        seen.push(getActiveExtensionCommandOrigin(second)?.invocation ?? "missing-second");
        expect(getActiveExtensionCommandOrigin(first)).toBeUndefined();
        await secondGate.promise;
        seen.push(getActiveExtensionCommandOrigin(second)?.invocation ?? "missing-second");
      },
    );

    firstGate.resolve();
    secondGate.resolve();
    await Promise.all([firstRun, secondRun]);
    expect(seen).toEqual(["brainstorm", "plan", "brainstorm", "plan"]);
    expect(getActiveExtensionCommandOrigin(first)).toBeUndefined();
    expect(getActiveExtensionCommandOrigin(second)).toBeUndefined();
  });
});
