/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostStatusSnapshot, SessionSummary, WorkspaceSnapshot } from "@pideck/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore } from "../../lib/stores/app-store";
import { SessionList } from "./SessionList";

const summary: SessionSummary = {
  sessionId: "session-1",
  sessionPath: "/sessions/session-1.jsonl",
  name: "Position the menu",
  cwd: "/workspace",
  updatedAt: 1,
  messageCount: 1,
};

const host: HostStatusSnapshot = {
  protocolVersion: 1,
  hostInstanceId: "host-1",
  workspaceId: "workspace-1",
  workspaceRevision: 1,
  sessionId: null,
  sessionRevision: 0,
  packageRevision: 1,
  sdkVersion: "0.82.1",
  nodeVersion: process.version,
  agentDir: "/agent",
  phase: "ready",
  capabilities: {
    packageUpdateCheck: true,
    extensionUi: true,
    sessionExport: true,
  },
  modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
};

const workspace: WorkspaceSnapshot = {
  id: "workspace-1",
  cwd: "/workspace",
  canonicalCwd: "/workspace",
  revision: 1,
  servicesReady: true,
};

describe("SessionList menu", () => {
  beforeEach(() => {
    useAppStore.setState({
      host,
      workspace,
      session: null,
      connecting: false,
      rehydrating: false,
      desynchronized: false,
      hostFatal: null,
    });
    useAppStore.getState().replaceSessionCatalog(workspace.id, [summary]);
    vi.spyOn(hostClient, "request").mockResolvedValue({
      ok: true,
      result: { items: [summary] },
    } as never);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("portals the fixed menu out of the transformed collapsible region", () => {
    render(<SessionList />);
    const trigger = screen.getByRole("button", { name: "Session actions" });
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      x: 186,
      y: 118,
      width: 22,
      height: 22,
      top: 118,
      right: 208,
      bottom: 140,
      left: 186,
      toJSON: () => ({}),
    });

    fireEvent.click(trigger);

    const menu = document.body.querySelector<HTMLElement>(
      ".theme-floating-surface[data-session-menu]",
    );
    expect(menu).not.toBeNull();
    expect(trigger.closest(".collapsible-region__content")).not.toBeNull();
    expect(menu?.closest(".collapsible-region__content")).toBeNull();
    expect(menu).toHaveStyle({ left: "64px", top: "144px" });
  });

  it("portals the delete confirm out of the clipped collapsible region", () => {
    render(<SessionList />);
    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    const dialog = screen.getByRole("dialog", { name: "Permanently delete Session?" });
    expect(dialog).toHaveAttribute("data-session-confirm");
    expect(dialog.closest(".collapsible-region__content")).toBeNull();
    expect(dialog.parentElement?.parentElement).toBe(document.body);
  });

  it("shows a running status without a stop control", () => {
    useAppStore.getState().replaceSessionCatalog(workspace.id, [
      {
        ...summary,
        runtimeState: "running",
        sessionRevision: 4,
      },
    ]);

    render(<SessionList />);

    expect(screen.getByLabelText("running")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });
});
