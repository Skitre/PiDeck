import { afterEach, describe, expect, it, vi } from "vitest";
import {
  catalogPageUrl,
  getPackageCatalog,
  parseCatalogIndexMeta,
  parsePackageCatalogHtml,
  resetPackageCatalogCache,
} from "./package-catalog.js";

function card(args: {
  name: string;
  search?: string;
  types?: string;
  downloads?: string;
  date?: string;
  description?: string;
  author?: string;
  npmUrl?: string;
  githubUrl?: string;
}): string {
  const links = [
    args.npmUrl ? `<a href="${args.npmUrl}" target="_blank" rel="noopener">npm</a>` : "",
    args.githubUrl ? `<a href="${args.githubUrl}" target="_blank" rel="noopener">GitHub</a>` : "",
  ].join("");
  return (
    `<article class="surface-panel content-card" data-package-card="true" ` +
    `data-package-name="${args.name}" ` +
    `data-package-search="${args.search ?? ""}" ` +
    `data-package-types="${args.types ?? "extension"}" ` +
    `data-package-downloads="${args.downloads ?? "100"}" ` +
    `data-package-date="${args.date ?? "1784623367738"}" ` +
    `data-package-sort-name="${args.name}">` +
    `<div class="packages-card-body">` +
    `<h3 class="packages-name"><a href="/packages/${args.name}" data-package-link="true">${args.name}</a></h3>` +
    `<p class="packages-desc">${args.description ?? "A test package."}</p>` +
    `<div class="packages-meta"><span>${args.author ?? "tester"}</span><span>100/mo</span><span>1d ago</span></div>` +
    `<div class="packages-links">${links}</div>` +
    `</div></article>`
  );
}

const PAGE_PREFIX =
  `<!DOCTYPE html><html><body>` +
  // The "recently published" strip uses data-package-link without data-package-card.
  `<a href="/packages/pi-noise" class="packages-recent-item" data-package-link="true" data-package-path="/packages/pi-noise">noise</a>`;
const PAGE_SUFFIX = `</body></html>`;

describe("parsePackageCatalogHtml", () => {
  it("extracts complete items and ignores non-card package links", () => {
    const html =
      PAGE_PREFIX +
      card({
        name: "@scope/pi-alpha",
        search: "@scope/pi-alpha alpha helper tester",
        types: "extension skill",
        downloads: "479565",
        date: "1784623367738",
        description: "Multi-phase audits &amp; specialist sub-agents.",
        author: "j3ssie",
        npmUrl: "https://www.npmjs.com/package/@scope/pi-alpha",
        githubUrl: "https://github.com/scope/pi-alpha",
      }) +
      card({ name: "pi-beta", types: "theme", downloads: "42" }) +
      PAGE_SUFFIX;

    const items = parsePackageCatalogHtml(html);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      name: "@scope/pi-alpha",
      description: "Multi-phase audits & specialist sub-agents.",
      author: "j3ssie",
      types: ["extension", "skill"],
      downloadsPerMonth: 479565,
      publishedAt: 1784623367738,
      npmUrl: "https://www.npmjs.com/package/@scope/pi-alpha",
      githubUrl: "https://github.com/scope/pi-alpha",
      searchText: "@scope/pi-alpha alpha helper tester",
      installSource: "npm:@scope/pi-alpha",
      pageUrl: "https://pi.dev/packages/@scope/pi-alpha",
    });
    expect(items[1]?.types).toEqual(["theme"]);
    expect(items[1]?.installSource).toBe("npm:pi-beta");
  });

  it("skips malformed cards and tolerates missing optional fields", () => {
    const brokenCard = `<article data-package-card="true" data-package-types="extension">`;
    const minimal =
      `<article data-package-card="true" data-package-name="pi-min">` +
      `<div class="packages-card-body"></div></article>`;
    const items = parsePackageCatalogHtml(PAGE_PREFIX + brokenCard + minimal + PAGE_SUFFIX);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      name: "pi-min",
      description: "",
      types: [],
      searchText: "",
      installSource: "npm:pi-min",
    });
    expect(items[0]).not.toHaveProperty("author");
    expect(items[0]).not.toHaveProperty("npmUrl");
  });
});

describe("parseCatalogIndexMeta", () => {
  it("reads the visible range, total, and last page link", () => {
    const html =
      `<span class="packages-count">1-50 / 5413</span>` +
      `<nav class="pagination packages-pagination">` +
      `<a class="pagination-page" href="/packages?page=2">2</a>` +
      `<a class="pagination-page" href="/packages?page=109">109</a>` +
      `</nav>`;
    expect(parseCatalogIndexMeta(html)).toEqual({
      rangeStart: 1,
      rangeEnd: 50,
      total: 5413,
      lastPage: 109,
    });
  });

  it("defaults to a single page when the index has no pager", () => {
    expect(parseCatalogIndexMeta("<html><body>no pager</body></html>")).toEqual({ lastPage: 1 });
  });
});

describe("getPackageCatalog", () => {
  afterEach(() => {
    resetPackageCatalogCache();
  });

  function okFetch(html: string) {
    return vi.fn(async () => ({ ok: true, status: 200, text: async () => html }));
  }

  const PAGE = PAGE_PREFIX + card({ name: "pi-cached" }) + PAGE_SUFFIX;

  it("caches within the TTL and refetches on refresh", async () => {
    const fetchImpl = okFetch(PAGE);
    let clock = 1_000;
    const now = () => clock;

    const first = await getPackageCatalog({ fetchImpl, now });
    expect("catalog" in first && first.catalog.fromCache).toBe(false);
    expect("catalog" in first && first.catalog).toMatchObject({
      page: 1,
      pageSize: 1,
      total: 1,
      lastPage: 1,
    });

    clock += 60_000;
    const second = await getPackageCatalog({ fetchImpl, now });
    expect("catalog" in second && second.catalog.fromCache).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const forced = await getPackageCatalog({ fetchImpl, now, refresh: true });
    expect("catalog" in forced && forced.catalog.fromCache).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("serves the stale cache when a refresh fails", async () => {
    const fetchImpl = okFetch(PAGE);
    let clock = 1_000;
    const now = () => clock;
    await getPackageCatalog({ fetchImpl, now });

    const failing = vi.fn(async () => {
      throw new Error("offline");
    });
    clock += 60 * 60_000;
    const result = await getPackageCatalog({ fetchImpl: failing, now });
    expect("catalog" in result && result.catalog.fromCache).toBe(true);
    expect("catalog" in result && result.catalog.items[0]?.name).toBe("pi-cached");
  });

  it("returns CATALOG_UNAVAILABLE without a cache", async () => {
    const failing = vi.fn(async () => {
      throw new Error("offline");
    });
    const result = await getPackageCatalog({ fetchImpl: failing });
    expect("error" in result && result.error.code).toBe("CATALOG_UNAVAILABLE");
    expect("error" in result && result.error.retryable).toBe(true);
  });

  it("treats a card-less page as unavailable rather than an empty market", async () => {
    const result = await getPackageCatalog({
      fetchImpl: okFetch("<html><body>redesigned page</body></html>"),
    });
    expect("error" in result && result.error.code).toBe("CATALOG_UNAVAILABLE");
  });

  it("fetches only the requested page", async () => {
    const pageOne =
      `<span class="packages-count">1-2 / 4</span>` +
      `<a href="/packages?page=2">2</a>` +
      card({ name: "pi-one" }) +
      card({ name: "pi-two" });
    const pageTwo =
      `<span class="packages-count">3-4 / 4</span>` +
      card({ name: "pi-three" }) +
      card({ name: "pi-four" });
    const fetchImpl = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      text: async () => (url.includes("page=2") ? pageTwo : pageOne),
    }));

    const first = await getPackageCatalog({ fetchImpl });
    expect("catalog" in first && first.catalog.items.map((item) => item.name)).toEqual([
      "pi-one",
      "pi-two",
    ]);
    expect("catalog" in first && first.catalog).toMatchObject({ page: 1, total: 4, lastPage: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://pi.dev/packages",
      expect.objectContaining({ headers: { accept: "text/html" } }),
    );

    const second = await getPackageCatalog({ fetchImpl, page: 2 });
    expect("catalog" in second && second.catalog.items.map((item) => item.name)).toEqual([
      "pi-three",
      "pi-four",
    ]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://pi.dev/packages?page=2",
      expect.objectContaining({ headers: { accept: "text/html" } }),
    );
  });

  it("maps search, type, and sort onto the pi.dev query string", async () => {
    expect(catalogPageUrl({ page: 3, query: "web", type: "skill", sort: "recent" })).toBe(
      "https://pi.dev/packages?page=3&name=web&type=skill&sort=recent",
    );
    const fetchImpl = okFetch(card({ name: "pi-web" }));
    await getPackageCatalog({
      fetchImpl,
      page: 2,
      query: "web",
      type: "extension",
      sort: "recent",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://pi.dev/packages?page=2&name=web&type=extension&sort=recent",
      expect.objectContaining({ headers: { accept: "text/html" } }),
    );
  });

  it("returns an empty page for a filtered miss instead of CATALOG_UNAVAILABLE", async () => {
    const result = await getPackageCatalog({
      fetchImpl: okFetch("<html><body>no cards</body></html>"),
      query: "definitely-missing",
    });
    expect("catalog" in result && result.catalog.items).toEqual([]);
    expect("catalog" in result && result.catalog.total).toBe(0);
  });
});
