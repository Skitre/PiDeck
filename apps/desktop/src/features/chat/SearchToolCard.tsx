import { useEffect, useMemo, useState } from "react";
import { ChevronRight, ExternalLink, Search } from "lucide-react";
import { isSafeExternalUrl } from "./markdown-utils";
import {
  formatDuration,
  statusLabel,
  ToolCard,
  type ToolCardProps,
} from "./ToolCard";

export type SearchResultItem = {
  title: string;
  url: string;
  snippet?: string;
  site: string;
};

const SEARCH_NAMES = new Set([
  "search",
  "web_search",
  "search_web",
  "google_search",
  "brave_search",
  "tavily_search",
  "exa_search",
]);

const NON_WEB_SEARCH_NAMES = new Set(["file_search", "find", "grep", "glob"]);

function parseJsonish(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  const parsed = parseJsonish(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

function trimmedString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function siteForUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function textResults(value: string): Array<{ title: string; url: string }> {
  const results: Array<{ title: string; url: string }> = [];
  const markdownLinks = value.matchAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g);
  for (const match of markdownLinks) {
    results.push({ title: match[1]?.trim() || match[2]!, url: match[2]! });
  }

  const lines = value.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const match of line.matchAll(/https?:\/\/[^\s<>)\]]+/g)) {
      const url = match[0].replace(/[.,;:!?]+$/, "");
      const previous = lines[index - 1]?.trim() ?? "";
      const title =
        previous && !previous.includes("http") && previous.length <= 160
          ? previous.replace(/^[-*#\d.\s]+/, "")
          : siteForUrl(url) || url;
      results.push({ title, url });
    }
  });
  return results;
}

export function extractSearchResults(value: unknown): SearchResultItem[] {
  const results: SearchResultItem[] = [];
  const seenUrls = new Set<string>();

  function add(title: string, url: string, snippet?: string) {
    const normalizedUrl = url.trim();
    if (!isSafeExternalUrl(normalizedUrl) || seenUrls.has(normalizedUrl)) return;
    seenUrls.add(normalizedUrl);
    results.push({
      title: title.trim() || siteForUrl(normalizedUrl) || normalizedUrl,
      url: normalizedUrl,
      ...(snippet?.trim() ? { snippet: snippet.trim().slice(0, 280) } : {}),
      site: siteForUrl(normalizedUrl),
    });
  }

  function visit(candidate: unknown, depth: number) {
    if (depth > 5 || results.length >= 12 || candidate == null) return;
    const parsed = parseJsonish(candidate);
    if (typeof parsed === "string") {
      for (const item of textResults(parsed)) add(item.title, item.url);
      return;
    }
    if (Array.isArray(parsed)) {
      for (const item of parsed) visit(item, depth + 1);
      return;
    }
    if (typeof parsed !== "object") return;

    const record = parsed as Record<string, unknown>;
    const url = trimmedString(record, ["url", "link", "href", "sourceUrl"]);
    if (url) {
      add(
        trimmedString(record, ["title", "name", "label"]),
        url,
        trimmedString(record, ["snippet", "description", "summary"]),
      );
    }
    for (const nested of Object.values(record)) visit(nested, depth + 1);
  }

  visit(value, 0);
  return results;
}

export function searchQuery(args: unknown): string {
  const record = asRecord(args);
  if (!record) return typeof args === "string" ? args.split("\n")[0]?.slice(0, 120) ?? "" : "";
  const query = trimmedString(record, ["query", "q", "search", "term"]);
  if (query) return query;
  const queries = record.queries;
  if (Array.isArray(queries)) {
    return queries.filter((item): item is string => typeof item === "string").join(", ");
  }
  return "";
}

export function isWebSearchTool(name: string): boolean {
  const normalized = name.trim().toLocaleLowerCase().replace(/[\s-]+/g, "_");
  if (NON_WEB_SEARCH_NAMES.has(normalized)) return false;
  return (
    SEARCH_NAMES.has(normalized) ||
    normalized.includes("web_search") ||
    normalized.includes("search_web")
  );
}

async function openSearchResult(url: string) {
  if (!window.confirm(`Open external link?\n\n${url}`)) return;
  await import("@tauri-apps/plugin-shell")
    .then(({ open }) => open(url))
    .catch(() => window.open(url, "_blank", "noopener,noreferrer"));
}

export function SearchToolCard(props: ToolCardProps) {
  const results = useMemo(() => extractSearchResults(props.result), [props.result]);
  const [open, setOpen] = useState(false);
  const query = searchQuery(props.args);

  useEffect(() => {
    if (props.status === "error") setOpen(true);
  }, [props.status]);

  if ((props.result !== undefined && results.length === 0) || props.status === "error") {
    return <ToolCard {...props} />;
  }

  const canExpand = results.length > 0;
  const statusClass =
    props.status === "running"
      ? "text-warning"
      : props.status === "done"
        ? "text-success"
        : "text-muted";

  return (
    <div className="min-w-0 max-w-full">
      <button
        type="button"
        className={`flex min-h-8 w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors ${
          canExpand ? "hover:bg-surface-overlay/60" : "cursor-default"
        }`}
        onClick={() => {
          if (canExpand) setOpen((current) => !current);
        }}
        aria-expanded={canExpand ? open : undefined}
      >
        <Search size={14} className="shrink-0 text-muted" />
        <span className="shrink-0 text-xs font-medium text-foreground/80">Search</span>
        <span className="min-w-0 flex-1 truncate text-xs text-foreground/75" title={query}>
          {query || props.name}
        </span>
        <span className="shrink-0 text-[10px] text-muted">
          {formatDuration(props.startedAt, props.endedAt)}
        </span>
        <span className={`shrink-0 text-[10px] ${statusClass}`}>
          {statusLabel(props.status)}
        </span>
        {canExpand && (
          <ChevronRight
            size={13}
            className={`shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`}
          />
        )}
      </button>
      {open && canExpand && (
        <div className="mb-2 ml-[22px] mt-1 space-y-1 border-l border-border pl-3">
          {results.map((result) => (
            <a
              key={result.url}
              href={result.url}
              className="group/result block min-w-0 rounded-md px-2 py-1.5 transition-colors hover:bg-surface-overlay/55"
              title={result.url}
              onClick={(event) => {
                event.preventDefault();
                void openSearchResult(result.url);
              }}
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground/85 underline decoration-border underline-offset-2 group-hover/result:decoration-foreground/50">
                  {result.title}
                </span>
                <span className="shrink-0 text-[10px] text-muted">{result.site}</span>
                <ExternalLink size={11} className="shrink-0 text-muted" />
              </div>
              {result.snippet && (
                <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-muted">
                  {result.snippet}
                </p>
              )}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
