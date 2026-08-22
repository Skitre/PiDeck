import type { NormalizedFloatRect } from "@pideck/protocol";

export type PixelRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type ViewportSize = {
  width: number;
  height: number;
};

const FLOAT_EDGE_MARGIN = 8;
const FLOAT_SNAP_DISTANCE = 16;
const FLOAT_MIN_WIDTH = 200;
const FLOAT_MIN_HEIGHT = 96;

export type FloatResizeEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export function applyFloatResize(
  start: PixelRect,
  edge: FloatResizeEdge,
  dx: number,
  dy: number,
): PixelRect {
  const right = start.left + start.width;
  const bottom = start.top + start.height;
  let { left, top, width, height } = start;
  if (edge.includes("e")) width = start.width + dx;
  if (edge.includes("s")) height = start.height + dy;
  if (edge.includes("w")) {
    left = start.left + dx;
    width = right - left;
  }
  if (edge.includes("n")) {
    top = start.top + dy;
    height = bottom - top;
  }
  return { left, top, width, height };
}

export function resizeFloatRect(
  start: PixelRect,
  edge: FloatResizeEdge,
  dx: number,
  dy: number,
  viewport: ViewportSize,
  excluded?: PixelRect | null,
): PixelRect {
  const next = applyFloatResize(start, edge, dx, dy);
  const maxWidth = Math.max(FLOAT_MIN_WIDTH, viewport.width - FLOAT_EDGE_MARGIN * 2);
  const maxHeight = Math.max(FLOAT_MIN_HEIGHT, viewport.height - FLOAT_EDGE_MARGIN * 2);
  const width = Math.min(Math.max(FLOAT_MIN_WIDTH, next.width), maxWidth);
  const height = Math.min(Math.max(FLOAT_MIN_HEIGHT, next.height), maxHeight);
  const left = edge.includes("w") ? start.left + start.width - width : start.left;
  const top = edge.includes("n") ? start.top + start.height - height : start.top;
  return clampAndSnapFloatRect({ left, top, width, height }, viewport, excluded);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function floatRectToPixels(rect: NormalizedFloatRect, viewport: ViewportSize): PixelRect {
  return {
    left: rect.x * viewport.width,
    top: rect.y * viewport.height,
    width: rect.width,
    height: rect.height,
  };
}

export function pixelsToNormalizedFloatRect(
  pixel: PixelRect,
  viewport: ViewportSize,
): NormalizedFloatRect {
  const width = Math.max(1, viewport.width);
  const height = Math.max(1, viewport.height);
  return {
    x: clamp01(pixel.left / width),
    y: clamp01(pixel.top / height),
    width: pixel.width,
    height: pixel.height,
  };
}

export function rectsOverlap(left: PixelRect, right: PixelRect): boolean {
  return (
    left.left < right.left + right.width &&
    left.left + left.width > right.left &&
    left.top < right.top + right.height &&
    left.top + left.height > right.top
  );
}

function snapEdge(value: number, min: number, max: number): number {
  if (value - min <= FLOAT_SNAP_DISTANCE) return min;
  if (max - value <= FLOAT_SNAP_DISTANCE) return max;
  return value;
}

export function excludeBrowserRect(
  pixel: PixelRect,
  excluded: PixelRect | null | undefined,
): PixelRect {
  if (!excluded || !rectsOverlap(pixel, excluded)) return pixel;
  const leftOf = excluded.left - pixel.width - FLOAT_EDGE_MARGIN;
  if (leftOf >= FLOAT_EDGE_MARGIN) {
    return { ...pixel, left: leftOf };
  }
  const rightOf = excluded.left + excluded.width + FLOAT_EDGE_MARGIN;
  return { ...pixel, left: rightOf };
}

export function clampAndSnapFloatRect(
  pixel: PixelRect,
  viewport: ViewportSize,
  excluded?: PixelRect | null,
): PixelRect {
  const maxWidth = Math.max(FLOAT_MIN_WIDTH, viewport.width - FLOAT_EDGE_MARGIN * 2);
  const maxHeight = Math.max(FLOAT_MIN_HEIGHT, viewport.height - FLOAT_EDGE_MARGIN * 2);
  const width = Math.min(Math.max(FLOAT_MIN_WIDTH, pixel.width), maxWidth);
  const height = Math.min(Math.max(FLOAT_MIN_HEIGHT, pixel.height), maxHeight);
  const minLeft = FLOAT_EDGE_MARGIN;
  const minTop = FLOAT_EDGE_MARGIN;
  const maxLeft = Math.max(minLeft, viewport.width - width - FLOAT_EDGE_MARGIN);
  const maxTop = Math.max(minTop, viewport.height - height - FLOAT_EDGE_MARGIN);
  const next = excludeBrowserRect(
    {
      left: snapEdge(pixel.left, minLeft, maxLeft),
      top: snapEdge(pixel.top, minTop, maxTop),
      width,
      height,
    },
    excluded,
  );
  return {
    left: Math.min(Math.max(minLeft, next.left), maxLeft),
    top: Math.min(Math.max(minTop, next.top), maxTop),
    width,
    height,
  };
}

export function readBrowserExclusionRect(root: ParentNode = document): PixelRect | null {
  const element = root.querySelector<HTMLElement>("[data-pideck-browser-surface]");
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 8) return null;
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}
