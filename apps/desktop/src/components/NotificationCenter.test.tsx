import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  NotificationPanel,
  notificationPopupLeft,
  notificationPopupTop,
} from "./NotificationCenter";

describe("notification popup position", () => {
  it("centers the panel on the bell and keeps it on screen", () => {
    expect(notificationPopupLeft(220, 240, 1280)).toBe(100);
    expect(notificationPopupLeft(20, 240, 1280)).toBe(8);
    expect(notificationPopupLeft(1260, 240, 1280)).toBe(1032);
    expect(notificationPopupTop(64)).toBe(70);
  });
});

describe("NotificationPanel", () => {
  it("renders retained notifications newest first with actionable controls", () => {
    const html = renderToStaticMarkup(
      <NotificationPanel
        notifications={[
          {
            id: "older",
            message: "Provider unavailable",
            level: "error",
            createdAt: 1_700_000_000_000,
            read: true,
          },
          {
            id: "newer",
            message: "Settings backup created",
            level: "warning",
            createdAt: 1_700_000_001_000,
            read: false,
          },
        ]}
        onDismiss={vi.fn()}
        onClear={vi.fn()}
      />,
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain("data-notification-panel");
    expect(html).toContain("w-60");
    expect(html).toContain('aria-label="Notifications"');
    expect(html).toContain('aria-label="Clear all"');
    expect(html).toContain('aria-label="Dismiss notification"');
    expect(html).toContain("Settings backup created");
    expect(html).toContain("Provider unavailable");
    expect(html.indexOf("Settings backup created")).toBeLessThan(
      html.indexOf("Provider unavailable"),
    );
  });

  it("renders an explicit empty state", () => {
    const html = renderToStaticMarkup(
      <NotificationPanel notifications={[]} onDismiss={vi.fn()} onClear={vi.fn()} />,
    );
    expect(html).toContain("No notifications");
    expect(html).not.toContain('aria-label="Clear all"');
  });
});
