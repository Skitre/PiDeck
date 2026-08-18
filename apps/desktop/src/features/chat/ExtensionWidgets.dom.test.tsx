/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../lib/stores/app-store";
import { ExtensionWidgetsPopover } from "./ExtensionWidgets";

class TestResizeObserver {
  static instance: TestResizeObserver | null = null;

  readonly observed = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {
    TestResizeObserver.instance = this;
  }

  observe(target: Element) {
    this.observed.add(target);
  }

  disconnect() {
    this.observed.clear();
  }

  trigger(target: Element) {
    if (!this.observed.has(target)) return;
    this.callback([], this as unknown as ResizeObserver);
  }
}

describe("extension widget popover layout tracking", () => {
  beforeEach(() => {
    TestResizeObserver.instance = null;
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    useAppStore.setState({
      desktopSettings: {
        theme: "system",
        language: "en",
        restoreLastSession: true,
        autoRestartHostOnce: true,
        extensionDecisionPresentation: "auto",
        terminalProfile: "auto",
      },
      extensionWidgets: {
        status: {
          key: "status",
          widget: ["ready"],
          hostInstanceId: "host",
          workspaceId: null,
          workspaceRevision: 1,
          sessionId: null,
          sessionRevision: 1,
        },
      },
      collapsedExtensionWidgetKeys: {},
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("follows the composer when its container changes size but the anchor does not", () => {
    let anchorLeft = 100;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.dataset.testid !== "composer-anchor") {
        return new DOMRect();
      }
      return {
        top: 500,
        bottom: 600,
        left: anchorLeft,
        right: anchorLeft + 600,
        width: 600,
        height: 100,
        x: anchorLeft,
        y: 500,
        toJSON: () => ({}),
      } as DOMRect;
    });

    function Harness({ open }: { open: boolean }) {
      const anchorRef = useRef<HTMLDivElement>(null);
      return (
        <div data-testid="composer-container">
          <div ref={anchorRef} data-testid="composer-anchor">
            <ExtensionWidgetsPopover anchorRef={anchorRef} open={open} onClose={() => undefined} />
          </div>
        </div>
      );
    }

    const { rerender } = render(<Harness open={false} />);
    rerender(<Harness open />);

    const panel = screen.getByLabelText("Extension widgets above editor");
    const container = screen.getByTestId("composer-container");
    expect(panel).toHaveStyle({ left: "100px" });
    expect(TestResizeObserver.instance?.observed.has(container)).toBe(true);

    anchorLeft = 180;
    act(() => TestResizeObserver.instance?.trigger(container));

    expect(panel).toHaveStyle({ left: "180px" });
  });

  it("clears the portaled drawer when a usable anchor collapses to zero width", () => {
    let anchorWidth = 600;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.dataset.testid !== "composer-anchor") {
        return new DOMRect();
      }
      return {
        top: 500,
        bottom: 600,
        left: 100,
        right: 100 + anchorWidth,
        width: anchorWidth,
        height: 100,
        x: 100,
        y: 500,
        toJSON: () => ({}),
      } as DOMRect;
    });

    function Harness({ open }: { open: boolean }) {
      const anchorRef = useRef<HTMLDivElement>(null);
      return (
        <div data-testid="composer-container">
          <div ref={anchorRef} data-testid="composer-anchor">
            <ExtensionWidgetsPopover anchorRef={anchorRef} open={open} onClose={() => undefined} />
          </div>
        </div>
      );
    }

    const { rerender } = render(<Harness open={false} />);
    rerender(<Harness open />);

    expect(screen.getByLabelText("Extension widgets above editor")).toBeInTheDocument();

    anchorWidth = 0;
    act(() => TestResizeObserver.instance?.trigger(screen.getByTestId("composer-anchor")));

    expect(screen.queryByLabelText("Extension widgets above editor")).not.toBeInTheDocument();
  });
});
