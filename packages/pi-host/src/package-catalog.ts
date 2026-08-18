import {
  createHostError,
  type HostError,
  type PackageCatalog,
  type PackageCatalogItem,
} from "@pideck/protocol";

/**
 * pi.dev has no public JSON API yet ("API routes are reserved for future
 * features"), but the catalog page embeds machine-readable data- attributes
 * and paginates at 50 cards (`?page=N`, `name`, `type`, `sort`). This module
 * fetches one page per call, parses that semi-stable contract tolerantly, and
 * treats an unfiltered first page without cards as CATALOG_UNAVAILABLE.
 */
const CATALOG_URL = "https://pi.dev/packages";
const CATALOG_TTL_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_PAGE_CARDS = 200;
const DEFAULT_PAGE_SIZE = 50;

export type CatalogSort = "downloads" | "recent";

export type CatalogQuery = {
  page: number;
  query: string;
  type: string;
  sort: CatalogSort;
};

type CatalogFetcher = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

const cache = new Map<string, { atMs: number; catalog: PackageCatalog }>();

/** Test hook. */
export function resetPackageCatalogCache(): void {
  cache.clear();
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

function tagAttribute(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`${name}="([^"]*)"`));
  return match?.[1] !== undefined ? decodeHtmlEntities(match[1]) : undefined;
}

function finiteNonNegative(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function parsePackageCatalogHtml(html: string): PackageCatalogItem[] {
  const items: PackageCatalogItem[] = [];
  const cardTags = [...html.matchAll(/<article[^>]*data-package-card="true"[^>]*>/g)];
  for (let index = 0; index < cardTags.length && items.length < MAX_PAGE_CARDS; index += 1) {
    const card = cardTags[index]!;
    const tag = card[0];
    const bodyStart = (card.index ?? 0) + tag.length;
    const bodyEnd =
      index + 1 < cardTags.length ? (cardTags[index + 1]!.index ?? html.length) : html.length;
    const body = html.slice(bodyStart, bodyEnd);

    const name = tagAttribute(tag, "data-package-name");
    if (!name) continue;

    const descriptionMatch = body.match(/<p class="packages-desc">([\s\S]*?)<\/p>/);
    const authorMatch = body.match(/<div class="packages-meta"><span>([\s\S]*?)<\/span>/);
    const npmMatch = body.match(/href="(https:\/\/www\.npmjs\.com\/package\/[^"]+)"/);
    const githubMatch = body.match(/href="(https:\/\/github\.com\/[^"]+)"/);
    const pageMatch = body.match(/class="packages-name"><a href="([^"]+)"/);

    const author = authorMatch ? decodeHtmlEntities(stripTags(authorMatch[1] ?? "")).trim() : "";
    const downloadsPerMonth = finiteNonNegative(tagAttribute(tag, "data-package-downloads"));
    const publishedAt = finiteNonNegative(tagAttribute(tag, "data-package-date"));
    let pageUrl = `${CATALOG_URL}/${name}`;
    if (pageMatch?.[1]) {
      try {
        pageUrl = new URL(decodeHtmlEntities(pageMatch[1]), "https://pi.dev").toString();
      } catch {
        /* keep constructed fallback */
      }
    }

    items.push({
      name,
      description: descriptionMatch
        ? decodeHtmlEntities(stripTags(descriptionMatch[1] ?? "")).trim()
        : "",
      ...(author ? { author } : {}),
      types: (tagAttribute(tag, "data-package-types") ?? "").split(/\s+/).filter(Boolean),
      ...(downloadsPerMonth !== undefined ? { downloadsPerMonth } : {}),
      ...(publishedAt !== undefined && publishedAt > 0 ? { publishedAt } : {}),
      ...(npmMatch ? { npmUrl: decodeHtmlEntities(npmMatch[1] ?? "") } : {}),
      ...(githubMatch ? { githubUrl: decodeHtmlEntities(githubMatch[1] ?? "") } : {}),
      searchText: tagAttribute(tag, "data-package-search") ?? "",
      installSource: `npm:${name}`,
      pageUrl,
    });
  }
  return items;
}

export function parseCatalogIndexMeta(html: string): {
  rangeStart?: number;
  rangeEnd?: number;
  total?: number;
  lastPage: number;
} {
  let lastPage = 1;
  for (const match of html.matchAll(/[?&]page=(\d+)/g)) {
    const page = Number(match[1]);
    if (Number.isSafeInteger(page) && page > lastPage) lastPage = page;
  }
  const count = html.match(/class="packages-count">\s*(\d+)\s*-\s*(\d+)\s*\/\s*(\d+)/);
  if (!count) return { lastPage };
  const rangeStart = Number(count[1]);
  const rangeEnd = Number(count[2]);
  const total = Number(count[3]);
  const pageSize = rangeEnd - rangeStart + 1;
  if (Number.isSafeInteger(pageSize) && pageSize > 0 && Number.isSafeInteger(total) && total >= 0) {
    lastPage = Math.max(lastPage, Math.ceil(total / pageSize) || 1);
  }
  return { rangeStart, rangeEnd, total, lastPage };
}

export function catalogPageUrl(query: CatalogQuery): string {
  const params = new URLSearchParams();
  if (query.page > 1) params.set("page", String(query.page));
  if (query.query) params.set("name", query.query);
  if (query.type) params.set("type", query.type);
  if (query.sort !== "downloads") params.set("sort", query.sort);
  const search = params.toString();
  return search ? `${CATALOG_URL}?${search}` : CATALOG_URL;
}

function cacheKey(query: CatalogQuery): string {
  return `${query.page}\t${query.query}\t${query.type}\t${query.sort}`;
}

function normalizeQuery(args: {
  page?: number;
  query?: string;
  type?: string;
  sort?: CatalogSort;
}): CatalogQuery {
  return {
    page: args.page ?? 1,
    query: (args.query ?? "").trim(),
    type: (args.type ?? "").trim(),
    sort: args.sort === "recent" ? "recent" : "downloads",
  };
}

function createTimeoutSignal(ms: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timer),
  };
}

function buildCatalog(
  items: PackageCatalogItem[],
  query: CatalogQuery,
  meta: ReturnType<typeof parseCatalogIndexMeta>,
  generatedAt: number,
  fromCache: boolean,
): PackageCatalog {
  const inferredPageSize =
    meta.rangeEnd !== undefined && meta.rangeStart !== undefined
      ? meta.rangeEnd - meta.rangeStart + 1
      : items.length;
  const pageSize = inferredPageSize > 0 ? inferredPageSize : DEFAULT_PAGE_SIZE;
  const total = meta.total ?? items.length;
  const lastPage = Math.max(
    1,
    query.page,
    meta.lastPage,
    pageSize > 0 && total > 0 ? Math.ceil(total / pageSize) : 1,
  );
  return {
    generatedAt,
    fromCache,
    items,
    page: query.page,
    pageSize,
    total,
    lastPage,
  };
}

export async function getPackageCatalog(
  args: {
    refresh?: boolean;
    page?: number;
    query?: string;
    type?: string;
    sort?: CatalogSort;
    fetchImpl?: CatalogFetcher;
    now?: () => number;
  } = {},
): Promise<{ catalog: PackageCatalog } | { error: HostError }> {
  const now = args.now ?? Date.now;
  const fetchImpl: CatalogFetcher = args.fetchImpl ?? fetch;
  const query = normalizeQuery(args);
  const key = cacheKey(query);
  const hit = cache.get(key);

  if (args.refresh !== true && hit && now() - hit.atMs <= CATALOG_TTL_MS) {
    return { catalog: { ...hit.catalog, fromCache: true } };
  }

  const timeout = createTimeoutSignal(FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(catalogPageUrl(query), {
      signal: timeout.signal,
      headers: { accept: "text/html" },
    });
    if (!response.ok) {
      throw new Error(`Package catalog request failed with status ${response.status}`);
    }
    const html = await response.text();
    const items = parsePackageCatalogHtml(html);
    const unfilteredFirstPage = query.page === 1 && !query.query && !query.type;
    if (items.length === 0 && unfilteredFirstPage) {
      throw new Error("Package catalog page contained no packages");
    }
    const catalog = buildCatalog(items, query, parseCatalogIndexMeta(html), now(), false);
    cache.set(key, { atMs: now(), catalog });
    return { catalog };
  } catch (error) {
    if (hit) return { catalog: { ...hit.catalog, fromCache: true } };
    return {
      error: createHostError(
        "CATALOG_UNAVAILABLE",
        error instanceof Error ? error.message : "Package catalog unavailable",
        { retryable: true },
      ),
    };
  } finally {
    timeout.dispose();
  }
}
