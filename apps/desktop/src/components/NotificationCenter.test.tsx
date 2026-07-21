import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { NotificationPanel } from "./NotificationCenter";

describe("NotificationPanel", () => {
  it("renders retained notifications newest first with actionable controls", () => {
    const html = renderToStaticMarkup(
      <NotificationPanel
        notifications={[
          { id: "older", message: "Provider unavailable", level: "error", createdAt: 1_700_000_000_000 },
          { id: "newer", message: "Settings backup created", level: "warning", createdAt: 1_700_000_001_000 },
        ]}
        onDismiss={vi.fn()}
        onClear={vi.fn()}
      />,
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-label="Notification center"');
    expect(html).toContain('aria-label="Clear all notifications"');
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
    expect(html).not.toContain('aria-label="Clear all notifications"');
  });
});
