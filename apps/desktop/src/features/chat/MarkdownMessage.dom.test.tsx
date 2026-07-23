/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantOrderedContent } from "./Transcript";
import type { TranscriptBlock } from "./transcript-model";
import { MarkdownMessage } from "./MarkdownMessage";

const { mermaidRender } = vi.hoisted(() => ({ mermaidRender: vi.fn() }));

vi.mock("@streamdown/mermaid", () => ({
  createMermaidPlugin: () => ({
    name: "mermaid",
    type: "diagram",
    language: "mermaid",
    getMermaid: () => ({
      initialize: vi.fn(),
      render: mermaidRender,
    }),
  }),
}));

beforeAll(() => {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      private readonly callback: (entries: unknown[]) => void;

      constructor(callback: (entries: unknown[]) => void) {
        this.callback = callback;
      }

      observe(target: Element) {
        this.callback([{ isIntersecting: true, intersectionRatio: 1, target }]);
      }

      disconnect() {}

      unobserve() {}

      takeRecords() {
        return [];
      }
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}

      disconnect() {}

      unobserve() {}
    },
  );
});

beforeEach(() => {
  mermaidRender.mockReset();
  mermaidRender.mockResolvedValue({
    svg: '<svg viewBox="0 0 100 40"><text>diagram</text></svg>',
  });
});

afterEach(() => {
  cleanup();
});

describe("MarkdownMessage math rendering", () => {
  it("renders dollar, display-dollar, escaped-inline, and escaped-display math", async () => {
    const content = String.raw`Inline $a+b$.

$$
a^2+b^2=c^2
$$

Inline \(x+y\).

\[
(a+b)^n = \sum_{k=0}^{n} \binom{n}{k}a^{n-k}b^k
\]`;

    const { container } = render(<MarkdownMessage content={content} mode="static" />);

    await waitFor(() => expect(container.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(4));
    expect(container.querySelector(".katex-display")).toBeInTheDocument();
    expect(container.textContent).toContain("(a+b)");
  });

  it("uses the same Markdown renderer for an open Thought process block", async () => {
    const block: TranscriptBlock = {
      kind: "thinking",
      text: String.raw`\[
(a+b)^n = \sum_{k=0}^{n} \binom{n}{k}a^{n-k}b^k
\]`,
    };

    const { container } = render(
      <AssistantOrderedContent
        blocks={[block]}
        mode="streaming"
        showCaret={false}
        turnActive
      />,
    );

    await waitFor(() => expect(container.querySelector(".thinking-markdown .katex")).toBeInTheDocument());
  });
});

describe("MarkdownMessage Mermaid rendering", () => {
  const closed = "```mermaid\nflowchart TD\n  A --> B\n```";
  const open = "```mermaid\nflowchart TD\n  A --> B";

  it("renders only after a Mermaid fence is closed", async () => {
    const view = render(<MarkdownMessage content={open} mode="streaming" />);

    await waitFor(() => expect(view.container.textContent).toContain("flowchart TD"));
    expect(view.container.querySelector('[data-streamdown="mermaid"]')).not.toBeInTheDocument();

    view.rerender(<MarkdownMessage content={closed} mode="streaming" />);
    await waitFor(() => expect(view.container.querySelector('[data-streamdown="mermaid"]')).toBeInTheDocument());
    expect(mermaidRender).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("flowchart TD"));
  });

  it("shows a recoverable error for invalid Mermaid and retries", async () => {
    mermaidRender.mockRejectedValueOnce(new Error("invalid syntax"));
    const user = userEvent.setup();
    render(<MarkdownMessage content={closed} mode="static" />);

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("invalid syntax"));
    mermaidRender.mockResolvedValue({
      svg: '<svg viewBox="0 0 100 40"><text>diagram</text></svg>',
    });
    await user.click(screen.getByRole("button", { name: "Retry diagram" }));
    await waitFor(() => expect(document.querySelector('[data-streamdown="mermaid"]')).toBeInTheDocument());
  });

  it("shows an error when a rendered chart later becomes invalid", async () => {
    const view = render(<MarkdownMessage content={closed} mode="streaming" />);
    await waitFor(() => expect(view.container.querySelector('[data-streamdown="mermaid"]')).toBeInTheDocument());

    mermaidRender.mockRejectedValueOnce(new Error("updated syntax error"));
    view.rerender(
      <MarkdownMessage content={"```mermaid\nthis is not valid\n```"} mode="streaming" />,
    );

    await waitFor(() => expect(view.container.querySelector('[role="alert"]')).toHaveTextContent("updated syntax error"));
  });

  it("exposes Mermaid controls without a download action", async () => {
    const { container } = render(<MarkdownMessage content={closed} mode="static" />);

    await waitFor(() => expect(container.querySelector('[data-streamdown="mermaid"]')).toBeInTheDocument());
    expect(container.querySelector('[data-streamdown="mermaid-block-actions"]')).toBeInTheDocument();
    expect(screen.getByTitle("Copy Code")).toBeInTheDocument();
    expect(screen.getByTitle("View fullscreen")).toBeInTheDocument();
    expect(screen.getByTitle("Zoom in")).toBeInTheDocument();
    expect(screen.getByTitle("Zoom out")).toBeInTheDocument();
    expect(screen.getByTitle("Reset zoom and pan")).toBeInTheDocument();
    expect(container.querySelector('[title*="Download"]')).not.toBeInTheDocument();
  });

  it("does not expose Mermaid resource or unsafe link URLs", async () => {
    mermaidRender.mockResolvedValueOnce({
      svg: [
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" onload="window.__mermaidRan = true" href="file:///root">',
        '<script>window.__mermaidRan = true</script>',
        '<style>.node { fill: url(#gradient); }</style>',
        '<style>@import url("https://evil.example/style.css")</style>',
        '<defs><path id="shape" d="M0 0h1v1z" /><linearGradient id="gradient" /></defs>',
        '<use href="#shape" xlink:href="https://evil.example/shape.svg#shape" />',
        '<g data-pideck-mermaid-href="https://evil.example/forged"><text>forged</text></g>',
        '<rect fill="url(https://evil.example/fill.svg#paint)" />',
        '<animate attributeName="href" to="https://evil.example/animated" />',
        '<set attributeName="onclick" to="window.__mermaidRan = true" />',
        '<discard begin="0s" />',
        '<image href="file:///secret.png" />',
        '<a href="file:///secret"><text>blocked</text></a>',
        '<a xlink:href="https://example.com/path"><text>allowed</text></a>',
        "</svg>",
      ].join(""),
    });
    const { container } = render(<MarkdownMessage content={closed} mode="static" />);

    await waitFor(() => expect(container.querySelector('[aria-label="Mermaid chart"] svg')).toBeInTheDocument());
    expect(container.querySelector("script")).not.toBeInTheDocument();
    expect(container.querySelector("style")).toHaveTextContent("url(#gradient)");
    expect(container.querySelectorAll("style")).toHaveLength(1);
    expect(container.querySelector('use[href="#shape"]')).toBeInTheDocument();
    expect(container.querySelector("use")).not.toHaveAttribute("xlink:href");
    expect(container.querySelector('[data-pideck-mermaid-href="https://evil.example/forged"]')).not.toBeInTheDocument();
    expect(container.querySelector("rect")).not.toHaveAttribute("fill");
    expect(container.querySelector("animate, set, discard")).not.toBeInTheDocument();
    expect(container.querySelector("image")).not.toBeInTheDocument();
    expect(container.querySelector('a[href], a[xlink\\:href]')).not.toBeInTheDocument();
    expect(container.querySelector('[data-pideck-mermaid-href="https://example.com/path"]')).toBeInTheDocument();
    expect(container.querySelector('[aria-label="Mermaid chart"] svg')).not.toHaveAttribute("onload");
    expect(container.querySelector('[aria-label="Mermaid chart"] svg')).not.toHaveAttribute("href");
    expect((window as Window & { __mermaidRan?: boolean }).__mermaidRan).not.toBe(true);

    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(container.querySelector("[data-pideck-mermaid-href]")!);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("https://example.com/path"));
    confirm.mockRestore();
  });
});

describe("MarkdownMessage safety and footnotes", () => {
  it("keeps footnote targets unique and connected across messages", async () => {
    const content = "Reference[^one].\n\n[^one]: Footnote text";
    const { container } = render(
      <>
        <MarkdownMessage content={content} mode="static" />
        <MarkdownMessage content={content} mode="static" />
      </>,
    );

    await waitFor(() => expect(container.querySelectorAll("[data-footnote-ref]")).toHaveLength(2));
    const references = Array.from(container.querySelectorAll<HTMLElement>("[data-footnote-ref]"));
    const targetIds = references.map((reference) => reference.getAttribute("href")?.slice(1));
    expect(new Set(targetIds).size).toBe(2);
    for (const targetId of targetIds) {
      expect(targetId).toBeTruthy();
      expect(document.getElementById(targetId!)).toBeInTheDocument();
    }

    const labels = Array.from(container.querySelectorAll<HTMLElement>('[id$="footnote-label"]'));
    expect(labels).toHaveLength(2);
    expect(new Set(labels.map((label) => label.id)).size).toBe(2);
    expect(container.querySelector('[id="footnote-label"]')).not.toBeInTheDocument();
    for (const reference of references) {
      const describedBy = reference.getAttribute("aria-describedby");
      expect(describedBy).toBeTruthy();
      expect(document.getElementById(describedBy!)).toBeInTheDocument();
      expect(reference).not.toHaveAttribute("target");
      expect(reference).not.toHaveAttribute("rel");
    }

    const backrefs = Array.from(container.querySelectorAll<HTMLElement>("[data-footnote-backref]"));
    expect(backrefs).toHaveLength(2);
    for (const backref of backrefs) {
      const target = backref.getAttribute("href")?.slice(1);
      expect(target).toBeTruthy();
      expect(container.querySelector(`[data-footnote-ref][id=\"${target}\"]`)).toBeInTheDocument();
    }
  });

  it("does not let a normal Markdown link spoof a generated footnote target", async () => {
    const view = render(
      <MarkdownMessage content={"Reference[^one].\n\n[^one]: Footnote text"} mode="static" />,
    );

    const reference = await waitFor(() => {
      const element = view.container.querySelector<HTMLElement>("[data-footnote-ref]");
      expect(element).toBeInTheDocument();
      return element!;
    });
    const href = reference.getAttribute("href");
    expect(href).toMatch(/^#pideck-md-.*-fn-/);

    view.rerender(<MarkdownMessage content={`[spoof](${href})`} mode="static" />);
    await waitFor(() => expect(view.container).toHaveTextContent("spoof"));
    expect(view.container.querySelector(`a[href=\"${href}\"]`)).not.toBeInTheDocument();
  });

  it("renders raw HTML as text and does not execute scripts", async () => {
    const { container } = render(
      <MarkdownMessage content={'<b>bold</b><script>window.__ran = true</script>'} mode="static" />,
    );

    await waitFor(() => expect(container.textContent).toContain("<b>bold</b>"));
    expect(container.querySelector("b")).not.toBeInTheDocument();
    expect(container.querySelector("script")).not.toBeInTheDocument();
    expect((window as Window & { __ran?: boolean }).__ran).not.toBe(true);
  });

  it("keeps external links and image fallbacks within the existing policy", async () => {
    const content = [
      "[external](https://example.com)",
      "[script](javascript:alert(1))",
      "[fragment](#section)",
      "![diagram](https://example.com/diagram.png \"Diagram title\")",
    ].join(" ");
    const { container } = render(<MarkdownMessage content={content} mode="static" />);

    await waitFor(() => expect(screen.getByRole("link", { name: "external" })).toBeInTheDocument());
    const external = screen.getByRole("link", { name: "external" });
    expect(external).toHaveAttribute("href", "https://example.com/");
    expect(external).toHaveAttribute("target", "_blank");
    expect(container.querySelectorAll("a")).toHaveLength(1);
    expect(container.querySelector("img")).not.toBeInTheDocument();
    expect(container).toHaveTextContent("Image: diagram");
  });
});
