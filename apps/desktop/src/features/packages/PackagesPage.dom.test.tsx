/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type {
  HostResponseEnvelope,
  HostStatusSnapshot,
  PackageMutationResult,
  PackageRecord,
  PackageSnapshot,
  ResourceRecord,
  WorkspaceSnapshot,
} from "@pideck/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore } from "../../lib/stores/app-store";
import { PackagesPage } from "./PackagesPage";

const { shellOpen } = vi.hoisted(() => ({ shellOpen: vi.fn() }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: shellOpen }));

function host(overrides: Partial<HostStatusSnapshot> = {}): HostStatusSnapshot {
  return {
    protocolVersion: 1,
    hostInstanceId: "h1",
    workspaceId: "w1",
    workspaceRevision: 1,
    sessionId: "s1",
    sessionRevision: 1,
    packageRevision: 1,
    sdkVersion: "0.82.1",
    nodeVersion: process.version,
    agentDir: "C:/agent",
    phase: "ready",
    capabilities: {
      packageUpdateCheck: true,
      extensionUi: true,
      sessionExport: true,
    },
    modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
    ...overrides,
  };
}

function workspace(): WorkspaceSnapshot {
  return {
    id: "w1",
    revision: 1,
    cwd: "C:/workspace",
    canonicalCwd: "C:/workspace",
    servicesReady: true,
  };
}

function packageRecord(overrides: Partial<PackageRecord> = {}): PackageRecord {
  return {
    id: "package:user:tools",
    identity: "npm:tools",
    source: "npm:tools",
    kind: "npm",
    scope: "user",
    filtered: false,
    installed: true,
    displayName: "Tools",
    versionOrRef: "1.0.0",
    effective: true,
    resourceCounts: {
      extensions: 1,
      skills: 1,
      prompts: 0,
      themes: 0,
      enabled: 2,
      disabled: 0,
    },
    resourceCountsState: "resolvedEffective",
    ...overrides,
  };
}

function resource(overrides: Partial<ResourceRecord> = {}): ResourceRecord {
  return {
    id: "resource:extension:tools",
    type: "extension",
    name: "index.ts",
    description: "Adds local tools",
    path: "C:/agent/npm/tools/src/index.ts",
    relativePath: "src/index.ts",
    scope: "user",
    origin: "package",
    source: "npm:tools",
    packageId: "package:user:tools",
    enabled: true,
    preferences: { user: "enabled", project: "inherit" },
    control: { kind: "preference", scopes: ["user", "project"] },
    diagnostics: [],
    ...overrides,
  };
}

function snapshot(overrides: Partial<PackageSnapshot> = {}): PackageSnapshot {
  const owner = resource();
  return {
    revision: 1,
    workspaceId: "w1",
    scope: "user",
    configured: [
      packageRecord(),
      packageRecord({
        id: "package:user:legacy-theme",
        identity: "local:legacy-theme",
        source: "./legacy-theme",
        kind: "local",
        scope: "user",
        displayName: "Legacy theme",
        effective: false,
        resourceCounts: null,
        resourceCountsState: "unknownShadowed",
      }),
    ],
    resources: [
      owner,
      resource({
        id: "resource:skill:review",
        type: "skill",
        name: "Review skill",
        path: "C:/agent/skills/review/SKILL.md",
        manualOnly: true,
        preferences: { user: "enabled", project: "inherit" },
      }),
      resource({
        id: "resource:runtime:dynamic",
        type: "skill",
        name: "Dynamic review",
        path: "runtime://review/SKILL.md",
        origin: "extension",
        scope: "temporary",
        packageId: undefined,
        control: { kind: "owner-extension", ownerResourceId: owner.id },
      }),
    ],
    updateCheck: { supported: true },
    diagnostics: [
      { severity: "warning", source: "package:user:tools", message: "Optional dependency missing" },
    ],
    ...overrides,
  };
}

function envelope<M extends string, R>(method: M, result: R): HostResponseEnvelope {
  return {
    protocolVersion: 1,
    id: `${method}-test`,
    method,
    hostInstanceId: "h1",
    workspaceId: "w1",
    workspaceRevision: 1,
    sessionId: "s1",
    sessionRevision: 1,
    packageRevision: 1,
    ok: true,
    result,
  } as HostResponseEnvelope;
}

function serviceGraphBusyEnvelope(method: string): HostResponseEnvelope {
  return {
    protocolVersion: 1,
    id: `${method}-busy-test`,
    method,
    hostInstanceId: "h1",
    workspaceId: "w1",
    workspaceRevision: 1,
    sessionId: "s1",
    sessionRevision: 1,
    packageRevision: 1,
    ok: false,
    error: {
      code: "SERVICE_GRAPH_BUSY",
      message: "Service graph is busy",
      retryable: true,
      details: { operationKind: "package.mutation" },
    },
  } as HostResponseEnvelope;
}

function mutationResult(current: PackageSnapshot): PackageMutationResult {
  return {
    operationId: "op-1",
    status: "committed",
    packageSnapshot: current,
    warnings: [],
    reconcileRequired: false,
  };
}

describe("PackagesPage DOM workflows", () => {
  let currentSnapshot: PackageSnapshot;
  let request: MockInstance<typeof hostClient.request>;

  beforeEach(() => {
    currentSnapshot = snapshot();
    shellOpen.mockReset();
    useAppStore.getState().setHost(null);
    useAppStore.getState().setWorkspace(null);
    useAppStore.getState().applyPackageSnapshot(null);
    useAppStore.getState().setHost(host());
    useAppStore.getState().setWorkspace(workspace());
    useAppStore.getState().applyPackageSnapshot(currentSnapshot);
    request = vi.spyOn(hostClient, "request").mockImplementation(async (method: string) => {
      if (method === "package.list") return envelope(method, currentSnapshot);
      if (
        method === "package.install" ||
        method === "package.update" ||
        method === "package.updateAll" ||
        method === "resource.setPreference" ||
        method === "resource.setPreferences"
      ) {
        return envelope(method, mutationResult(currentSnapshot));
      }
      if (method === "package.checkUpdates")
        return envelope(method, { supported: true, updates: [] });
      throw new Error(`Unexpected method ${method}`);
    });
  });

  afterEach(() => {
    request.mockRestore();
    cleanup();
  });

  it("keeps the selected package detail while combining installed filters", async () => {
    const user = userEvent.setup();
    render(<PackagesPage />);

    await screen.findByRole("button", { name: /Tools.*User/ });
    expect(request).toHaveBeenCalledWith(
      "package.list",
      expect.objectContaining({ expectedWorkspaceId: "w1" }),
      { scope: "user", includeResources: true },
      60_000,
    );

    await user.click(screen.getByRole("button", { name: /Tools.*User/ }));
    expect(screen.getByRole("heading", { name: "Tools" })).toBeInTheDocument();
    const toolsRow = screen.getByRole("button", { name: /Tools.*User/ });
    expect(toolsRow).toHaveTextContent("1.0.0");
    expect(toolsRow).toHaveTextContent("2 resources");
    expect(toolsRow).toHaveTextContent("1 diagnostic");
    expect(screen.getByRole("button", { name: /Legacy theme/ })).toBeInTheDocument();

    await user.type(screen.getByLabelText("Search installed packages"), "legacy");

    expect(screen.getByRole("button", { name: /Legacy theme/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Tools" })).toBeInTheDocument();

    await user.clear(screen.getByLabelText("Search installed packages"));
    await user.type(screen.getByLabelText("Search installed packages"), "does-not-exist");
    expect(screen.getByText("No installed packages match these filters.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("button", { name: /Tools.*User/ })).toBeInTheDocument();
  });

  it("groups package resources with user preference controls and keeps runtime rows read-only", async () => {
    const user = userEvent.setup();
    render(<PackagesPage />);
    const installedTab = await screen.findByRole("button", { name: "Installed" });
    const resourcesTab = screen.getByRole("button", { name: "Resources" });
    expect(installedTab).toHaveAttribute("aria-pressed", "true");
    expect(installedTab).toHaveAttribute("data-state", "active");
    expect(resourcesTab).toHaveAttribute("aria-pressed", "false");
    expect(resourcesTab).toHaveAttribute("data-state", "inactive");

    await user.click(resourcesTab);
    expect(installedTab).toHaveAttribute("data-state", "inactive");
    expect(resourcesTab).toHaveAttribute("aria-pressed", "true");
    expect(resourcesTab).toHaveAttribute("data-state", "active");
    expect(screen.queryByRole("button", { name: "project" })).not.toBeInTheDocument();

    for (const name of ["All", "Extensions", "Skills", "Prompts", "Themes"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    expect(screen.getByLabelText("Resource source")).toHaveTextContent("Standalone");
    expect(screen.getByLabelText("Resource source")).toHaveTextContent("Runtime");
    expect(screen.getByRole("heading", { name: /Packages \(1\)/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Runtime \(1\)/ })).toBeInTheDocument();

    const toolsControls = screen.getByRole("group", { name: "Tools package" });
    expect(
      within(toolsControls).queryByRole("button", {
        name: "inherit all resources in Tools package",
      }),
    ).not.toBeInTheDocument();
    expect(
      within(toolsControls).getByRole("button", { name: "enabled all resources in Tools package" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      within(toolsControls).getByRole("button", {
        name: "disabled all resources in Tools package",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("Managed by extension")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Provided by Tools extension" })).toBeInTheDocument();
    const runtimeRow = screen.getByText("Dynamic review").closest("li");
    expect(runtimeRow).not.toBeNull();
    expect(within(runtimeRow!).queryByTitle("enabled in user scope")).not.toBeInTheDocument();

    await user.click(
      within(toolsControls).getByRole("button", {
        name: "disabled all resources in Tools package",
      }),
    );
    expect(screen.queryByRole("dialog", { name: "Confirm project resource change" })).toBeNull();
    await waitFor(() => {
      const mutations = request.mock.calls.filter(
        ([method]) => method === "resource.setPreferences",
      );
      expect(mutations).toHaveLength(1);
      expect(mutations[0]).toEqual([
        "resource.setPreferences",
        expect.anything(),
        {
          updates: [
            {
              resourceId: "resource:extension:tools",
              targetScope: "user",
              preference: "disabled",
            },
            { resourceId: "resource:skill:review", targetScope: "user", preference: "disabled" },
          ],
        },
        615_000,
      ]);
    });
    await user.click(screen.getByRole("button", { name: "Provided by Tools extension" }));
    expect(screen.getByLabelText("Search resources")).toHaveValue("Tools");
    expect(screen.getByRole("button", { name: "Extensions" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("controls all direct resources from the installed package detail", async () => {
    const user = userEvent.setup();
    render(<PackagesPage />);
    await user.click(await screen.findByRole("button", { name: /Tools.*User/ }));

    const toolsControls = screen.getByRole("group", { name: "Tools package" });
    expect(
      within(toolsControls).getByRole("button", { name: "enabled all resources in Tools package" }),
    ).toHaveAttribute("aria-pressed", "true");
    await user.click(
      within(toolsControls).getByRole("button", {
        name: "disabled all resources in Tools package",
      }),
    );

    await waitFor(() => {
      expect(request).toHaveBeenCalledWith(
        "resource.setPreferences",
        expect.anything(),
        {
          updates: [
            { resourceId: "resource:extension:tools", targetScope: "user", preference: "disabled" },
            { resourceId: "resource:skill:review", targetScope: "user", preference: "disabled" },
          ],
        },
        615_000,
      );
    });
  });

  it("uses the mutation snapshot when enabling a mixed package without a competing refresh", async () => {
    const extension = resource();
    const prompt = resource({
      id: "resource:prompt:create-goal",
      type: "prompt",
      name: "Create goal",
      path: "C:/agent/npm/tools/prompts/create-goal.md",
      relativePath: "prompts/create-goal.md",
      enabled: false,
      preferences: { user: "disabled", project: "inherit" },
    });
    currentSnapshot = snapshot({
      configured: [
        packageRecord({
          resourceCounts: {
            extensions: 1,
            skills: 0,
            prompts: 1,
            themes: 0,
            enabled: 1,
            disabled: 1,
          },
        }),
      ],
      resources: [extension, prompt],
      diagnostics: [],
    });
    const committedSnapshot: PackageSnapshot = {
      ...currentSnapshot,
      resources: [
        extension,
        { ...prompt, enabled: true, preferences: { user: "enabled", project: "inherit" } },
      ],
    };
    let listRequests = 0;
    let releaseMutation!: () => void;
    const mutationGate = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    request.mockImplementation(async (method: string) => {
      if (method === "package.list") {
        listRequests += 1;
        if (listRequests > 1) throw new Error("Service graph is busy");
        return envelope(method, currentSnapshot);
      }
      if (method === "resource.setPreferences") {
        await mutationGate;
        currentSnapshot = committedSnapshot;
        return envelope(method, mutationResult(committedSnapshot));
      }
      if (method === "package.checkUpdates") {
        return envelope(method, { supported: true, updates: [] });
      }
      throw new Error(`Unexpected method ${method}`);
    });
    useAppStore.getState().applyPackageSnapshot(currentSnapshot);

    const user = userEvent.setup();
    render(<PackagesPage />);
    await user.click(await screen.findByRole("button", { name: "Resources" }));
    const enable = screen.getByRole("button", {
      name: "enabled all resources in Tools package",
    });
    expect(enable).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("Mixed")).toBeInTheDocument();

    await user.click(enable);
    expect(enable).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Applying resource preferences");
    expect(
      screen.getByRole("button", {
        name: "enabled all resources in Tools package",
      }),
    ).toBeDisabled();
    expect(screen.getByTitle("Refresh packages")).toBeDisabled();
    releaseMutation();
    await waitFor(() => {
      expect(request).toHaveBeenCalledWith(
        "resource.setPreferences",
        expect.anything(),
        {
          updates: [
            {
              resourceId: prompt.id,
              targetScope: "user",
              preference: "enabled",
            },
          ],
        },
        615_000,
      );
      expect(
        screen.getByRole("button", {
          name: "enabled all resources in Tools package",
        }),
      ).not.toBeDisabled();
    });

    expect(listRequests).toBe(1);
    expect(
      screen.getByRole("button", {
        name: "enabled all resources in Tools package",
      }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText(/Refresh failed: Service graph is busy/)).not.toBeInTheDocument();
  });

  it("does not let an older package refresh replace a committed mutation snapshot", async () => {
    const extension = resource();
    const prompt = resource({
      id: "resource:prompt:create-goal",
      type: "prompt",
      name: "Create goal",
      path: "C:/agent/npm/tools/prompts/create-goal.md",
      relativePath: "prompts/create-goal.md",
      enabled: false,
      preferences: { user: "disabled", project: "inherit" },
    });
    const staleSnapshot = snapshot({
      configured: [
        packageRecord({
          resourceCounts: {
            extensions: 1,
            skills: 0,
            prompts: 1,
            themes: 0,
            enabled: 1,
            disabled: 1,
          },
        }),
      ],
      resources: [extension, prompt],
      diagnostics: [],
    });
    const committedSnapshot: PackageSnapshot = {
      ...staleSnapshot,
      revision: staleSnapshot.revision + 1,
      resources: [
        extension,
        { ...prompt, enabled: true, preferences: { user: "enabled", project: "inherit" } },
      ],
    };
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    request.mockImplementation(async (method: string) => {
      if (method === "package.list") {
        await refreshGate;
        return envelope(method, staleSnapshot);
      }
      if (method === "resource.setPreferences") {
        return envelope(method, mutationResult(committedSnapshot));
      }
      if (method === "package.checkUpdates") {
        return envelope(method, { supported: true, updates: [] });
      }
      throw new Error(`Unexpected method ${method}`);
    });
    useAppStore.getState().applyPackageSnapshot(staleSnapshot);

    const user = userEvent.setup();
    render(<PackagesPage />);
    await user.click(screen.getByRole("button", { name: "Resources" }));
    await user.click(
      screen.getByRole("button", {
        name: "enabled all resources in Tools package",
      }),
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", {
          name: "enabled all resources in Tools package",
        }),
      ).toHaveAttribute("aria-pressed", "true");
    });
    releaseRefresh();
    await waitFor(() => {
      expect(
        screen.getByRole("button", {
          name: "enabled all resources in Tools package",
        }),
      ).toHaveAttribute("aria-pressed", "true");
    });
    expect(useAppStore.getState().packages?.revision).toBe(committedSnapshot.revision);
  });

  it("makes the manage-resources owner filter visibly clearable", async () => {
    const user = userEvent.setup();
    render(<PackagesPage />);
    await user.click(await screen.findByRole("button", { name: /Tools.*User/ }));
    await user.click(screen.getByRole("button", { name: "Manage resources" }));

    expect(screen.getByLabelText("Resource owner")).toHaveValue("package:user:tools");
    const clearOwner = screen.getByRole("button", { name: "Clear owner filter" });
    expect(clearOwner).toBeVisible();
    await user.click(clearOwner);
    expect(screen.getByLabelText("Resource owner")).toHaveValue("");
  });

  it("opens a user package's resources without a project mode toggle", async () => {
    const user = userEvent.setup();
    render(<PackagesPage />);
    await user.click(await screen.findByRole("button", { name: /Legacy theme/ }));
    await user.click(screen.getByRole("button", { name: "Manage resources" }));

    expect(screen.getByLabelText("Resource owner")).toHaveValue("package:user:legacy-theme");
    expect(screen.queryByRole("button", { name: "project" })).not.toBeInTheDocument();
  });

  it("requires an install review and shows executable-code security context", async () => {
    const user = userEvent.setup();
    render(<PackagesPage />);
    await screen.findByLabelText("Package source");
    await user.type(screen.getByLabelText("Package source"), "npm:trusted-tools");
    await user.click(screen.getByRole("button", { name: "Install…" }));

    expect(screen.getByRole("dialog", { name: "Review package install" })).toBeInTheDocument();
    expect(screen.getByText(/dependency lifecycle scripts/i)).toBeInTheDocument();
    expect(screen.getByText(/current-user permissions/i)).toBeInTheDocument();
    expect(screen.getByText(/Skills and Prompts may direct Agent actions/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Install package" }));
    await waitFor(() => {
      expect(request).toHaveBeenCalledWith(
        "package.install",
        expect.anything(),
        { source: "npm:trusted-tools", scope: "user" },
        615_000,
      );
    });
  });

  it("requires a risk review before updating executable code and instructions", async () => {
    const user = userEvent.setup();
    render(<PackagesPage />);
    await user.click(await screen.findByRole("button", { name: /Tools.*User/ }));
    await user.click(screen.getByRole("button", { name: "Update" }));

    expect(screen.getByRole("dialog", { name: "Review package update" })).toBeInTheDocument();
    expect(screen.getByText(/executable code and Agent instructions/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update package" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Review package update" })).not.toBeInTheDocument();
  });

  it("disables Update all when a completed check reports no updates", async () => {
    const user = userEvent.setup();
    render(<PackagesPage />);
    await screen.findByRole("button", { name: /Tools.*User/ });
    const updateAll = screen.getByRole("button", { name: "Update all packages" });
    const updateActions = updateAll.closest("[data-package-update-actions]");
    expect(updateAll).toBeEnabled();
    expect(updateActions?.previousElementSibling).toContainElement(
      screen.getByLabelText("Package source"),
    );
    expect(updateActions).not.toHaveClass("justify-end");

    await user.click(screen.getByRole("button", { name: "Check" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Update all packages" })).toBeDisabled(),
    );
  });

  it("shows a human progress label and can be dismissed", async () => {
    const user = userEvent.setup();
    useAppStore.getState().setPackageProgress({
      operationId: "op-9",
      action: "install",
      source: "npm:tools",
      message: "Installing package",
      type: "progress",
      lastEventAt: Date.now(),
    });
    try {
      render(<PackagesPage />);

      expect(await screen.findByText("Working…")).toBeInTheDocument();
      expect(screen.queryByText("progress")).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Dismiss package progress" }));
      expect(screen.queryByText("Working…")).not.toBeInTheDocument();
    } finally {
      useAppStore.getState().setPackageProgress(null);
    }
  });

  it("requires a danger review before removing a package", async () => {
    const user = userEvent.setup();
    render(<PackagesPage />);
    await user.click(await screen.findByRole("button", { name: /Tools.*User/ }));
    await user.click(screen.getByRole("button", { name: "Remove" }));

    const dialog = screen.getByRole("dialog", { name: "Remove package" });
    expect(dialog).toHaveTextContent("Removal cannot be undone");
    expect(dialog).toHaveTextContent("Tools");
    await user.click(within(dialog).getByRole("button", { name: "Remove package" }));
    await waitFor(() => {
      expect(request).toHaveBeenCalledWith(
        "package.remove",
        expect.anything(),
        { packageId: "package:user:tools" },
        615_000,
      );
    });
  });

  it("renders a retryable loading error when the authoritative snapshot fails", async () => {
    request.mockRejectedValueOnce(new Error("host offline"));
    useAppStore.getState().applyPackageSnapshot(null);
    const user = userEvent.setup();
    render(<PackagesPage />);

    expect(await screen.findByText("Packages could not be loaded")).toBeInTheDocument();
    expect(screen.getByText("host offline")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  });

  it("recovers when remount refresh races an active package mutation", async () => {
    let listRequests = 0;
    request.mockImplementation(async (method: string) => {
      if (method === "package.list") {
        listRequests += 1;
        return listRequests === 2
          ? serviceGraphBusyEnvelope(method)
          : envelope(method, currentSnapshot);
      }
      if (method === "package.checkUpdates") {
        return envelope(method, { supported: true, updates: [] });
      }
      throw new Error(`Unexpected method ${method}`);
    });

    const first = render(<PackagesPage />);
    await waitFor(() => expect(listRequests).toBe(1));
    first.unmount();

    useAppStore.getState().setPackageProgress({
      operationId: "install-in-flight",
      type: "progress",
      action: "install",
      source: "npm:tools",
      lastEventAt: Date.now(),
    });
    try {
      render(<PackagesPage />);
      await waitFor(() => expect(listRequests).toBe(3));
      expect(screen.queryByText("Service graph is busy")).not.toBeInTheDocument();
    } finally {
      useAppStore.getState().setPackageProgress(null);
    }
  });

  it("renders the initial loading state while the authoritative snapshot is pending", async () => {
    request.mockImplementationOnce(() => new Promise(() => {}));
    useAppStore.getState().applyPackageSnapshot(null);
    render(<PackagesPage />);
    expect(await screen.findByText("Loading installed packages")).toBeInTheDocument();
  });

  it("disables package mutations while an authoritative mutation is running", async () => {
    currentSnapshot = snapshot({
      mutation: { operationId: "running-op", status: "running", reconcileRequired: false },
    });
    useAppStore.getState().applyPackageSnapshot(currentSnapshot);
    const user = userEvent.setup();
    render(<PackagesPage />);

    expect(await screen.findByRole("button", { name: "Update all packages" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Resources" }));
    const toolsControls = screen.getByRole("group", { name: "Tools package" });
    expect(
      within(toolsControls).getByRole("button", { name: "enabled all resources in Tools package" }),
    ).toBeDisabled();
    expect(
      within(toolsControls).getByRole("button", {
        name: "disabled all resources in Tools package",
      }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Enable all shown" })).toBeDisabled();
  });

  it("keeps a package bundled under a type filter and mutates all cross-type members", async () => {
    const user = userEvent.setup();
    render(<PackagesPage />);
    await user.click(await screen.findByRole("button", { name: "Resources" }));
    await user.click(screen.getByRole("button", { name: "Extensions" }));

    expect(screen.getByRole("heading", { name: /Packages \(1\)/ })).toBeInTheDocument();
    expect(screen.getAllByRole("group", { name: "Tools package" })).toHaveLength(1);
    const packageRow = screen.getByRole("group", { name: "Tools package" }).closest("li");
    expect(packageRow).not.toBeNull();
    await user.click(within(packageRow!).getByText("Show package resources"));
    expect(within(packageRow!).getByText("Tools extension")).toBeInTheDocument();
    expect(within(packageRow!).getByText("Review skill")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Disable all shown" }));
    await waitFor(() => {
      const mutations = request.mock.calls.filter(
        ([method]) => method === "resource.setPreferences",
      );
      expect(mutations).toHaveLength(1);
      expect(mutations[0]).toEqual([
        "resource.setPreferences",
        expect.anything(),
        {
          updates: [
            { resourceId: "resource:extension:tools", targetScope: "user", preference: "disabled" },
            { resourceId: "resource:skill:review", targetScope: "user", preference: "disabled" },
          ],
        },
        615_000,
      ]);
    });
  });

  it("renders the installed empty state from an authoritative snapshot", async () => {
    currentSnapshot = snapshot({ configured: [], resources: [], diagnostics: [] });
    useAppStore.getState().applyPackageSnapshot(currentSnapshot);
    render(<PackagesPage />);
    expect(await screen.findByText("No packages are installed yet.")).toBeInTheDocument();
  });

  it("distinguishes an empty resource inventory from filtered-out resources", async () => {
    const user = userEvent.setup();
    render(<PackagesPage />);
    await user.click(await screen.findByRole("button", { name: "Resources" }));
    await user.type(screen.getByLabelText("Search resources"), "nothing-can-match-this");
    expect(screen.getByText("No resources match these filters.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText("Tools extension")).toBeInTheDocument();

    cleanup();
    currentSnapshot = snapshot({ resources: [] });
    useAppStore.getState().applyPackageSnapshot(currentSnapshot);
    render(<PackagesPage />);
    await user.click(await screen.findByRole("button", { name: "Resources" }));
    expect(screen.getByText("No resources are available yet.")).toBeInTheDocument();
  });

  it("opens the hardcoded catalog URL with the Tauri shell", async () => {
    const user = userEvent.setup();
    render(<PackagesPage />);
    await user.click(await screen.findByRole("button", { name: /pi.dev catalog/ }));
    expect(shellOpen).toHaveBeenCalledWith("https://pi.dev/packages");
  });
});

describe("PackagesPage market tab", () => {
  let request: MockInstance<typeof hostClient.request>;
  let catalogResult: () => HostResponseEnvelope;

  function catalogEnvelope(): HostResponseEnvelope {
    return envelope("package.catalog", {
      generatedAt: 1,
      fromCache: false,
      items: [
        {
          name: "tools",
          description: "Already installed helper",
          author: "tester",
          types: ["extension"],
          downloadsPerMonth: 43_100,
          publishedAt: 1_784_623_367_738,
          npmUrl: "https://www.npmjs.com/package/tools",
          searchText: "tools already installed helper",
          installSource: "npm:tools",
          pageUrl: "https://pi.dev/packages/tools",
        },
        {
          name: "pi-web-access",
          description: "Web search for Pi",
          author: "nicopreme",
          types: ["extension", "skill"],
          downloadsPerMonth: 222_000,
          publishedAt: 1_785_450_190_149,
          searchText: "pi-web-access web search",
          installSource: "npm:pi-web-access",
          pageUrl: "https://pi.dev/packages/pi-web-access",
        },
      ],
    });
  }

  beforeEach(() => {
    shellOpen.mockReset();
    catalogResult = catalogEnvelope;
    useAppStore.getState().setHost(null);
    useAppStore.getState().setWorkspace(null);
    useAppStore.getState().applyPackageSnapshot(null);
    useAppStore.getState().setHost(host());
    useAppStore.getState().setWorkspace(workspace());
    useAppStore.getState().applyPackageSnapshot(snapshot());
    request = vi.spyOn(hostClient, "request").mockImplementation(async (method: string) => {
      if (method === "package.list") return envelope(method, snapshot());
      if (method === "package.catalog") return catalogResult();
      throw new Error(`Unexpected method ${method}`);
    });
  });

  afterEach(() => {
    request.mockRestore();
    cleanup();
  });

  it("loads the catalog lazily and marks installed packages", async () => {
    const user = userEvent.setup();
    render(<PackagesPage />);
    expect(request).not.toHaveBeenCalledWith(
      "package.catalog",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );

    await user.click(await screen.findByRole("button", { name: "Market" }));
    expect(await screen.findByText("pi-web-access")).toBeInTheDocument();
    expect(request).toHaveBeenCalledWith(
      "package.catalog",
      { expectedHostInstanceId: "h1" },
      {},
      30_000,
    );

    const installedCard = screen.getByText("tools").closest("[data-market-card]");
    expect(installedCard).not.toBeNull();
    expect(within(installedCard as HTMLElement).getByText("Installed")).toBeInTheDocument();
    expect(screen.getByText("222K/mo")).toBeInTheDocument();
  });

  it("starts the existing install review from a market card", async () => {
    const user = userEvent.setup();
    render(<PackagesPage />);
    await user.click(await screen.findByRole("button", { name: "Market" }));

    const card = (await screen.findByText("pi-web-access")).closest("[data-market-card]");
    await user.click(within(card as HTMLElement).getByRole("button", { name: /Install/ }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("npm:pi-web-access")).toBeInTheDocument();
  });

  it("shows a recoverable error with a browser fallback", async () => {
    catalogResult = () =>
      ({
        ...catalogEnvelope(),
        ok: false,
        result: undefined,
        error: { code: "CATALOG_UNAVAILABLE", message: "offline", retryable: true },
      }) as unknown as HostResponseEnvelope;
    const user = userEvent.setup();
    render(<PackagesPage />);
    await user.click(await screen.findByRole("button", { name: "Market" }));

    expect(await screen.findByText("Couldn't load the package catalog")).toBeInTheDocument();
    expect(screen.getByText("offline")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Open pi.dev/ }));
    expect(shellOpen).toHaveBeenCalledWith("https://pi.dev/packages");
  });
});
