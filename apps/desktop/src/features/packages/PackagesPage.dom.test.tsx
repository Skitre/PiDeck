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
    sdkVersion: "0.80.7",
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
    scope: "all",
    configured: [packageRecord(), packageRecord({
      id: "package:project:theme",
      identity: "local:theme",
      source: "./theme",
      kind: "local",
      scope: "project",
      displayName: "Workspace theme",
      projectOverride: { source: ".pi/settings.json", overrideCount: 2 },
      resourceCounts: {
        extensions: 0,
        skills: 0,
        prompts: 0,
        themes: 1,
        enabled: 1,
        disabled: 0,
      },
    }), packageRecord({
      id: "package:user:legacy-theme",
      identity: "local:legacy-theme",
      source: "./legacy-theme",
      kind: "local",
      scope: "user",
      displayName: "Legacy theme",
      effective: false,
      shadowedByPackageId: "package:project:theme",
      resourceCounts: null,
      resourceCountsState: "unknownShadowed",
    })],
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
      resource({
        id: "resource:project:prompt",
        type: "prompt",
        name: "Project prompt",
        path: "C:/workspace/.pi/prompt.md",
        scope: "project",
        origin: "top-level",
        packageId: undefined,
      }),
    ],
    updateCheck: { supported: true },
    diagnostics: [{ severity: "warning", source: "package:user:tools", message: "Optional dependency missing" }],
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
      if (method === "package.install" || method === "package.update" || method === "package.updateAll" || method === "resource.setPreference" || method === "resource.setPreferences") {
        return envelope(method, mutationResult(currentSnapshot));
      }
      if (method === "package.checkUpdates") return envelope(method, { supported: true, updates: [] });
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
      { scope: "all", includeResources: true },
      60_000,
    );

    await user.click(screen.getByRole("button", { name: /Tools.*User/ }));
    expect(screen.getByRole("heading", { name: "Tools" })).toBeInTheDocument();
    const toolsRow = screen.getByRole("button", { name: /Tools.*User/ });
    expect(toolsRow).toHaveTextContent("1.0.0");
    expect(toolsRow).toHaveTextContent("2 resources");
    expect(toolsRow).toHaveTextContent("1 diagnostic");
    expect(screen.getByRole("button", { name: /Legacy theme.*Replaced by project/ })).toBeInTheDocument();

    await user.type(screen.getByLabelText("Search installed packages"), "workspace");
    await user.selectOptions(screen.getByLabelText("Package scope"), "project");
    await user.selectOptions(screen.getByLabelText("Contained resource type"), "theme");

    expect(screen.getByRole("button", { name: /Workspace theme.*Project/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Workspace theme.*Workspace overrides/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Tools" })).toBeInTheDocument();

    await user.clear(screen.getByLabelText("Search installed packages"));
    await user.type(screen.getByLabelText("Search installed packages"), "does-not-exist");
    expect(screen.getByText("No installed packages match these filters.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("button", { name: /Tools.*User/ })).toBeInTheDocument();
  });

  it("groups package resources with project tri-state controls and keeps runtime rows read-only", async () => {
    const user = userEvent.setup();
    render(<PackagesPage />);
    await screen.findByRole("tab", { name: "Resources" });
    await user.click(screen.getByRole("tab", { name: "Resources" }));
    await user.click(screen.getByRole("button", { name: "project" }));

    for (const name of ["All", "Extensions", "Skills", "Prompts", "Themes"]) {
      expect(screen.getByRole("tab", { name })).toBeInTheDocument();
    }
    expect(screen.getByLabelText("Resource source")).toHaveTextContent("Standalone");
    expect(screen.getByLabelText("Resource source")).toHaveTextContent("Runtime");
    expect(screen.getByRole("heading", { name: /Packages \(1\)/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Runtime \(1\)/ })).toBeInTheDocument();

    const toolsControls = screen.getByRole("group", { name: "Tools package" });
    expect(within(toolsControls).getByRole("button", { name: "inherit all resources in Tools package" })).toHaveAttribute("aria-pressed", "true");
    expect(within(toolsControls).getByRole("button", { name: "enabled all resources in Tools package" })).toBeInTheDocument();
    expect(within(toolsControls).getByRole("button", { name: "disabled all resources in Tools package" })).toBeInTheDocument();
    expect(screen.getByText("Managed by extension")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Provided by Tools extension" })).toBeInTheDocument();
    const runtimeRow = screen.getByText("Dynamic review").closest("li");
    expect(runtimeRow).not.toBeNull();
    expect(within(runtimeRow!).queryByTitle("enabled in project scope")).not.toBeInTheDocument();

    await user.click(within(toolsControls).getByRole("button", { name: "disabled all resources in Tools package" }));
    expect(screen.getByRole("dialog", { name: "Confirm project resource change" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Apply change" }));
    await waitFor(() => {
      const mutations = request.mock.calls.filter(([method]) => method === "resource.setPreferences");
      expect(mutations).toHaveLength(1);
      expect(mutations[0]).toEqual([
        "resource.setPreferences",
        expect.anything(),
        {
          updates: [
            { resourceId: "resource:extension:tools", targetScope: "project", preference: "disabled" },
            { resourceId: "resource:skill:review", targetScope: "project", preference: "disabled" },
          ],
        },
        60_000,
      ]);
    });
    await user.click(screen.getByRole("button", { name: "Provided by Tools extension" }));
    expect(screen.getByLabelText("Search resources")).toHaveValue("Tools");
    expect(screen.getByRole("tab", { name: "Extensions" })).toHaveAttribute("aria-selected", "true");
  });

  it("controls all direct resources from the installed package detail", async () => {
    const user = userEvent.setup();
    render(<PackagesPage />);
    await user.click(await screen.findByRole("button", { name: /Tools.*User/ }));

    const toolsControls = screen.getByRole("group", { name: "Tools package" });
    expect(within(toolsControls).getByRole("button", { name: "enabled all resources in Tools package" })).toHaveAttribute("aria-pressed", "true");
    await user.click(within(toolsControls).getByRole("button", { name: "disabled all resources in Tools package" }));

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
        60_000,
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
      configured: [packageRecord({
        resourceCounts: {
          extensions: 1,
          skills: 0,
          prompts: 1,
          themes: 0,
          enabled: 1,
          disabled: 1,
        },
      })],
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
    await user.click(await screen.findByRole("tab", { name: "Resources" }));
    const enable = screen.getByRole("button", {
      name: "enabled all resources in Tools package",
    });
    expect(enable).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("Mixed")).toBeInTheDocument();

    await user.click(enable);
    expect(enable).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Applying resource preferences");
    expect(screen.getByRole("button", {
      name: "enabled all resources in Tools package",
    })).toBeDisabled();
    expect(screen.getByTitle("Refresh packages")).toBeDisabled();
    releaseMutation();
    await waitFor(() => {
      expect(request).toHaveBeenCalledWith(
        "resource.setPreferences",
        expect.anything(),
        {
          updates: [{
            resourceId: prompt.id,
            targetScope: "user",
            preference: "enabled",
          }],
        },
        60_000,
      );
      expect(screen.getByRole("button", {
        name: "enabled all resources in Tools package",
      })).not.toBeDisabled();
    });

    expect(listRequests).toBe(1);
    expect(screen.getByRole("button", {
      name: "enabled all resources in Tools package",
    })).toHaveAttribute("aria-pressed", "true");
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
      configured: [packageRecord({
        resourceCounts: {
          extensions: 1,
          skills: 0,
          prompts: 1,
          themes: 0,
          enabled: 1,
          disabled: 1,
        },
      })],
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
    await user.click(screen.getByRole("tab", { name: "Resources" }));
    await user.click(screen.getByRole("button", {
      name: "enabled all resources in Tools package",
    }));

    await waitFor(() => {
      expect(screen.getByRole("button", {
        name: "enabled all resources in Tools package",
      })).toHaveAttribute("aria-pressed", "true");
    });
    releaseRefresh();
    await waitFor(() => {
      expect(screen.getByRole("button", {
        name: "enabled all resources in Tools package",
      })).toHaveAttribute("aria-pressed", "true");
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

  it("opens a replaced user package's resources in User mode", async () => {
    const user = userEvent.setup();
    render(<PackagesPage />);
    await user.click(await screen.findByRole("button", { name: /Legacy theme.*Replaced by project/ }));
    await user.click(screen.getByRole("button", { name: "Manage resources" }));

    expect(screen.getByLabelText("Resource owner")).toHaveValue("package:user:legacy-theme");
    expect(screen.getByRole("button", { name: "user" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "project" })).toHaveAttribute("aria-pressed", "false");
  });

  it("requires an install review and shows executable-code security context", async () => {
    const user = userEvent.setup();
    render(<PackagesPage />);
    await screen.findByLabelText("Package source");
    await user.type(screen.getByLabelText("Package source"), "npm:trusted-tools");
    await user.click(screen.getByRole("button", { name: "Review" }));

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
        600_000,
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

    expect(await screen.findByRole("button", { name: "Update all" })).toBeDisabled();
    await user.click(screen.getByRole("tab", { name: "Resources" }));
    const toolsControls = screen.getByRole("group", { name: "Tools package" });
    expect(within(toolsControls).getByRole("button", { name: "enabled all resources in Tools package" })).toBeDisabled();
    expect(within(toolsControls).getByRole("button", { name: "disabled all resources in Tools package" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Enable" })).toBeDisabled();
  });

  it("keeps a package bundled under a type filter and mutates all cross-type members", async () => {
    const user = userEvent.setup();
    render(<PackagesPage />);
    await user.click(await screen.findByRole("tab", { name: "Resources" }));
    await user.click(screen.getByRole("tab", { name: "Extensions" }));

    expect(screen.getByRole("heading", { name: /Packages \(1\)/ })).toBeInTheDocument();
    expect(screen.getAllByRole("group", { name: "Tools package" })).toHaveLength(1);
    const packageRow = screen.getByRole("group", { name: "Tools package" }).closest("li");
    expect(packageRow).not.toBeNull();
    await user.click(within(packageRow!).getByText("Show package resources"));
    expect(within(packageRow!).getByText("Tools extension")).toBeInTheDocument();
    expect(within(packageRow!).getByText("Review skill")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Disable" }));
    await waitFor(() => {
      const mutations = request.mock.calls.filter(([method]) => method === "resource.setPreferences");
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
        60_000,
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
    await user.click(await screen.findByRole("tab", { name: "Resources" }));
    await user.type(screen.getByLabelText("Search resources"), "nothing-can-match-this");
    expect(screen.getByText("No resources match these filters.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText("Tools extension")).toBeInTheDocument();

    cleanup();
    currentSnapshot = snapshot({ resources: [] });
    useAppStore.getState().applyPackageSnapshot(currentSnapshot);
    render(<PackagesPage />);
    await user.click(await screen.findByRole("tab", { name: "Resources" }));
    expect(screen.getByText("No resources are available yet.")).toBeInTheDocument();
  });

  it("opens the hardcoded catalog URL with the Tauri shell", async () => {
    const user = userEvent.setup();
    render(<PackagesPage />);
    await user.click(await screen.findByRole("button", { name: /pi.dev catalog/ }));
    expect(shellOpen).toHaveBeenCalledWith("https://pi.dev/packages");
  });
});
