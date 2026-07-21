import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidebarLayout } from "./Sidebar";
import type { NavPage } from "../lib/stores/app-store";

describe("Sidebar", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each<NavPage>(["chat", "packages", "settings"])(
    "keeps the conversation workspace mounted on the %s page",
    (page) => {
      const html = renderToStaticMarkup(
        createElement(SidebarLayout, { page, setPage: vi.fn() }),
      );

      expect(html).toContain("New conversation");
      expect(html).toContain("Workspaces");
      expect(html).toContain("Recent conversations");
      expect(html).toContain("Settings");
      expect(html).not.toContain(">Chat<");
      expect(html).not.toContain(">Packages<");
    },
  );

  it("keeps only the hover edge control mounted when the sidebar is collapsed", () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key === "pideck.sidebar.collapsed" ? "1" : null),
      setItem: vi.fn(),
    });

    const html = renderToStaticMarkup(
      createElement(SidebarLayout, { page: "chat", setPage: vi.fn() }),
    );

    expect(html).toContain('aria-label="Expand left sidebar"');
    expect(html).toContain("margin-left:-268px");
    expect(html).not.toContain("New conversation");
    expect(html).not.toContain("Recent conversations");
  });
});
