import { describe, expect, it } from "vitest";
import { resolveRehydrateHostInstanceId } from "./rehydrate";

describe("resolveRehydrateHostInstanceId", () => {
  it("keeps the Host identity returned by hello during restart recovery", () => {
    expect(resolveRehydrateHostInstanceId("hello-host", null)).toBe("hello-host");
    expect(resolveRehydrateHostInstanceId("hello-host", "stale-host")).toBe(
      "hello-host",
    );
  });

  it("falls back to the client identity outside an explicit recovery", () => {
    expect(resolveRehydrateHostInstanceId(undefined, "current-host")).toBe(
      "current-host",
    );
    expect(resolveRehydrateHostInstanceId(undefined, null)).toBeNull();
  });
});
