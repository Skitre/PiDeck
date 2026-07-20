import { describe, expect, it } from "vitest";
import { formatTokenCount } from "./format-token-count";

describe("formatTokenCount", () => {
  it("keeps small values and compacts thousands and millions", () => {
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(1_000)).toBe("1k");
    expect(formatTokenCount(15_742)).toBe("15.7k");
    expect(formatTokenCount(125_000)).toBe("125k");
    expect(formatTokenCount(1_000_000)).toBe("1M");
    expect(formatTokenCount(1_250_000)).toBe("1.3M");
  });
});
