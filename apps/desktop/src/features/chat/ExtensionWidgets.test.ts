import { describe, expect, it } from "vitest";
import { partitionExtensionWidgets } from "./ExtensionWidgets";

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
    expect(partitioned.belowEditor.map((entry) => entry.key)).toEqual([
      "below-1",
      "below-2",
    ]);
    expect([...partitioned.aboveEditor, ...partitioned.belowEditor]).toHaveLength(
      entries.length,
    );
  });
});
