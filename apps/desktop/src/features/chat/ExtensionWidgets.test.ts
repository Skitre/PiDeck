import { describe, expect, it } from "vitest";
import { partitionExtensionWidgets } from "./ExtensionWidgets";

describe("extension widget placement hints", () => {
  it("defaults widgets without placement above the editor", () => {
    const entry = { key: "default" };

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
});
