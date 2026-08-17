/**
 * The two acceptance invariants that have no runtime signal to observe:
 * a local refresh must never be allowed to reach the network, and every
 * session must be built on the Host-owned runtime.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelsRefreshOptions, ModelsRefreshResult } from "@earendil-works/pi-ai";
import { refreshModelsLocal } from "./model-runtime-refresh.js";

const sourceDir = dirname(fileURLToPath(import.meta.url));

function fakeRuntime(result?: Partial<ModelsRefreshResult>): {
  runtime: ModelRuntime;
  calls: ModelsRefreshOptions[];
} {
  const calls: ModelsRefreshOptions[] = [];
  const runtime = {
    refresh: async (options?: ModelsRefreshOptions): Promise<ModelsRefreshResult> => {
      calls.push(options ?? {});
      return { aborted: false, errors: new Map(), ...result };
    },
  } as unknown as ModelRuntime;
  return { runtime, calls };
}

describe("refresh helpers", () => {
  it("never allows network access on a local refresh", async () => {
    const { runtime, calls } = fakeRuntime();

    await refreshModelsLocal(runtime);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.allowNetwork).toBe(false);
  });

  it("forwards the cancellation signal on a local refresh", async () => {
    const { runtime, calls } = fakeRuntime();
    const controller = new AbortController();

    await refreshModelsLocal(runtime, { signal: controller.signal });

    expect(calls[0]!.signal).toBe(controller.signal);
    expect(calls[0]!.allowNetwork).toBe(false);
  });

  it("returns the runtime result so callers can see aborts and per-provider errors", async () => {
    const errors = new Map([["openai", new Error("catalog unreachable")]]);
    const { runtime } = fakeRuntime({ aborted: true, errors });

    const result = await refreshModelsLocal(runtime);

    expect(result.aborted).toBe(true);
    expect(result.errors.get("openai")?.message).toBe("catalog unreachable");
  });
});

describe("Host-owned runtime injection", () => {
  /**
   * Structural, not behavioural, on purpose. CreateAgentSessionOptions.
   * modelRuntime defaults to a freshly built runtime, so a call site that
   * omits it silently gets a second runtime with its own provider and auth
   * state — there is no event or error to assert on. The only reliable check
   * is that no production call site omits the option.
   */
  it("passes modelRuntime at every production createAgentSession call site", () => {
    const files = readdirSync(sourceDir).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
    );

    const callSites: Array<{ file: string; text: string }> = [];
    for (const file of files) {
      const text = readFileSync(join(sourceDir, file), "utf8");
      let index = text.indexOf("createAgentSession({");
      while (index >= 0) {
        const close = text.indexOf("});", index);
        callSites.push({ file, text: text.slice(index, close < 0 ? undefined : close) });
        index = text.indexOf("createAgentSession({", index + 1);
      }
    }

    expect(callSites.length).toBeGreaterThan(0);
    expect(callSites.map((site) => site.file)).toEqual(["agent-session-factory.ts"]);
    const factorySource = readFileSync(join(sourceDir, "agent-session-factory.ts"), "utf8");
    expect(factorySource).toContain("modelRuntime: ModelRuntime");
    expect(callSites[0]!.text).toContain("...options");
  });

  it("keeps AuthStorage and ModelRegistry.create out of production source", () => {
    const files = readdirSync(sourceDir).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
    );

    for (const file of files) {
      const text = readFileSync(join(sourceDir, file), "utf8");
      // Comments explaining the migration are fine; code references are not.
      const code = text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
        .join("\n");
      expect(code, `${file} must not use AuthStorage`).not.toMatch(/\bAuthStorage\b/);
      expect(code, `${file} must not use ModelRegistry.create`).not.toMatch(
        /ModelRegistry\.(create|inMemory)\b/,
      );
    }
  });
});
