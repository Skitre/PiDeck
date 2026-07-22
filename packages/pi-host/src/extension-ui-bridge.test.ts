import { describe, expect, it } from "vitest";
import {
  bindExtensionUi,
  createExtensionUiContext,
  respondExtensionUi,
  cancelPendingForIdentity,
  cancelAllPending,
  injectExtensionCustomInput,
} from "./extension-ui-bridge.js";
import type { HostEventName, HostIdentity } from "@pideck/protocol";
import { withExtensionCommandOrigin } from "./extension-command-context.js";

const id: HostIdentity = {
  hostInstanceId: "h",
  workspaceId: "w",
  workspaceRevision: 1,
  sessionId: "s",
  sessionRevision: 1,
  packageRevision: 0,
};

const COMMAND_RUN_ID = "00000000-0000-4000-8000-000000000006";
const NEXT_COMMAND_RUN_ID = "00000000-0000-4000-8000-000000000007";

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

  it("preserves below-editor widget placement", () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    const ui = createExtensionUiContext({
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
    });

    ui.setWidget("progress", ["working"], { placement: "belowEditor" });

    expect(events.at(-1)).toEqual({
      e: "extensionUi.widgetChanged",
      p: { key: "progress", widget: ["working"], placement: "belowEditor" },
    });
  });

  it("requests attention once when an extension command writes a static widget", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    let ui: ReturnType<typeof createExtensionUiContext> | undefined;
    const session = {
      bindExtensions: async ({ uiContext }: { uiContext: typeof ui }) => {
        ui = uiContext;
      },
    };
    const binding = await bindExtensionUi(session as never, null, {
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
    });
    const publish = await binding.activate();
    publish();

    // A nano-context-style lifecycle refresh is not command-originated.
    ui!.setWidget("nano-context", ["usage"]);
    await withExtensionCommandOrigin(
      session as never,
      COMMAND_RUN_ID,
      "brainstorm",
      async () => {
        ui!.setWidget("brainstorm", ["active"]);
        ui!.setWidget("brainstorm-details", ["more"]);
        ui!.setWidget("brainstorm", undefined);
      },
    );

    const attention = events.filter(
      (event) => event.e === "extensionUi.widgetAttentionRequested",
    );
    expect(attention).toEqual([
      {
        e: "extensionUi.widgetAttentionRequested",
        p: {
          key: "brainstorm",
          runId: COMMAND_RUN_ID,
          invocation: "brainstorm",
        },
      },
    ]);
    const brainstormWrite = events.findIndex(
      (event) =>
        event.e === "extensionUi.widgetChanged" &&
        (event.p as { key?: string }).key === "brainstorm" &&
        (event.p as { widget?: unknown }).widget !== null,
    );
    const attentionIndex = events.findIndex(
      (event) => event.e === "extensionUi.widgetAttentionRequested",
    );
    expect(attentionIndex).toBeGreaterThan(brainstormWrite);
    binding.cleanup();
  });

  it("clears a prior same-key widget when a replacement factory fails", () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    const ui = createExtensionUiContext({
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
    });

    ui.setWidget("progress", ["old"]);
    ui.setWidget("progress", () => {
      throw new Error("factory failed");
    });

    const widgets = events
      .filter((event) => event.e === "extensionUi.widgetChanged")
      .map((event) => event.p);
    expect(widgets).toEqual([
      { key: "progress", widget: ["old"] },
      { key: "progress", widget: null },
    ]);
    expect(
      events.some(
        (event) =>
          event.e === "package.diagnostic" &&
          String((event.p as { message?: unknown }).message).includes("factory failed"),
      ),
    ).toBe(true);
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
        uiContext.setWidget("startup", ["loading"]);
        uiContext.setWidget("startup", ["ready"]);
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
      "extensionUi.widgetChanged",
      "extensionUi.notification",
    ]);
    expect(events[1]?.p).toEqual({ key: "startup", widget: ["ready"] });
    publish();
    expect(events).toHaveLength(3);
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

  it("custom() drives a TUI over a virtual terminal: started → frames → done → closed", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    const ui = createExtensionUiContext({
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
    });
    let doneFn: ((result: string) => void) | undefined;
    const received: string[] = [];
    const panel = ui.custom<string>((tui, theme, keybindings, done) => {
      expect(theme).toBeTruthy();
      expect(keybindings.matches("\r", "tui.select.confirm")).toBe(true);
      expect(keybindings.matches("\x1b", "app.interrupt")).toBe(true);
      doneFn = done;
      return {
        render: () => ["hello panel"],
        invalidate: () => {},
        handleInput: (data: string) => {
          received.push(data);
          done(`picked:${data}`);
        },
      };
    });

    const started = events.find((x) => x.e === "extensionUi.customStarted")?.p as {
      requestId: string;
      cols: number;
      rows: number;
    };
    expect(started).toBeTruthy();
    expect(started.cols).toBe(100);
    expect(started.rows).toBe(32);
    expect(doneFn).toBeTypeOf("function"); // factory invoked synchronously, like the CLI

    // Wait past the frame flush interval for the first differential render.
    await new Promise((resolve) => setTimeout(resolve, 80));
    const frames = events
      .filter((x) => x.e === "extensionUi.customFrame")
      .map((x) => (x.p as { requestId: string; data: string }).data)
      .join("");
    expect(frames).toContain("hello panel");
    expect(
      events
        .filter((x) => x.e === "extensionUi.customFrame")
        .every((x) => (x.p as { requestId: string }).requestId === started.requestId),
    ).toBe(true);

    // Input injected through the handler path reaches the focused component.
    const okInput = injectExtensionCustomInput(started.requestId, "\r");
    expect(okInput).toBe(true);
    expect(received).toEqual(["\r"]);
    await expect(panel).resolves.toBe("picked:\r");
    expect(events.some((x) => x.e === "extensionUi.customClosed")).toBe(true);

    // Panel is gone — further input is rejected.
    expect(injectExtensionCustomInput(started.requestId, "x")).toBe(false);
  });

  it("custom() cancels via identity cleanup and emits customClosed", async () => {
    const cancelId: HostIdentity = { ...id, sessionId: "s-cancel" };
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    const ui = createExtensionUiContext({
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => cancelId,
    });
    const panel = ui.custom(() => ({
      render: () => ["waiting"],
      invalidate: () => {},
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    cancelPendingForIdentity(cancelId);
    await expect(panel).resolves.toBeUndefined();
    expect(events.some((x) => x.e === "extensionUi.customClosed")).toBe(true);
  });

  it("custom() cancels via protocol response without terminal input", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    const ui = createExtensionUiContext({
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
    });
    const panel = ui.custom(() => ({
      render: () => ["waiting"],
      invalidate: () => {},
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const started = events.find((x) => x.e === "extensionUi.customStarted")?.p as {
      requestId: string;
    };

    expect(respondExtensionUi(started.requestId, "cancelled", undefined, id)).toBe(true);
    await expect(panel).resolves.toBeUndefined();
    expect(events.some((x) => x.e === "extensionUi.customClosed")).toBe(true);
  });

  it("custom input runs extension-owned close callbacks", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    const ui = createExtensionUiContext({
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
    });
    const extensionFlow = new Promise<void>((resolve) => {
      void ui.custom((_tui, _theme, _keybindings, done) => ({
        render: () => ["waiting"],
        invalidate: () => {},
        handleInput: (data: string) => {
          if (data !== "\u0003") return;
          done(undefined);
          resolve();
        },
      }));
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const started = events.find((x) => x.e === "extensionUi.customStarted")?.p as {
      requestId: string;
    };

    expect(injectExtensionCustomInput(started.requestId, "\u0003")).toBe(true);
    await expect(extensionFlow).resolves.toBeUndefined();
    expect(events.some((x) => x.e === "extensionUi.customClosed")).toBe(true);
  });

  it("custom() rejects and notifies when the factory throws", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    const ui = createExtensionUiContext({
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
    });
    const panel = ui.custom(() => {
      throw new Error("factory boom");
    });
    await expect(panel).rejects.toThrow("factory boom");
    expect(events.some((x) => x.e === "extensionUi.customClosed")).toBe(true);
    const notification = events.find((x) => x.e === "extensionUi.notification")?.p as {
      message: string;
      level: string;
    };
    expect(notification.level).toBe("error");
    expect(notification.message).toContain("factory boom");
  });

  it("setWidget factory publishes live snapshots and disposes when cleared", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    const ui = createExtensionUiContext({
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
    });
    let text = "line one";
    let requestRender: (() => void) | undefined;
    let disposed = false;
    ui.setWidget("tasks", (tui) => {
      requestRender = () => tui.requestRender();
      return {
        render: () => [`\x1b[32m${text}\x1b[0m`, "line two"],
        invalidate: () => {},
        dispose: () => {
          disposed = true;
        },
      };
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    let widget = events.filter((x) => x.e === "extensionUi.widgetChanged").at(-1)?.p as {
      key: string;
      widget: string[];
    };
    expect(widget.key).toBe("tasks");
    expect(widget.widget).toEqual(["line one", "line two"]);

    text = "updated";
    requestRender?.();
    requestRender?.();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const updates = events.filter((x) => x.e === "extensionUi.widgetChanged");
    expect(updates).toHaveLength(2);
    expect(updates[0]?.p).toEqual({
      key: "tasks",
      widget: ["line one", "line two"],
    });
    widget = updates.at(-1)?.p as { key: string; widget: string[] };
    expect(widget.widget).toEqual(["updated", "line two"]);

    ui.setWidget("tasks", ["static replacement"]);
    expect(disposed).toBe(true);
    expect(events.at(-1)).toEqual({
      e: "extensionUi.widgetChanged",
      p: { key: "tasks", widget: ["static replacement"] },
    });

    requestRender?.();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(events.filter((x) => x.e === "extensionUi.widgetChanged")).toHaveLength(3);

    ui.setWidget("tasks", undefined);
    expect(events.at(-1)).toEqual({
      e: "extensionUi.widgetChanged",
      p: { key: "tasks", widget: null },
    });
    expect(events.filter((x) => x.e === "extensionUi.widgetChanged")).toHaveLength(4);
  });

  it("replaces a live widget factory without a transient clear", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    const ui = createExtensionUiContext({
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
    });
    let disposed = false;

    ui.setWidget("nano-context", () => ({
      render: () => ["old context"],
      invalidate: () => {},
      dispose: () => {
        disposed = true;
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 30));

    ui.setWidget("nano-context", () => ({
      render: () => ["new context"],
      invalidate: () => {},
    }));
    expect(disposed).toBe(true);
    expect(events.filter((event) => event.e === "extensionUi.widgetChanged")).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(
      events
        .filter((event) => event.e === "extensionUi.widgetChanged")
        .map((event) => event.p),
    ).toEqual([
      { key: "nano-context", widget: ["old context"] },
      { key: "nano-context", widget: ["new context"] },
    ]);
  });

  it("clears a prior widget when a replacement factory first render fails", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    const ui = createExtensionUiContext({
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
    });

    ui.setWidget("progress", ["old"]);
    ui.setWidget("progress", () => ({
      render: () => {
        throw new Error("render failed");
      },
      invalidate: () => {},
    }));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(
      events
        .filter((event) => event.e === "extensionUi.widgetChanged")
        .map((event) => event.p),
    ).toEqual([
      { key: "progress", widget: ["old"] },
      { key: "progress", widget: null },
    ]);
  });

  it("captures command origin until a widget factory first renders successfully", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    let ui: ReturnType<typeof createExtensionUiContext> | undefined;
    const session = {
      bindExtensions: async ({ uiContext }: { uiContext: typeof ui }) => {
        ui = uiContext;
      },
    };
    const binding = await bindExtensionUi(session as never, null, {
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
    });
    const publish = await binding.activate();
    publish();

    let failRender = true;
    let text = "ready";
    let requestRender: (() => void) | undefined;
    await withExtensionCommandOrigin(
      session as never,
      COMMAND_RUN_ID,
      "brainstorm",
      async () => {
        ui!.setWidget("brainstorm-live", (tui) => {
          requestRender = () => tui.requestRender();
          return {
            render: () => {
              if (failRender) throw new Error("not ready");
              return [text];
            },
            invalidate: () => {},
          };
        });
        await new Promise((resolve) => setTimeout(resolve, 30));
      },
    );
    expect(
      events.filter((event) => event.e === "extensionUi.widgetAttentionRequested"),
    ).toHaveLength(0);

    failRender = false;
    requestRender?.();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(
      events.filter((event) => event.e === "extensionUi.widgetAttentionRequested"),
    ).toEqual([
      {
        e: "extensionUi.widgetAttentionRequested",
        p: {
          key: "brainstorm-live",
          runId: COMMAND_RUN_ID,
          invocation: "brainstorm",
        },
      },
    ]);

    text = "refreshed";
    requestRender?.();
    requestRender?.();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(
      events.filter((event) => event.e === "extensionUi.widgetAttentionRequested"),
    ).toHaveLength(1);
    binding.cleanup();
  });

  it("attributes an existing live widget redraw to the command that requested it", async () => {
    const events: Array<{ e: HostEventName; p: unknown }> = [];
    let ui: ReturnType<typeof createExtensionUiContext> | undefined;
    const session = {
      bindExtensions: async ({ uiContext }: { uiContext: typeof ui }) => {
        ui = uiContext;
      },
    };
    const binding = await bindExtensionUi(session as never, null, {
      emit: (e, p) => events.push({ e, p }),
      getIdentity: () => id,
    });
    const publish = await binding.activate();
    publish();

    let text = "idle";
    let requestRender: (() => void) | undefined;
    ui!.setWidget("existing-live", (tui) => {
      requestRender = () => tui.requestRender();
      return {
        render: () => [text],
        invalidate: () => {},
      };
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(
      events.filter((event) => event.e === "extensionUi.widgetAttentionRequested"),
    ).toHaveLength(0);

    await withExtensionCommandOrigin(
      session as never,
      COMMAND_RUN_ID,
      "brainstorm",
      async () => {
        text = "command update";
        requestRender?.();
        await new Promise((resolve) => setTimeout(resolve, 30));

        text = "same command update";
        requestRender?.();
        await new Promise((resolve) => setTimeout(resolve, 30));
      },
    );
    expect(
      events.filter((event) => event.e === "extensionUi.widgetAttentionRequested"),
    ).toEqual([
      {
        e: "extensionUi.widgetAttentionRequested",
        p: {
          key: "existing-live",
          runId: COMMAND_RUN_ID,
          invocation: "brainstorm",
        },
      },
    ]);

    await withExtensionCommandOrigin(
      session as never,
      NEXT_COMMAND_RUN_ID,
      "brainstorm",
      async () => {
        text = "next command update";
        requestRender?.();
        await new Promise((resolve) => setTimeout(resolve, 30));
      },
    );
    expect(
      events.filter((event) => event.e === "extensionUi.widgetAttentionRequested"),
    ).toEqual([
      {
        e: "extensionUi.widgetAttentionRequested",
        p: {
          key: "existing-live",
          runId: COMMAND_RUN_ID,
          invocation: "brainstorm",
        },
      },
      {
        e: "extensionUi.widgetAttentionRequested",
        p: {
          key: "existing-live",
          runId: NEXT_COMMAND_RUN_ID,
          invocation: "brainstorm",
        },
      },
    ]);

    text = "background refresh";
    requestRender?.();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(
      events.filter((event) => event.e === "extensionUi.widgetAttentionRequested"),
    ).toHaveLength(2);
    binding.cleanup();
  });

  it("binding cleanup disposes live setWidget factories", async () => {
    let disposed = false;
    const session = {
      bindExtensions: async ({ uiContext }: { uiContext: ReturnType<typeof createExtensionUiContext> }) => {
        uiContext.setWidget("live", () => ({
          render: () => ["live"],
          invalidate: () => {},
          dispose: () => {
            disposed = true;
          },
        }));
      },
    };
    const binding = await bindExtensionUi(session as never, null, {
      emit: () => {},
      getIdentity: () => id,
    });
    const publish = await binding.activate();
    publish();
    binding.cleanup();
    expect(disposed).toBe(true);
  });
});
