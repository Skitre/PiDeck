import { describe, expect, it } from "vitest";
import {
  acquireBrowserOcclusion,
  isBrowserOccluded,
  resetBrowserOcclusionForTests,
} from "./browser-occlusion";

describe("browser occlusion", () => {
  it("hides until the last owner releases", () => {
    resetBrowserOcclusionForTests();
    const releaseModal = acquireBrowserOcclusion("extension-ui-modal");
    const releaseDialog = acquireBrowserOcclusion("app-dialog");
    expect(isBrowserOccluded()).toBe(true);
    releaseModal();
    expect(isBrowserOccluded()).toBe(true);
    releaseDialog();
    expect(isBrowserOccluded()).toBe(false);
  });
});
