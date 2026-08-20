import {
  DefaultResourceLoader,
  loadProjectContextFiles,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { withoutImplicitPackageInstall } from "./offline-package-resolution.js";
import { logger } from "./logger.js";

type ExtensionBundle = ReturnType<DefaultResourceLoader["getExtensions"]>;

type UserResourceSnapshot = {
  extensions: ExtensionBundle;
  skills: ReturnType<DefaultResourceLoader["getSkills"]>;
  prompts: ReturnType<DefaultResourceLoader["getPrompts"]>;
  themes: ReturnType<DefaultResourceLoader["getThemes"]>;
};

type ExtensionHolder = { current: ExtensionBundle };

export type ExtensionRefreshTransaction = {
  apply(): void;
  commit(): void;
  rollback(): void;
  settleFailure(args: {
    session?: { extensionRunner?: unknown } | null;
    runnerBefore?: unknown;
    loader?: DefaultResourceLoader | null;
  }): Promise<void>;
};

/**
 * Process-wide user/global resources. SDK extension caches are cwd-scoped, so
 * every Workspace `reload()` would otherwise re-jiti the same global packages.
 * Warm skills/prompts/themes against `agentDir` without running Extension
 * factories, then mint a fresh Extension runtime per Workspace/Session so
 * disposing one AgentSession cannot stale the next.
 */
export class UserResourceCache {
  private snapshot: UserResourceSnapshot | null = null;
  private loading: Promise<UserResourceSnapshot> | null = null;
  private reloadCount = 0;
  private readonly bindings = new WeakMap<DefaultResourceLoader, ExtensionHolder>();

  constructor(private readonly agentDir: string) {}

  private loaderOptions<T extends { cwd: string; agentDir: string }>(options: T): T {
    return options;
  }

  get fullReloadCount(): number {
    return this.reloadCount;
  }

  async ensure(): Promise<UserResourceSnapshot> {
    if (this.snapshot) return this.snapshot;
    if (this.loading) return this.loading;
    this.loading = this.reload();
    try {
      this.snapshot = await this.loading;
      return this.snapshot;
    } finally {
      this.loading = null;
    }
  }

  async invalidate(): Promise<UserResourceSnapshot> {
    this.snapshot = null;
    return this.ensure();
  }

  /**
   * Mint a replacement Extension runtime without publishing it. Callers must
   * `apply()` before `AgentSession.reload()` so the session sees the new
   * bundle, then `commit()` after a successful reload or `rollback()` if
   * reload fails. The previous runtime stays active until `commit()` so
   * `session_shutdown` can still call `pi.*`.
   */
  async prepareLoaderExtensionRefresh(
    loader: DefaultResourceLoader,
  ): Promise<ExtensionRefreshTransaction | null> {
    const holder = this.bindings.get(loader);
    if (!holder) return null;
    const previous = holder.current;
    // Do not reload `loader` here: its override still exposes the previous
    // bundle, and the SDK stats those just-deleted git/npm entry files.
    await this.bustExtensionModuleCache();
    const next = await this.instantiateExtensions();
    let phase: "prepared" | "applied" | "committed" | "rolledBack" = "prepared";
    const commit = () => {
      if (phase === "committed" || phase === "rolledBack") return;
      if (phase === "prepared") holder.current = next;
      phase = "committed";
      this.disposeBundle(previous, "user-resource-refresh");
    };
    const rollback = () => {
      if (phase === "committed" || phase === "rolledBack") return;
      if (phase === "applied") holder.current = previous;
      phase = "rolledBack";
      this.disposeBundle(next, "user-resource-refresh-rollback");
    };
    return {
      apply: () => {
        if (phase !== "prepared") return;
        holder.current = next;
        phase = "applied";
      },
      commit,
      rollback,
      settleFailure: async (args) => {
        const adopted = Boolean(args.session && args.session.extensionRunner !== args.runnerBefore);
        if (adopted) {
          commit();
          return;
        }
        rollback();
        if (!args.loader) return;
        try {
          await withoutImplicitPackageInstall(() => args.loader!.reload());
        } catch {
          /* best-effort restore of the loader's cached getExtensions() */
        }
      },
    };
  }

  async createWorkspaceLoader(args: {
    cwd: string;
    settingsManager: SettingsManager;
  }): Promise<DefaultResourceLoader> {
    await this.ensure();
    const holder: ExtensionHolder = { current: await this.instantiateExtensions() };
    const agentsFiles = loadProjectContextFiles({
      cwd: args.cwd,
      agentDir: this.agentDir,
    });
    // Keep loader cwd on agentDir so reload() does not change the SDK's
    // cwd-keyed factory cache. Workspace AGENTS.md is injected explicitly.
    const loader = new DefaultResourceLoader(
      this.loaderOptions({
        cwd: this.agentDir,
        agentDir: this.agentDir,
        settingsManager: args.settingsManager,
        noExtensions: true,
        extensionsOverride: () => holder.current,
        skillsOverride: () => this.requireSnapshot().skills,
        promptsOverride: () => this.requireSnapshot().prompts,
        themesOverride: () => this.requireSnapshot().themes,
        agentsFilesOverride: () => ({ agentsFiles }),
      }),
    );
    this.bindings.set(loader, holder);
    const startedAt = Date.now();
    await withoutImplicitPackageInstall(() => loader.reload());
    logger.info("workspace resource loader applied user cache", {
      cwd: args.cwd,
      totalMs: Date.now() - startedAt,
      userReloads: this.reloadCount,
      extensions: holder.current.extensions.length,
    });
    return loader;
  }

  /**
   * A throwaway loader's second reload is what clears the SDK's cwd-keyed
   * extension module cache. The workspace loader cannot do that first: it would
   * still publish the previous bundle and stat removed package files.
   */
  private async bustExtensionModuleCache(): Promise<void> {
    const settingsManager = SettingsManager.create(this.agentDir, this.agentDir, {
      projectTrusted: false,
    });
    const loader = new DefaultResourceLoader(
      this.loaderOptions({
        cwd: this.agentDir,
        agentDir: this.agentDir,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      }),
    );
    await withoutImplicitPackageInstall(async () => {
      await loader.reload();
      await loader.reload();
    });
  }

  /**
   * Re-run cached factories against `agentDir` so each Session gets its own
   * runtime. jiti does not run again while the SDK cwd cache stays on agentDir.
   */
  private async instantiateExtensions(): Promise<ExtensionBundle> {
    const settingsManager = SettingsManager.create(this.agentDir, this.agentDir, {
      projectTrusted: false,
    });
    const loader = new DefaultResourceLoader(
      this.loaderOptions({
        cwd: this.agentDir,
        agentDir: this.agentDir,
        settingsManager,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      }),
    );
    const startedAt = Date.now();
    await withoutImplicitPackageInstall(() => loader.reload());
    const extensions = loader.getExtensions();
    logger.info("user extensions instantiated", {
      totalMs: Date.now() - startedAt,
      extensions: extensions.extensions.length,
    });
    return extensions;
  }

  private requireSnapshot(): UserResourceSnapshot {
    if (!this.snapshot) throw new Error("User resource cache is empty");
    return this.snapshot;
  }

  private disposeBundle(bundle: ExtensionBundle, reason: string): void {
    try {
      bundle.runtime.invalidate(reason);
    } catch {
      /* already stale or missing runtime */
    }
  }

  private async reload(): Promise<UserResourceSnapshot> {
    const startedAt = Date.now();
    const settingsManager = SettingsManager.create(this.agentDir, this.agentDir, {
      projectTrusted: false,
    });
    // Warm skills/prompts/themes only. Running Extension factories here would
    // create a runtime that no AgentSession owns and that never receives
    // session_shutdown.
    const loader = new DefaultResourceLoader(
      this.loaderOptions({
        cwd: this.agentDir,
        agentDir: this.agentDir,
        settingsManager,
        noExtensions: true,
      }),
    );
    await withoutImplicitPackageInstall(() => loader.reload());
    this.reloadCount += 1;
    const extensions = loader.getExtensions();
    this.disposeBundle(extensions, "user-resource-cache-warmup");
    const snapshot = {
      extensions,
      skills: loader.getSkills(),
      prompts: loader.getPrompts(),
      themes: loader.getThemes(),
    };
    logger.info("user resource cache loaded", {
      totalMs: Date.now() - startedAt,
      reloadCount: this.reloadCount,
      extensions: snapshot.extensions.extensions.length,
    });
    return snapshot;
  }
}
