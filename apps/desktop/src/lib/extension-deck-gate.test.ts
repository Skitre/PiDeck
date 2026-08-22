import { afterEach, describe, expect, it } from "vitest";
import { isExtensionDeckV1Enabled, resetExtensionDeckV1GateForTests } from "./extension-deck-gate";

afterEach(() => {
  resetExtensionDeckV1GateForTests();
});

describe("extension-deck-v1 gate", () => {
  it("resolves once and stays stable for the process", () => {
    resetExtensionDeckV1GateForTests(true);
    expect(isExtensionDeckV1Enabled()).toBe(true);
    resetExtensionDeckV1GateForTests(false);
    expect(isExtensionDeckV1Enabled()).toBe(false);
  });

  it("defaults on so the accepted Extensions tab is the active path", () => {
    resetExtensionDeckV1GateForTests(undefined);
    expect(isExtensionDeckV1Enabled()).toBe(true);
  });
});
