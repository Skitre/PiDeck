/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAttachmentReferenceBlock,
  type HostStatusSnapshot,
  type SessionSnapshot,
  type WorkspaceSnapshot,
} from "@pideck/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore } from "../../lib/stores/app-store";
import { Transcript } from "./Transcript";
import { MenuHost } from "../../components/Menu";
import { PROGRESSIVE_BATCH_ROWS } from "./progressive-mount";
import { clearTranscriptScrollPositions } from "./transcript-scroll-memory";
import { buildAttachedFileBlock } from "./transcript-model";

const linkMocks = vi.hoisted(() => ({
  requestDockBrowser: vi.fn(),
  openSystemUrl: vi.fn(),
}));

vi.mock("../../lib/dock-browser", () => ({
  requestDockBrowser: linkMocks.requestDockBrowser,
}));

vi.mock("../../lib/open-system-url", () => ({
  openSystemUrl: linkMocks.openSystemUrl,
}));

const SESSION_A = "33333333-3333-4333-8333-333333333333";
const SESSION_B = "44444444-4444-4444-8444-444444444444";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

function longSession(sessionId: string, messageCount: number): SessionSnapshot {
  return {
    ...session(sessionId, "seed"),
    messages: Array.from({ length: messageCount }, (_, index) => ({
      role: "user" as const,
      content: `Message ${index + 1}`,
    })),
  };
}

function session(sessionId: string, text: string): SessionSnapshot {
  return {
    sessionId,
    cwd: "/workspace",
    revision: 1,
    isStreaming: false,
    isIdle: true,
    isCompacting: false,
    isRetrying: false,
    thinkingLevel: "off",
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    steeringMode: "all",
    followUpMode: "all",
    pending: { revision: 0, steering: [], followUp: [] },
    messages: [{ role: "user", content: text }],
    tools: {
      revision: 1,
      workspaceId: WORKSPACE_ID,
      sessionId,
      sessionRevision: 1,
      tools: [],
      active: [],
    },
  };
}

class TestResizeObserver {
  static instances: TestResizeObserver[] = [];

  constructor(private readonly callback: ResizeObserverCallback) {
    TestResizeObserver.instances.push(this);
  }

  observe() {}
  unobserve() {}
  disconnect() {}

  trigger() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

let nextFrameId = 1;
let frames = new Map<number, FrameRequestCallback>();

function flushFrames() {
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(0));
  });
}

let nextIdleId = 1;
let idleCallbacks = new Map<number, () => void>();

function flushIdle() {
  act(() => {
    const pending = [...idleCallbacks.values()];
    idleCallbacks.clear();
    pending.forEach((callback) => callback());
  });
}

/** Each flush runs one mount batch; loop until the idle queue settles. */
function flushIdleToConvergence(maxBatches = 60) {
  for (let batch = 0; batch < maxBatches && idleCallbacks.size > 0; batch++) {
    flushIdle();
  }
}

describe("Transcript Session-open scrolling", () => {
  beforeEach(() => {
    nextFrameId = 1;
    frames = new Map();
    TestResizeObserver.instances = [];
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        const id = nextFrameId++;
        frames.set(id, callback);
        return id;
      }),
    );
    vi.stubGlobal(
      "cancelAnimationFrame",
      vi.fn((id: number) => {
        frames.delete(id);
      }),
    );
    nextIdleId = 1;
    idleCallbacks = new Map();
    vi.stubGlobal(
      "requestIdleCallback",
      vi.fn((callback: () => void) => {
        const id = nextIdleId++;
        idleCallbacks.set(id, callback);
        return id;
      }),
    );
    vi.stubGlobal(
      "cancelIdleCallback",
      vi.fn((id: number) => {
        idleCallbacks.delete(id);
      }),
    );
    useAppStore.setState({
      session: session(SESSION_A, "First Session"),
      desktopSettings: {
        theme: "system",
        language: "en",
        restoreLastSession: true,
        autoRestartHostOnce: true,
        extensionDecisionPresentation: "auto",
        terminalProfile: "auto",
      },
    });
    linkMocks.requestDockBrowser.mockReset().mockReturnValue(true);
    linkMocks.openSystemUrl.mockReset().mockResolvedValue(undefined);
    clearTranscriptScrollPositions();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    delete (navigator as { clipboard?: Clipboard }).clipboard;
    useAppStore.setState({ session: null, desktopSettings: null });
  });

  it("keeps a newly opened Session at the bottom through late content growth", () => {
    const { container } = render(<Transcript />);
    const scroll = container.querySelector<HTMLElement>("[data-transcript-scroll]")!;
    let scrollHeight = 900;
    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, get: () => 300 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });

    flushFrames();
    expect(scroll.scrollTop).toBe(900);

    scrollHeight = 1_400;
    act(() => TestResizeObserver.instances.at(-1)?.trigger());
    flushFrames();
    expect(scroll.scrollTop).toBe(1_400);
  });

  it("stops following manual history reads and resets to the bottom for the next Session", () => {
    const { container } = render(<Transcript />);
    const scroll = container.querySelector<HTMLElement>("[data-transcript-scroll]")!;
    let scrollHeight = 1_000;
    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, get: () => 300 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });
    flushFrames();

    scroll.scrollTop = 100;
    fireEvent.scroll(scroll);
    scrollHeight = 1_300;
    act(() => TestResizeObserver.instances.at(-1)?.trigger());
    flushFrames();
    expect(scroll.scrollTop).toBe(100);

    scrollHeight = 1_700;
    act(() => useAppStore.setState({ session: session(SESSION_B, "Second Session") }));
    flushFrames();
    expect(scroll.scrollTop).toBe(1_700);
  });

  it("releases a small upward gesture before a queued tail alignment", () => {
    const { container } = render(<Transcript />);
    const scroll = container.querySelector<HTMLElement>("[data-transcript-scroll]")!;
    let scrollHeight = 1_000;
    const clientHeight = 300;
    let scrollTop = 0;
    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, get: () => clientHeight },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = Math.max(0, Math.min(value, scrollHeight - clientHeight));
        },
      },
    });
    flushFrames();
    expect(scroll.scrollTop).toBe(700);

    act(() => TestResizeObserver.instances.at(-1)?.trigger());
    fireEvent.wheel(scroll, { deltaY: -20 });
    scroll.scrollTop = 680;
    fireEvent.scroll(scroll);
    flushFrames();

    expect(scroll.scrollTop).toBe(680);
    expect(screen.getByRole("button", { name: "Jump to latest message" })).toBeInTheDocument();

    scroll.scrollTop = 695;
    fireEvent.scroll(scroll);
    scrollHeight = 1_100;
    act(() => TestResizeObserver.instances.at(-1)?.trigger());
    flushFrames();
    expect(scroll.scrollTop).toBe(800);
  });

  it("keeps following when content shrinkage lowers the maximum scroll position", () => {
    const { container } = render(<Transcript />);
    const scroll = container.querySelector<HTMLElement>("[data-transcript-scroll]")!;
    let scrollHeight = 1_000;
    const clientHeight = 300;
    let scrollTop = 0;
    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, get: () => clientHeight },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = Math.max(0, Math.min(value, scrollHeight - clientHeight));
        },
      },
    });
    flushFrames();
    expect(scroll.scrollTop).toBe(700);

    scrollHeight = 900;
    scroll.scrollTop = 600;
    fireEvent.scroll(scroll);
    scrollHeight = 950;
    act(() => TestResizeObserver.instances.at(-1)?.trigger());
    flushFrames();

    expect(scroll.scrollTop).toBe(650);
    expect(
      screen.queryByRole("button", { name: "Jump to latest message" }),
    ).not.toBeInTheDocument();
  });

  it("opens a row context menu and copies the complete message", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const { container } = render(
      <>
        <Transcript />
        <MenuHost />
      </>,
    );
    fireEvent.contextMenu(container.querySelector(".transcript-row")!, {
      clientX: 24,
      clientY: 32,
    });
    await user.click(await screen.findByRole("menuitem", { name: "Copy message" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("First Session"));
  });

  it("adds Dock, external-browser, and copy actions when right-clicking a link", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const { container } = render(
      <>
        <Transcript />
        <MenuHost />
      </>,
    );
    const row = container.querySelector<HTMLElement>(".transcript-row")!;
    const link = document.createElement("a");
    link.href = "https://example.com/docs";
    link.textContent = "Documentation";
    row.append(link);

    fireEvent.contextMenu(link, { clientX: 24, clientY: 32 });
    expect(await screen.findByRole("menuitem", { name: "Open in Dock" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Open in external browser" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Copy link" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Copy message" })).toBeInTheDocument();

    await user.click(screen.getByRole("menuitem", { name: "Open in Dock" }));
    expect(linkMocks.requestDockBrowser).toHaveBeenCalledWith({
      url: "https://example.com/docs",
    });

    fireEvent.contextMenu(link, { clientX: 24, clientY: 32 });
    await user.click(await screen.findByRole("menuitem", { name: "Open in external browser" }));
    expect(linkMocks.openSystemUrl).toHaveBeenCalledWith("https://example.com/docs");

    fireEvent.contextMenu(link, { clientX: 24, clientY: 32 });
    await user.click(await screen.findByRole("menuitem", { name: "Copy link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://example.com/docs"));

    expect(row).toBeInTheDocument();
  });

  it("leaves development Shift-right-click available for the native menu", () => {
    const { container } = render(
      <>
        <Transcript />
        <MenuHost />
      </>,
    );
    fireEvent.contextMenu(container.querySelector(".transcript-row")!, {
      clientX: 24,
      clientY: 32,
      shiftKey: true,
    });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  describe("progressive mounting", () => {
    /** Fake metrics, then release the tail pin with an upward history read. */
    function unfollow(scroll: HTMLElement) {
      let scrollTop = 0;
      Object.defineProperties(scroll, {
        clientHeight: { configurable: true, get: () => 300 },
        scrollHeight: { configurable: true, get: () => 1_000 },
        scrollTop: {
          configurable: true,
          get: () => scrollTop,
          set: (value: number) => {
            scrollTop = Math.max(0, Math.min(value, 700));
          },
        },
      });
      flushFrames();
      scroll.scrollTop = 650;
      fireEvent.scroll(scroll);
    }

    it("opens with only the tail mounted, then converges once the reader unpins", async () => {
      act(() => useAppStore.setState({ session: longSession(SESSION_A, 150) }));
      const { container } = render(<Transcript />);
      const scroll = container.querySelector<HTMLElement>("[data-transcript-scroll]")!;

      expect(container.querySelectorAll(".transcript-row")).toHaveLength(60);
      expect(
        screen.getByRole("button", { name: "Show earlier messages (90 hidden)" }),
      ).toBeInTheDocument();

      unfollow(scroll);
      await waitFor(
        () => {
          flushIdleToConvergence();
          expect(container.querySelectorAll(".transcript-row")).toHaveLength(150);
        },
        { timeout: 10_000 },
      );
      expect(
        screen.queryByRole("button", { name: /Show earlier messages/ }),
      ).not.toBeInTheDocument();
    }, 15_000);

    it("yields idle mounting to a followed stream and converges after it settles", async () => {
      act(() =>
        useAppStore.setState({
          session: { ...longSession(SESSION_A, 150), isStreaming: true, isIdle: false },
        }),
      );
      const { container } = render(<Transcript />);
      const scroll = container.querySelector<HTMLElement>("[data-transcript-scroll]")!;

      expect(idleCallbacks.size).toBe(0);
      flushIdleToConvergence();
      expect(container.querySelectorAll(".transcript-row")).toHaveLength(60);

      act(() =>
        useAppStore.setState({
          session: { ...longSession(SESSION_A, 150), isStreaming: false, isIdle: true },
        }),
      );
      unfollow(scroll);
      await waitFor(
        () => {
          flushIdleToConvergence();
          expect(container.querySelectorAll(".transcript-row")).toHaveLength(150);
        },
        { timeout: 10_000 },
      );
    }, 15_000);

    it("restores the reading position when switching back to a session", () => {
      const longA = longSession(SESSION_A, 150);
      act(() => useAppStore.setState({ session: longA }));
      const { container } = render(<Transcript />);
      const scroll = container.querySelector<HTMLElement>("[data-transcript-scroll]")!;
      unfollow(scroll);
      expect(scroll.scrollTop).toBe(650);

      act(() => useAppStore.setState({ session: session(SESSION_B, "Second Session") }));
      flushFrames();
      expect(scroll.scrollTop).toBe(700);

      act(() => useAppStore.setState({ session: longA }));
      expect(container.querySelectorAll(".transcript-row")).toHaveLength(60);
      expect(scroll.scrollTop).toBe(650);
      expect(screen.getByRole("button", { name: "Jump to latest message" })).toBeInTheDocument();
    });

    it("mounts the next batch synchronously when the reader nears the top edge", () => {
      act(() => useAppStore.setState({ session: longSession(SESSION_A, 300) }));
      const { container } = render(<Transcript />);
      const scroll = container.querySelector<HTMLElement>("[data-transcript-scroll]")!;
      Object.defineProperties(scroll, {
        clientHeight: { configurable: true, get: () => 300 },
        scrollHeight: { configurable: true, get: () => 2_000 },
        scrollTop: { configurable: true, writable: true, value: 500 },
      });
      expect(container.querySelectorAll(".transcript-row")).toHaveLength(60);

      fireEvent.scroll(scroll);

      // One synchronous boost batch at the initial adaptive size.
      expect(container.querySelectorAll(".transcript-row")).toHaveLength(
        60 + PROGRESSIVE_BATCH_ROWS,
      );
    });
  });
});

const HOST_ID = "11111111-1111-4111-8111-111111111111";

function hostStatus(): HostStatusSnapshot {
  return {
    protocolVersion: 1,
    hostInstanceId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    workspaceRevision: 1,
    sessionId: SESSION_A,
    sessionRevision: 1,
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

function workspaceStatus(): WorkspaceSnapshot {
  return {
    id: WORKSPACE_ID,
    cwd: "/workspace",
    canonicalCwd: "/workspace",
    revision: 1,
    servicesReady: true,
  };
}

function branchedSession(): SessionSnapshot {
  return {
    ...session(SESSION_A, "Hello"),
    messages: [
      { role: "user", content: "Hello" },
      { role: "assistant", content: [{ type: "text", text: "Hi there" }] },
    ],
    entries: [
      {
        id: "u1",
        type: "message",
        message: { role: "user", content: "Hello" },
      },
      {
        id: "a1",
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "Hi there" }] },
      },
    ],
    leafId: "a1",
  };
}

function attachedFileSession(): SessionSnapshot {
  const content = ["Review this", buildAttachedFileBlock("notes.txt", "hello from disk")].join(
    "\n\n",
  );
  return {
    ...session(SESSION_A, content),
    messages: [
      { role: "user", content },
      { role: "assistant", content: [{ type: "text", text: "Reviewed" }] },
    ],
    entries: [
      {
        id: "u1",
        type: "message",
        message: { role: "user", content },
      },
      {
        id: "a1",
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "Reviewed" }] },
      },
    ],
    leafId: "a1",
  };
}

function documentOnlySession(): SessionSnapshot {
  const content = buildAttachmentReferenceBlock([
    {
      id: "11111111-1111-4111-8111-111111111111",
      name: "manual.pdf",
      mediaType: "application/pdf",
      sizeBytes: 1024,
      status: "ready",
      unit: "page",
      unitCount: 12,
    },
  ]);
  return {
    ...session(SESSION_A, content),
    messages: [
      { role: "user", content },
      { role: "assistant", content: [{ type: "text", text: "Read the PDF" }] },
    ],
    entries: [
      {
        id: "u1",
        type: "message",
        message: { role: "user", content },
      },
      {
        id: "a1",
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "Read the PDF" }] },
      },
    ],
    leafId: "a1",
  };
}

describe("Transcript edit and regenerate", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal(
      "requestIdleCallback",
      vi.fn((callback: () => void) => {
        callback();
        return 1;
      }),
    );
    vi.stubGlobal("cancelIdleCallback", vi.fn());
    useAppStore.getState().setHost(hostStatus());
    useAppStore.getState().setWorkspace(workspaceStatus());
    useAppStore.getState().applySessionSnapshot(branchedSession());
    useAppStore.setState({
      desktopSettings: {
        theme: "system",
        language: "en",
        restoreLastSession: true,
        autoRestartHostOnce: true,
        extensionDecisionPresentation: "auto",
        terminalProfile: "auto",
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    useAppStore.getState().setHost(null);
    useAppStore.getState().setWorkspace(null);
    useAppStore.getState().applySessionSnapshot(null);
    useAppStore.setState({ desktopSettings: null });
  });

  it("edits a user message in place and only prompts after send", async () => {
    const request = vi.spyOn(hostClient, "request").mockResolvedValue({
      protocolVersion: 1,
      id: "req",
      method: "agent.prompt",
      hostInstanceId: HOST_ID,
      workspaceId: WORKSPACE_ID,
      workspaceRevision: 1,
      sessionId: SESSION_A,
      sessionRevision: 1,
      packageRevision: 1,
      ok: true,
      result: {
        accepted: true,
        runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        session: branchedSession(),
      },
    } as never);
    render(
      <>
        <Transcript />
        <MenuHost />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(request).not.toHaveBeenCalled();
    const editor = screen.getByRole("textbox", { name: "Edit" });
    expect(editor).toHaveValue("Hello");
    fireEvent.change(editor, { target: { value: "Hello again" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "agent.prompt",
        expect.any(Object),
        { text: "Hello again", fromEntryId: "u1" },
        null,
      ),
    );
  });

  it("regenerates an assistant turn from the preceding user entry", async () => {
    const request = vi.spyOn(hostClient, "request").mockResolvedValue({
      protocolVersion: 1,
      id: "req",
      method: "agent.prompt",
      hostInstanceId: HOST_ID,
      workspaceId: WORKSPACE_ID,
      workspaceRevision: 1,
      sessionId: SESSION_A,
      sessionRevision: 1,
      packageRevision: 1,
      ok: true,
      result: { accepted: true, runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    } as never);
    render(<Transcript />);

    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "agent.prompt",
        expect.any(Object),
        { text: "Hello", fromEntryId: "u1" },
        null,
      ),
    );
  });

  it("re-attaches a text file when regenerating", async () => {
    useAppStore.getState().applySessionSnapshot(attachedFileSession());
    const request = vi.spyOn(hostClient, "request").mockResolvedValue({
      protocolVersion: 1,
      id: "req",
      method: "agent.prompt",
      hostInstanceId: HOST_ID,
      workspaceId: WORKSPACE_ID,
      workspaceRevision: 1,
      sessionId: SESSION_A,
      sessionRevision: 1,
      packageRevision: 1,
      ok: true,
      result: { accepted: true, runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    } as never);
    render(<Transcript />);

    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "agent.prompt",
        expect.any(Object),
        {
          text: ["Review this", buildAttachedFileBlock("notes.txt", "hello from disk")].join(
            "\n\n",
          ),
          fromEntryId: "u1",
        },
        null,
      ),
    );
  });

  it("re-attaches a text file when editing and sending", async () => {
    useAppStore.getState().applySessionSnapshot(attachedFileSession());
    const request = vi.spyOn(hostClient, "request").mockResolvedValue({
      protocolVersion: 1,
      id: "req",
      method: "agent.prompt",
      hostInstanceId: HOST_ID,
      workspaceId: WORKSPACE_ID,
      workspaceRevision: 1,
      sessionId: SESSION_A,
      sessionRevision: 1,
      packageRevision: 1,
      ok: true,
      result: { accepted: true, runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    } as never);
    render(<Transcript />);

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit" }), {
      target: { value: "Please review again" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "agent.prompt",
        expect.any(Object),
        {
          text: [
            "Please review again",
            buildAttachedFileBlock("notes.txt", "hello from disk"),
          ].join("\n\n"),
          fromEntryId: "u1",
        },
        null,
      ),
    );
  });

  it("regenerates a document-only message with attachment ids", async () => {
    useAppStore.getState().applySessionSnapshot(documentOnlySession());
    const request = vi.spyOn(hostClient, "request").mockResolvedValue({
      protocolVersion: 1,
      id: "req",
      method: "agent.prompt",
      hostInstanceId: HOST_ID,
      workspaceId: WORKSPACE_ID,
      workspaceRevision: 1,
      sessionId: SESSION_A,
      sessionRevision: 1,
      packageRevision: 1,
      ok: true,
      result: { accepted: true, runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    } as never);
    render(<Transcript />);

    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "agent.prompt",
        expect.any(Object),
        {
          text: "",
          fromEntryId: "u1",
          attachmentIds: ["11111111-1111-4111-8111-111111111111"],
        },
        null,
      ),
    );
  });

  it("offers edit on the user-row context menu", async () => {
    const { container } = render(
      <>
        <Transcript />
        <MenuHost />
      </>,
    );
    const userRow = container.querySelectorAll(".transcript-row")[0]!;
    fireEvent.contextMenu(userRow, { clientX: 24, clientY: 32 });
    expect(await screen.findByRole("menuitem", { name: "Edit" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Copy message" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Regenerate" })).not.toBeInTheDocument();
  });
});
