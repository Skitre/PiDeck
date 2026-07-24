import { describe, expect, it, vi } from "vitest";
import { activateOnce, clearSlots, type ExtensionUiSlots } from "./extension-ui-lifecycle.js";

describe("Extension UI lifecycle", () => {
  it("activates a prepared binding only once", async () => {
    const publish = vi.fn();
    const activate = vi.fn(async () => publish);
    const slots: ExtensionUiSlots = {
      extensionUiActivate: activate,
      extensionUiCleanup: vi.fn(),
      extensionUiUpdateIdentity: vi.fn(),
    };

    await expect(activateOnce(slots)).resolves.toBe(publish);
    await expect(activateOnce(slots)).resolves.toEqual(expect.any(Function));
    expect(activate).toHaveBeenCalledTimes(1);
    expect(slots.extensionUiActivate).toBeNull();
  });

  it("clears every lifecycle slot when activation fails", async () => {
    const cleanup = vi.fn();
    const slots: ExtensionUiSlots = {
      extensionUiActivate: vi.fn(async () => {
        throw new Error("activation failed");
      }),
      extensionUiCleanup: cleanup,
      extensionUiUpdateIdentity: vi.fn(),
    };

    await expect(activateOnce(slots)).rejects.toThrow("activation failed");
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(slots).toMatchObject({
      extensionUiActivate: null,
      extensionUiCleanup: null,
      extensionUiUpdateIdentity: null,
    });
  });

  it("clears slots even when cleanup throws", () => {
    const slots: ExtensionUiSlots = {
      extensionUiActivate: vi.fn(),
      extensionUiCleanup: vi.fn(() => {
        throw new Error("cleanup failed");
      }),
      extensionUiUpdateIdentity: vi.fn(),
    };

    expect(() => clearSlots(slots)).toThrow("cleanup failed");
    expect(slots).toMatchObject({
      extensionUiActivate: null,
      extensionUiCleanup: null,
      extensionUiUpdateIdentity: null,
    });
  });
});
