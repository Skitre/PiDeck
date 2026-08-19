import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as undici from "undici";

vi.mock("./logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Each test re-imports the module under a fresh registry (vi.resetModules in
// beforeEach) so module-level state (installedGlobalFetch, the captured
// original fetch) is deterministic. The logger mock factory re-runs per
// registry, so assertions must use the dynamically imported instance.
async function load() {
  const mod = await import("./network-bootstrap.js");
  const { logger } = await import("./logger.js");
  return { ...mod, logger: vi.mocked(logger) };
}

describe("network-bootstrap", () => {
  let dir: string;
  let savedHttpProxy: string | undefined;
  let savedHttpsProxy: string | undefined;
  let savedDispatcher: undici.Dispatcher;
  let savedFetch: typeof globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
    dir = mkdtempSync(join(tmpdir(), "pideck-netboot-"));
    savedHttpProxy = process.env.HTTP_PROXY;
    savedHttpsProxy = process.env.HTTPS_PROXY;
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    savedDispatcher = undici.getGlobalDispatcher();
    savedFetch = globalThis.fetch;
  });

  afterEach(() => {
    if (savedHttpProxy === undefined) delete process.env.HTTP_PROXY;
    else process.env.HTTP_PROXY = savedHttpProxy;
    if (savedHttpsProxy === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = savedHttpsProxy;
    undici.setGlobalDispatcher(savedDispatcher);
    globalThis.fetch = savedFetch;
    rmSync(dir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function writeSettings(contents: string): void {
    writeFileSync(join(dir, "settings.json"), contents, "utf-8");
  }

  it("creates an empty settings.json when missing and never overwrites an existing one", async () => {
    const { ensureGlobalSettingsFile } = await load();
    const settingsPath = join(dir, "settings.json");

    ensureGlobalSettingsFile(dir);
    expect(readFileSync(settingsPath, "utf-8")).toBe("{}\n");

    writeSettings('{"defaultModel":"keep-me"}');
    ensureGlobalSettingsFile(dir);
    expect(readFileSync(settingsPath, "utf-8")).toBe('{"defaultModel":"keep-me"}');
  });

  it("creates a schema-valid models.json when missing and never overwrites an existing one", async () => {
    const { ensureModelsJsonFile } = await load();
    const modelsPath = join(dir, "models.json");

    ensureModelsJsonFile(dir);
    expect(readFileSync(modelsPath, "utf-8")).toBe('{"providers":{}}\n');

    writeFileSync(modelsPath, '{"providers":{"keep":{}}}', "utf-8");
    ensureModelsJsonFile(dir);
    expect(readFileSync(modelsPath, "utf-8")).toBe('{"providers":{"keep":{}}}');
  });

  it("applies httpProxy from settings to the environment when unset", async () => {
    writeSettings('{"httpProxy":"http://127.0.0.1:7890"}');
    const { applyHostNetworkSettings, logger } = await load();

    applyHostNetworkSettings(dir);

    expect(process.env.HTTP_PROXY).toBe("http://127.0.0.1:7890");
    expect(process.env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
    expect(logger.info).toHaveBeenCalledWith(
      "Applied httpProxy from global settings",
      expect.objectContaining({ proxyOrigin: "http://127.0.0.1:7890" }),
    );
  });

  it("keeps explicit environment variables ahead of the settings value (??=)", async () => {
    process.env.HTTP_PROXY = "http://existing:1";
    writeSettings('{"httpProxy":"http://127.0.0.1:7890"}');
    const { applyHostNetworkSettings } = await load();

    applyHostNetworkSettings(dir);

    expect(process.env.HTTP_PROXY).toBe("http://existing:1");
    expect(process.env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
  });

  it("installs an EnvHttpProxyAgent dispatcher even with no proxy configured", async () => {
    const { applyHostNetworkSettings, ensureGlobalSettingsFile } = await load();
    ensureGlobalSettingsFile(dir);

    applyHostNetworkSettings(dir);

    const dispatcher = undici.getGlobalDispatcher();
    expect(dispatcher).not.toBe(savedDispatcher);
    expect(dispatcher).toBeInstanceOf(undici.EnvHttpProxyAgent);
    expect(process.env.HTTP_PROXY).toBeUndefined();
  });

  it("honors a custom httpIdleTimeoutMs without throwing", async () => {
    writeSettings('{"httpIdleTimeoutMs":120000}');
    const { applyHostNetworkSettings } = await load();

    expect(() => applyHostNetworkSettings(dir)).not.toThrow();
    expect(undici.getGlobalDispatcher()).toBeInstanceOf(undici.EnvHttpProxyAgent);
  });

  it("survives a malformed settings file: warns, skips env, still installs the dispatcher", async () => {
    writeSettings("{ not json");
    const { applyHostNetworkSettings, logger } = await load();

    expect(() => applyHostNetworkSettings(dir)).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(
      "Global settings file not fully applied",
      expect.objectContaining({ scope: "global" }),
    );
    expect(process.env.HTTP_PROXY).toBeUndefined();
    expect(undici.getGlobalDispatcher()).toBeInstanceOf(undici.EnvHttpProxyAgent);
  });

  it("preserves a fetch that was deliberately replaced after module load", async () => {
    const mod = await load();
    const deliberate = (() => Promise.resolve(new Response())) as typeof fetch;
    globalThis.fetch = deliberate;

    mod.applyHostNetworkSettings(dir);

    expect(globalThis.fetch).toBe(deliberate);
  });

  it("never logs credentials embedded in the proxy URL", async () => {
    writeSettings('{"httpProxy":"http://user:p4ss@127.0.0.1:7890"}');
    const { applyHostNetworkSettings, logger } = await load();

    applyHostNetworkSettings(dir);

    expect(logger.info).toHaveBeenCalledWith(
      "Applied httpProxy from global settings",
      expect.objectContaining({ proxyOrigin: "http://127.0.0.1:7890" }),
    );
    const logged = JSON.stringify(logger.info.mock.calls);
    expect(logged).not.toContain("user:p4ss");
    expect(logged).not.toContain("p4ss");
    // The credential still reaches the environment — the proxy agent needs it.
    expect(process.env.HTTP_PROXY).toBe("http://user:p4ss@127.0.0.1:7890");
  });

  it("leaves a pre-created settings file's bytes untouched on the happy path", async () => {
    writeSettings('{"httpProxy":"http://127.0.0.1:7890","customKey":true}');
    const { applyHostNetworkSettings, ensureGlobalSettingsFile } = await load();

    ensureGlobalSettingsFile(dir);
    applyHostNetworkSettings(dir);

    expect(readFileSync(join(dir, "settings.json"), "utf-8")).toBe(
      '{"httpProxy":"http://127.0.0.1:7890","customKey":true}',
    );
    expect(existsSync(join(dir, "settings.json"))).toBe(true);
  });
});
