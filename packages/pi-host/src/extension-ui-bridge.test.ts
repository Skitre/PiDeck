import { describe, expect, it } from "vitest";
import {
  bindExtensionUi,
  createExtensionUiContext,
  respondExtensionUi,
  cancelPendingForIdentity,
  cancelAllPending,
} from "./extension-ui-bridge.js";
import type { HostEventName, HostIdentity } from "@pideck/protocol";

const id: HostIdentity = {
  hostInstanceId: "h",
  workspaceId: "w",
  workspaceRevision: 1,
  sessionId: "s",
  sessionRevision: 1,
  packageRevision: 0,
};

describe("extension-ui-bridge", () => {
  it("select uses positional title/options and returns option string", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    const ui = createExtensionUiContext({
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
    });
    const p = ui.select("Pick", ["alpha", "beta"]);
    expect(events.some((x) => x.e === "extensionUi.request")).toBe(true);
    const req = events.find((x) => x.e === "extensionUi.request")!.p as {
      requestId: string;
      kind: string;
    };
    expect(req.kind).toBe("select");
    respondExtensionUi(req.requestId, "resolved", "beta", id);
    await expect(p).resolves.toBe("beta");
  });

  it("confirm returns boolean; cancel yields false", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    const ui = createExtensionUiContext({
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
    });
    const p = ui.confirm("Sure?", "Really");
    const req = events.find((x) => x.e === "extensionUi.request")!.p as {
      requestId: string;
    };
    respondExtensionUi(req.requestId, "resolved", true, id);
    await expect(p).resolves.toBe(true);

    const p2 = ui.confirm("Sure?", "Really");
    const req2 = events.filter((x) => x.e === "extensionUi.request").at(-1)!
      .p as { requestId: string };
    respondExtensionUi(req2.requestId, "cancelled", undefined, id);
    await expect(p2).resolves.toBe(false);
  });

  it("cancelAllPending resolves pending without hang", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    const ui = createExtensionUiContext({
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
    });
    const p = ui.input("Name", "type here");
    cancelAllPending("test");
    await expect(p).resolves.toBeUndefined();
  });

  it("cancels only the matching session generation", async () => {
    const nextId: HostIdentity = {
      ...id,
      sessionId: "s-next",
      sessionRevision: 2,
    };
    const first = createExtensionUiContext({ emit: () => {}, getIdentity: () => id });
    const second = createExtensionUiContext({ emit: () => {}, getIdentity: () => nextId });
    const firstPending = first.input("First", "");
    const secondPending = second.input("Second", "");

    cancelPendingForIdentity(id);
    await expect(firstPending).resolves.toBeUndefined();

    let secondSettled = false;
    void secondPending.then(() => {
      secondSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(secondSettled).toBe(false);

    cancelPendingForIdentity(nextId);
    await expect(secondPending).resolves.toBeUndefined();
  });

  it("notify is non-blocking", () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    const ui = createExtensionUiContext({
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
    });
    ui.notify("hello", "info");
    expect(events.some((x) => x.e === "extensionUi.notification")).toBe(true);
  });

  it("strips VT controls from requests, status, widget keys, and nested content", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    const ui = createExtensionUiContext({
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
    });
    const select = ui.select("\u001b]0;title\u0007Pick", ["\u001b[2Kalpha"]);
    const editor = ui.editor("\u001b[33mEdit\u001b[0m", "\u001b[1Gprefill");
    ui.setStatus("\u001b[31mstatus\u001b[0m", "\u001b]0;ignored\u0007ready");
    ui.setWidget(
      "\u001b[35mansi\u001b[0m",
      {
        "\u001b]8;;https://example.com\u0007label\u001b]8;;\u0007": "\u001b[2Jwidget",
      } as never,
    );

    const requests = events
      .filter((event) => event.e === "extensionUi.request")
      .map((event) => event.p as { title?: string; options?: Array<{ id: string; label: string }>; defaultValue?: string });
    expect(requests[0]?.title).toBe("Pick");
    expect(requests[0]?.options?.[0]).toEqual({ id: "alpha", label: "alpha" });
    expect(requests[1]?.title).toBe("Edit");
    expect(requests[1]?.defaultValue).toBe("prefill");
    const status = events.find((event) => event.e === "extensionUi.statusChanged")?.p as {
      key?: string;
      text?: string;
    };
    expect(status).toEqual({ key: "status", text: "ready" });
    const widget = events.find((event) => event.e === "extensionUi.widgetChanged")?.p as {
      key?: string;
      widget?: Record<string, string>;
    };
    expect(widget.key).toBe("ansi");
    expect(widget.widget).toEqual({ label: "widget" });

    cancelAllPending("test cleanup");
    await expect(select).resolves.toBeUndefined();
    await expect(editor).resolves.toBeUndefined();
  });

  it("releases blocking candidate requests during activation and waits for bind completion", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    const session = {
      bindExtensions: async ({ uiContext }: { uiContext: ReturnType<typeof createExtensionUiContext> }) => {
        await uiContext.input("Startup", "value");
      },
    };
    const binding = await bindExtensionUi(session as never, null, {
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
    });

    const activation = binding.activate();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const request = events.find((event) => event.e === "extensionUi.request")?.p as {
      requestId: string;
    };
    expect(request.requestId).toBeTruthy();
    respondExtensionUi(request.requestId, "resolved", "ok", id);
    const publish = await activation;
    expect(publish).toBeTypeOf("function");
    publish();
    binding.cleanup();
  });

  it("propagates bind failure from activation", async () => {
    const session = {
      bindExtensions: async () => {
        throw new Error("bind failed");
      },
    };
    const binding = await bindExtensionUi(session as never, null, {
      emit: () => {},
      getIdentity: () => id,
    });

    await expect(binding.activate()).rejects.toThrow("bind failed");
    binding.cleanup();
  });

  it("buffers non-blocking events until the candidate generation is published", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    const session = {
      bindExtensions: async ({ uiContext }: { uiContext: ReturnType<typeof createExtensionUiContext> }) => {
        uiContext.setStatus("startup", "loading");
        uiContext.notify("candidate ready", "info");
      },
    };

    const binding = await bindExtensionUi(session as never, null, {
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
    });

    expect(events).toEqual([]);
    const publish = await binding.activate();
    expect(events).toEqual([]);
    publish();
    expect(events.map((event) => event.e)).toEqual([
      "extensionUi.statusChanged",
      "extensionUi.notification",
    ]);
    publish();
    expect(events).toHaveLength(2);
    binding.cleanup();
  });

  it("migrates pending requests and future events to a promoted Session identity", async () => {
    const promoted = { ...id, sessionRevision: id.sessionRevision + 1 };
    const events: Array<{ identity: HostIdentity; e: HostEventName; p: unknown }> = [];
    let ui: ReturnType<typeof createExtensionUiContext> | undefined;
    const session = {
      bindExtensions: async ({ uiContext }: { uiContext: typeof ui }) => {
        ui = uiContext;
      },
    };
    const binding = await bindExtensionUi(session as never, null, {
      emit: () => {},
      emitForIdentity: (identity, e, p) => events.push({ identity, e, p }),
      getIdentity: () => id,
    });
    const publish = await binding.activate();
    publish();

    const pendingInput = ui!.input("Promote", "value");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const request = events.find((event) => event.e === "extensionUi.request")?.p as {
      requestId: string;
    };
    binding.updateIdentity(promoted);
    ui!.notify("promoted", "info");

    expect(events.at(-1)?.identity.sessionRevision).toBe(promoted.sessionRevision);
    expect(
      respondExtensionUi(request.requestId, "resolved", "done", promoted),
    ).toBe(true);
    await expect(pendingInput).resolves.toBe("done");
    binding.cleanup();
  });
});
