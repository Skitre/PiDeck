import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  WidgetPanel,
  calculateWidgetPopoverLayout,
  calculateWidgetPopoverPosition,
  isUsableWidgetAnchor,
  partitionExtensionWidgets,
} from "./ExtensionWidgets";

describe("extension widget placement", () => {
  it("defaults widgets without placement above the editor", () => {
    const entry = { key: "default" };

    expect(partitionExtensionWidgets([entry])).toEqual({
      aboveEditor: [entry],
      belowEditor: [],
    });
  });

  it("keeps explicit above-editor widgets above the editor", () => {
    const entry = { key: "above", placement: "aboveEditor" as const };

    expect(partitionExtensionWidgets([entry])).toEqual({
      aboveEditor: [entry],
      belowEditor: [],
    });
  });

  it("places explicit below-editor widgets below the editor", () => {
    const entry = { key: "below", placement: "belowEditor" as const };

    expect(partitionExtensionWidgets([entry])).toEqual({
      aboveEditor: [],
      belowEditor: [entry],
    });
  });

  it("preserves insertion order without duplicating mixed widgets", () => {
    const entries = [
      { key: "default" },
      { key: "below-1", placement: "belowEditor" as const },
      { key: "above", placement: "aboveEditor" as const },
      { key: "below-2", placement: "belowEditor" as const },
    ];

    const partitioned = partitionExtensionWidgets(entries);

    expect(partitioned.aboveEditor.map((entry) => entry.key)).toEqual(["default", "above"]);
    expect(partitioned.belowEditor.map((entry) => entry.key)).toEqual(["below-1", "below-2"]);
    expect([...partitioned.aboveEditor, ...partitioned.belowEditor]).toHaveLength(entries.length);
  });
});

describe("extension widget popover geometry", () => {
  const anchor = { top: 500, bottom: 600, left: 100, width: 600 };

  it("places default widgets above the editor without changing layout", () => {
    const position = calculateWidgetPopoverPosition({
      anchor,
      viewportWidth: 1_000,
      viewportHeight: 800,
      preferredPlacement: "aboveEditor",
      compact: false,
    });

    expect(position).toEqual({
      side: "above",
      left: 100,
      width: 600,
      maxHeight: 256,
      bottom: 308,
    });

    const markup = renderToStaticMarkup(
      createElement(WidgetPanel, {
        entries: [{ key: "nano-context", widget: ["5 pattools"] }],
        collapsedWidgetKeys: {},
        placementLabel: "above",
        position,
        onClose: () => undefined,
        onToggleCollapsed: () => undefined,
      }),
    );
    expect(markup).toContain("fixed z-40");
    expect(markup).toContain('data-widget-popover-side="above"');
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain("5 pattools");
  });

  it("rejects a collapsed composer as a drawer anchor", () => {
    expect(isUsableWidgetAnchor({ top: 0, bottom: 0, left: 0, width: 0 })).toBe(false);
    expect(isUsableWidgetAnchor({ top: 500, bottom: 600, left: 100, width: 600 })).toBe(true);
  });

  it("does not park an unmeasured drawer at the window origin", () => {
    const markup = renderToStaticMarkup(
      createElement(WidgetPanel, {
        entries: [{ key: "nano-context", widget: ["hidden until measured"] }],
        collapsedWidgetKeys: {},
        placementLabel: "above",
        position: null,
        onClose: () => undefined,
        onToggleCollapsed: () => undefined,
      }),
    );

    expect(markup).toBe("");
  });

  it("does not render a drawer that is too narrow to be the composer popover", () => {
    const markup = renderToStaticMarkup(
      createElement(WidgetPanel, {
        entries: [{ key: "nano-context", widget: ["clipped sliver"] }],
        collapsedWidgetKeys: {},
        placementLabel: "above",
        position: { side: "above", left: 0, width: 1, maxHeight: 200, bottom: 8 },
        onClose: () => undefined,
        onToggleCollapsed: () => undefined,
      }),
    );

    expect(markup).toBe("");
  });

  it("keeps a collapsed widget header accessible without rendering its body", () => {
    const markup = renderToStaticMarkup(
      createElement(WidgetPanel, {
        entries: [{ key: "nano-context", widget: ["private snapshot"] }],
        collapsedWidgetKeys: { "nano-context": true },
        placementLabel: "above",
        position: calculateWidgetPopoverPosition({
          anchor,
          viewportWidth: 1_000,
          viewportHeight: 800,
          preferredPlacement: "aboveEditor",
          compact: false,
        }),
        onClose: () => undefined,
        onToggleCollapsed: () => undefined,
      }),
    );

    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("aria-controls=");
    expect(markup).toContain("nano-context");
    expect(markup).not.toContain("private snapshot");
  });

  it("keeps below-editor widgets below when the viewport has room", () => {
    expect(
      calculateWidgetPopoverPosition({
        anchor: { ...anchor, top: 200, bottom: 300 },
        viewportWidth: 1_000,
        viewportHeight: 800,
        preferredPlacement: "belowEditor",
        compact: false,
      }),
    ).toMatchObject({ side: "below", top: 308, maxHeight: 256 });
  });

  it("flips below-editor widgets above a bottom-docked composer", () => {
    expect(
      calculateWidgetPopoverPosition({
        anchor: { ...anchor, top: 620, bottom: 760 },
        viewportWidth: 1_000,
        viewportHeight: 800,
        preferredPlacement: "belowEditor",
        compact: false,
      }),
    ).toMatchObject({ side: "above", bottom: 188, maxHeight: 256 });
  });

  it("clamps the drawer to the horizontal viewport", () => {
    expect(
      calculateWidgetPopoverPosition({
        anchor: { ...anchor, left: -40, width: 900 },
        viewportWidth: 800,
        viewportHeight: 800,
        preferredPlacement: "aboveEditor",
        compact: false,
      }),
    ).toMatchObject({ left: 8, width: 784 });
  });

  it("keeps mixed widgets on opposite sides when both sides have room", () => {
    const layout = calculateWidgetPopoverLayout({
      anchor: { ...anchor, top: 350, bottom: 450 },
      viewportWidth: 1_000,
      viewportHeight: 800,
      hasAbove: true,
      hasBelow: true,
    });

    expect(layout.combined).toBeNull();
    expect(layout.above).toMatchObject({ side: "above", bottom: 458 });
    expect(layout.below).toMatchObject({ side: "below", top: 458 });
  });

  it("combines mixed widgets when both placements must use the same side", () => {
    const layout = calculateWidgetPopoverLayout({
      anchor: { ...anchor, top: 620, bottom: 760 },
      viewportWidth: 1_000,
      viewportHeight: 800,
      hasAbove: true,
      hasBelow: true,
    });

    expect(layout.above).toBeNull();
    expect(layout.below).toBeNull();
    expect(layout.combined).toMatchObject({
      side: "above",
      bottom: 188,
      maxHeight: 256,
    });
  });
});
