import { describe, expect, it } from "vitest";
import type { DefaultPackageManager, PackageManager } from "@earendil-works/pi-coding-agent";

function typedUpdate(
  manager: Pick<PackageManager, "update">,
  source: string,
  local: boolean,
): Promise<void> {
  return manager.update(source, { local });
}

function typedSignal(manager: Pick<DefaultPackageManager, "setOperationSignal">): void {
  manager.setOperationSignal(undefined);
}

describe("PiDeck PackageManager augmentation", () => {
  it("types scoped update and setOperationSignal on SDK package types", async () => {
    const calls: unknown[] = [];
    const manager = {
      update: async (source?: string, options?: { local?: boolean }) => {
        calls.push({ source, options });
      },
      setOperationSignal: (signal: AbortSignal | undefined) => {
        calls.push({ signal });
      },
    };
    await typedUpdate(manager, "npm:example", true);
    typedSignal(manager);
    expect(calls).toEqual([
      { source: "npm:example", options: { local: true } },
      { signal: undefined },
    ]);
  });
});
