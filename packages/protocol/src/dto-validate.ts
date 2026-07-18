import { HOST_ERROR_CODES } from "./errors.js";
import type { HostEventName } from "./events.js";
import type { HostMethod } from "./methods.js";
import type { ToolSnapshot } from "./types.js";

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key));
}

export function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

export function isSafeRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isJsonValue(value: unknown): boolean {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isPlainObject(value) && Object.values(value).every(isJsonValue);
}

export function isHostErrorRecord(value: unknown): boolean {
  if (!isPlainObject(value) || !hasExactKeys(value, ["code", "message", "retryable"], ["details"])) {
    return false;
  }
  return (
    typeof value.code === "string" &&
    (HOST_ERROR_CODES as readonly string[]).includes(value.code) &&
    typeof value.message === "string" &&
    typeof value.retryable === "boolean" &&
    (value.details === undefined || isJsonValue(value.details))
  );
}

function isHostIdentity(value: Record<string, unknown>): boolean {
  return (
    isUuid(value.hostInstanceId) &&
    (value.workspaceId === null || isUuid(value.workspaceId)) &&
    isSafeRevision(value.workspaceRevision) &&
    (value.sessionId === null || isUuid(value.sessionId)) &&
    isSafeRevision(value.sessionRevision) &&
    isSafeRevision(value.packageRevision)
  );
}

function isModelConfigHealth(value: unknown): boolean {
  if (!isPlainObject(value) || !hasExactKeys(value, ["state", "source"], ["message", "migrationHint"])) {
    return false;
  }
  if (
    (value.state !== "ok" && value.state !== "error") ||
    value.source !== "ModelRegistry.getError" ||
    !isOptionalString(value.message)
  ) {
    return false;
  }
  if (value.migrationHint === undefined) return true;
  return (
    isPlainObject(value.migrationHint) &&
    hasExactKeys(value.migrationHint, ["code", "message"]) &&
    value.migrationHint.code === "SESSION_AFFINITY_FORMAT_REQUIRED" &&
    isString(value.migrationHint.message)
  );
}

export function isHostStatusSnapshot(value: unknown): boolean {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(
      value,
      [
        "protocolVersion",
        "hostInstanceId",
        "workspaceId",
        "workspaceRevision",
        "sessionId",
        "sessionRevision",
        "packageRevision",
        "sdkVersion",
        "nodeVersion",
        "agentDir",
        "phase",
        "capabilities",
        "modelConfigHealth",
      ],
      ["lastError", "fatalError"],
    )
  ) {
    return false;
  }
  const phases = [
    "booting",
    "waitingForWorkspace",
    "trustRequired",
    "ready",
    "agentBusy",
    "packageBusy",
    "reloading",
    "workspaceError",
    "shuttingDown",
    "fatal",
  ];
  const caps = value.capabilities;
  return (
    value.protocolVersion === 1 &&
    isHostIdentity(value) &&
    isString(value.sdkVersion) &&
    isString(value.nodeVersion) &&
    isString(value.agentDir) &&
    phases.includes(String(value.phase)) &&
    isPlainObject(caps) &&
    hasExactKeys(caps, ["packageUpdateCheck", "extensionUi", "projectTrust", "sessionExport"]) &&
    isBoolean(caps.packageUpdateCheck) &&
    caps.extensionUi === true &&
    caps.projectTrust === true &&
    isBoolean(caps.sessionExport) &&
    isModelConfigHealth(value.modelConfigHealth) &&
    (value.lastError === undefined || isHostErrorRecord(value.lastError)) &&
    (value.fatalError === undefined || isHostErrorRecord(value.fatalError))
  );
}

export function isTrustOption(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, ["id", "label", "trusted", "persisted"]) &&
    ["trustOnce", "trust", "deny"].includes(String(value.id)) &&
    isString(value.label) &&
    isBoolean(value.trusted) &&
    isBoolean(value.persisted)
  );
}

export function isWorkspaceSnapshot(value: unknown): boolean {
  if (!isPlainObject(value) || !hasExactKeys(value, ["id", "cwd", "canonicalCwd", "revision", "trust", "servicesReady"])) {
    return false;
  }
  const trust = value.trust;
  return (
    isUuid(value.id) &&
    isString(value.cwd) &&
    isString(value.canonicalCwd) &&
    isSafeRevision(value.revision) &&
    isPlainObject(trust) &&
    hasExactKeys(trust, ["required", "decision"], ["persistedAtPath"]) &&
    isBoolean(trust.required) &&
    ["trusted", "denied", "session", "pending", "notRequired"].includes(String(trust.decision)) &&
    isOptionalString(trust.persistedAtPath) &&
    isBoolean(value.servicesReady)
  );
}

function isModelSummary(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, ["provider", "modelId", "name"], ["thinkingLevels"]) &&
    isString(value.provider) &&
    isString(value.modelId) &&
    isString(value.name) &&
    (value.thinkingLevels === undefined || isStringArray(value.thinkingLevels))
  );
}

const PROVIDER_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
] as const;

function isProviderModelConfig(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    hasExactKeys(
      value,
      ["id", "name", "reasoning", "input", "contextWindow", "maxTokens"],
      ["thinkingLevelMap"],
    ) &&
    isString(value.id) &&
    value.id.trim().length > 0 &&
    isString(value.name) &&
    value.name.trim().length > 0 &&
    isBoolean(value.reasoning) &&
    (value.thinkingLevelMap === undefined ||
      (isPlainObject(value.thinkingLevelMap) &&
        Object.keys(value.thinkingLevelMap).every((key) =>
          ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(key),
        ) &&
        Object.values(value.thinkingLevelMap).every(
          (item) => item === null || typeof item === "string",
        ))) &&
    Array.isArray(value.input) &&
    value.input.length > 0 &&
    value.input.every((item) => item === "text" || item === "image") &&
    isSafeRevision(value.contextWindow) &&
    value.contextWindow > 0 &&
    isSafeRevision(value.maxTokens) &&
    value.maxTokens > 0
  );
}

function isStringRecord(value: unknown): boolean {
  return isPlainObject(value) && Object.values(value).every(isString);
}

export function isProviderDraft(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, ["id", "name", "baseUrl", "api", "authHeader", "headers", "models"]) &&
    isString(value.id) &&
    value.id.trim().length > 0 &&
    isString(value.name) &&
    value.name.trim().length > 0 &&
    isString(value.baseUrl) &&
    value.baseUrl.trim().length > 0 &&
    (PROVIDER_APIS as readonly string[]).includes(String(value.api)) &&
    isBoolean(value.authHeader) &&
    isStringRecord(value.headers) &&
    Array.isArray(value.models) &&
    value.models.every(isProviderModelConfig)
  );
}

function isProviderAuthStatus(value: unknown): boolean {
  const sources = [
    "stored",
    "runtime",
    "environment",
    "fallback",
    "models_json_key",
    "models_json_command",
  ];
  return (
    isPlainObject(value) &&
    hasExactKeys(value, ["configured"], ["source", "label"]) &&
    isBoolean(value.configured) &&
    (value.source === undefined || sources.includes(String(value.source))) &&
    isOptionalString(value.label)
  );
}

function isProviderSnapshot(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, ["id", "name", "baseUrl", "api", "authHeader", "headers", "models", "auth"]) &&
    isString(value.id) &&
    value.id.trim().length > 0 &&
    isString(value.name) &&
    value.name.trim().length > 0 &&
    isString(value.baseUrl) &&
    (PROVIDER_APIS as readonly string[]).includes(String(value.api)) &&
    isBoolean(value.authHeader) &&
    isStringRecord(value.headers) &&
    Array.isArray(value.models) &&
    value.models.every(isProviderModelConfig) &&
    isProviderAuthStatus(value.auth)
  );
}

function isDiscoveredProviderModel(value: unknown): boolean {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(
      value,
      ["id", "name", "reasoning", "input", "contextWindow", "maxTokens", "enabled", "thinkingSource"],
      ["thinkingLevelMap"],
    )
  ) {
    return false;
  }
  const { enabled, thinkingSource, ...model } = value;
  return (
    isProviderModelConfig(model) &&
    isBoolean(enabled) &&
    ["provider", "profile", "inferred", "configured", "manual", "default"].includes(
      String(thinkingSource),
    )
  );
}

export function isSerializableAgentContent(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    isString(value.type) &&
    (value.text === undefined || isString(value.text)) &&
    Object.entries(value).every(([key, item]) =>
      key === "type" || key === "text" || item === undefined || isJsonValue(item),
    )
  );
}

function isAgentMessage(value: unknown): boolean {
  if (!isPlainObject(value) || !isString(value.role)) return false;
  if (
    !(
      typeof value.content === "string" ||
      (Array.isArray(value.content) && value.content.every(isSerializableAgentContent))
    )
  ) {
    return false;
  }
  return Object.entries(value).every(
    ([key, item]) => key === "role" || key === "content" || item === undefined || isJsonValue(item),
  );
}

function isSerializableCompactionResult(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    isOptionalString(value.summary) &&
    (value.tokensBefore === undefined || isFiniteNumber(value.tokensBefore)) &&
    (value.tokensAfter === undefined || isFiniteNumber(value.tokensAfter)) &&
    Object.entries(value).every(([key, item]) =>
      key === "summary" ||
      key === "tokensBefore" ||
      key === "tokensAfter" ||
      item === undefined ||
      isJsonValue(item),
    )
  );
}

function isSerializableAgentSessionEvent(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    isString(value.type) &&
    Object.entries(value).every(
      ([key, item]) => key === "type" || item === undefined || isJsonValue(item),
    )
  );
}

function isToolInfo(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, ["name"], ["description", "parameters", "source"]) &&
    isString(value.name) &&
    isOptionalString(value.description) &&
    (value.parameters === undefined || isJsonValue(value.parameters)) &&
    isOptionalString(value.source)
  );
}

export function isToolSnapshot(value: unknown): value is ToolSnapshot {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, ["revision", "workspaceId", "sessionId", "sessionRevision", "tools", "active"]) &&
    isSafeRevision(value.revision) &&
    isUuid(value.workspaceId) &&
    isUuid(value.sessionId) &&
    isSafeRevision(value.sessionRevision) &&
    Array.isArray(value.tools) &&
    value.tools.every(isToolInfo) &&
    isStringArray(value.active)
  );
}

export function isSessionSnapshot(value: unknown): boolean {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(
      value,
      [
        "sessionId",
        "cwd",
        "revision",
        "isStreaming",
        "isIdle",
        "isCompacting",
        "isRetrying",
        "thinkingLevel",
        "autoCompactionEnabled",
        "autoRetryEnabled",
        "steeringMode",
        "followUpMode",
        "pending",
        "messages",
        "tools",
      ],
      ["sessionPath", "name", "model"],
    )
  ) {
    return false;
  }
  const pending = value.pending;
  const tools = value.tools;
  return (
    isUuid(value.sessionId) &&
    isOptionalString(value.sessionPath) &&
    isOptionalString(value.name) &&
    isString(value.cwd) &&
    isSafeRevision(value.revision) &&
    [value.isStreaming, value.isIdle, value.isCompacting, value.isRetrying].every(isBoolean) &&
    (value.model === undefined || isModelSummary(value.model)) &&
    isString(value.thinkingLevel) &&
    isBoolean(value.autoCompactionEnabled) &&
    isBoolean(value.autoRetryEnabled) &&
    ["all", "one-at-a-time"].includes(String(value.steeringMode)) &&
    ["all", "one-at-a-time"].includes(String(value.followUpMode)) &&
    isPlainObject(pending) &&
    hasExactKeys(pending, ["steering", "followUp"]) &&
    isStringArray(pending.steering) &&
    isStringArray(pending.followUp) &&
    Array.isArray(value.messages) &&
    value.messages.every(isAgentMessage) &&
    isToolSnapshot(tools) &&
    tools.sessionId === value.sessionId &&
    tools.sessionRevision === value.revision
  );
}

function isSessionSummary(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    hasExactKeys(
      value,
      ["sessionId", "sessionPath", "cwd", "updatedAt"],
      ["name", "messageCount", "archived", "runtimeState", "sessionRevision"],
    ) &&
    isUuid(value.sessionId) &&
    isString(value.sessionPath) &&
    isOptionalString(value.name) &&
    isString(value.cwd) &&
    isFiniteNumber(value.updatedAt) &&
    (value.messageCount === undefined || isSafeRevision(value.messageCount)) &&
    (value.archived === undefined || isBoolean(value.archived)) &&
    (value.runtimeState === undefined ||
      ["starting", "running", "queued", "idle", "error", "inactive"].includes(
        String(value.runtimeState),
      )) &&
    (value.sessionRevision === undefined || isSafeRevision(value.sessionRevision))
  );
}

function isDiagnostic(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, ["severity", "message"], ["source"]) &&
    ["info", "warning", "error"].includes(String(value.severity)) &&
    isOptionalString(value.source) &&
    isString(value.message)
  );
}

function isResourceCounts(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, ["extensions", "skills", "prompts", "themes", "enabled", "disabled"]) &&
    Object.values(value).every(isSafeRevision)
  );
}

function isPackageRecord(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    hasExactKeys(
      value,
      [
        "id",
        "source",
        "kind",
        "scope",
        "filtered",
        "installed",
        "displayName",
        "effective",
        "resourceCounts",
        "resourceCountsState",
      ],
      ["installedPath", "versionOrRef", "updateAvailable", "shadowedByPackageId", "overridesPackageId"],
    ) &&
    isString(value.id) &&
    isString(value.source) &&
    ["npm", "git", "local"].includes(String(value.kind)) &&
    ["user", "project"].includes(String(value.scope)) &&
    isBoolean(value.filtered) &&
    isBoolean(value.installed) &&
    isOptionalString(value.installedPath) &&
    isString(value.displayName) &&
    isOptionalString(value.versionOrRef) &&
    (value.updateAvailable === undefined || isBoolean(value.updateAvailable)) &&
    isBoolean(value.effective) &&
    isOptionalString(value.shadowedByPackageId) &&
    isOptionalString(value.overridesPackageId) &&
    (value.resourceCounts === null || isResourceCounts(value.resourceCounts)) &&
    ["resolvedEffective", "unknownShadowed"].includes(String(value.resourceCountsState))
  );
}

function isPackageResource(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    hasExactKeys(
      value,
      ["id", "packageId", "type", "name", "path", "enabled", "scope", "origin"],
      ["relativePath", "diagnostic"],
    ) &&
    isString(value.id) &&
    isString(value.packageId) &&
    ["extension", "skill", "prompt", "theme"].includes(String(value.type)) &&
    isString(value.name) &&
    isString(value.path) &&
    isOptionalString(value.relativePath) &&
    isBoolean(value.enabled) &&
    ["user", "project", "temporary"].includes(String(value.scope)) &&
    value.origin === "package" &&
    (value.diagnostic === undefined || isDiagnostic(value.diagnostic))
  );
}

function isTopLevelResource(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, ["id", "type", "name", "path", "enabled", "scope", "source", "origin"], ["diagnostic"]) &&
    isString(value.id) &&
    ["extension", "skill", "prompt", "theme"].includes(String(value.type)) &&
    isString(value.name) &&
    isString(value.path) &&
    isBoolean(value.enabled) &&
    ["user", "project"].includes(String(value.scope)) &&
    ["auto", "local"].includes(String(value.source)) &&
    value.origin === "top-level" &&
    (value.diagnostic === undefined || isDiagnostic(value.diagnostic))
  );
}

export function isPackageSnapshot(value: unknown): boolean {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(
      value,
      ["revision", "workspaceId", "scope", "configured", "packageResources", "topLevelResources", "updateCheck", "diagnostics"],
      ["resourceReloadRequired", "mutation"],
    )
  ) {
    return false;
  }
  const updateCheck = value.updateCheck;
  const mutation = value.mutation;
  return (
    isSafeRevision(value.revision) &&
    isUuid(value.workspaceId) &&
    ["user", "project", "all"].includes(String(value.scope)) &&
    Array.isArray(value.configured) &&
    value.configured.every(isPackageRecord) &&
    Array.isArray(value.packageResources) &&
    value.packageResources.every(isPackageResource) &&
    Array.isArray(value.topLevelResources) &&
    value.topLevelResources.every(isTopLevelResource) &&
    isPlainObject(updateCheck) &&
    hasExactKeys(updateCheck, ["supported"], ["checkedAt"]) &&
    isBoolean(updateCheck.supported) &&
    (updateCheck.checkedAt === undefined || isFiniteNumber(updateCheck.checkedAt)) &&
    Array.isArray(value.diagnostics) &&
    value.diagnostics.every(isDiagnostic) &&
    (value.resourceReloadRequired === undefined || isBoolean(value.resourceReloadRequired)) &&
    (mutation === undefined ||
      (isPlainObject(mutation) &&
        hasExactKeys(mutation, ["operationId", "status", "reconcileRequired"]) &&
        isUuid(mutation.operationId) &&
        ["running", "partialFailure"].includes(String(mutation.status)) &&
        isBoolean(mutation.reconcileRequired)))
  );
}

function isPackageMutationResult(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, ["operationId", "status", "packageSnapshot", "warnings", "reconcileRequired"], ["session"]) &&
    isUuid(value.operationId) &&
    ["committed", "partialFailure", "failed"].includes(String(value.status)) &&
    isPackageSnapshot(value.packageSnapshot) &&
    (value.session === undefined || isSessionSnapshot(value.session)) &&
    Array.isArray(value.warnings) &&
    value.warnings.every(isHostErrorRecord) &&
    isBoolean(value.reconcileRequired)
  );
}

function isPiSettingsSnapshot(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    hasExactKeys(
      value,
      ["steeringMode", "followUpMode", "autoCompaction", "autoRetry"],
      ["defaultModel", "defaultThinkingLevel", "defaultProjectTrust"],
    ) &&
    (value.defaultModel === undefined || isModelSummary(value.defaultModel)) &&
    isOptionalString(value.defaultThinkingLevel) &&
    ["all", "one-at-a-time"].includes(String(value.steeringMode)) &&
    ["all", "one-at-a-time"].includes(String(value.followUpMode)) &&
    isBoolean(value.autoCompaction) &&
    isBoolean(value.autoRetry) &&
    isOptionalString(value.defaultProjectTrust)
  );
}

function isExtensionUiRequest(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, ["requestId", "kind"], ["title", "message", "options", "defaultValue", "timeoutMs"]) &&
    isUuid(value.requestId) &&
    ["select", "confirm", "input", "editor"].includes(String(value.kind)) &&
    isOptionalString(value.title) &&
    isOptionalString(value.message) &&
    (value.options === undefined ||
      (Array.isArray(value.options) &&
        value.options.every(
          (item) =>
            isPlainObject(item) &&
            hasExactKeys(item, ["id", "label"]) &&
            isString(item.id) &&
            isString(item.label),
        ))) &&
    isOptionalString(value.defaultValue) &&
    (value.timeoutMs === undefined || isSafeRevision(value.timeoutMs))
  );
}

function isSessionEntry(value: unknown): boolean {
  return isPlainObject(value) && isString(value.id) && isString(value.type) && Object.values(value).every(isJsonValue);
}

function isSessionTreeNode(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, ["entry", "children"], ["label", "labelTimestamp"]) &&
    isSessionEntry(value.entry) &&
    Array.isArray(value.children) &&
    value.children.every(isSessionTreeNode) &&
    isOptionalString(value.label) &&
    isOptionalString(value.labelTimestamp)
  );
}

export function validateMethodResultShape(method: HostMethod, result: unknown): string | null {
  const exactAccepted = () =>
    isPlainObject(result) && hasExactKeys(result, ["accepted"]) && result.accepted === true;
  switch (method) {
    case "system.hello":
    case "system.getStatus":
      return isHostStatusSnapshot(result) ? null : "invalid HostStatusSnapshot";
    case "system.shutdown":
      return exactAccepted() ? null : "shutdown result must be { accepted: true }";
    case "workspace.setCurrent":
      return isPlainObject(result) &&
        hasExactKeys(result, ["workspace"], ["session", "trustOptions"]) &&
        isWorkspaceSnapshot(result.workspace) &&
        (result.session === undefined || isSessionSnapshot(result.session)) &&
        (result.trustOptions === undefined ||
          (Array.isArray(result.trustOptions) && result.trustOptions.every(isTrustOption)))
        ? null
        : "invalid workspace.setCurrent result";
    case "workspace.getCurrent":
      return result === null || isWorkspaceSnapshot(result) ? null : "invalid workspace snapshot";
    case "workspace.getTrust":
      return isPlainObject(result) &&
        hasExactKeys(result, ["workspace", "options"]) &&
        isWorkspaceSnapshot(result.workspace) &&
        Array.isArray(result.options) &&
        result.options.every(isTrustOption)
        ? null
        : "invalid workspace.getTrust result";
    case "workspace.setTrust":
      return isPlainObject(result) &&
        hasExactKeys(result, ["workspace"], ["session"]) &&
        isWorkspaceSnapshot(result.workspace) &&
        (result.session === undefined || isSessionSnapshot(result.session))
        ? null
        : "invalid workspace.setTrust result";
    case "session.list":
      return isPlainObject(result) &&
        hasExactKeys(result, ["workspaceId", "items"]) &&
        isUuid(result.workspaceId) &&
        Array.isArray(result.items) &&
        result.items.every(isSessionSummary)
        ? null
        : "invalid session.list result";
    case "session.archive":
    case "session.restore":
      return isPlainObject(result) &&
        hasExactKeys(result, ["sessionId", "sessionPath", "archived"]) &&
        isUuid(result.sessionId) &&
        isString(result.sessionPath) &&
        result.archived === (method === "session.archive")
        ? null
        : `invalid ${method} result`;
    case "session.delete":
      return isPlainObject(result) &&
        hasExactKeys(result, ["sessionId", "deleted"]) &&
        isUuid(result.sessionId) &&
        result.deleted === true
        ? null
        : "invalid session.delete result";
    case "session.cleanupArchived":
      return isPlainObject(result) &&
        hasExactKeys(result, ["deletedCount", "failedCount"]) &&
        isSafeRevision(result.deletedCount) &&
        isSafeRevision(result.failedCount)
        ? null
        : "invalid session.cleanupArchived result";
    case "session.create":
    case "session.open":
    case "session.reload":
    case "session.setName":
    case "agent.setAutoCompaction":
    case "agent.setAutoRetry":
    case "model.setThinkingLevel":
      return isSessionSnapshot(result) ? null : `${method} must return SessionSnapshot`;
    case "session.getSnapshot":
      return result === null || isSessionSnapshot(result) ? null : "invalid session snapshot";
    case "session.getEntries":
      return isPlainObject(result) &&
        hasExactKeys(result, ["entries", "leafId"]) &&
        Array.isArray(result.entries) &&
        result.entries.every(isSessionEntry) &&
        (result.leafId === null || isString(result.leafId))
        ? null
        : "invalid session entries";
    case "session.getTree":
      return isPlainObject(result) &&
        hasExactKeys(result, ["tree", "leafId"]) &&
        Array.isArray(result.tree) &&
        result.tree.every(isSessionTreeNode) &&
        (result.leafId === null || isString(result.leafId))
        ? null
        : "invalid session tree";
    case "session.getStats":
      return isPlainObject(result) &&
        hasExactKeys(result, ["messageCount"], ["toolCallCount", "tokenUsage"]) &&
        isSafeRevision(result.messageCount) &&
        (result.toolCallCount === undefined || isSafeRevision(result.toolCallCount)) &&
        (result.tokenUsage === undefined || isJsonValue(result.tokenUsage))
        ? null
        : "invalid session stats";
    case "agent.prompt":
      return isPlainObject(result) &&
        hasExactKeys(result, ["accepted", "runId"]) &&
        result.accepted === true &&
        isUuid(result.runId)
        ? null
        : "invalid agent.prompt result";
    case "agent.steer":
    case "agent.followUp":
    case "agent.abortCompaction":
    case "agent.abortRetry":
    case "extensionUi.respond":
      return exactAccepted() ? null : `${method} result must be { accepted: true }`;
    case "agent.abort":
      return isPlainObject(result) &&
        hasExactKeys(result, ["aborted", "session"]) &&
        isBoolean(result.aborted) &&
        isSessionSnapshot(result.session)
        ? null
        : "invalid agent.abort result";
    case "agent.clearQueue":
      return isPlainObject(result) &&
        hasExactKeys(result, ["steering", "followUp"]) &&
        isStringArray(result.steering) &&
        isStringArray(result.followUp)
        ? null
        : "invalid queue result";
    case "agent.compact":
      return isPlainObject(result) &&
        hasExactKeys(result, ["result", "session"]) &&
        isSerializableCompactionResult(result.result) &&
        isSessionSnapshot(result.session)
        ? null
        : "invalid compact result";
    case "agent.getTools":
    case "agent.setActiveTools":
      return isToolSnapshot(result) ? null : "invalid ToolSnapshot";
    case "provider.list":
      return isPlainObject(result) &&
        hasExactKeys(result, ["providers"]) &&
        Array.isArray(result.providers) &&
        result.providers.every(isProviderSnapshot)
        ? null
        : "invalid provider.list result";
    case "provider.save":
      return isPlainObject(result) &&
        hasExactKeys(result, ["provider"]) &&
        isProviderSnapshot(result.provider)
        ? null
        : "invalid provider.save result";
    case "provider.remove":
      return isPlainObject(result) &&
        hasExactKeys(result, ["providerId", "removed"]) &&
        isString(result.providerId) &&
        result.removed === true
        ? null
        : "invalid provider.remove result";
    case "provider.fetchModels":
      return isPlainObject(result) &&
        hasExactKeys(result, ["providerId", "models"]) &&
        isString(result.providerId) &&
        Array.isArray(result.models) &&
        result.models.every(isDiscoveredProviderModel)
        ? null
        : "invalid provider.fetchModels result";
    case "model.list":
      return isPlainObject(result) &&
        hasExactKeys(result, ["models", "thinkingLevels", "configHealth"], ["current"]) &&
        Array.isArray(result.models) &&
        result.models.every(isModelSummary) &&
        (result.current === undefined || isModelSummary(result.current)) &&
        isStringArray(result.thinkingLevels) &&
        isModelConfigHealth(result.configHealth)
        ? null
        : "invalid model.list result";
    case "model.setCurrent":
      return isPlainObject(result) &&
        hasExactKeys(result, ["model", "thinkingLevels", "session"]) &&
        isModelSummary(result.model) &&
        isStringArray(result.thinkingLevels) &&
        isSessionSnapshot(result.session)
        ? null
        : "invalid model.setCurrent result";
    case "package.list":
      return isPackageSnapshot(result) ? null : "invalid PackageSnapshot";
    case "package.install":
    case "package.remove":
    case "package.update":
    case "package.updateAll":
    case "package.setResourceEnabled":
    case "package.setResourceTypeEnabled":
    case "package.reloadResources":
    case "resource.setTopLevelEnabled":
      return isPackageMutationResult(result) ? null : "invalid PackageMutationResult";
    case "package.checkUpdates":
      return isPlainObject(result) &&
        hasExactKeys(result, ["supported", "updates"]) &&
        isBoolean(result.supported) &&
        Array.isArray(result.updates) &&
        result.updates.every(
          (item) =>
            isPlainObject(item) &&
            hasExactKeys(item, ["packageId", "source"], ["current", "available"]) &&
            isString(item.packageId) &&
            isString(item.source) &&
            isOptionalString(item.current) &&
            isOptionalString(item.available),
        )
        ? null
        : "invalid package.checkUpdates result";
    case "package.getResources":
      return isPlainObject(result) &&
        hasExactKeys(result, ["package", "resources"]) &&
        isPackageRecord(result.package) &&
        Array.isArray(result.resources) &&
        result.resources.every(isPackageResource)
        ? null
        : "invalid package.getResources result";
    case "piSettings.get":
    case "piSettings.patch":
      return isPiSettingsSnapshot(result) ? null : "invalid PiSettingsSnapshot";
  }
}

export function validateEventPayloadShape(event: HostEventName, payload: unknown): string | null {
  switch (event) {
    case "host.ready":
    case "host.statusChanged":
      return isHostStatusSnapshot(payload) ? null : "invalid HostStatusSnapshot payload";
    case "host.fatal":
      return isPlainObject(payload) && hasExactKeys(payload, ["error"]) && isHostErrorRecord(payload.error)
        ? null
        : "invalid host.fatal payload";
    case "workspace.changed":
      return isWorkspaceSnapshot(payload) ? null : "invalid workspace.changed payload";
    case "workspace.trustRequired":
      return isPlainObject(payload) &&
        hasExactKeys(payload, ["workspace", "options"]) &&
        isWorkspaceSnapshot(payload.workspace) &&
        Array.isArray(payload.options) &&
        payload.options.every(isTrustOption)
        ? null
        : "invalid workspace.trustRequired payload";
    case "session.snapshot":
      return payload === null || isSessionSnapshot(payload) ? null : "invalid session.snapshot payload";
    case "session.infoChanged":
      return isPlainObject(payload) &&
        hasExactKeys(payload, ["sessionId"], ["name"]) &&
        isUuid(payload.sessionId) &&
        isOptionalString(payload.name)
        ? null
        : "invalid session.infoChanged payload";
    case "session.runtimeChanged":
      return isPlainObject(payload) &&
        hasExactKeys(
          payload,
          ["sessionId", "sessionRevision", "state", "updatedAt"],
          ["error"],
        ) &&
        isUuid(payload.sessionId) &&
        isSafeRevision(payload.sessionRevision) &&
        ["starting", "running", "queued", "idle", "error", "inactive"].includes(
          String(payload.state),
        ) &&
        isFiniteNumber(payload.updatedAt) &&
        payload.updatedAt >= 0 &&
        isOptionalString(payload.error)
        ? null
        : "invalid session.runtimeChanged payload";
    case "agent.event":
      return isPlainObject(payload) &&
        hasExactKeys(payload, ["runId", "event"]) &&
        isUuid(payload.runId) &&
        isSerializableAgentSessionEvent(payload.event)
        ? null
        : "invalid agent.event payload";
    case "agent.toolsChanged":
      return isToolSnapshot(payload) ? null : "invalid agent.toolsChanged payload";
    case "agent.queueChanged":
      return isPlainObject(payload) &&
        hasExactKeys(payload, ["steering", "followUp"]) &&
        isStringArray(payload.steering) &&
        isStringArray(payload.followUp)
        ? null
        : "invalid agent.queueChanged payload";
    case "agent.compactionChanged":
      return isPlainObject(payload) &&
        hasExactKeys(payload, ["active"], ["reason", "result", "error"]) &&
        isBoolean(payload.active) &&
        isOptionalString(payload.reason) &&
        (payload.result === undefined || isSerializableCompactionResult(payload.result)) &&
        (payload.error === undefined || isHostErrorRecord(payload.error))
        ? null
        : "invalid agent.compactionChanged payload";
    case "agent.retryChanged":
      return isPlainObject(payload) &&
        hasExactKeys(payload, ["active"], ["attempt", "maxAttempts", "delayMs", "errorMessage"]) &&
        isBoolean(payload.active) &&
        (payload.attempt === undefined || isSafeRevision(payload.attempt)) &&
        (payload.maxAttempts === undefined || isSafeRevision(payload.maxAttempts)) &&
        (payload.delayMs === undefined || isSafeRevision(payload.delayMs)) &&
        isOptionalString(payload.errorMessage)
        ? null
        : "invalid agent.retryChanged payload";
    case "model.changed":
      return isPlainObject(payload) &&
        hasExactKeys(payload, ["thinkingLevel", "availableThinkingLevels"], ["model"]) &&
        isString(payload.thinkingLevel) &&
        isStringArray(payload.availableThinkingLevels) &&
        (payload.model === undefined || isModelSummary(payload.model))
        ? null
        : "invalid model.changed payload";
    case "package.progress":
      return isPlainObject(payload) &&
        hasExactKeys(payload, ["operationId", "type", "action", "source"], ["message"]) &&
        isUuid(payload.operationId) &&
        ["start", "progress", "complete", "error"].includes(String(payload.type)) &&
        isString(payload.action) &&
        isString(payload.source) &&
        isOptionalString(payload.message)
        ? null
        : "invalid package.progress payload";
    case "package.snapshot":
      return isPackageSnapshot(payload) ? null : "invalid package.snapshot payload";
    case "package.resourcesChanged":
      return isPlainObject(payload) &&
        hasExactKeys(payload, ["packages"], ["session"]) &&
        isPackageSnapshot(payload.packages) &&
        (payload.session === undefined || isSessionSnapshot(payload.session))
        ? null
        : "invalid package.resourcesChanged payload";
    case "package.diagnostic":
      return isDiagnostic(payload) ? null : "invalid package.diagnostic payload";
    case "extensionUi.request":
      return isExtensionUiRequest(payload) ? null : "invalid extensionUi.request payload";
    case "extensionUi.statusChanged":
      return isPlainObject(payload) &&
        hasExactKeys(payload, ["text"], ["key"]) &&
        isOptionalString(payload.key) &&
        isString(payload.text)
        ? null
        : "invalid extensionUi.statusChanged payload";
    case "extensionUi.widgetChanged":
      return isPlainObject(payload) &&
        hasExactKeys(payload, ["widget"], ["key"]) &&
        isOptionalString(payload.key) &&
        isJsonValue(payload.widget)
        ? null
        : "invalid extensionUi.widgetChanged payload";
    case "extensionUi.notification":
      return isPlainObject(payload) &&
        hasExactKeys(payload, ["message", "level"]) &&
        isString(payload.message) &&
        isString(payload.level)
        ? null
        : "invalid extensionUi.notification payload";
  }
}
