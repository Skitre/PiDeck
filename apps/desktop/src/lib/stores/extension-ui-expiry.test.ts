import { expect, it } from "vitest";
import { useAppStore } from "./app-store";

it("drops expired Extension UI requests and advances to the next live request", () => {
  const context = {
    expectedHostInstanceId: "11111111-1111-4111-8111-111111111111",
    expectedWorkspaceId: "22222222-2222-4222-8222-222222222222",
    expectedWorkspaceRevision: 1,
    expectedSessionId: "33333333-3333-4333-8333-333333333333",
    expectedSessionRevision: 1,
  };
  const now = Date.now();
  useAppStore.getState().setExtensionUiRequest({
    requestId: "44444444-4444-4444-8444-444444444444",
    kind: "confirm",
    title: "Expired",
    context,
    expiresAt: now - 1,
  });
  useAppStore.getState().setExtensionUiRequest({
    requestId: "55555555-5555-4555-8555-555555555555",
    kind: "confirm",
    title: "First live",
    context,
    expiresAt: now + 60_000,
  });
  useAppStore.getState().setExtensionUiRequest({
    requestId: "66666666-6666-4666-8666-666666666666",
    kind: "confirm",
    title: "Second live",
    context,
    expiresAt: now + 60_000,
  });

  expect(useAppStore.getState().extensionUiRequest?.title).toBe("First live");
  expect(useAppStore.getState().extensionUiQueue.map((request) => request.title)).toEqual([
    "Second live",
  ]);
  useAppStore.getState().setExtensionUiRequest(null);
  expect(useAppStore.getState().extensionUiRequest?.title).toBe("Second live");
});
