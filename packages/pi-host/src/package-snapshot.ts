import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DefaultPackageManager,
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ResolvedResource } from "@earendil-works/pi-coding-agent";
import type {
  PackageDiagnostic,
  PackageRecord,
  PackageSnapshot,
  ResourceRecord,
} from "@pideck/protocol";
import {
  matchesResourcePattern,
  resourceTypeToSettingsKey,
  toObjectSource,
  toPosixPath,
  type PackageSource,
} from "./package-filters.js";

type ResourceType = ResourceRecord["type"];
type ResourceScope = ResourceRecord["scope"];

export type ResourceIdMetadata = {
  type: ResourceType;
  scope: ResourceScope;
  path: string;
  baseDir?: string;
  relativePath: string;
  origin: ResourceRecord["origin"];
  packageSource?: string;
  projectOverrideSource?: string;
  packageScope?: "user" | "project";
  packageIdentity?: string;
  configurableScopes: Array<"user" | "project">;
};

export type ResourceIdMap = Map<string, ResourceIdMetadata>;

type SourceInfo = {
  path: string;
  source: string;
  scope: ResourceScope;
  origin: "package" | "top-level";
  baseDir?: string;
};

type LoaderResource = {
  type: ResourceType;
  path: string;
  name: string;
  description?: string;
  sourceInfo: SourceInfo;
  manualOnly?: boolean;
};

function stableId(prefix: string, ...parts: string[]): string {
  const hash = createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);
  return `${prefix}_${hash}`;
}

export type PackageIdentityContext = {
  installedPath?: string;
  scope?: "user" | "project";
  cwd?: string;
  agentDir?: string;
};

function normalizeLocalIdentity(source: string, context: PackageIdentityContext): string {
  const baseDir = context.scope === "project"
    ? join(context.cwd ?? process.cwd(), ".pi")
    : context.agentDir ?? process.cwd();
  let localSource = source.trim();
  const home = process.env.HOME || homedir();
  if (localSource === "~") {
    localSource = home;
  } else if (
    localSource.startsWith("~/") ||
    (process.platform === "win32" && localSource.startsWith("~\\"))
  ) {
    localSource = join(home, localSource.slice(2));
  }
  if (/^file:\/\//.test(localSource)) {
    try {
      localSource = fileURLToPath(localSource);
    } catch {
      // Keep invalid file URLs as literal local paths, matching resolvePath fallback behavior.
    }
  }
  const candidate = context.installedPath ?? resolve(baseDir, localSource);
  const normalized = toPosixPath(resolve(candidate)).replace(/\/$/, "");
  return `local:${process.platform === "win32" ? normalized.toLocaleLowerCase() : normalized}`;
}

/** Mirrors the SDK package identity rules while keeping the value public and stable. */
export function normalizePackageIdentity(
  source: string,
  installedPathOrContext?: string | PackageIdentityContext,
): { identity: string; kind: PackageRecord["kind"] } {
  const context = typeof installedPathOrContext === "string"
    ? { installedPath: installedPathOrContext }
    : installedPathOrContext ?? {};
  const trimmed = source.trim();
  if (trimmed.startsWith("npm:")) {
    const spec = trimmed.slice(4);
    const match = spec.match(/^(@[^/]+\/[^@]+|[^@]+)(?:@.+)?$/);
    return { identity: `npm:${match?.[1] ?? spec}`, kind: "npm" };
  }

  const gitPrefixed = trimmed.startsWith("git:");
  const gitCandidate = gitPrefixed ? trimmed.slice(4).trim() : trimmed;
  const scp = gitCandidate.match(/^(?:git@)?([^/:]+):(.+)$/);
  let gitHost: string | undefined;
  let gitPath: string | undefined;
  if (gitPrefixed && scp && (gitCandidate.startsWith("git@") || scp[1]?.includes("."))) {
    gitHost = scp[1];
    gitPath = scp[2];
  } else {
    try {
      const url = new URL(gitCandidate);
      if (["git:", "ssh:", "http:", "https:"].includes(url.protocol)) {
        gitHost = url.hostname;
        gitPath = url.pathname;
      }
    } catch {
      // Local and npm shorthand sources are handled below.
    }
  }
  if (!gitHost && gitPrefixed) {
    const shorthand = gitCandidate.replace(/#.*$/, "").match(/^([^/]+)\/(.+)$/);
    if (shorthand) {
      const hostAlias = shorthand[1]!.toLocaleLowerCase();
      if (hostAlias === "github" || hostAlias === "gitlab" || hostAlias === "bitbucket") {
        gitHost = `${hostAlias}.com`;
        gitPath = shorthand[2];
      } else if (hostAlias.includes(".")) {
        gitHost = shorthand[1];
        gitPath = shorthand[2];
      } else if (!hostAlias.includes(":")) {
        // Pi treats git:owner/repo as the historical GitHub shorthand.
        gitHost = "github.com";
        gitPath = `${shorthand[1]}/${shorthand[2]}`;
      }
    }
    const alias = gitCandidate.replace(/#.*$/, "").match(/^(github|gitlab|bitbucket):(.+)$/i);
    if (!gitHost && alias) {
      gitHost = `${alias[1]!.toLocaleLowerCase()}.com`;
      gitPath = alias[2];
    }
  }
  if (gitHost && gitPath) {
    const path = gitPath
      .replace(/^\//, "")
      .replace(/#.*$/, "")
      .replace(/@[^/]+$/, "")
      .replace(/\.git$/, "");
    return { identity: `git:${gitHost.toLocaleLowerCase()}/${path}`, kind: "git" };
  }

  return { identity: normalizeLocalIdentity(trimmed, context), kind: "local" };
}

function packageId(identity: string, scope: "user" | "project"): string {
  return stableId(`pkg_${scope}`, identity);
}

function resourceId(type: ResourceType, path: string, owner: string): string {
  const normalized = toPosixPath(resolve(path));
  return stableId("res", type, owner, process.platform === "win32" ? normalized.toLowerCase() : normalized);
}

function displayName(source: string): string {
  if (source.startsWith("npm:")) return source.slice(4);
  return basename(source.replace(/\\/g, "/")) || source;
}

function installedPackageMetadata(
  installedPath: string | undefined,
): { description?: string; versionOrRef?: string } {
  if (!installedPath) return {};
  try {
    const value = JSON.parse(readFileSync(join(installedPath, "package.json"), "utf8")) as {
      description?: unknown;
      version?: unknown;
    };
    return {
      ...(typeof value.description === "string" && value.description
        ? { description: value.description }
        : {}),
      ...(typeof value.version === "string" && value.version
        ? { versionOrRef: value.version }
        : {}),
    };
  } catch {
    return {};
  }
}

function readSkillFrontmatter(path: string): { name?: string; description?: string } {
  try {
    const content = readFileSync(path, "utf8");
    const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!match) return {};
    const result: { name?: string; description?: string } = {};
    for (const line of match[1]!.split(/\r?\n/)) {
      const field = line.match(/^(name|description)\s*:\s*(.*?)\s*$/);
      if (!field) continue;
      const value = field[2]!.replace(/^(['"])(.*)\1$/, "$2").trim();
      if (field[1] === "name" && value) result.name = value;
      if (field[1] === "description" && value) result.description = value;
    }
    return result;
  } catch {
    return {};
  }
}

function samePath(left: string, right: string): boolean {
  const a = toPosixPath(resolve(left));
  const b = toPosixPath(resolve(right));
  return process.platform === "win32" ? a.toLocaleLowerCase() === b.toLocaleLowerCase() : a === b;
}

function configuredVersionOrRef(source: string): string | undefined {
  if (source.startsWith("npm:")) {
    const spec = source.slice(4);
    return spec.match(/^(@[^/]+\/[^@]+|[^@]+)@(.+)$/)?.[2];
  }
  const hashRef = source.match(/#(.+)$/)?.[1];
  if (hashRef) return hashRef;
  const withoutPrefix = source.startsWith("git:") ? source.slice(4) : source;
  return withoutPrefix.match(/^[^/]+\/.+@([^/]+)$/)?.[1];
}

function includesScope(requested: PackageSnapshot["scope"], actual: ResourceScope): boolean {
  const normalized = actual === "temporary" ? "user" : actual;
  return requested === "all" || requested === normalized;
}

function sourceString(source: PackageSource): string {
  return typeof source === "string" ? source : source.source;
}

function findSource(
  sources: PackageSource[],
  identity: string,
  context: PackageIdentityContext,
): PackageSource | undefined {
  const candidateContext = { ...context, installedPath: undefined };
  return sources.find(
    (source) => normalizePackageIdentity(sourceString(source), candidateContext).identity === identity,
  );
}

function explicitPreference(
  source: PackageSource | undefined,
  type: ResourceType,
  relativePath: string,
  absolutePath?: string,
): "enabled" | "disabled" | undefined {
  if (!source) return undefined;
  if (typeof source === "string") return "enabled";
  const patterns = source[resourceTypeToSettingsKey(type)];
  if (patterns === undefined) return source.autoload === false ? undefined : "enabled";
  if (patterns.length === 0) return source.autoload === false ? undefined : "disabled";
  const candidates = [
    relativePath,
    relativePath.split("/").pop() ?? relativePath,
    ...(absolutePath ? [absolutePath] : []),
  ];
  const matches = (pattern: string, exact = false): boolean =>
    candidates.some((candidate) => matchesResourcePattern(candidate, pattern, exact));
  if (source.autoload === false) {
    let enabled: boolean | undefined;
    for (const pattern of patterns) {
      const prefix = /^[!+-]/.test(pattern) ? pattern[0] : "";
      const target = prefix ? pattern.slice(1) : pattern;
      if (!matches(target, prefix === "+" || prefix === "-")) continue;
      enabled = prefix !== "!" && prefix !== "-";
    }
    return enabled === undefined ? undefined : enabled ? "enabled" : "disabled";
  }
  const includes = patterns.filter((pattern) => !/^[!+-]/.test(pattern));
  const excludes = patterns.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1));
  const forceIncludes = patterns.filter((pattern) => pattern.startsWith("+")).map((pattern) => pattern.slice(1));
  const forceExcludes = patterns.filter((pattern) => pattern.startsWith("-")).map((pattern) => pattern.slice(1));

  let enabled = includes.length === 0 || includes.some((pattern) => matches(pattern));
  if (excludes.some((pattern) => matches(pattern))) enabled = false;
  if (forceIncludes.some((pattern) => matches(pattern, true))) enabled = true;
  if (forceExcludes.some((pattern) => matches(pattern, true))) enabled = false;
  return enabled === undefined ? undefined : enabled ? "enabled" : "disabled";
}

function projectOverridePreference(
  source: PackageSource | undefined,
  type: ResourceType,
  relativePath: string,
  absolutePath?: string,
): "inherit" | "enabled" | "disabled" {
  if (!source || typeof source === "string") return "inherit";
  return explicitPreference(source, type, relativePath, absolutePath) ?? "inherit";
}

function topLevelProjectPreference(
  patterns: string[],
  path: string,
  relativePath: string,
  cwd?: string,
): "inherit" | "enabled" | "disabled" {
  const candidates = new Set([
    toPosixPath(path),
    toPosixPath(relativePath),
    ...(cwd ? [toPosixPath(relative(join(cwd, ".pi"), path))] : []),
  ]);
  let result: "inherit" | "enabled" | "disabled" = "inherit";
  for (const entry of patterns) {
    if (!/^[!+-]/.test(entry)) continue;
    if (!candidates.has(toPosixPath(entry.slice(1)))) continue;
    result = entry.startsWith("-") || entry.startsWith("!") ? "disabled" : "enabled";
  }
  return result;
}

function toDiagnostic(
  diagnostic: { type?: string; message: string; path?: string },
): PackageDiagnostic {
  return {
    severity: diagnostic.type === "error" ? "error" : "warning",
    ...(diagnostic.path ? { source: diagnostic.path } : {}),
    message: diagnostic.message,
  };
}

function appendLoaderDiagnostic(
  target: Array<PackageDiagnostic & { path?: string }>,
  diagnostic: {
    type?: string;
    message: string;
    path?: string;
    collision?: { winnerPath: string; loserPath: string };
  },
): void {
  const paths = new Set([
    diagnostic.path,
    diagnostic.collision?.winnerPath,
    diagnostic.collision?.loserPath,
  ].filter((path): path is string => Boolean(path)));
  if (paths.size === 0) {
    target.push(toDiagnostic(diagnostic));
    return;
  }
  for (const path of paths) {
    target.push({ ...toDiagnostic({ ...diagnostic, path }), path });
  }
}

function loaderInventory(resourceLoader?: DefaultResourceLoader | null): {
  resources: LoaderResource[];
  diagnostics: Array<PackageDiagnostic & { path?: string }>;
} {
  if (!resourceLoader) return { resources: [], diagnostics: [] };
  const loader = resourceLoader as Partial<DefaultResourceLoader>;
  if (
    typeof loader.getExtensions !== "function" ||
    typeof loader.getSkills !== "function" ||
    typeof loader.getPrompts !== "function" ||
    typeof loader.getThemes !== "function"
  ) {
    return { resources: [], diagnostics: [] };
  }
  const resources: LoaderResource[] = [];
  const diagnostics: Array<PackageDiagnostic & { path?: string }> = [];
  const extensions = loader.getExtensions();
  for (const extension of extensions.extensions) {
    resources.push({
      type: "extension",
      path: extension.path,
      name: basename(extension.path),
      sourceInfo: extension.sourceInfo,
    });
  }
  for (const error of extensions.errors) {
    diagnostics.push({ severity: "error", source: error.path, path: error.path, message: error.error });
  }

  const skills = loader.getSkills();
  for (const skill of skills.skills) {
    resources.push({
      type: "skill",
      path: skill.filePath,
      name: skill.name,
      description: skill.description,
      sourceInfo: skill.sourceInfo,
      manualOnly: skill.disableModelInvocation,
    });
  }
  for (const diagnostic of skills.diagnostics) {
    appendLoaderDiagnostic(diagnostics, diagnostic);
  }

  const prompts = loader.getPrompts();
  for (const prompt of prompts.prompts) {
    resources.push({
      type: "prompt",
      path: prompt.filePath,
      name: prompt.name,
      description: prompt.description,
      sourceInfo: prompt.sourceInfo,
    });
  }
  for (const diagnostic of prompts.diagnostics) {
    appendLoaderDiagnostic(diagnostics, diagnostic);
  }

  const themes = loader.getThemes();
  for (const theme of themes.themes) {
    if (!theme.sourcePath || !theme.sourceInfo) continue;
    resources.push({
      type: "theme",
      path: theme.sourcePath,
      name: theme.name ?? basename(theme.sourcePath),
      sourceInfo: theme.sourceInfo,
    });
  }
  for (const diagnostic of themes.diagnostics) {
    appendLoaderDiagnostic(diagnostics, diagnostic);
  }
  return { resources, diagnostics };
}

function pathKey(type: ResourceType, path: string): string {
  const normalized = toPosixPath(resolve(path));
  return `${type}:${process.platform === "win32" ? normalized.toLowerCase() : normalized}`;
}

export async function buildPackageSnapshot(args: {
  revision: number;
  workspaceId: string;
  scope: PackageSnapshot["scope"];
  packageManager: DefaultPackageManager;
  settingsManager: SettingsManager;
  resourceLoader?: DefaultResourceLoader | null;
  cwd?: string;
  agentDir?: string;
  packageUpdateCheck: boolean;
  resourceIdMap: ResourceIdMap;
  updatesCache?: Map<string, boolean>;
  resourceReloadRequired?: boolean;
}): Promise<PackageSnapshot> {
  const { packageManager, resourceIdMap, settingsManager } = args;
  resourceIdMap.clear();
  const configured = packageManager.listConfiguredPackages();
  const globalSettings = settingsManager.getGlobalSettings?.() ?? {};
  const globalSources = (globalSettings.packages ?? []) as PackageSource[];
  const projectSources = (settingsManager.getProjectSettings?.().packages ?? []) as PackageSource[];
  const resolved = await packageManager.resolve(async () => "skip");

  const configuredInfo = configured.map((item) => {
    const installedPath = item.installedPath ?? packageManager.getInstalledPath(item.source, item.scope);
    return {
      ...item,
      installedPath,
      ...normalizePackageIdentity(item.source, {
        installedPath,
        scope: item.scope,
        cwd: args.cwd,
        agentDir: args.agentDir,
      }),
    };
  });
  const userByIdentity = new Map(
    configuredInfo.filter((item) => item.scope === "user").map((item) => [item.identity, item]),
  );
  const projectSettingsByIdentity = new Map(
    projectSources.map((item) => [
      normalizePackageIdentity(sourceString(item), {
        scope: "project",
        cwd: args.cwd,
        agentDir: args.agentDir,
      }).identity,
      item,
    ]),
  );
  const matchedDeltas = new Map<string, PackageSource>();
  const orphanDeltas = new Set<string>();
  for (const [identity, source] of projectSettingsByIdentity) {
    if (typeof source !== "object" || source.autoload !== false) continue;
    if (userByIdentity.has(identity)) matchedDeltas.set(identity, source);
    else orphanDeltas.add(identity);
  }

  const shadowedIdentities = new Set(
    configuredInfo
      .filter((item) => item.scope === "user")
      .filter((item) => configuredInfo.some(
        (candidate) => candidate.scope === "project" && candidate.identity === item.identity && !matchedDeltas.has(item.identity),
      ))
      .map((item) => item.identity),
  );
  let globalProjection:
    | { manager: DefaultPackageManager; resolved: Awaited<ReturnType<DefaultPackageManager["resolve"]>> }
    | undefined;
  if (shadowedIdentities.size > 0 && args.cwd && args.agentDir) {
    const globalSettingsManager = SettingsManager.inMemory(globalSettings, { projectTrusted: false });
    const manager = new DefaultPackageManager({
      cwd: args.cwd,
      agentDir: args.agentDir,
      settingsManager: globalSettingsManager,
    });
    globalProjection = { manager, resolved: await manager.resolve(async () => "skip") };
  }

  const diagnostics: PackageDiagnostic[] = [];
  for (const item of configuredInfo) {
    if (
      item.installedPath ||
      (item.scope === "project" && matchedDeltas.has(item.identity))
    ) {
      continue;
    }
    diagnostics.push({
      severity: "warning",
      source: item.source,
      message: "Package is configured but its installed source is missing or unresolved.",
    });
  }
  for (const identity of orphanDeltas) {
    const source = projectSettingsByIdentity.get(identity)!;
    diagnostics.push({
      severity: "warning",
      source: sourceString(source),
      message: "Project package override has no matching user package and is loaded as a project package.",
    });
  }

  const records: PackageRecord[] = [];
  const recordByIdentityScope = new Map<string, PackageRecord>();
  for (const item of configuredInfo) {
    if (item.scope === "project" && matchedDeltas.has(item.identity)) continue;
    if (args.scope !== "all" && args.scope !== item.scope) continue;
    const user = userByIdentity.get(item.identity);
    const project = configuredInfo.find(
      (candidate) => candidate.scope === "project" && candidate.identity === item.identity && !matchedDeltas.has(item.identity),
    );
    const replaced = Boolean(user && project);
    const id = packageId(item.identity, item.scope);
    const packageMetadata = installedPackageMetadata(item.installedPath);
    const record: PackageRecord = {
      id,
      identity: item.identity,
      source: item.source,
      kind: item.kind,
      scope: item.scope,
      filtered: item.filtered,
      installed: Boolean(item.installedPath),
      ...(item.installedPath ? { installedPath: item.installedPath } : {}),
      displayName: displayName(item.source),
      ...packageMetadata,
      ...(!packageMetadata.versionOrRef && configuredVersionOrRef(item.source)
        ? { versionOrRef: configuredVersionOrRef(item.source) }
        : {}),
      ...(args.updatesCache?.has(item.source)
        ? { updateAvailable: args.updatesCache.get(item.source) }
        : {}),
      effective: !replaced || item.scope === "project",
      ...(replaced && item.scope === "user"
        ? { shadowedByPackageId: packageId(item.identity, "project") }
        : {}),
      ...(replaced && item.scope === "project"
        ? { overridesPackageId: packageId(item.identity, "user") }
        : {}),
      ...(item.scope === "user" && matchedDeltas.has(item.identity)
        ? {
            projectOverride: {
              source: sourceString(matchedDeltas.get(item.identity)!),
              overrideCount: Object.values(toObjectSource(matchedDeltas.get(item.identity)!))
                .filter(Array.isArray)
                .reduce((count, values) => count + values.length, 0),
            },
          }
        : {}),
      resourceCounts: null,
      resourceCountsState:
        replaced && item.scope === "user" && !globalProjection
          ? "unknownShadowed"
          : "resolvedEffective",
    };
    records.push(record);
    recordByIdentityScope.set(`${item.identity}:${item.scope}`, record);
  }

  const resolvedByPath = new Map<
    string,
    { type: ResourceType; resource: ResolvedResource; globalOnly?: boolean }
  >();
  for (const [plural, type] of [
    ["extensions", "extension"],
    ["skills", "skill"],
    ["prompts", "prompt"],
    ["themes", "theme"],
  ] as const) {
    for (const resource of resolved[plural]) resolvedByPath.set(pathKey(type, resource.path), { type, resource });
    for (const resource of globalProjection?.resolved[plural] ?? []) {
      if (resource.metadata.origin !== "package") continue;
      const installedPath = globalProjection!.manager.getInstalledPath(resource.metadata.source, "user");
      const identity = normalizePackageIdentity(resource.metadata.source, {
        installedPath,
        scope: "user",
        cwd: args.cwd,
        agentDir: args.agentDir,
      }).identity;
      if (!shadowedIdentities.has(identity)) continue;
      resolvedByPath.set(`global:${pathKey(type, resource.path)}`, {
        type,
        resource,
        globalOnly: true,
      });
    }
  }
  const loader = loaderInventory(args.resourceLoader);
  diagnostics.push(...loader.diagnostics.map(({ path: _path, ...diagnostic }) => diagnostic));
  const loaderByPath = new Map(loader.resources.map((resource) => [pathKey(resource.type, resource.path), resource]));
  const allKeys = new Set([...resolvedByPath.keys(), ...loaderByPath.keys()]);
  const resources: ResourceRecord[] = [];
  const dynamicBaseDirs = new Map<string, string | undefined>();

  for (const key of allKeys) {
    const resolvedEntry = resolvedByPath.get(key);
    const loaded = loaderByPath.get(key.replace(/^global:/, ""));
    const type = resolvedEntry?.type ?? loaded!.type;
    const path = resolvedEntry?.resource.path ?? loaded!.path;
    const info: SourceInfo = (!resolvedEntry?.globalOnly ? loaded?.sourceInfo : undefined) ?? {
      path,
      ...resolvedEntry!.resource.metadata,
    };
    const dynamic = !resolvedEntry && info.source.startsWith("extension:");
    const origin: ResourceRecord["origin"] = dynamic ? "extension" : info.origin;
    const installedPath = info.origin === "package"
      ? (resolvedEntry?.globalOnly ? globalProjection!.manager : packageManager)
          .getInstalledPath(info.source, info.scope === "project" ? "project" : "user")
      : undefined;
    const packageIdentity = info.origin === "package"
      ? normalizePackageIdentity(info.source, {
          installedPath,
          scope: info.scope === "project" ? "project" : "user",
          cwd: args.cwd,
          agentDir: args.agentDir,
        }).identity
      : undefined;
    const isDelta = packageIdentity ? matchedDeltas.has(packageIdentity) : false;
    const packageScope = isDelta ? "user" : info.scope === "project" ? "project" : "user";
    const logicalScope: ResourceScope = info.origin === "package" ? packageScope : info.scope;
    if (!includesScope(args.scope, logicalScope)) continue;
    const packageRecord = packageIdentity
      ? recordByIdentityScope.get(`${packageIdentity}:${packageScope}`)
      : undefined;
    const relativePath = toPosixPath(
      info.baseDir ? relative(info.baseDir, path) : basename(path),
    );
    const ownerKey = packageRecord?.id ?? `${origin}:${info.scope}:${info.source}`;
    const id = resourceId(type, path, ownerKey);
    if (dynamic) dynamicBaseDirs.set(id, loaded?.sourceInfo.baseDir);
    const userSource = packageIdentity
      ? findSource(globalSources, packageIdentity, {
          installedPath: packageScope === "user" ? installedPath : undefined,
          scope: "user",
          cwd: args.cwd,
          agentDir: args.agentDir,
        })
      : undefined;
    const projectSource = packageIdentity
      ? findSource(projectSources, packageIdentity, {
          scope: "project",
          cwd: args.cwd,
          agentDir: args.agentDir,
        })
      : undefined;
    const userPreference = packageIdentity && packageScope === "user"
      ? explicitPreference(userSource, type, relativePath, path) ?? "enabled"
      : info.scope === "user" ? (resolvedEntry?.resource.enabled === false ? "disabled" : "enabled") : undefined;
    let projectPreference: "inherit" | "enabled" | "disabled" | undefined;
    if (packageIdentity && packageScope === "user") {
      projectPreference = projectOverridePreference(projectSource, type, relativePath, path);
    } else if (info.origin === "top-level") {
      const key = resourceTypeToSettingsKey(type);
      const patterns = (settingsManager.getProjectSettings?.()[key] ?? []) as string[];
      projectPreference = topLevelProjectPreference(patterns, path, relativePath, args.cwd);
    } else if (info.scope === "project") {
      projectPreference = projectOverridePreference(projectSource, type, relativePath, path);
    }
    const configurableScopes: Array<"user" | "project"> =
      origin === "extension"
        ? []
        : info.origin === "package"
          ? packageScope === "user"
            ? resolvedEntry?.globalOnly ? ["user"] : ["user", "project"]
            : ["project"]
          : info.scope === "project" ? ["project"] : info.scope === "user" ? ["user", "project"] : [];
    const resourceDiagnostics = loader.diagnostics
      .filter((diagnostic) => diagnostic.path && pathKey(type, diagnostic.path) === key)
      .map(({ path: _path, ...diagnostic }) => diagnostic);
    const skillMetadata = type === "skill" && !loaded ? readSkillFrontmatter(path) : {};
    resources.push({
      id,
      type,
      name:
        loaded?.name ?? skillMetadata.name ??
        (type === "skill" && basename(path).toLocaleLowerCase() === "skill.md"
          ? basename(dirname(path))
          : basename(path)),
      ...(loaded?.description || skillMetadata.description
        ? { description: loaded?.description ?? skillMetadata.description }
        : {}),
      path,
      ...(relativePath ? { relativePath } : {}),
      scope: logicalScope,
      origin,
      source: info.source,
      ...(packageRecord ? { packageId: packageRecord.id } : {}),
      enabled: resolvedEntry?.resource.enabled ?? true,
      preferences: {
        ...(userPreference ? { user: userPreference } : {}),
        ...(projectPreference ? { project: projectPreference } : {}),
      },
      control: configurableScopes.length > 0
        ? { kind: "preference", scopes: configurableScopes }
        : { kind: "read-only", reason: dynamic ? "Runtime resource owner is unavailable" : "Temporary resource" },
      ...(loaded?.manualOnly !== undefined ? { manualOnly: loaded.manualOnly } : {}),
      diagnostics: resourceDiagnostics,
    });
    resourceIdMap.set(id, {
      type,
      scope: logicalScope,
      path,
      baseDir: info.baseDir,
      relativePath,
      origin,
      packageSource: packageRecord?.source,
      projectOverrideSource:
        packageRecord?.kind === "local" && packageScope === "user" && args.cwd
          ? toPosixPath(
              relative(join(args.cwd, ".pi"), info.baseDir ?? installedPath ?? info.source),
            ) || "."
          : packageRecord?.source,
      packageScope: packageRecord?.scope,
      packageIdentity,
      configurableScopes,
    });
  }

  const extensionsByLabel = new Map<string, ResourceRecord[]>();
  for (const resource of resources) {
    if (resource.type !== "extension" || resource.origin === "extension") continue;
    const label = basename(resource.path).replace(/\.(?:ts|js)$/, "");
    const entries = extensionsByLabel.get(`extension:${label}`) ?? [];
    entries.push(resource);
    extensionsByLabel.set(`extension:${label}`, entries);
  }
  for (const resource of resources) {
    if (resource.origin !== "extension") continue;
    const candidates = extensionsByLabel.get(resource.source) ?? [];
    const baseDir = dynamicBaseDirs.get(resource.id);
    const owner = candidates.length === 1
      ? candidates[0]
      : candidates.find((candidate) => baseDir && samePath(baseDir, dirname(candidate.path)));
    if (!owner) continue;
    resource.control = { kind: "owner-extension", ownerResourceId: owner.id };
    if (owner.packageId) resource.packageId = owner.packageId;
  }

  for (const record of records) {
    if (record.resourceCountsState === "unknownShadowed") continue;
    const owned = resources.filter((resource) => resource.packageId === record.id && resource.origin !== "extension");
    const counts = { extensions: 0, skills: 0, prompts: 0, themes: 0, enabled: 0, disabled: 0 };
    for (const resource of owned) {
      counts[`${resource.type}s` as keyof Pick<typeof counts, "extensions" | "skills" | "prompts" | "themes">]++;
      counts[resource.enabled ? "enabled" : "disabled"]++;
    }
    record.resourceCounts = counts;
  }

  return {
    revision: args.revision,
    workspaceId: args.workspaceId,
    scope: args.scope,
    configured: records,
    resources,
    updateCheck: { supported: args.packageUpdateCheck },
    diagnostics,
    resourceReloadRequired: args.resourceReloadRequired === true,
  };
}
