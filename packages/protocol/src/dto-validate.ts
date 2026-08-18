import { HOST_ERROR_CODES } from "./errors.js";
import type { HostEventName } from "./events.js";
import {
  MAX_EXTENSION_UI_CORRELATION_ID_LENGTH,
  MAX_EXTENSION_UI_DEFAULT_VALUE_LENGTH,
  MAX_EXTENSION_UI_MESSAGE_LENGTH,
  MAX_EXTENSION_UI_OPTION_DESCRIPTION_LENGTH,
  MAX_EXTENSION_UI_OPTION_ID_LENGTH,
  MAX_EXTENSION_UI_OPTION_LABEL_LENGTH,
  MAX_EXTENSION_UI_OPTIONS,
  MAX_EXTENSION_UI_SOURCE_LABEL_LENGTH,
  MAX_EXTENSION_UI_TITLE_LENGTH,
  MAX_EXTENSION_MESSAGE_RENDER_CHARACTERS,
  MAX_EXTENSION_MESSAGE_RENDER_LINE_LENGTH,
  MAX_EXTENSION_MESSAGE_RENDER_LINES,
} from "./limits.js";
import type { HostMethod } from "./methods.js";
import type {
  AttachmentSnapshot,
  GitStatusSnapshot,
  RehydrateSnapshot,
  ToolSnapshot,
} from "./types.js";

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key))
  );
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

function isNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isBoundedNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isOptionalBoundedString(value: unknown, maxLength: number): boolean {
  return value === undefined || (typeof value === "string" && value.length <= maxLength);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength;
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
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ["code", "message", "retryable"], ["details"])
  ) {
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

function isModelConfigRecovery(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, ["journalId", "stage", "restored"]) &&
    isString(value.journalId) &&
    (value.stage === "prepared" || value.stage === "committed") &&
    typeof value.restored === "boolean"
  );
}

function isModelConfigHealth(value: unknown): boolean {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ["state", "source"], ["message", "migrationHint", "recovery"])
  ) {
    return false;
  }
  if (
    (value.state !== "ok" && value.state !== "error" && value.state !== "degraded") ||
    (value.source !== "ModelRegistry.getError" && value.source !== "provider.journal") ||
    !isOptionalString(value.message)
  ) {
    return false;
  }
  if (value.recovery !== undefined && !isModelConfigRecovery(value.recovery)) return false;
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
      ["extensionDecisionPresentation", "lastError", "fatalError"],
    )
  ) {
    return false;
  }
  const phases = [
    "booting",
    "waitingForWorkspace",
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
    hasExactKeys(caps, ["packageUpdateCheck", "extensionUi", "sessionExport"]) &&
    isBoolean(caps.packageUpdateCheck) &&
    caps.extensionUi === true &&
    isBoolean(caps.sessionExport) &&
    isModelConfigHealth(value.modelConfigHealth) &&
    (value.extensionDecisionPresentation === undefined ||
      ["legacy-modal", "auto", "inline-first"].includes(
        String(value.extensionDecisionPresentation),
      )) &&
    (value.lastError === undefined || isHostErrorRecord(value.lastError)) &&
    (value.fatalError === undefined || isHostErrorRecord(value.fatalError))
  );
}

export function isWorkspaceSnapshot(value: unknown): boolean {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ["id", "cwd", "canonicalCwd", "revision", "servicesReady"])
  ) {
    return false;
  }
  return (
    isUuid(value.id) &&
    isString(value.cwd) &&
    isString(value.canonicalCwd) &&
    isSafeRevision(value.revision) &&
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

function isProviderCompatibility(value: unknown, allowNull: boolean): boolean {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, [], ["supportsDeveloperRole", "supportsReasoningEffort"]) &&
    Object.values(value).every((item) => isBoolean(item) || (allowNull && item === null))
  );
}

export function isProviderDraft(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    hasExactKeys(
      value,
      ["id", "name", "baseUrl", "api", "headers", "models"],
      ["modelsUrl", "authHeader", "compat"],
    ) &&
    isString(value.id) &&
    value.id.trim().length > 0 &&
    isString(value.name) &&
    value.name.trim().length > 0 &&
    isString(value.baseUrl) &&
    value.baseUrl.trim().length > 0 &&
    (value.modelsUrl === undefined || isString(value.modelsUrl)) &&
    (PROVIDER_APIS as readonly string[]).includes(String(value.api)) &&
    (value.authHeader === undefined || isBoolean(value.authHeader)) &&
    isStringRecord(value.headers) &&
    (value.compat === undefined || isProviderCompatibility(value.compat, true)) &&
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
    hasExactKeys(
      value,
      ["id", "enabled", "name", "baseUrl", "api", "authHeader", "headers", "models", "auth"],
      ["modelsUrl", "compat"],
    ) &&
    isString(value.id) &&
    value.id.trim().length > 0 &&
    isBoolean(value.enabled) &&
    isString(value.name) &&
    value.name.trim().length > 0 &&
    isString(value.baseUrl) &&
    (value.modelsUrl === undefined || isString(value.modelsUrl)) &&
    (PROVIDER_APIS as readonly string[]).includes(String(value.api)) &&
    isBoolean(value.authHeader) &&
    isStringRecord(value.headers) &&
    (value.compat === undefined || isProviderCompatibility(value.compat, false)) &&
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
      [
        "id",
        "name",
        "reasoning",
        "input",
        "contextWindow",
        "maxTokens",
        "enabled",
        "thinkingSource",
      ],
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

function isBuiltinProviderModelChoice(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, ["id", "name", "enabled"]) &&
    isString(value.id) &&
    value.id.trim().length > 0 &&
    isString(value.name) &&
    isBoolean(value.enabled)
  );
}

function isBuiltinProviderAuthStatus(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    hasExactKeys(
      value,
      [
        "providerId",
        "name",
        "supportsOauth",
        "supportsApiKeyLogin",
        "configured",
        "hasStoredCredential",
        "enabled",
      ],
      ["oauthLabel", "authLabel"],
    ) &&
    isString(value.providerId) &&
    value.providerId.trim().length > 0 &&
    isString(value.name) &&
    isBoolean(value.supportsOauth) &&
    isOptionalString(value.oauthLabel) &&
    isBoolean(value.supportsApiKeyLogin) &&
    isBoolean(value.configured) &&
    isOptionalString(value.authLabel) &&
    isBoolean(value.hasStoredCredential) &&
    isBoolean(value.enabled)
  );
}

function isProviderLoginPrompt(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, ["promptId", "kind", "message"], ["placeholder", "options"]) &&
    isString(value.promptId) &&
    value.promptId.trim().length > 0 &&
    ["text", "secret", "select", "manual_code"].includes(String(value.kind)) &&
    isString(value.message) &&
    isOptionalString(value.placeholder) &&
    (value.options === undefined ||
      (Array.isArray(value.options) &&
        value.options.every(
          (option) =>
            isPlainObject(option) &&
            hasExactKeys(option, ["id", "label"], ["description"]) &&
            isString(option.id) &&
            isString(option.label) &&
            isOptionalString(option.description),
        )))
  );
}

function isProviderLoginFlowEvent(value: unknown): boolean {
  if (!isPlainObject(value) || !isString(value.kind)) return false;
  switch (value.kind) {
    case "info":
      return (
        hasExactKeys(value, ["kind", "message"], ["links"]) &&
        isString(value.message) &&
        (value.links === undefined ||
          (Array.isArray(value.links) &&
            value.links.every(
              (link) =>
                isPlainObject(link) &&
                hasExactKeys(link, ["url"], ["label"]) &&
                isString(link.url) &&
                isOptionalString(link.label),
            )))
      );
    case "auth_url":
      return (
        hasExactKeys(value, ["kind", "url"], ["instructions"]) &&
        isString(value.url) &&
        isOptionalString(value.instructions)
      );
    case "device_code":
      return (
        hasExactKeys(value, ["kind", "userCode", "verificationUri"], ["expiresInSeconds"]) &&
        isString(value.userCode) &&
        isString(value.verificationUri) &&
        (value.expiresInSeconds === undefined || isSafeRevision(value.expiresInSeconds))
      );
    case "progress":
      return hasExactKeys(value, ["kind", "message"]) && isString(value.message);
    case "prompt":
      return hasExactKeys(value, ["kind", "prompt"]) && isProviderLoginPrompt(value.prompt);
    case "prompt_cancel":
      return hasExactKeys(value, ["kind", "promptId"]) && isString(value.promptId);
    case "done":
      return (
        hasExactKeys(value, ["kind", "ok"], ["message"]) &&
        isBoolean(value.ok) &&
        isOptionalString(value.message)
      );
    default:
      return false;
  }
}

export function isSerializableAgentContent(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    isString(value.type) &&
    (value.text === undefined || isString(value.text)) &&
    Object.entries(value).every(
      ([key, item]) => key === "type" || key === "text" || item === undefined || isJsonValue(item),
    )
  );
}

function isSerializableUsage(value: unknown): boolean {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(
      value,
      ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"],
      ["cacheWrite1h", "reasoning"],
    ) ||
    ![value.input, value.output, value.cacheRead, value.cacheWrite, value.totalTokens].every(
      isSafeRevision,
    ) ||
    (value.cacheWrite1h !== undefined && !isSafeRevision(value.cacheWrite1h)) ||
    (value.reasoning !== undefined && !isSafeRevision(value.reasoning)) ||
    !isPlainObject(value.cost) ||
    !hasExactKeys(value.cost, ["input", "output", "cacheRead", "cacheWrite", "total"])
  ) {
    return false;
  }
  return [
    value.cost.input,
    value.cost.output,
    value.cost.cacheRead,
    value.cost.cacheWrite,
    value.cost.total,
  ].every(isNonNegativeNumber);
}

function isAgentMessage(value: unknown): boolean {
  if (!isPlainObject(value) || !isString(value.role)) return false;
  if (!(
    typeof value.content === "string" ||
    (Array.isArray(value.content) && value.content.every(isSerializableAgentContent))
  )) {
    return false;
  }
  if (value.usage !== undefined && !isSerializableUsage(value.usage)) return false;
  return Object.entries(value).every(
    ([key, item]) => key === "role" || key === "content" || item === undefined || isJsonValue(item),
  );
}

function isSessionContextBreakdown(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, [
      "systemPrompt",
      "toolDefinitions",
      "userPrompts",
      "assistantMessages",
      "toolResults",
      "summaries",
      "other",
    ]) &&
    [
      value.systemPrompt,
      value.toolDefinitions,
      value.userPrompts,
      value.assistantMessages,
      value.toolResults,
      value.summaries,
      value.other,
    ].every(isSafeRevision)
  );
}

function isSerializableCompactionResult(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    isOptionalString(value.summary) &&
    (value.tokensBefore === undefined || isFiniteNumber(value.tokensBefore)) &&
    (value.tokensAfter === undefined || isFiniteNumber(value.tokensAfter)) &&
    Object.entries(value).every(
      ([key, item]) =>
        key === "summary" ||
        key === "tokensBefore" ||
        key === "tokensAfter" ||
        item === undefined ||
        isJsonValue(item),
    )
  );
}

function isSerializableAssistantMessageEvent(value: unknown): boolean {
  if (!isPlainObject(value) || !isString(value.type)) return false;
  switch (value.type) {
    case "start":
      return hasExactKeys(value, ["type"]);
    case "text_start":
    case "thinking_start":
      return hasExactKeys(value, ["type", "contentIndex"]) && isSafeRevision(value.contentIndex);
    case "text_delta":
    case "thinking_delta":
    case "toolcall_delta":
      return (
        hasExactKeys(value, ["type", "contentIndex", "delta"]) &&
        isSafeRevision(value.contentIndex) &&
        isString(value.delta)
      );
    case "text_end":
    case "thinking_end":
      return (
        hasExactKeys(value, ["type", "contentIndex", "content"]) &&
        isSafeRevision(value.contentIndex) &&
        isString(value.content)
      );
    case "toolcall_start":
      return (
        hasExactKeys(value, ["type", "contentIndex", "id", "name"]) &&
        isSafeRevision(value.contentIndex) &&
        isString(value.id) &&
        isString(value.name)
      );
    case "toolcall_end":
      return (
        hasExactKeys(value, ["type", "contentIndex", "toolCall"]) &&
        isSafeRevision(value.contentIndex) &&
        isSerializableAgentContent(value.toolCall)
      );
    case "done":
      return hasExactKeys(value, ["type", "reason"]) && isString(value.reason);
    case "error":
      return (
        hasExactKeys(value, ["type", "reason"], ["errorMessage"]) &&
        isString(value.reason) &&
        isOptionalString(value.errorMessage)
      );
    default:
      return false;
  }
}

function isSerializableAgentSessionEvent(value: unknown): boolean {
  if (!isPlainObject(value) || !isString(value.type)) return false;
  if (value.type === "message_update") {
    return (
      hasExactKeys(value, ["type", "assistantMessageEvent"]) &&
      isSerializableAssistantMessageEvent(value.assistantMessageEvent)
    );
  }
  return Object.entries(value).every(
    ([key, item]) => key === "type" || item === undefined || isJsonValue(item),
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
    hasExactKeys(value, [
      "revision",
      "workspaceId",
      "sessionId",
      "sessionRevision",
      "tools",
      "active",
    ]) &&
    isSafeRevision(value.revision) &&
    isUuid(value.workspaceId) &&
    isUuid(value.sessionId) &&
    isSafeRevision(value.sessionRevision) &&
    Array.isArray(value.tools) &&
    value.tools.every(isToolInfo) &&
    isStringArray(value.active)
  );
}

function isQueueSnapshot(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, ["revision", "steering", "followUp"]) &&
    isSafeRevision(value.revision) &&
    isStringArray(value.steering) &&
    isStringArray(value.followUp)
  );
}

function isExtensionMessageRenderLines(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_EXTENSION_MESSAGE_RENDER_LINES &&
    value.every(
      (line) => typeof line === "string" && line.length <= MAX_EXTENSION_MESSAGE_RENDER_LINE_LENGTH,
    ) &&
    value.reduce((total, line) => total + line.length, 0) <= MAX_EXTENSION_MESSAGE_RENDER_CHARACTERS
  );
}

function isExtensionMessageRenderSnapshot(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, ["version", "collapsed", "expanded"], ["messageIndex"]) &&
    value.version === 1 &&
    isExtensionMessageRenderLines(value.collapsed) &&
    isExtensionMessageRenderLines(value.expanded) &&
    (value.messageIndex === undefined || isSafeRevision(value.messageIndex))
  );
}

function isExtensionMessageRenderMap(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    Object.entries(value).every(
      ([entryId, render]) => entryId.length > 0 && isExtensionMessageRenderSnapshot(render),
    )
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
      [
        "sessionPath",
        "name",
        "model",
        "contextUsage",
        "entries",
        "leafId",
        "extensionMessageRenders",
      ],
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
    (value.contextUsage === undefined ||
      (isPlainObject(value.contextUsage) &&
        hasExactKeys(value.contextUsage, ["tokens", "contextWindow"], ["breakdown"]) &&
        (value.contextUsage.tokens === null || isSafeRevision(value.contextUsage.tokens)) &&
        isSafeRevision(value.contextUsage.contextWindow) &&
        value.contextUsage.contextWindow > 0 &&
        (value.contextUsage.breakdown === undefined ||
          isSessionContextBreakdown(value.contextUsage.breakdown)))) &&
    isString(value.thinkingLevel) &&
    isBoolean(value.autoCompactionEnabled) &&
    isBoolean(value.autoRetryEnabled) &&
    ["all", "one-at-a-time"].includes(String(value.steeringMode)) &&
    ["all", "one-at-a-time"].includes(String(value.followUpMode)) &&
    isPlainObject(pending) &&
    hasExactKeys(pending, ["revision", "steering", "followUp"]) &&
    isSafeRevision(pending.revision) &&
    isStringArray(pending.steering) &&
    isStringArray(pending.followUp) &&
    Array.isArray(value.messages) &&
    value.messages.every(isAgentMessage) &&
    (value.entries === undefined ||
      (Array.isArray(value.entries) && value.entries.every(isSessionEntry))) &&
    (value.leafId === undefined || value.leafId === null || isString(value.leafId)) &&
    (value.extensionMessageRenders === undefined ||
      isExtensionMessageRenderMap(value.extensionMessageRenders)) &&
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

function isSessionUsageReportItem(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    hasExactKeys(
      value,
      ["sessionId", "sessionPath", "updatedAt", "archived", "messageCount", "usage"],
      ["name"],
    ) &&
    isUuid(value.sessionId) &&
    isString(value.sessionPath) &&
    isOptionalString(value.name) &&
    isNonNegativeNumber(value.updatedAt) &&
    isBoolean(value.archived) &&
    isSafeRevision(value.messageCount) &&
    isSerializableUsage(value.usage)
  );
}

function isSessionUsageReport(value: unknown): boolean {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ["workspaceId", "generatedAt", "totals", "sessions"]) ||
    !isUuid(value.workspaceId) ||
    !isNonNegativeNumber(value.generatedAt) ||
    !isPlainObject(value.totals) ||
    !hasExactKeys(value.totals, ["sessionCount", "messageCount", "usage"]) ||
    !isSafeRevision(value.totals.sessionCount) ||
    !isSafeRevision(value.totals.messageCount) ||
    !isSerializableUsage(value.totals.usage) ||
    !Array.isArray(value.sessions) ||
    !value.sessions.every(isSessionUsageReportItem)
  ) {
    return false;
  }
  return value.totals.sessionCount === value.sessions.length;
}

function isPackageCatalogItem(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    hasExactKeys(
      value,
      ["name", "description", "types", "searchText", "installSource", "pageUrl"],
      ["author", "downloadsPerMonth", "publishedAt", "npmUrl", "githubUrl"],
    ) &&
    isString(value.name) &&
    value.name.length > 0 &&
    isString(value.description) &&
    Array.isArray(value.types) &&
    value.types.every(isString) &&
    isOptionalString(value.author) &&
    (value.downloadsPerMonth === undefined || isNonNegativeNumber(value.downloadsPerMonth)) &&
    (value.publishedAt === undefined || isNonNegativeNumber(value.publishedAt)) &&
    isOptionalString(value.npmUrl) &&
    isOptionalString(value.githubUrl) &&
    isString(value.searchText) &&
    isString(value.installSource) &&
    value.installSource.length > 0 &&
    isString(value.pageUrl)
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isPackageCatalog(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, [
      "generatedAt",
      "fromCache",
      "items",
      "page",
      "pageSize",
      "total",
      "lastPage",
    ]) &&
    isNonNegativeNumber(value.generatedAt) &&
    isBoolean(value.fromCache) &&
    Array.isArray(value.items) &&
    value.items.every(isPackageCatalogItem) &&
    isPositiveSafeInteger(value.page) &&
    isPositiveSafeInteger(value.pageSize) &&
    isNonNegativeNumber(value.total) &&
    Number.isSafeInteger(value.total) &&
    isPositiveSafeInteger(value.lastPage)
  );
}

function isSessionSearchMatch(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, ["role", "snippet"]) &&
    (value.role === "user" || value.role === "assistant") &&
    isString(value.snippet)
  );
}

function isSessionSearchResultItem(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    hasExactKeys(
      value,
      [
        "sessionId",
        "sessionPath",
        "cwd",
        "archived",
        "updatedAt",
        "matchCount",
        "matches",
        "nameMatched",
      ],
      ["name"],
    ) &&
    isUuid(value.sessionId) &&
    isString(value.sessionPath) &&
    isOptionalString(value.name) &&
    isString(value.cwd) &&
    isBoolean(value.archived) &&
    isNonNegativeNumber(value.updatedAt) &&
    isSafeRevision(value.matchCount) &&
    Array.isArray(value.matches) &&
    value.matches.every(isSessionSearchMatch) &&
    isBoolean(value.nameMatched)
  );
}

function isSessionSearchReport(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, ["generatedAt", "query", "scannedCount", "truncated", "items"]) &&
    isNonNegativeNumber(value.generatedAt) &&
    isString(value.query) &&
    isSafeRevision(value.scannedCount) &&
    isBoolean(value.truncated) &&
    Array.isArray(value.items) &&
    value.items.every(isSessionSearchResultItem)
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
        "identity",
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
      [
        "installedPath",
        "description",
        "versionOrRef",
        "updateAvailable",
        "shadowedByPackageId",
        "overridesPackageId",
        "projectOverride",
      ],
    ) &&
    isString(value.id) &&
    isString(value.identity) &&
    isString(value.source) &&
    ["npm", "git", "local"].includes(String(value.kind)) &&
    ["user", "project"].includes(String(value.scope)) &&
    isBoolean(value.filtered) &&
    isBoolean(value.installed) &&
    isOptionalString(value.installedPath) &&
    isString(value.displayName) &&
    isOptionalString(value.description) &&
    isOptionalString(value.versionOrRef) &&
    (value.updateAvailable === undefined || isBoolean(value.updateAvailable)) &&
    isBoolean(value.effective) &&
    isOptionalString(value.shadowedByPackageId) &&
    isOptionalString(value.overridesPackageId) &&
    (value.projectOverride === undefined ||
      (isPlainObject(value.projectOverride) &&
        hasExactKeys(value.projectOverride, ["source", "overrideCount"]) &&
        isString(value.projectOverride.source) &&
        isSafeRevision(value.projectOverride.overrideCount))) &&
    (value.resourceCounts === null || isResourceCounts(value.resourceCounts)) &&
    ["resolvedEffective", "unknownShadowed"].includes(String(value.resourceCountsState))
  );
}

function isResourceControl(value: unknown): boolean {
  if (!isPlainObject(value) || !isString(value.kind)) return false;
  switch (value.kind) {
    case "preference":
      return (
        hasExactKeys(value, ["kind", "scopes"]) &&
        Array.isArray(value.scopes) &&
        value.scopes.every((scope) => scope === "user" || scope === "project")
      );
    case "owner-extension":
      return hasExactKeys(value, ["kind", "ownerResourceId"]) && isString(value.ownerResourceId);
    case "read-only":
      return hasExactKeys(value, ["kind", "reason"]) && isString(value.reason);
    default:
      return false;
  }
}

function isResourceRecord(value: unknown): boolean {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(
      value,
      [
        "id",
        "type",
        "name",
        "path",
        "scope",
        "origin",
        "source",
        "enabled",
        "preferences",
        "control",
        "diagnostics",
      ],
      ["description", "relativePath", "packageId", "manualOnly"],
    ) ||
    !isString(value.id) ||
    !["extension", "skill", "prompt", "theme"].includes(String(value.type)) ||
    !isString(value.name) ||
    !isOptionalString(value.description) ||
    !isString(value.path) ||
    !isOptionalString(value.relativePath) ||
    !["user", "project", "temporary"].includes(String(value.scope)) ||
    !["package", "top-level", "extension"].includes(String(value.origin)) ||
    !isString(value.source) ||
    !isOptionalString(value.packageId) ||
    !isBoolean(value.enabled) ||
    !isPlainObject(value.preferences) ||
    !hasExactKeys(value.preferences, [], ["user", "project"]) ||
    (value.preferences.user !== undefined &&
      value.preferences.user !== "enabled" &&
      value.preferences.user !== "disabled") ||
    (value.preferences.project !== undefined &&
      !["inherit", "enabled", "disabled"].includes(String(value.preferences.project))) ||
    !isResourceControl(value.control) ||
    (value.manualOnly !== undefined && !isBoolean(value.manualOnly)) ||
    !Array.isArray(value.diagnostics) ||
    !value.diagnostics.every(isDiagnostic)
  ) {
    return false;
  }
  return true;
}

export function isPackageSnapshot(value: unknown): boolean {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(
      value,
      ["revision", "workspaceId", "scope", "configured", "resources", "updateCheck", "diagnostics"],
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
    Array.isArray(value.resources) &&
    value.resources.every(isResourceRecord) &&
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

function isRehydrateSnapshot(value: unknown): value is RehydrateSnapshot {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ["watermark", "host", "workspace", "session", "tools", "packages"]) ||
    !isSafeRevision(value.watermark) ||
    !isHostStatusSnapshot(value.host) ||
    !(value.workspace === null || isWorkspaceSnapshot(value.workspace)) ||
    !(value.session === null || isSessionSnapshot(value.session)) ||
    !(value.tools === null || isToolSnapshot(value.tools)) ||
    !(value.packages === null || isPackageSnapshot(value.packages))
  ) {
    return false;
  }

  const { host, workspace, session, tools, packages } = value as RehydrateSnapshot;
  if (workspace === null) {
    return (
      host.workspaceId === null &&
      host.sessionId === null &&
      session === null &&
      tools === null &&
      packages === null
    );
  }
  if (workspace.id !== host.workspaceId || workspace.revision !== host.workspaceRevision) {
    return false;
  }
  if (session === null) {
    if (host.sessionId !== null || tools !== null) return false;
  } else if (
    session.sessionId !== host.sessionId ||
    session.revision !== host.sessionRevision ||
    tools === null ||
    tools.workspaceId !== workspace.id ||
    tools.sessionId !== session.sessionId ||
    tools.sessionRevision !== session.revision
  ) {
    return false;
  }
  return (
    packages === null ||
    (packages.workspaceId === workspace.id && packages.revision === host.packageRevision)
  );
}

function isPackageMutationResult(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    hasExactKeys(
      value,
      ["operationId", "status", "packageSnapshot", "warnings", "reconcileRequired"],
      ["session"],
    ) &&
    isUuid(value.operationId) &&
    ["committed", "partialFailure", "failed"].includes(String(value.status)) &&
    isPackageSnapshot(value.packageSnapshot) &&
    (value.session === undefined || isSessionSnapshot(value.session)) &&
    Array.isArray(value.warnings) &&
    value.warnings.every(isHostErrorRecord) &&
    isBoolean(value.reconcileRequired)
  );
}

function isExtensionUiOrigin(value: unknown): boolean {
  if (!isPlainObject(value) || !isString(value.invocationKind)) return false;
  if (value.invocationKind === "unknown") {
    return hasExactKeys(value, ["invocationKind"]);
  }
  const baseKeys = ["invocationKind", "extensionId", "extensionDisplayName", "sourceKind"];
  if (
    !isBoundedNonEmptyString(value.extensionId, 128) ||
    !isBoundedNonEmptyString(value.extensionDisplayName, 120) ||
    !["package", "user", "project", "synthetic"].includes(String(value.sourceKind))
  ) {
    return false;
  }
  switch (value.invocationKind) {
    case "tool":
      return (
        hasExactKeys(value, [...baseKeys, "toolName", "toolCallId"]) &&
        isBoundedNonEmptyString(value.toolName, 256) &&
        isBoundedNonEmptyString(value.toolCallId, 256)
      );
    case "command":
      return (
        hasExactKeys(value, [...baseKeys, "commandName"]) &&
        isBoundedNonEmptyString(value.commandName, 256)
      );
    case "shortcut":
      return (
        hasExactKeys(value, [...baseKeys, "shortcut"]) &&
        isBoundedNonEmptyString(value.shortcut, 128)
      );
    case "event":
      return (
        hasExactKeys(value, [...baseKeys, "eventType"], ["toolName", "toolCallId"]) &&
        isBoundedNonEmptyString(value.eventType, 256) &&
        (value.toolName === undefined || isBoundedNonEmptyString(value.toolName, 256)) &&
        (value.toolCallId === undefined || isBoundedNonEmptyString(value.toolCallId, 256))
      );
    case "background":
      return hasExactKeys(value, baseKeys);
    default:
      return false;
  }
}

function isExtensionUiRequest(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    hasExactKeys(
      value,
      ["requestId", "kind"],
      [
        "title",
        "message",
        "options",
        "defaultValue",
        "timeoutMs",
        "sourceLabel",
        "correlationId",
        "presentationHint",
        "riskHint",
        "presentation",
        "risk",
        "routeReason",
        "groupKey",
        "allowFreeform",
        "origin",
      ],
    ) &&
    isUuid(value.requestId) &&
    ["select", "confirm", "input", "editor"].includes(String(value.kind)) &&
    isOptionalBoundedString(value.title, MAX_EXTENSION_UI_TITLE_LENGTH) &&
    isOptionalBoundedString(value.message, MAX_EXTENSION_UI_MESSAGE_LENGTH) &&
    (value.options === undefined ||
      (Array.isArray(value.options) &&
        value.options.length <= MAX_EXTENSION_UI_OPTIONS &&
        value.options.every(
          (item) =>
            isPlainObject(item) &&
            hasExactKeys(item, ["id", "label"], ["description", "destructive"]) &&
            isBoundedString(item.id, MAX_EXTENSION_UI_OPTION_ID_LENGTH) &&
            isBoundedString(item.label, MAX_EXTENSION_UI_OPTION_LABEL_LENGTH) &&
            isOptionalBoundedString(item.description, MAX_EXTENSION_UI_OPTION_DESCRIPTION_LENGTH) &&
            (item.destructive === undefined || isBoolean(item.destructive)),
        ))) &&
    isOptionalBoundedString(value.defaultValue, MAX_EXTENSION_UI_DEFAULT_VALUE_LENGTH) &&
    (value.timeoutMs === undefined || isSafeRevision(value.timeoutMs)) &&
    isOptionalBoundedString(value.sourceLabel, MAX_EXTENSION_UI_SOURCE_LABEL_LENGTH) &&
    isOptionalBoundedString(value.correlationId, MAX_EXTENSION_UI_CORRELATION_ID_LENGTH) &&
    (value.presentationHint === undefined ||
      ["inline", "modal"].includes(String(value.presentationHint))) &&
    (value.riskHint === undefined || ["normal", "high"].includes(String(value.riskHint))) &&
    (value.presentation === undefined ||
      ["inline", "modal"].includes(String(value.presentation))) &&
    (value.risk === undefined || ["normal", "high"].includes(String(value.risk))) &&
    (value.routeReason === undefined ||
      [
        "stale-owner",
        "explicit-modal",
        "explicit-inline",
        "high-risk",
        "destructive-option",
        "project-trust",
        "session-lifecycle",
        "active-tool",
        "active-command",
        "background-session",
        "inline-unavailable",
        "unknown-origin",
      ].includes(String(value.routeReason))) &&
    (value.groupKey === undefined || isBoundedNonEmptyString(value.groupKey, 256)) &&
    (value.allowFreeform === undefined || isBoolean(value.allowFreeform)) &&
    (value.origin === undefined || isExtensionUiOrigin(value.origin))
  );
}

function isSessionEntry(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    isString(value.id) &&
    isString(value.type) &&
    Object.values(value).every(isJsonValue)
  );
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

function isAttachmentSnapshot(value: unknown): value is AttachmentSnapshot {
  return (
    isPlainObject(value) &&
    hasExactKeys(
      value,
      ["id", "name", "mediaType", "sizeBytes", "status"],
      ["unit", "unitCount", "processedUnits", "error"],
    ) &&
    isUuid(value.id) &&
    isBoundedNonEmptyString(value.name, 1_024) &&
    [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "text/plain",
    ].includes(String(value.mediaType)) &&
    isSafeRevision(value.sizeBytes) &&
    ["copying", "parsing", "ready", "needs_ocr", "failed"].includes(String(value.status)) &&
    (value.unit === undefined || value.unit === "page" || value.unit === "chunk") &&
    (value.unitCount === undefined || isSafeRevision(value.unitCount)) &&
    (value.processedUnits === undefined || isSafeRevision(value.processedUnits)) &&
    isOptionalString(value.error)
  );
}

const GIT_CHANGE_KINDS = new Set([
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "type_changed",
  "untracked",
  "conflicted",
]);

function isGitChangeKind(value: unknown): boolean {
  return value === null || (typeof value === "string" && GIT_CHANGE_KINDS.has(value));
}

function isGitFileChange(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    hasExactKeys(
      value,
      ["path", "staged", "unstaged", "conflict", "submodule", "pathSupported"],
      ["originalPath"],
    ) &&
    isString(value.path) &&
    (value.originalPath === undefined || isString(value.originalPath)) &&
    isGitChangeKind(value.staged) &&
    isGitChangeKind(value.unstaged) &&
    isBoolean(value.conflict) &&
    isBoolean(value.submodule) &&
    isBoolean(value.pathSupported)
  );
}

function isGitStatusSnapshot(value: unknown): value is GitStatusSnapshot {
  if (!isPlainObject(value) || !isSafeRevision(value.revision) || !isString(value.state)) {
    return false;
  }
  if (value.state === "not_repository") {
    return hasExactKeys(value, ["state", "revision"]);
  }
  if (value.state === "unavailable" || value.state === "error") {
    return hasExactKeys(value, ["state", "revision", "message"]) && isString(value.message);
  }
  return (
    value.state === "ready" &&
    hasExactKeys(value, [
      "state",
      "revision",
      "repositoryRoot",
      "workspaceIsRepositoryRoot",
      "branch",
      "detached",
      "unborn",
      "headSha",
      "upstream",
      "ahead",
      "behind",
      "indexGeneration",
      "files",
      "warnings",
    ]) &&
    isString(value.repositoryRoot) &&
    isBoolean(value.workspaceIsRepositoryRoot) &&
    (value.branch === null || isString(value.branch)) &&
    isBoolean(value.detached) &&
    isBoolean(value.unborn) &&
    (value.headSha === null || isString(value.headSha)) &&
    (value.upstream === null || isString(value.upstream)) &&
    isSafeRevision(value.ahead) &&
    isSafeRevision(value.behind) &&
    isString(value.indexGeneration) &&
    /^[0-9a-f]{64}$/.test(value.indexGeneration) &&
    Array.isArray(value.files) &&
    value.files.every(isGitFileChange) &&
    isStringArray(value.warnings)
  );
}

function isGitDiffSnapshot(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, [
      "path",
      "area",
      "patch",
      "additions",
      "deletions",
      "binary",
      "truncated",
      "contentGeneration",
      "hunks",
      "hunkOperations",
    ]) &&
    isString(value.path) &&
    (value.area === "staged" || value.area === "unstaged") &&
    isString(value.patch) &&
    isSafeRevision(value.additions) &&
    isSafeRevision(value.deletions) &&
    isBoolean(value.binary) &&
    isBoolean(value.truncated) &&
    isString(value.contentGeneration) &&
    /^[0-9a-f]{64}$/.test(value.contentGeneration) &&
    Array.isArray(value.hunks) &&
    value.hunks.every(isGitDiffHunk) &&
    Array.isArray(value.hunkOperations) &&
    value.hunkOperations.every(
      (operation) => operation === "stage" || operation === "unstage" || operation === "discard",
    ) &&
    new Set(value.hunkOperations).size === value.hunkOperations.length
  );
}

function isGitDiffHunk(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, [
      "id",
      "header",
      "oldStart",
      "oldLines",
      "newStart",
      "newLines",
      "additions",
      "deletions",
    ]) &&
    isString(value.id) &&
    /^[0-9a-f]{64}$/.test(value.id) &&
    isString(value.header) &&
    isSafeRevision(value.oldStart) &&
    isSafeRevision(value.oldLines) &&
    isSafeRevision(value.newStart) &&
    isSafeRevision(value.newLines) &&
    isSafeRevision(value.additions) &&
    isSafeRevision(value.deletions)
  );
}

function isGitSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40,64}$/.test(value);
}

function isGitBranchList(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, ["statusRevision", "current", "detached", "branches", "truncated"]) &&
    isSafeRevision(value.statusRevision) &&
    (value.current === null || isString(value.current)) &&
    isBoolean(value.detached) &&
    Array.isArray(value.branches) &&
    value.branches.every(
      (branch) =>
        isPlainObject(branch) &&
        hasExactKeys(branch, ["name", "current", "upstream", "ahead", "behind"]) &&
        isString(branch.name) &&
        isBoolean(branch.current) &&
        (branch.upstream === null || isString(branch.upstream)) &&
        isSafeRevision(branch.ahead) &&
        isSafeRevision(branch.behind),
    ) &&
    isBoolean(value.truncated)
  );
}

function isGitHistoryResult(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, ["commits", "nextCursor"]) &&
    Array.isArray(value.commits) &&
    value.commits.every(
      (commit) =>
        isPlainObject(commit) &&
        hasExactKeys(commit, [
          "sha",
          "shortSha",
          "parents",
          "authorName",
          "authoredAt",
          "subject",
          "refs",
        ]) &&
        isGitSha(commit.sha) &&
        isString(commit.shortSha) &&
        Array.isArray(commit.parents) &&
        commit.parents.every(isGitSha) &&
        isString(commit.authorName) &&
        isString(commit.authoredAt) &&
        isString(commit.subject) &&
        isStringArray(commit.refs),
    ) &&
    (value.nextCursor === null || isGitSha(value.nextCursor))
  );
}

function isGitCommitDiffSnapshot(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, [
      "commitSha",
      "parentSha",
      "patch",
      "additions",
      "deletions",
      "binary",
      "truncated",
    ]) &&
    isGitSha(value.commitSha) &&
    (value.parentSha === null || isGitSha(value.parentSha)) &&
    isString(value.patch) &&
    isSafeRevision(value.additions) &&
    isSafeRevision(value.deletions) &&
    isBoolean(value.binary) &&
    isBoolean(value.truncated)
  );
}

function isGitMutationResult(value: unknown, commit: boolean): boolean {
  if (!isPlainObject(value)) return false;
  const required = commit ? ["applied", "commitSha"] : ["applied"];
  if (!hasExactKeys(value, required, ["snapshot", "warning"])) return false;
  return (
    value.applied === true &&
    (!commit || value.commitSha === null || isString(value.commitSha)) &&
    (value.snapshot === undefined || isGitStatusSnapshot(value.snapshot)) &&
    (value.warning === undefined || isString(value.warning))
  );
}

export function validateMethodResultShape(method: HostMethod, result: unknown): string | null {
  const exactAccepted = () =>
    isPlainObject(result) && hasExactKeys(result, ["accepted"]) && result.accepted === true;
  switch (method) {
    case "system.hello":
    case "system.getStatus":
      return isHostStatusSnapshot(result) ? null : "invalid HostStatusSnapshot";
    case "system.rehydrate":
      return isRehydrateSnapshot(result) ? null : "invalid RehydrateSnapshot";
    case "system.shutdown":
      return exactAccepted() ? null : "shutdown result must be { accepted: true }";
    case "workspace.setCurrent":
      return isPlainObject(result) &&
        hasExactKeys(result, ["workspace"], ["session"]) &&
        isWorkspaceSnapshot(result.workspace) &&
        (result.session === undefined || isSessionSnapshot(result.session))
        ? null
        : "invalid workspace.setCurrent result";
    case "workspace.getCurrent":
      return result === null || isWorkspaceSnapshot(result) ? null : "invalid workspace snapshot";
    case "attachment.create":
    case "attachment.createText":
    case "attachment.get":
      return isAttachmentSnapshot(result) ? null : `invalid ${method} result`;
    case "attachment.remove":
      return isPlainObject(result) &&
        hasExactKeys(result, ["attachmentId", "removed"]) &&
        isUuid(result.attachmentId) &&
        result.removed === true
        ? null
        : "invalid attachment.remove result";
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
    case "session.rename":
      return isPlainObject(result) &&
        hasExactKeys(result, ["sessionId", "name"], ["session"]) &&
        isUuid(result.sessionId) &&
        isString(result.name) &&
        (result.session === undefined || isSessionSnapshot(result.session))
        ? null
        : "invalid session.rename result";
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
    case "workspace.searchFiles":
      return isPlainObject(result) &&
        hasExactKeys(result, ["files", "truncated"]) &&
        typeof result.truncated === "boolean" &&
        Array.isArray(result.files) &&
        result.files.every(
          (f) =>
            isPlainObject(f) &&
            hasExactKeys(f, ["path", "kind"]) &&
            isString(f.path) &&
            (f.kind === "file" || f.kind === "dir"),
        )
        ? null
        : "invalid workspace.searchFiles result";
    case "workspace.listDirectory":
      return isPlainObject(result) &&
        hasExactKeys(result, ["path", "entries"]) &&
        isString(result.path) &&
        Array.isArray(result.entries) &&
        result.entries.every(
          (entry) =>
            isPlainObject(entry) &&
            hasExactKeys(entry, ["name", "path", "kind", "symlink"]) &&
            isString(entry.name) &&
            isString(entry.path) &&
            (entry.kind === "file" || entry.kind === "dir") &&
            isBoolean(entry.symlink),
        )
        ? null
        : "invalid workspace.listDirectory result";
    case "workspace.setDirectoryWatches":
      return isPlainObject(result) &&
        hasExactKeys(result, ["paths"]) &&
        Array.isArray(result.paths) &&
        result.paths.every(isString)
        ? null
        : "invalid workspace.setDirectoryWatches result";
    case "git.getStatus":
      return isGitStatusSnapshot(result) ? null : "invalid git.getStatus result";
    case "git.setWatching":
      return isPlainObject(result) &&
        hasExactKeys(result, ["watching", "snapshot"]) &&
        isBoolean(result.watching) &&
        (result.snapshot === null || isGitStatusSnapshot(result.snapshot))
        ? null
        : "invalid git.setWatching result";
    case "git.getDiff":
      return isGitDiffSnapshot(result) ? null : "invalid git.getDiff result";
    case "git.listBranches":
      return isGitBranchList(result) ? null : "invalid git.listBranches result";
    case "git.listHistory":
      return isGitHistoryResult(result) ? null : "invalid git.listHistory result";
    case "git.getCommitDiff":
      return isGitCommitDiffSnapshot(result) ? null : "invalid git.getCommitDiff result";
    case "git.mutateHunk":
    case "git.stage":
    case "git.stageAll":
    case "git.unstage":
    case "git.unstageAll":
    case "git.discard":
    case "git.createBranch":
    case "git.switchBranch":
      return isGitMutationResult(result, false) ? null : `invalid ${method} result`;
    case "git.commit":
      return isGitMutationResult(result, true) ? null : "invalid git.commit result";
    case "session.getCommands":
      return isPlainObject(result) &&
        hasExactKeys(result, ["commands"]) &&
        Array.isArray(result.commands) &&
        result.commands.every(
          (t) =>
            isPlainObject(t) &&
            hasExactKeys(t, ["invocation", "description", "kind"], ["argumentHint"]) &&
            isString(t.invocation) &&
            isString(t.description) &&
            (t.kind === "template" || t.kind === "command" || t.kind === "skill") &&
            (t.argumentHint === undefined || isString(t.argumentHint)),
        )
        ? null
        : "invalid session.getCommands result";
    case "session.getStats":
      return isPlainObject(result) &&
        hasExactKeys(
          result,
          ["messageCount"],
          [
            "toolCallCount",
            "tokenUsage",
            "userMessageCount",
            "assistantMessageCount",
            "toolResultCount",
            "tokens",
            "cost",
            "sessionFile",
          ],
        ) &&
        isSafeRevision(result.messageCount) &&
        (result.toolCallCount === undefined || isSafeRevision(result.toolCallCount)) &&
        (result.tokenUsage === undefined || isJsonValue(result.tokenUsage)) &&
        (result.userMessageCount === undefined || isSafeRevision(result.userMessageCount)) &&
        (result.assistantMessageCount === undefined ||
          isSafeRevision(result.assistantMessageCount)) &&
        (result.toolResultCount === undefined || isSafeRevision(result.toolResultCount)) &&
        (result.tokens === undefined ||
          (isPlainObject(result.tokens) &&
            hasExactKeys(result.tokens, ["input", "output", "cacheRead", "cacheWrite", "total"]) &&
            isFiniteNumber(result.tokens.input) &&
            isFiniteNumber(result.tokens.output) &&
            isFiniteNumber(result.tokens.cacheRead) &&
            isFiniteNumber(result.tokens.cacheWrite) &&
            isFiniteNumber(result.tokens.total))) &&
        (result.cost === undefined || isFiniteNumber(result.cost)) &&
        (result.sessionFile === undefined || isString(result.sessionFile))
        ? null
        : "invalid session stats";
    case "session.usageReport":
      return isSessionUsageReport(result) ? null : "invalid session usage report";
    case "session.searchAll":
      return isSessionSearchReport(result) ? null : "invalid session search report";
    case "session.getForkPoints":
      return isPlainObject(result) &&
        hasExactKeys(result, ["items"]) &&
        Array.isArray(result.items) &&
        result.items.every(
          (item) =>
            isPlainObject(item) &&
            hasExactKeys(item, ["entryId", "text"]) &&
            isString(item.entryId) &&
            isString(item.text),
        )
        ? null
        : "invalid session.getForkPoints result";
    case "session.fork":
      return isPlainObject(result) &&
        hasExactKeys(result, ["session"], ["selectedText"]) &&
        isSessionSnapshot(result.session) &&
        (result.selectedText === undefined || isString(result.selectedText))
        ? null
        : "invalid session.fork result";
    case "session.export":
      return isPlainObject(result) &&
        hasExactKeys(result, ["path"]) &&
        isString(result.path) &&
        result.path.length > 0
        ? null
        : "invalid session.export result";
    case "agent.setQueue":
      return isQueueSnapshot(result) ? null : "invalid agent.setQueue result";
    case "agent.runNow":
      return isPlainObject(result) &&
        hasExactKeys(
          result,
          ["started", "settled", "queueRestored", "partialFailure", "queue"],
          ["runId", "error"],
        ) &&
        isBoolean(result.started) &&
        (result.started ? isUuid(result.runId) : result.runId === undefined) &&
        isBoolean(result.settled) &&
        isBoolean(result.queueRestored) &&
        isBoolean(result.partialFailure) &&
        isQueueSnapshot(result.queue) &&
        (result.error === undefined || isHostErrorRecord(result.error))
        ? null
        : "invalid agent.runNow result";
    case "agent.prompt":
      return isPlainObject(result) &&
        hasExactKeys(result, ["accepted", "runId"], ["session"]) &&
        result.accepted === true &&
        isUuid(result.runId) &&
        (result.session === undefined || isSessionSnapshot(result.session))
        ? null
        : "invalid agent.prompt result";
    case "extensionUi.configure":
      return isPlainObject(result) &&
        hasExactKeys(result, ["extensionDecisionPresentation"]) &&
        ["legacy-modal", "auto", "inline-first"].includes(
          String(result.extensionDecisionPresentation),
        )
        ? null
        : "invalid extensionUi.configure result";
    case "agent.steer":
    case "agent.followUp":
    case "agent.abortCompaction":
    case "agent.abortRetry":
    case "extensionUi.respond":
      return exactAccepted() ? null : `${method} result must be { accepted: true }`;
    case "extensionUi.customInput":
      return exactAccepted() ? null : `${method} result must be { accepted: true }`;
    case "extensionUi.customResize":
      return exactAccepted() ? null : `${method} result must be { accepted: true }`;
    case "agent.abort":
      return isPlainObject(result) &&
        hasExactKeys(
          result,
          ["aborted", "settled", "queueRestored", "partialFailure", "queue", "session"],
          ["error"],
        ) &&
        isBoolean(result.aborted) &&
        isBoolean(result.settled) &&
        isBoolean(result.queueRestored) &&
        isBoolean(result.partialFailure) &&
        isQueueSnapshot(result.queue) &&
        (result.error === undefined || isHostErrorRecord(result.error)) &&
        isSessionSnapshot(result.session)
        ? null
        : "invalid agent.abort result";
    case "agent.clearQueue":
      return isQueueSnapshot(result) ? null : "invalid queue result";
    case "agent.compact":
      return isPlainObject(result) &&
        hasExactKeys(result, ["result", "session"]) &&
        isSerializableCompactionResult(result.result) &&
        isSessionSnapshot(result.session)
        ? null
        : "invalid compact result";
    case "agent.navigateTree":
      return isPlainObject(result) &&
        hasExactKeys(result, ["session", "cancelled"], ["editorText"]) &&
        isSessionSnapshot(result.session) &&
        isBoolean(result.cancelled) &&
        (result.editorText === undefined || isString(result.editorText))
        ? null
        : "invalid agent.navigateTree result";
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
    case "provider.setEnabled":
      return isPlainObject(result) &&
        hasExactKeys(result, ["providerId", "enabled"]) &&
        isString(result.providerId) &&
        isBoolean(result.enabled)
        ? null
        : "invalid provider.setEnabled result";
    case "provider.remove":
      return isPlainObject(result) &&
        hasExactKeys(result, ["providerId", "removed"]) &&
        isString(result.providerId) &&
        result.removed === true
        ? null
        : "invalid provider.remove result";
    case "provider.authStatus":
      return isPlainObject(result) &&
        hasExactKeys(result, ["providers"]) &&
        Array.isArray(result.providers) &&
        result.providers.every(isBuiltinProviderAuthStatus)
        ? null
        : "invalid provider.authStatus result";
    case "provider.loginStart":
      return isPlainObject(result) &&
        hasExactKeys(result, ["loginId", "providerId"]) &&
        isString(result.loginId) &&
        isString(result.providerId)
        ? null
        : "invalid provider.loginStart result";
    case "provider.loginRespond":
    case "provider.loginCancel":
      return exactAccepted() ? null : `${method} result must be { accepted: true }`;
    case "provider.logout":
      return isPlainObject(result) &&
        hasExactKeys(result, ["providerId", "loggedOut"]) &&
        isString(result.providerId) &&
        result.loggedOut === true
        ? null
        : "invalid provider.logout result";
    case "provider.builtinModels":
    case "provider.setBuiltinModels":
      return isPlainObject(result) &&
        hasExactKeys(result, ["providerId", "models"]) &&
        isString(result.providerId) &&
        Array.isArray(result.models) &&
        result.models.every(isBuiltinProviderModelChoice)
        ? null
        : `invalid ${method} result`;
    case "provider.fetchModels":
      return isPlainObject(result) &&
        hasExactKeys(result, ["providerId", "models"]) &&
        isString(result.providerId) &&
        Array.isArray(result.models) &&
        result.models.every(isDiscoveredProviderModel)
        ? null
        : "invalid provider.fetchModels result";
    case "provider.checkConnection":
      return isPlainObject(result) &&
        hasExactKeys(
          result,
          ["providerId", "modelId", "api", "ok", "latencyMs", "category", "message"],
          ["suggestion"],
        ) &&
        isString(result.providerId) &&
        isString(result.modelId) &&
        (PROVIDER_APIS as readonly string[]).includes(String(result.api)) &&
        isBoolean(result.ok) &&
        isSafeRevision(result.latencyMs) &&
        [
          "ok",
          "configuration",
          "authentication",
          "blocked",
          "rate_limit",
          "not_found",
          "timeout",
          "network",
          "protocol",
          "provider",
        ].includes(String(result.category)) &&
        isString(result.message) &&
        isOptionalString(result.suggestion)
        ? null
        : "invalid provider.checkConnection result";
    case "model.list":
      return isPlainObject(result) &&
        hasExactKeys(
          result,
          ["models", "thinkingLevels", "configHealth"],
          ["current", "enabledProviders"],
        ) &&
        Array.isArray(result.models) &&
        result.models.every(isModelSummary) &&
        (result.current === undefined || isModelSummary(result.current)) &&
        (result.enabledProviders === undefined ||
          (Array.isArray(result.enabledProviders) && result.enabledProviders.every(isString))) &&
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
    case "package.catalog":
      return isPackageCatalog(result) ? null : "invalid package catalog";
    case "package.install":
    case "package.remove":
    case "package.update":
    case "package.updateAll":
    case "package.reloadResources":
    case "resource.setPreference":
    case "resource.setPreferences":
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
        result.resources.every(isResourceRecord)
        ? null
        : "invalid package.getResources result";
    default:
      // Exhaustiveness guard: a new HostMethod without a result validator is a
      // compile error here — outbound validation can never be silently skipped.
      return assertNeverShape(method, "method result");
  }
}

function assertNeverShape(value: never, kind: string): never {
  throw new Error(`No ${kind} validator registered for: ${String(value)}`);
}

export function validateEventPayloadShape(event: HostEventName, payload: unknown): string | null {
  switch (event) {
    case "host.ready":
    case "host.statusChanged":
      return isHostStatusSnapshot(payload) ? null : "invalid HostStatusSnapshot payload";
    case "host.fatal":
      return isPlainObject(payload) &&
        hasExactKeys(payload, ["error"]) &&
        isHostErrorRecord(payload.error)
        ? null
        : "invalid host.fatal payload";
    case "workspace.changed":
      return isWorkspaceSnapshot(payload) ? null : "invalid workspace.changed payload";
    case "workspace.filesChanged":
      return isPlainObject(payload) &&
        hasExactKeys(payload, ["directories"]) &&
        Array.isArray(payload.directories) &&
        payload.directories.every(isString)
        ? null
        : "invalid workspace.filesChanged payload";
    case "git.changed":
      return isPlainObject(payload) &&
        hasExactKeys(payload, ["snapshot"]) &&
        isGitStatusSnapshot(payload.snapshot)
        ? null
        : "invalid git.changed payload";
    case "attachment.changed":
      return isPlainObject(payload) &&
        hasExactKeys(payload, ["attachment"]) &&
        isAttachmentSnapshot(payload.attachment)
        ? null
        : "invalid attachment.changed payload";
    case "session.snapshot":
      return payload === null || isSessionSnapshot(payload)
        ? null
        : "invalid session.snapshot payload";
    case "session.infoChanged":
      return isPlainObject(payload) &&
        hasExactKeys(payload, ["sessionId"], ["name"]) &&
        isUuid(payload.sessionId) &&
        isOptionalString(payload.name)
        ? null
        : "invalid session.infoChanged payload";
    case "session.runtimeChanged":
      return isPlainObject(payload) &&
        hasExactKeys(payload, ["sessionId", "sessionRevision", "state", "updatedAt"], ["error"]) &&
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
      return isQueueSnapshot(payload) ? null : "invalid agent.queueChanged payload";
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
    case "provider.loginEvent":
      return isPlainObject(payload) &&
        hasExactKeys(payload, ["loginId", "providerId", "event"]) &&
        isString(payload.loginId) &&
        payload.loginId.trim().length > 0 &&
        isString(payload.providerId) &&
        payload.providerId.trim().length > 0 &&
        isProviderLoginFlowEvent(payload.event)
        ? null
        : "invalid provider.loginEvent payload";
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
    case "extensionUi.closed":
      return isPlainObject(payload) &&
        hasExactKeys(payload, ["requestId", "reason"]) &&
        isUuid(payload.requestId) &&
        ["aborted", "timed-out", "disposed", "stale"].includes(String(payload.reason))
        ? null
        : "invalid extensionUi.closed payload";
    case "extensionUi.groupClosed":
      return isPlainObject(payload) &&
        hasExactKeys(payload, ["groupKey", "status"]) &&
        isBoundedNonEmptyString(payload.groupKey, 256) &&
        ["completed", "failed", "cancelled", "stale"].includes(String(payload.status))
        ? null
        : "invalid extensionUi.groupClosed payload";
    case "extensionUi.statusChanged":
      return isPlainObject(payload) &&
        hasExactKeys(payload, ["text"], ["key"]) &&
        isOptionalString(payload.key) &&
        isString(payload.text)
        ? null
        : "invalid extensionUi.statusChanged payload";
    case "extensionUi.widgetChanged":
      return isPlainObject(payload) &&
        hasExactKeys(payload, ["widget"], ["key", "placement"]) &&
        isOptionalString(payload.key) &&
        isJsonValue(payload.widget) &&
        (payload.placement === undefined ||
          payload.placement === "aboveEditor" ||
          payload.placement === "belowEditor")
        ? null
        : "invalid extensionUi.widgetChanged payload";
    case "extensionUi.widgetAttentionRequested":
      return isPlainObject(payload) &&
        hasExactKeys(payload, ["key", "runId", "invocation"]) &&
        isString(payload.key) &&
        payload.key.length > 0 &&
        isUuid(payload.runId) &&
        isString(payload.invocation) &&
        payload.invocation.length > 0
        ? null
        : "invalid extensionUi.widgetAttentionRequested payload";
    case "extensionUi.messageRendered":
      return isPlainObject(payload) &&
        hasExactKeys(payload, ["entryId", "render"]) &&
        isString(payload.entryId) &&
        payload.entryId.length > 0 &&
        (payload.render === null || isExtensionMessageRenderSnapshot(payload.render))
        ? null
        : "invalid extensionUi.messageRendered payload";
    case "extensionUi.notification":
      return isPlainObject(payload) &&
        hasExactKeys(payload, ["message", "level"]) &&
        isString(payload.message) &&
        isString(payload.level)
        ? null
        : "invalid extensionUi.notification payload";
    case "extensionUi.customStarted":
      return isPlainObject(payload) &&
        hasExactKeys(payload, ["requestId", "cols", "rows"], ["title"]) &&
        isString(payload.requestId) &&
        isOptionalString(payload.title) &&
        typeof payload.cols === "number" &&
        Number.isInteger(payload.cols) &&
        payload.cols > 0 &&
        typeof payload.rows === "number" &&
        Number.isInteger(payload.rows) &&
        payload.rows > 0
        ? null
        : "invalid extensionUi.customStarted payload";
    case "extensionUi.customFrame":
      return isPlainObject(payload) &&
        hasExactKeys(payload, ["requestId", "data"]) &&
        isString(payload.requestId) &&
        isString(payload.data)
        ? null
        : "invalid extensionUi.customFrame payload";
    case "extensionUi.customClosed":
      return isPlainObject(payload) &&
        hasExactKeys(payload, ["requestId"]) &&
        isString(payload.requestId)
        ? null
        : "invalid extensionUi.customClosed payload";
    default:
      // Exhaustiveness guard — same contract as validateMethodResultShape.
      return assertNeverShape(event, "event payload");
  }
}
