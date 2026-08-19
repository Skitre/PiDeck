/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HostStatusSnapshot,
  ProviderModelConfig,
  ProviderSnapshot,
} from "@pideck/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore } from "../../lib/stores/app-store";
import { ProvidersSettings } from "./ProvidersSettings";

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => tauriMocks.invoke(...(args as [])),
  isTauri: () => true,
}));

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

function host(): HostStatusSnapshot {
  return {
    protocolVersion: 1,
    hostInstanceId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    workspaceRevision: 1,
    sessionId: null,
    sessionRevision: 0,
    packageRevision: 1,
    sdkVersion: "0.82.1",
    nodeVersion: process.version,
    agentDir: "/agent",
    phase: "ready",
    capabilities: {
      packageUpdateCheck: true,
      extensionUi: true,
      sessionExport: true,
    },
    modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
  };
}

function model(): ProviderModelConfig {
  return {
    id: "m1",
    name: "Model One",
    reasoning: false,
    input: ["text"],
    contextWindow: 8192,
    maxTokens: 1024,
  };
}

function providerA(): ProviderSnapshot {
  return {
    id: "prov-a",
    enabled: true,
    name: "Provider A",
    baseUrl: "https://a.example.com/v1",
    api: "openai-completions",
    authHeader: true,
    headers: {},
    models: [model()],
    auth: { configured: true, source: "stored" },
  };
}

function providerB(): ProviderSnapshot {
  return {
    id: "prov-b",
    enabled: false,
    name: "Provider B",
    baseUrl: "https://b.example.com/v1",
    api: "openai-completions",
    authHeader: true,
    headers: {},
    models: [],
    auth: { configured: false },
  };
}

function envelope(method: string, result: unknown) {
  return {
    protocolVersion: 1,
    id: "test-request",
    method,
    hostInstanceId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    workspaceRevision: 1,
    packageRevision: 1,
    ok: true,
    result,
  };
}

function errorEnvelope(
  method: string,
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  },
) {
  return {
    protocolVersion: 1,
    id: "test-request",
    method,
    hostInstanceId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    workspaceRevision: 1,
    packageRevision: 1,
    ok: false,
    error,
  };
}

type RequestHandler = (params: unknown) => Promise<unknown> | unknown;

function mockRequests(overrides: Record<string, RequestHandler> = {}) {
  const spy = vi.spyOn(hostClient, "request").mockImplementation((async (
    method: string,
    _context: unknown,
    params: unknown,
  ) => {
    const override = overrides[method];
    if (override) return override(params);
    if (method === "provider.list") {
      return envelope(method, { providers: [providerA(), providerB()] });
    }
    if (method === "provider.save") {
      return envelope(method, { provider: providerA() });
    }
    if (method === "provider.checkConnection") {
      return envelope(method, {
        providerId: "prov-a",
        modelId: "m1",
        api: "openai-completions",
        ok: true,
        latencyMs: 7,
        category: "ok",
        message: "Generation succeeded",
      });
    }
    throw new Error(`Unexpected request: ${method}`);
  }) as never);
  return spy;
}

function callsFor(spy: ReturnType<typeof mockRequests>, method: string) {
  return spy.mock.calls.filter(([calledMethod]) => calledMethod === method);
}

async function renderLoaded(spy = mockRequests()) {
  render(<ProvidersSettings />);
  await screen.findByDisplayValue("Provider A");
  return spy;
}

beforeEach(() => {
  tauriMocks.invoke.mockReset();
  tauriMocks.invoke.mockResolvedValue(undefined);
  useAppStore.getState().setHost(host());
  useAppStore.getState().clearNotifications();
  useAppStore.getState().setProvidersDirty(false);
});

afterEach(() => {
  cleanup();
  useAppStore.getState().setProvidersDirty(false);
  useAppStore.getState().setHost(null);
  vi.restoreAllMocks();
});

describe("ProvidersSettings loading", () => {
  it("retries transient graph contention before showing Providers", async () => {
    let requests = 0;
    const spy = mockRequests({
      "provider.list": () => {
        requests += 1;
        return requests === 1
          ? errorEnvelope("provider.list", {
              code: "SERVICE_GRAPH_BUSY",
              message: "Service graph is busy",
              retryable: true,
            })
          : envelope("provider.list", { providers: [providerA(), providerB()] });
      },
    });

    render(<ProvidersSettings />);

    expect(await screen.findByDisplayValue("Provider A")).toBeInTheDocument();
    expect(callsFor(spy, "provider.list")).toHaveLength(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(useAppStore.getState().notifications).toHaveLength(0);
  });

  it("shows a recoverable error instead of an empty state after retries are exhausted", async () => {
    let busy = true;
    const spy = mockRequests({
      "provider.list": () =>
        busy
          ? errorEnvelope("provider.list", {
              code: "SERVICE_GRAPH_BUSY",
              message: "Service graph is busy",
              retryable: true,
              details: { operationKind: "workspace.setCurrent" },
            })
          : envelope("provider.list", { providers: [providerA(), providerB()] }),
    });
    const user = userEvent.setup();

    render(<ProvidersSettings />);

    const alert = await screen.findByRole("alert", undefined, { timeout: 2_500 });
    expect(alert).toHaveTextContent("Could not load Providers");
    expect(alert).toHaveTextContent("Service graph is busy (workspace.setCurrent)");
    expect(screen.queryByText("No Providers configured yet.")).not.toBeInTheDocument();
    expect(callsFor(spy, "provider.list")).toHaveLength(5);

    busy = false;
    await user.click(within(alert).getByRole("button", { name: "Try again" }));

    expect(await screen.findByDisplayValue("Provider A")).toBeInTheDocument();
    expect(callsFor(spy, "provider.list")).toHaveLength(6);
  });

  it("stops retrying after the page unmounts", async () => {
    const spy = mockRequests({
      "provider.list": () =>
        errorEnvelope("provider.list", {
          code: "SERVICE_GRAPH_BUSY",
          message: "Service graph is busy",
          retryable: true,
        }),
    });
    const view = render(<ProvidersSettings />);
    await waitFor(() => expect(callsFor(spy, "provider.list")).toHaveLength(1));

    view.unmount();
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(callsFor(spy, "provider.list")).toHaveLength(1);
    expect(useAppStore.getState().notifications).toHaveLength(0);
  });
});

describe("ProvidersSettings dirty tracking", () => {
  it("flags unsaved edits and guards switching to another Provider", async () => {
    const user = userEvent.setup();
    await renderLoaded();

    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(/Display name/), "X");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(useAppStore.getState().providersDirty).toBe(true);

    await user.click(screen.getByRole("button", { name: /Provider B/ }));
    expect(
      screen.getByRole("heading", { name: "Discard unsaved changes?" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByLabelText(/Display name/)).toHaveValue("Provider AX");

    await user.click(screen.getByRole("button", { name: /Provider B/ }));
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.getByLabelText(/Display name/)).toHaveValue("Provider B");
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
    expect(useAppStore.getState().providersDirty).toBe(false);
  });

  it("clears the dirty flag on unmount", async () => {
    const user = userEvent.setup();
    mockRequests();
    const { unmount } = render(<ProvidersSettings />);
    await screen.findByDisplayValue("Provider A");
    await user.type(screen.getByLabelText(/Display name/), "X");
    expect(useAppStore.getState().providersDirty).toBe(true);

    unmount();
    expect(useAppStore.getState().providersDirty).toBe(false);
  });
});

describe("ProvidersSettings key-removal safety", () => {
  it("Save & test saves without committing a pending stored-key removal", async () => {
    const user = userEvent.setup();
    const spy = await renderLoaded();

    await user.click(screen.getByRole("button", { name: "Remove stored key" }));
    expect(
      screen.getByText("Stored key will be removed when you save"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save & test" }));
    await waitFor(() =>
      expect(callsFor(spy, "provider.checkConnection")).toHaveLength(1),
    );

    const saveCalls = callsFor(spy, "provider.save");
    expect(saveCalls).toHaveLength(1);
    expect(saveCalls[0][2]).not.toHaveProperty("clearApiKey");
    // The removal stays armed for the explicit Save.
    expect(
      screen.getByText("Stored key will be removed when you save"),
    ).toBeInTheDocument();
  });

  it("explicit Save commits the stored-key removal", async () => {
    const user = userEvent.setup();
    const spy = await renderLoaded();

    await user.click(screen.getByRole("button", { name: "Remove stored key" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(callsFor(spy, "provider.save")).toHaveLength(1));
    expect(callsFor(spy, "provider.save")[0][2]).toMatchObject({
      clearApiKey: true,
    });
    await waitFor(() =>
      expect(
        screen.queryByText("Stored key will be removed when you save"),
      ).not.toBeInTheDocument(),
    );
  });
});

describe("ProvidersSettings model catalog refresh coordination", () => {
  it("delays chat model-list invalidation until Fetch settles", async () => {
    const user = userEvent.setup();
    let resolveFetch: (value: unknown) => void = () => undefined;
    const pendingFetch = new Promise((resolve) => {
      resolveFetch = resolve;
    });
    const spy = await renderLoaded(
      mockRequests({
        "provider.fetchModels": () => pendingFetch,
      }),
    );
    const revisionBefore = useAppStore.getState().providerConfigRevision;

    await user.click(
      screen.getByTitle("Save the Provider and fetch its model list"),
    );
    await waitFor(() => expect(callsFor(spy, "provider.fetchModels")).toHaveLength(1));

    expect(useAppStore.getState().providerConfigRevision).toBe(revisionBefore);
    resolveFetch(
      envelope("provider.fetchModels", {
        providerId: "prov-a",
        models: [{ ...model(), thinkingSource: "configured", enabled: true }],
      }),
    );
    await waitFor(() =>
      expect(useAppStore.getState().providerConfigRevision).toBe(revisionBefore + 1),
    );
  });

  it("delays chat model-list invalidation until Test settles", async () => {
    const user = userEvent.setup();
    let resolveTest: (value: unknown) => void = () => undefined;
    const pendingTest = new Promise((resolve) => {
      resolveTest = resolve;
    });
    const spy = await renderLoaded(
      mockRequests({ "provider.checkConnection": () => pendingTest }),
    );
    const revisionBefore = useAppStore.getState().providerConfigRevision;

    await user.click(screen.getByRole("button", { name: "Save & test" }));
    await waitFor(() =>
      expect(callsFor(spy, "provider.checkConnection")).toHaveLength(1),
    );

    expect(useAppStore.getState().providerConfigRevision).toBe(revisionBefore);
    resolveTest(
      envelope("provider.checkConnection", {
        providerId: "prov-a",
        modelId: "m1",
        api: "openai-completions",
        ok: true,
        latencyMs: 7,
        category: "ok",
        message: "Generation succeeded",
      }),
    );
    await waitFor(() =>
      expect(useAppStore.getState().providerConfigRevision).toBe(revisionBefore + 1),
    );
  });

  it("still invalidates the chat model list after an explicit Save", async () => {
    const user = userEvent.setup();
    const spy = await renderLoaded();
    const revisionBefore = useAppStore.getState().providerConfigRevision;

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(callsFor(spy, "provider.save")).toHaveLength(1));

    expect(useAppStore.getState().providerConfigRevision).toBe(revisionBefore + 1);
  });
});

describe("ProvidersSettings model number fields", () => {
  it("lets a cleared field be retyped without snapping to 1", async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await user.click(screen.getByTitle("Model settings"));
    const contextWindow = screen.getByLabelText("Context window");
    expect(contextWindow).toHaveValue(8192);

    await user.clear(contextWindow);
    await user.type(contextWindow, "200000");
    await user.tab();
    expect(contextWindow).toHaveValue(200000);
  });

  it("restores the last committed value when the field is left empty", async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await user.click(screen.getByTitle("Model settings"));
    const contextWindow = screen.getByLabelText("Context window");
    await user.clear(contextWindow);
    await user.tab();
    expect(contextWindow).toHaveValue(8192);
  });

  it("Escape reverts the field without committing and without closing Settings", async () => {
    const user = userEvent.setup();
    const outerClose = vi.fn();
    // Mirrors the Settings overlay listener: window-level, skips consumed events.
    const overlayHandler = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      outerClose();
    };
    window.addEventListener("keydown", overlayHandler);
    try {
      await renderLoaded();

      await user.click(screen.getByTitle("Model settings"));
      const contextWindow = screen.getByLabelText("Context window");
      await user.clear(contextWindow);
      await user.type(contextWindow, "200000");
      await user.keyboard("{Escape}");

      expect(contextWindow).toHaveValue(8192);
      expect(outerClose).not.toHaveBeenCalled();
      expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
    } finally {
      window.removeEventListener("keydown", overlayHandler);
    }
  });
});

describe("ProvidersSettings in-flight guards", () => {
  it("drops a fetch result that resolves after switching to another Provider", async () => {
    const user = userEvent.setup();
    let resolveFetch: (value: unknown) => void = () => undefined;
    const pendingFetch = new Promise((resolve) => {
      resolveFetch = resolve;
    });
    await renderLoaded(
      mockRequests({ "provider.fetchModels": () => pendingFetch }),
    );

    await user.click(
      screen.getByTitle("Save the Provider and fetch its model list"),
    );
    // The implicit save re-baselines, so switching is unguarded and immediate.
    await user.click(screen.getByRole("button", { name: /Provider B/ }));
    await screen.findByDisplayValue("Provider B");

    resolveFetch(
      envelope("provider.fetchModels", {
        models: [
          {
            ...model(),
            id: "from-a",
            name: "From A",
            thinkingSource: "configured",
            enabled: true,
          },
        ],
      }),
    );
    await waitFor(() =>
      expect(screen.queryByTitle("Save the Provider and fetch its model list"))
        .toBeEnabled(),
    );

    expect(screen.queryByText("From A")).not.toBeInTheDocument();
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Display name/)).toHaveValue("Provider B");
  });

  it("does not report unsaved changes when a fetch only reorders the saved models", async () => {
    const user = userEvent.setup();
    const second = { ...model(), id: "a0", name: "A Zero" };
    const provider = { ...providerA(), models: [model(), second] };
    await renderLoaded(
      mockRequests({
        "provider.list": () =>
          envelope("provider.list", { providers: [provider, providerB()] }),
        "provider.save": () => envelope("provider.save", { provider }),
        "provider.fetchModels": () =>
          envelope("provider.fetchModels", {
            // Host returns the same set sorted by id — no semantic change.
            models: [
              { ...second, thinkingSource: "configured", enabled: true },
              { ...model(), thinkingSource: "configured", enabled: true },
            ],
          }),
      }),
    );

    await user.click(
      screen.getByTitle("Save the Provider and fetch its model list"),
    );
    await waitFor(() =>
      expect(
        useAppStore
          .getState()
          .notifications.some((item) => item.message === "Found 2 models"),
      ).toBe(true),
    );

    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
  });

  it("keeps a dirty draft when the host restarts mid-edit", async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await user.type(screen.getByLabelText(/Display name/), "X");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();

    useAppStore
      .getState()
      .setHost({ ...host(), hostInstanceId: "99999999-9999-4999-8999-999999999999" });

    await waitFor(() =>
      expect(screen.getByLabelText(/Display name/)).toHaveValue("Provider AX"),
    );
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  });
});

describe("ProvidersSettings inline validation", () => {
  it("shows URL errors inline on blur and blocks saving until fixed", async () => {
    const user = userEvent.setup();
    const spy = await renderLoaded();

    const baseUrl = screen.getByLabelText(/Base URL/);
    await user.clear(baseUrl);
    await user.type(baseUrl, "not a url");
    await user.tab();
    expect(screen.getByText("Must be an http(s) URL")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(callsFor(spy, "provider.save")).toHaveLength(0);

    await user.clear(baseUrl);
    await user.type(baseUrl, "https://fixed.example.com/v1");
    expect(screen.queryByText("Must be an http(s) URL")).not.toBeInTheDocument();
  });
});

describe("ProvidersSettings models.json", () => {
  it("reveals models.json via the desktop_open_path command", async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await user.click(screen.getByRole("button", { name: "Open models.json" }));

    await waitFor(() =>
      expect(tauriMocks.invoke).toHaveBeenCalledWith("desktop_open_path", {
        path: "/agent/models.json",
      }),
    );
  });

  it("disables the open button while the Host is not connected", () => {
    useAppStore.getState().setHost(null);
    mockRequests();
    render(<ProvidersSettings />);

    expect(screen.getByRole("button", { name: "Open models.json" })).toBeDisabled();
  });
});

describe("ProvidersSettings delete confirmation", () => {
  it("confirms with the saved Provider name, not the edited draft name", async () => {
    const user = userEvent.setup();
    const spy = mockRequests({
      "provider.remove": () =>
        envelope("provider.remove", { providerId: "prov-a" }),
    });
    await renderLoaded(spy);

    await user.type(screen.getByLabelText(/Display name/), " renamed");
    await user.click(screen.getByRole("button", { name: "Delete" }));

    const dialog = screen.getByRole("dialog", { name: "Delete Provider" });
    expect(dialog).toHaveTextContent(
      "This deletes Provider A and its stored API key from this machine.",
    );
    expect(dialog).not.toHaveTextContent("renamed");

    await user.click(within(dialog).getByRole("button", { name: "Delete Provider" }));
    await waitFor(() => expect(callsFor(spy, "provider.remove")).toHaveLength(1));
    expect(callsFor(spy, "provider.remove")[0][2]).toEqual({ providerId: "prov-a" });
  });
});
