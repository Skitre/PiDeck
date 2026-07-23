import { parse, postprocess, preprocess } from "micromark";

export function sanitizeAgentText(value: string): string {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/<dcp-id>[\s\S]*?<\/dcp-id>/gi, "")
    .replace(/^Thinking:\s*/i, "");
}

export function isSafeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function codeLineCount(value: string): number {
  if (!value) return 0;
  return value.replace(/\n$/, "").split("\n").length;
}

type MicromarkEvent = ReturnType<typeof postprocess>[number];

type MermaidFence = {
  blockStart: number;
  blockEnd: number;
  infoStart: number;
  infoEnd: number;
  closed: boolean;
};

function scanMermaidFences(value: string): MermaidFence[] {
  let current:
    | {
        blockStart: number;
        infoStart: number;
        infoEnd: number;
        fenceCount: number;
      }
    | null = null;
  const fences: MermaidFence[] = [];

  let events: MicromarkEvent[];
  try {
    const chunks = preprocess()(value, undefined, true);
    events = postprocess(parse().document().write(chunks));
  } catch {
    return fences;
  }

  for (const [kind, token] of events) {
    if (kind === "enter" && token.type === "codeFenced") {
      current = {
        blockStart: token.start.offset,
        infoStart: -1,
        infoEnd: -1,
        fenceCount: 0,
      };
      continue;
    }

    if (!current) continue;

    if (kind === "enter" && token.type === "codeFencedFence") {
      current.fenceCount += 1;
      continue;
    }

    if (kind === "enter" && token.type === "codeFencedFenceInfo" && current.fenceCount === 1) {
      const info = value.slice(token.start.offset, token.end.offset);
      if (info.toLowerCase() === "mermaid") {
        current.infoStart = token.start.offset;
        current.infoEnd = token.end.offset;
      }
      continue;
    }

    if (kind === "exit" && token.type === "codeFenced") {
      if (current.infoStart >= 0) {
        fences.push({
          blockStart: current.blockStart,
          blockEnd: token.end.offset,
          infoStart: current.infoStart,
          infoEnd: current.infoEnd,
          closed: current.fenceCount > 1,
        });
      }
      current = null;
    }
  }

  return fences;
}

/**
 * Keeps an unfinished Mermaid fence as a normal code fence while content is
 * still arriving. Micromark's concrete token events are used here instead of
 * line heuristics so block quotes, lists, tabs, and container boundaries follow
 * the same CommonMark rules as the renderer.
 */
export function deferIncompleteMermaid(value: string): string {
  if (!/mermaid/i.test(value) || (!value.includes("```") && !value.includes("~~~"))) {
    return value;
  }

  const replacements = scanMermaidFences(value).map((fence) => ({
    start: fence.infoStart,
    end: fence.infoEnd,
    value: fence.closed ? "mermaid" : "text",
  }));

  if (replacements.length === 0) return value;

  // Apply from the end so a short "text" replacement cannot shift earlier
  // token offsets when several Mermaid fences are present in one message.
  return replacements
    .sort((left, right) => right.start - left.start)
    .reduce(
      (source, replacement) =>
        source.slice(0, replacement.start) + replacement.value + source.slice(replacement.end),
      value,
    );
}

/**
 * Returns a stable key for closed Mermaid blocks. Content outside those
 * blocks is ignored, so appending streamed prose does not remount the chart.
 */
export function mermaidFenceSignature(value: string): string {
  const fences = scanMermaidFences(value).filter((fence) => fence.closed);
  if (fences.length === 0) return "none";

  let hash = 2166136261;
  for (const fence of fences) {
    for (let index = fence.blockStart; index < fence.blockEnd; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    hash ^= 0;
    hash = Math.imul(hash, 16777619);
  }
  return `${fences.length}-${(hash >>> 0).toString(36)}`;
}

/**
 * Removes Mermaid-generated active/resource elements before the SVG is put in
 * the DOM. Safe HTTP(S) links are retained as inert metadata for the outer
 * Markdown handler to confirm and open through the system browser.
 */
export function sanitizeMermaidSvg(value: string): string {
  if (typeof DOMParser === "undefined" || typeof XMLSerializer === "undefined") return "";

  const parsed = new DOMParser().parseFromString(value, "image/svg+xml");
  if (parsed.querySelector("parsererror")) return "";
  const root = parsed.documentElement;
  if (root.localName.toLowerCase() !== "svg") return "";

  const blockedElements = new Set([
    "animate",
    "animatemotion",
    "animatetransform",
    "audio",
    "discard",
    "embed",
    "foreignobject",
    "iframe",
    "image",
    "link",
    "object",
    "script",
    "set",
    "video",
  ]);
  const elements = [root, ...Array.from(parsed.querySelectorAll("*"))];
  for (const element of elements) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.localName.toLowerCase();
      if (name.startsWith("on")) {
        element.removeAttributeNode(attribute);
        continue;
      }
      if (name === "data-pideck-mermaid-href") {
        element.removeAttributeNode(attribute);
        continue;
      }
      if (name === "style" && hasUnsafeCssResource(attribute.value)) {
        element.removeAttributeNode(attribute);
        continue;
      }
      if (/url\s*\(/i.test(attribute.value) && hasUnsafeCssResource(attribute.value)) {
        element.removeAttributeNode(attribute);
      }
    }
  }

  for (const element of elements) {
    const name = element.localName.toLowerCase();
    if (blockedElements.has(name)) {
      element.remove();
      continue;
    }
    if (name === "style" && hasUnsafeCssResource(element.textContent ?? "")) {
      element.remove();
    }
  }

  for (const anchor of elements.filter((element) => element.localName.toLowerCase() === "a")) {
    if (!anchor.isConnected) continue;
    const href = getSvgHrefs(anchor).find(isSafeExternalUrl);
    const parent = anchor.parentNode;
    if (!parent) continue;

    if (href && isSafeExternalUrl(href)) {
      removeSvgHref(anchor);
      anchor.setAttribute("data-pideck-mermaid-href", href);
      anchor.setAttribute("role", "link");
      anchor.setAttribute("tabindex", "0");
      continue;
    }

    while (anchor.firstChild) parent.insertBefore(anchor.firstChild, anchor);
    anchor.remove();
  }

  for (const element of elements) {
    if (!element.isConnected) continue;
    if (element.hasAttribute("data-pideck-mermaid-href")) continue;
    for (const attribute of Array.from(element.attributes)) {
      if (
        attribute.localName.toLowerCase() === "href" &&
        !isSafeSvgFragment(attribute.value)
      ) {
        element.removeAttributeNode(attribute);
      }
    }
  }

  root.setAttribute("data-pideck-mermaid-theme", "neutral");
  return new XMLSerializer().serializeToString(root);
}

function hasUnsafeCssResource(value: string): boolean {
  if (/@import\b/i.test(value)) return true;
  if (/\b(?:data|file|https?|javascript):/i.test(value)) return true;
  const urlPattern = /url\s*\(\s*(['"]?)(.*?)\1\s*\)/gi;
  for (const match of value.matchAll(urlPattern)) {
    if (!isSafeSvgFragment(match[2].trim())) return true;
  }
  return false;
}

function isSafeSvgFragment(value: string): boolean {
  return /^#[A-Za-z_][A-Za-z0-9_.:-]*$/.test(value.trim());
}

function getSvgHrefs(element: Element): string[] {
  return Array.from(element.attributes)
    .filter((attribute) => attribute.localName.toLowerCase() === "href")
    .map((attribute) => attribute.value);
}

function removeSvgHref(element: Element): void {
  for (const attribute of Array.from(element.attributes)) {
    if (attribute.localName.toLowerCase() === "href") element.removeAttributeNode(attribute);
  }
}

/**
 * Allows only same-message footnote fragments generated by remark-rehype.
 */
export function isSafeFootnoteFragment(value: string, prefix: string): boolean {
  if (!value.startsWith(`#${prefix}`)) return false;
  if (!value.startsWith(`#${prefix}fn-`) && !value.startsWith(`#${prefix}fnref-`)) return false;
  return /^#[A-Za-z0-9._:%-]+$/.test(value);
}
