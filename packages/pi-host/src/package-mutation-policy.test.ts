import { describe, expect, it } from "vitest";
import { packageMutationMayChangeDisk } from "./package-controller.js";

describe("package mutation disk reconciliation policy", () => {
  it.each(["install", "remove", "update", "updateAll"] as const)(
    "keeps disk reconciliation for %s",
    (kind) => {
      expect(packageMutationMayChangeDisk(kind)).toBe(true);
    },
  );

  it.each(["setPreferences", "reload"] as const)(
    "skips package-tree scans for %s",
    (kind) => {
      expect(packageMutationMayChangeDisk(kind)).toBe(false);
    },
  );
});
