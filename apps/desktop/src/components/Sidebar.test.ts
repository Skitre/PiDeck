import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SidebarLayout,
  SIDEBAR_WORKSPACE_PANE_HEIGHT_KEY,
  SIDEBAR_WORKSPACE_PANE_MIN,
  clampWorkspacePaneHeight,
  readWorkspacePaneHeight,
} from "./Sidebar";
import type { NavPage } from "../lib/stores/app-store";

describe("clampWorkspacePaneHeight", () => {
  it("keeps a floor so the workspace title stays visible", () => {
    expect(clampWorkspacePaneHeight(20, 400)).toBe(SIDEBAR_WORKSPACE_PANE_MIN);
    expect(clampWorkspacePaneHeight(Number.NaN, 400)).toBe(SIDEBAR_WORKSPACE_PANE_MIN);
  });

  it("leaves room for recent conversations when the split is tall", () => {
    expect(clampWorkspacePaneHeight(360, 400)).toBe(296);
    expect(clampWorkspacePaneHeight(180, 400)).toBe(180);
  });
});

describe("readWorkspacePaneHeight", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("treats a missing value as auto-sized", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: vi.fn(),
    });
    expect(readWorkspacePaneHeight()).toBeNull();
  });

  it("reads a stored pixel height", () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key === SIDEBAR_WORKSPACE_PANE_HEIGHT_KEY ? "180" : null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    expect(readWorkspacePaneHeight()).toBe(180);
  });
});

describe("Sidebar", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each<NavPage>(["chat", "packages", "settings"])(
    "keeps the conversation workspace mounted on the %s page",
    (page) => {
      vi.stubGlobal("localStorage", {
        getItem: () => null,
        setItem: vi.fn(),
        removeItem: vi.fn(),
      });

      const html = renderToStaticMarkup(
        createElement(SidebarLayout, { page, setPage: vi.fn() }),
      );

      expect(html).toContain("New conversation");
      expect(html).toContain("Workspaces");
      expect(html).toContain("Recent conversations");
      expect(html).toContain("Settings");
      expect(html).toContain("data-sidebar-workspaces");
      expect(html).toContain("data-sidebar-split");
      expect(html).toContain("Resize workspaces and conversations");
      expect(html).toContain("max-h-[min(40%,15rem)]");
      expect(html).not.toContain(">Chat<");
      expect(html).not.toContain(">Packages<");
    },
  );

  it("applies a stored workspace pane height instead of the auto cap", () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key === SIDEBAR_WORKSPACE_PANE_HEIGHT_KEY ? "180" : null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });

    const html = renderToStaticMarkup(
      createElement(SidebarLayout, { page: "chat", setPage: vi.fn() }),
    );

    expect(html).toContain("height:180px");
    expect(html).not.toContain("max-h-[min(40%,15rem)]");
  });

  it("keeps only the hover edge control mounted when the sidebar is collapsed", () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key === "pideck.sidebar.collapsed" ? "1" : null),
      setItem: vi.fn(),
    });

    const html = renderToStaticMarkup(
      createElement(SidebarLayout, { page: "chat", setPage: vi.fn() }),
    );

    expect(html).toContain('aria-label="Expand sidebar"');
    expect(html).toContain("margin-left:-268px");
    expect(html).not.toContain("New conversation");
    expect(html).not.toContain("Recent conversations");
  });
});
