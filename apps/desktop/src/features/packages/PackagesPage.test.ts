import { describe, expect, it } from "vitest";
import { PACKAGE_LIST_PARAMS } from "./packages-model";

describe("Packages page user-only contract", () => {
  it("lists user-scope packages only", () => {
    expect(PACKAGE_LIST_PARAMS).toEqual({ scope: "user", includeResources: true });
  });
});
