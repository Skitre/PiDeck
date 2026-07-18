import { describe, expect, it, vi } from "vitest";
import {
  PACKAGE_MUTATION_TIMEOUT_MS,
  waitForPackageMutation,
} from "./package-controller.js";

describe("package mutation timeout", () => {
  it("matches the desktop's ten minute package-operation budget", () => {
    expect(PACKAGE_MUTATION_TIMEOUT_MS).toBe(600_000);
  });

  it("returns a completed operation before the deadline", async () => {
    await expect(waitForPackageMutation(Promise.resolve("done"), 100)).resolves.toEqual({
      timedOut: false,
      value: "done",
    });
  });

  it("times out without cancelling or rejecting the underlying operation", async () => {
    vi.useFakeTimers();
    try {
      let complete!: (value: string) => void;
      const operation = new Promise<string>((resolve) => {
        complete = resolve;
      });
      const result = waitForPackageMutation(operation, 50);

      await vi.advanceTimersByTimeAsync(50);
      await expect(result).resolves.toEqual({ timedOut: true });

      complete("eventually finished");
      await operation;
    } finally {
      vi.useRealTimers();
    }
  });
});
