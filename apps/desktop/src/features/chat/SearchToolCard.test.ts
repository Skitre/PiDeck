import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  extractSearchResults,
  isWebSearchTool,
  SearchToolCard,
  searchQuery,
} from "./SearchToolCard";
import { selectToolRenderer } from "./ToolView";

describe("search tool renderer", () => {
  it("matches web search tools without taking over file searches", () => {
    expect(isWebSearchTool("web_search")).toBe(true);
    expect(isWebSearchTool("Google Search")).toBe(true);
    expect(isWebSearchTool("find")).toBe(false);
    expect(isWebSearchTool("file_search")).toBe(false);
    expect(
      selectToolRenderer({ name: "brave_search", status: "done" })?.id,
    ).toBe("web-search");
  });

  it("extracts structured and nested search results", () => {
    const results = extractSearchResults({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            results: [
              {
                title: "Pi documentation",
                url: "https://example.com/pi",
                snippet: "Agent documentation",
              },
            ],
          }),
        },
      ],
    });
    expect(results).toEqual([
      {
        title: "Pi documentation",
        url: "https://example.com/pi",
        snippet: "Agent documentation",
        site: "example.com",
      },
    ]);
  });

  it("extracts markdown links and rejects unsafe URLs", () => {
    const results = extractSearchResults(
      "[One](https://one.example/a)\n[Bad](javascript:alert(1))",
    );
    expect(results.map((item) => item.url)).toEqual(["https://one.example/a"]);
  });

  it("reads common query argument shapes", () => {
    expect(searchQuery('{"query":"agent architecture"}')).toBe("agent architecture");
    expect(searchQuery({ queries: ["one", "two"] })).toBe("one, two");
  });

  it("keeps a details-only structured result expandable", () => {
    const markup = renderToStaticMarkup(
      createElement(SearchToolCard, {
        name: "web_search",
        status: "done",
        details: { results: [], requestId: "search-1" },
      }),
    );

    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("lucide-chevron-right");
  });
});
