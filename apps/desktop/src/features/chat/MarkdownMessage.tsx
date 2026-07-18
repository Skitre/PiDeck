import { code } from "@streamdown/code";
import { cjk } from "@streamdown/cjk";
import {
  type ComponentProps,
  cloneElement,
  isValidElement,
  memo,
  type ReactElement,
  type ReactNode,
  useState,
} from "react";
import remarkBreaks from "remark-breaks";
import {
  type Components,
  defaultRemarkPlugins,
  type ExtraProps,
  Streamdown,
} from "streamdown";
import { Check, ChevronDown, ChevronUp, Copy, ExternalLink } from "lucide-react";
import {
  codeLineCount,
  isSafeExternalUrl,
  sanitizeAgentText,
} from "./markdown-utils";

type MarkdownMessageProps = {
  content: string;
  mode?: "streaming" | "static";
  showCaret?: boolean;
  className?: string;
};

type CodeChildProps = {
  children?: ReactNode;
  className?: string;
  "data-block"?: string;
};

type MarkdownPreProps = ComponentProps<"pre"> & ExtraProps;
type MarkdownImageProps = ComponentProps<"img"> & ExtraProps;
type MarkdownLinkProps = ComponentProps<"a"> & ExtraProps;

const CODE_COLLAPSE_THRESHOLD = 16;
const markdownPlugins = { code, cjk };
const remarkPlugins = [...Object.values(defaultRemarkPlugins), remarkBreaks];

function imageFallback({ alt, title }: MarkdownImageProps) {
  const label = alt?.trim() || title?.trim();
  return label ? (
    <span className="inline-flex rounded-md bg-surface-overlay px-2 py-1 text-xs italic text-muted">
      Image: {label}
    </span>
  ) : null;
}

function safeLink({ children, href, title }: MarkdownLinkProps) {
  const safeHref = typeof href === "string" && isSafeExternalUrl(href) ? href : null;
  if (!safeHref) {
    return <span className="text-foreground underline decoration-border">{children}</span>;
  }
  return (
    <a
      href={safeHref}
      title={title ?? safeHref}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(event) => {
        event.preventDefault();
        if (!window.confirm(`Open external link?\n\n${safeHref}`)) return;
        void import("@tauri-apps/plugin-shell")
          .then(({ open }) => open(safeHref))
          .catch(() => window.open(safeHref, "_blank", "noopener,noreferrer"));
      }}
    >
      {children}
      <ExternalLink className="ml-1 inline size-3" aria-hidden="true" />
    </a>
  );
}

function codeText(child: ReactElement<CodeChildProps>): string {
  const raw = child.props.children;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw.filter((item): item is string => typeof item === "string").join("");
  }
  return "";
}

function CollapsibleCodeBlock({ children }: MarkdownPreProps) {
  const child = isValidElement<CodeChildProps>(children) ? children : null;
  const content = child ? codeText(child) : "";
  const lineCount = codeLineCount(content);
  const collapsible = lineCount > CODE_COLLAPSE_THRESHOLD;
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!child) return children;
  const codeBlock = cloneElement(child, { "data-block": "true" });

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard access can be unavailable in browser previews.
    }
  }

  return (
    <div className="markdown-code-shell relative w-full">
      <button
        type="button"
        onClick={() => void copyCode()}
        className="absolute right-2 top-2 z-10 flex size-7 items-center justify-center rounded-md bg-surface/90 text-muted transition-colors hover:bg-surface-overlay hover:text-foreground"
        title={copied ? "Copied" : "Copy code"}
        aria-label={copied ? "Copied" : "Copy code"}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
      <div className={collapsible && !expanded ? "max-h-80 overflow-hidden" : ""}>
        {codeBlock}
      </div>
      {collapsible && (
        <button
          type="button"
          className="mx-auto mt-1 flex h-7 items-center gap-1 rounded-md px-2 text-[11px] text-muted hover:bg-surface-overlay hover:text-foreground"
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          {expanded ? "Collapse code" : `Expand ${lineCount} lines`}
        </button>
      )}
    </div>
  );
}

const markdownComponents: Components = {
  img: imageFallback,
  a: safeLink,
  pre: CollapsibleCodeBlock,
};

export const MarkdownMessage = memo(function MarkdownMessage({
  content,
  mode = "static",
  showCaret = false,
  className = "",
}: MarkdownMessageProps) {
  const normalized = sanitizeAgentText(content);

  return (
    <Streamdown
      className={`chat-markdown ${showCaret ? "chat-markdown-caret" : ""} ${className}`}
      plugins={markdownPlugins}
      remarkPlugins={remarkPlugins}
      components={markdownComponents}
      mode={mode}
      dir="auto"
      parseIncompleteMarkdown
      normalizeHtmlIndentation
      skipHtml
      animated={
        mode === "streaming"
          ? { animation: "fadeIn", duration: 110, easing: "ease-out", sep: "word", stagger: 3 }
          : false
      }
      isAnimating={showCaret}
      caret={mode === "streaming" ? "block" : undefined}
      shikiTheme={["github-light", "github-dark"]}
      controls={false}
      lineNumbers={false}
      urlTransform={(url, key) => {
        if (key === "src") return null;
        return isSafeExternalUrl(url) ? url : null;
      }}
    >
      {normalized}
    </Streamdown>
  );
});
