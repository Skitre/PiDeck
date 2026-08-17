import type { HostContextMap, HostRequestParams } from "./contracts.js";
import {
  MAX_AGENT_IMAGE_BYTES,
  MAX_AGENT_REQUEST_ATTACHMENTS,
  MAX_AGENT_REQUEST_IMAGES,
  MAX_PASTED_TEXT_ATTACHMENT_BYTES,
  MAX_GIT_COMMIT_MESSAGE_BYTES,
  MAX_GIT_BRANCH_NAME_BYTES,
  MAX_GIT_HISTORY_PAGE_SIZE,
  MAX_GIT_PATH_BYTES,
} from "./limits.js";
import {
  hasExactKeys,
  isHostErrorRecord,
  isHostStatusSnapshot,
  isPackageSnapshot,
  isPlainObject,
  isProviderDraft,
  isSafeRevision,
  isSerializableAgentContent,
  isSessionSnapshot,
  isToolSnapshot,
  isUuid,
  isWorkspaceSnapshot,
  validateEventPayloadShape,
  validateMethodResultShape,
} from "./dto-validate.js";
import { createHostError, type HostError, type JsonValue } from "./errors.js";
import { isHostEventName, type HostEventName } from "./events.js";
import type { HostEventEnvelope, HostResponseEnvelope } from "./envelopes.js";
import {
  isHostMethod,
  METHOD_CONTEXT_SCOPE,
  type HostMethod,
  type MethodContextScope,
} from "./methods.js";

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: HostError };

function fail(message: string, details?: JsonValue): ValidationResult<never> {
  return {
    ok: false,
    error: createHostError("INVALID_REQUEST", message, { details }),
  };
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isValidAttachmentText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !value.includes("\u0000") &&
    new TextEncoder().encode(value).byteLength <= MAX_PASTED_TEXT_ATTACHMENT_BYTES
  );
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isValidGitPath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const segments = value.split(/[\\/]/);
  return (
    value.length > 0 &&
    !value.includes("\u0000") &&
    utf8Bytes(value) <= MAX_GIT_PATH_BYTES &&
    !value.startsWith("/") &&
    !value.startsWith("\\") &&
    !/^[A-Za-z]:[\\/]/.test(value) &&
    !segments.includes("..")
  );
}

function isValidCommitMessage(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !value.includes("\u0000") &&
    utf8Bytes(value) <= MAX_GIT_COMMIT_MESSAGE_BYTES
  );
}

function isValidGitBranchName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    utf8Bytes(value) <= MAX_GIT_BRANCH_NAME_BYTES
  );
}

function isGitSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40,64}$/.test(value);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function exactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  return isPlainObject(value) && hasExactKeys(value, required, optional);
}

function requireRevision(
  obj: Record<string, unknown>,
  key: string,
  method: HostMethod,
): ValidationResult<number> {
  const value = obj[key];
  return isSafeRevision(value)
    ? { ok: true, value }
    : fail(`${key} must be a non-negative safe integer`, { method });
}

function validateImages(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= MAX_AGENT_REQUEST_IMAGES &&
      value.every(
        (image) =>
          exactObject(image, ["mediaType", "data"]) &&
          isNonEmptyString(image.mediaType) &&
          isNonEmptyString(image.data) &&
          validateBase64ImageData(image.data),
      ))
  );
}

function validateAttachmentIds(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= MAX_AGENT_REQUEST_ATTACHMENTS &&
      new Set(value).size === value.length &&
      value.every(isUuid))
  );
}

function validateBase64ImageData(data: string): boolean {
  const decodedBytes = base64DecodedByteLength(data);
  return decodedBytes !== null && decodedBytes <= MAX_AGENT_IMAGE_BYTES;
}

function base64DecodedByteLength(data: string): number | null {
  const maxEncodedCharacters = Math.ceil(MAX_AGENT_IMAGE_BYTES / 3) * 4;
  if (data.length > maxEncodedCharacters) return null;

  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const contentLength = data.length - padding;
  if (contentLength % 4 === 1 || (padding > 0 && data.length % 4 !== 0)) return null;

  for (let index = 0; index < contentLength; index += 1) {
    const code = data.charCodeAt(index);
    const isBase64Character =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47;
    if (!isBase64Character) return null;
  }
  return Math.floor((contentLength * 3) / 4);
}

function isResourcePreferenceUpdate(value: unknown): boolean {
  if (
    !exactObject(value, ["resourceId", "targetScope", "preference"]) ||
    !isNonEmptyString(value.resourceId)
  ) {
    return false;
  }
  if (value.targetScope === "user") {
    return value.preference === "enabled" || value.preference === "disabled";
  }
  return (
    value.targetScope === "project" &&
    ["inherit", "enabled", "disabled"].includes(String(value.preference))
  );
}

export function validateMethodContext<M extends HostMethod>(
  method: M,
  context: unknown,
): ValidationResult<HostContextMap[M]> {
  const scope: MethodContextScope = METHOD_CONTEXT_SCOPE[method];
  if (scope === "empty") {
    if (context === undefined || context === null) {
      return { ok: true, value: {} as HostContextMap[M] };
    }
    return exactObject(context, [])
      ? { ok: true, value: {} as HostContextMap[M] }
      : fail("system.hello context must be an exact empty object", { method });
  }

  if (!isPlainObject(context)) return fail("context must be an object", { method });
  const workspaceFields = [
    "expectedHostInstanceId",
    "expectedWorkspaceId",
    "expectedWorkspaceRevision",
  ] as const;
  const sessionFields = [
    ...workspaceFields,
    "expectedSessionId",
    "expectedSessionRevision",
  ] as const;

  const allowed =
    scope === "host"
      ? ["expectedHostInstanceId"]
      : scope === "workspace"
        ? [...workspaceFields]
        : scope === "nullableSession" || scope === "activeSession" || scope === "sessionTarget"
          ? [...sessionFields]
          : scope === "toolMutation"
            ? [...sessionFields, "expectedToolRevision"]
            : scope === "workspacePackage"
              ? [...workspaceFields, "expectedPackageRevision"]
              : [...sessionFields, "expectedPackageRevision"];
  if (!hasExactKeys(context, allowed)) {
    return fail("context has missing or unexpected fields", { method, allowed });
  }
  if (!isUuid(context.expectedHostInstanceId)) {
    return fail("expectedHostInstanceId must be UUID", { method });
  }

  if (scope === "host") return { ok: true, value: context as HostContextMap[M] };

  if (context.expectedWorkspaceId !== null && !isUuid(context.expectedWorkspaceId)) {
    return fail("expectedWorkspaceId must be UUID or null", { method });
  }
  const workspaceRevision = requireRevision(context, "expectedWorkspaceRevision", method);
  if (!workspaceRevision.ok) return workspaceRevision;

  if (scope === "workspace") return { ok: true, value: context as HostContextMap[M] };
  if (scope === "workspacePackage") {
    const packageRevision = requireRevision(context, "expectedPackageRevision", method);
    if (!packageRevision.ok) return packageRevision;
    return { ok: true, value: context as HostContextMap[M] };
  }

  if (scope === "activeSession" || scope === "sessionTarget" || scope === "toolMutation") {
    if (!isUuid(context.expectedSessionId)) {
      return fail("expectedSessionId must be UUID", { method });
    }
  } else if (context.expectedSessionId !== null && !isUuid(context.expectedSessionId)) {
    return fail("expectedSessionId must be UUID or null", { method });
  }
  const sessionRevision = requireRevision(context, "expectedSessionRevision", method);
  if (!sessionRevision.ok) return sessionRevision;
  if (scope === "toolMutation") {
    const toolRevision = requireRevision(context, "expectedToolRevision", method);
    if (!toolRevision.ok) return toolRevision;
  }
  if (scope === "sessionPackage") {
    const packageRevision = requireRevision(context, "expectedPackageRevision", method);
    if (!packageRevision.ok) return packageRevision;
  }
  return { ok: true, value: context as HostContextMap[M] };
}

export function validateRequestParams<M extends HostMethod>(
  method: M,
  params: unknown,
): ValidationResult<HostRequestParams[M]> {
  const ok = (value: unknown) => ({ ok: true, value: value as HostRequestParams[M] }) as const;
  switch (method) {
    case "system.hello":
      return exactObject(
        params,
        ["clientName", "clientVersion", "protocolVersion"],
        ["extensionDecisionPresentation"],
      ) &&
        isNonEmptyString(params.clientName) &&
        isNonEmptyString(params.clientVersion) &&
        params.protocolVersion === 1 &&
        (params.extensionDecisionPresentation === undefined ||
          ["legacy-modal", "auto", "inline-first"].includes(
            String(params.extensionDecisionPresentation),
          ))
        ? ok(params)
        : fail("invalid system.hello params", { method });
    case "system.getStatus":
    case "system.rehydrate":
    case "system.shutdown":
    case "workspace.getCurrent":
    case "git.getStatus":
    case "git.listBranches":
    case "session.list":
    case "session.cleanupArchived":
    case "session.reload":
    case "session.getSnapshot":
    case "session.getTree":
    case "session.getStats":
    case "session.getForkPoints":
    case "session.usageReport":
    case "session.getCommands":
    case "agent.abort":
    case "agent.abortCompaction":
    case "agent.abortRetry":
    case "agent.getTools":
    case "provider.list":
    case "provider.authStatus":
    case "model.list":
    case "package.updateAll":
    case "package.reloadResources":
      return params === null ? ok(null) : fail("params must be null", { method });
    case "workspace.searchFiles":
      return exactObject(params, ["query"], ["limit"]) &&
        isString(params.query) &&
        (params.limit === undefined ||
          (typeof params.limit === "number" &&
            Number.isInteger(params.limit) &&
            params.limit >= 1 &&
            params.limit <= 5000))
        ? ok(params)
        : fail("invalid workspace.searchFiles params", { method });
    case "session.searchAll":
      return exactObject(params, ["query"], ["limit", "includeArchived"]) &&
        isString(params.query) &&
        params.query.trim().length >= 1 &&
        params.query.length <= 256 &&
        (params.limit === undefined ||
          (typeof params.limit === "number" &&
            Number.isInteger(params.limit) &&
            params.limit >= 1 &&
            params.limit <= 200)) &&
        (params.includeArchived === undefined || typeof params.includeArchived === "boolean")
        ? ok(params)
        : fail("invalid session.searchAll params", { method });
    case "workspace.listDirectory":
      return exactObject(params, ["path"]) && isString(params.path)
        ? ok(params)
        : fail("invalid workspace.listDirectory params", { method });
    case "workspace.setDirectoryWatches":
      return exactObject(params, ["paths"]) &&
        Array.isArray(params.paths) &&
        params.paths.length <= 128 &&
        params.paths.every(isString)
        ? ok(params)
        : fail("invalid workspace.setDirectoryWatches params", { method });
    case "git.setWatching":
      return exactObject(params, ["enabled"]) && isBoolean(params.enabled)
        ? ok(params)
        : fail("invalid git.setWatching params", { method });
    case "git.getDiff":
      return exactObject(params, ["path", "area", "expectedRevision"]) &&
        isValidGitPath(params.path) &&
        (params.area === "staged" || params.area === "unstaged") &&
        isSafeRevision(params.expectedRevision)
        ? ok(params)
        : fail("invalid git.getDiff params", { method });
    case "git.mutateHunk":
      return exactObject(params, [
        "path",
        "area",
        "hunkId",
        "operation",
        "expectedRevision",
        "expectedContentGeneration",
      ]) &&
        isValidGitPath(params.path) &&
        (params.area === "staged" || params.area === "unstaged") &&
        (params.operation === "stage" ||
          params.operation === "unstage" ||
          params.operation === "discard") &&
        typeof params.hunkId === "string" &&
        /^[0-9a-f]{64}$/.test(params.hunkId) &&
        isSafeRevision(params.expectedRevision) &&
        typeof params.expectedContentGeneration === "string" &&
        /^[0-9a-f]{64}$/.test(params.expectedContentGeneration)
        ? ok(params)
        : fail("invalid git.mutateHunk params", { method });
    case "git.stage":
    case "git.unstage":
    case "git.discard":
      return exactObject(params, ["path", "expectedRevision"]) &&
        isValidGitPath(params.path) &&
        isSafeRevision(params.expectedRevision)
        ? ok(params)
        : fail(`invalid ${method} params`, { method });
    case "git.stageAll":
    case "git.unstageAll":
      return exactObject(params, ["expectedRevision"]) && isSafeRevision(params.expectedRevision)
        ? ok(params)
        : fail(`invalid ${method} params`, { method });
    case "git.commit":
      return exactObject(params, ["message", "expectedIndexGeneration"]) &&
        isValidCommitMessage(params.message) &&
        typeof params.expectedIndexGeneration === "string" &&
        /^[0-9a-f]{64}$/.test(params.expectedIndexGeneration)
        ? ok(params)
        : fail("invalid git.commit params", { method });
    case "git.createBranch":
    case "git.switchBranch":
      return exactObject(params, ["name", "expectedRevision"]) &&
        isValidGitBranchName(params.name) &&
        isSafeRevision(params.expectedRevision)
        ? ok(params)
        : fail(`invalid ${method} params`, { method });
    case "git.listHistory":
      return exactObject(params, ["limit"], ["cursor"]) &&
        typeof params.limit === "number" &&
        Number.isInteger(params.limit) &&
        params.limit >= 1 &&
        params.limit <= MAX_GIT_HISTORY_PAGE_SIZE &&
        (params.cursor === undefined || isGitSha(params.cursor))
        ? ok(params)
        : fail("invalid git.listHistory params", { method });
    case "git.getCommitDiff":
      return exactObject(params, ["commitSha"]) && isGitSha(params.commitSha)
        ? ok(params)
        : fail("invalid git.getCommitDiff params", { method });
    case "attachment.create":
      return exactObject(params, ["path"]) && isNonEmptyString(params.path)
        ? ok(params)
        : fail("invalid attachment.create params", { method });
    case "attachment.createText":
      return exactObject(params, ["text"]) && isValidAttachmentText(params.text)
        ? ok(params)
        : fail("invalid attachment.createText params", { method });
    case "attachment.get":
    case "attachment.remove":
      return exactObject(params, ["attachmentId"]) && isUuid(params.attachmentId)
        ? ok(params)
        : fail(`invalid ${method} params`, { method });
    case "workspace.setCurrent":
      return exactObject(params, ["cwd"]) && isNonEmptyString(params.cwd)
        ? ok(params)
        : fail("params must be { cwd: string }", { method });
    case "session.create":
      return exactObject(params, [], ["name"]) &&
        (params.name === undefined || isNonEmptyString(params.name))
        ? ok(params)
        : fail("session.create params must contain optional non-empty name", { method });
    case "session.open":
      return exactObject(params, ["sessionPath"]) && isNonEmptyString(params.sessionPath)
        ? ok(params)
        : fail("invalid session.open params", { method });
    case "session.archive":
    case "session.restore":
    case "session.delete":
      return exactObject(params, ["sessionId", "sessionPath"]) &&
        isUuid(params.sessionId) &&
        isNonEmptyString(params.sessionPath)
        ? ok(params)
        : fail(`invalid ${method} params`, { method });
    case "session.setName":
      return exactObject(params, ["name"]) && isNonEmptyString(params.name)
        ? ok(params)
        : fail("invalid session.setName params", { method });
    case "session.rename":
      return exactObject(params, ["sessionId", "sessionPath", "name"]) &&
        isUuid(params.sessionId) &&
        isNonEmptyString(params.sessionPath) &&
        isNonEmptyString(params.name)
        ? ok(params)
        : fail("invalid session.rename params", { method });
    case "session.getEntries":
      return params === null ||
        (exactObject(params, [], ["sinceEntryId"]) &&
          (params.sinceEntryId === undefined || isNonEmptyString(params.sinceEntryId)))
        ? ok(params)
        : fail("invalid session.getEntries params", { method });
    case "agent.prompt":
      return exactObject(
        params,
        ["text"],
        ["images", "attachmentIds", "streamingBehavior", "attachQueuedImages", "fromEntryId"],
      ) &&
        isString(params.text) &&
        validateImages(params.images) &&
        validateAttachmentIds(params.attachmentIds) &&
        (params.attachQueuedImages === undefined ||
          typeof params.attachQueuedImages === "boolean") &&
        (params.fromEntryId === undefined ||
          (isString(params.fromEntryId) && params.fromEntryId.length > 0)) &&
        (params.streamingBehavior === undefined ||
          params.streamingBehavior === "steer" ||
          params.streamingBehavior === "followUp")
        ? ok(params)
        : fail("invalid agent.prompt params", { method });
    case "agent.steer":
    case "agent.followUp":
      return exactObject(params, ["text"], ["images", "attachmentIds"]) &&
        isString(params.text) &&
        validateImages(params.images) &&
        validateAttachmentIds(params.attachmentIds)
        ? ok(params)
        : fail(`invalid ${method} params`, { method });
    case "agent.clearQueue":
      return exactObject(params, ["expectedRevision"]) && isSafeRevision(params.expectedRevision)
        ? ok(params)
        : fail("invalid agent.clearQueue params", { method });
    case "agent.setQueue":
      return exactObject(params, ["expectedRevision", "steering", "followUp"]) &&
        isSafeRevision(params.expectedRevision) &&
        Array.isArray(params.steering) &&
        params.steering.every(isNonEmptyString) &&
        Array.isArray(params.followUp) &&
        params.followUp.every(isNonEmptyString)
        ? ok(params)
        : fail("invalid agent.setQueue params", { method });
    case "agent.runNow":
      return exactObject(params, ["expectedRevision", "followUpIndex"]) &&
        isSafeRevision(params.expectedRevision) &&
        isSafeRevision(params.followUpIndex)
        ? ok(params)
        : fail("invalid agent.runNow params", { method });
    case "agent.compact":
      return params === null ||
        (exactObject(params, [], ["instructions"]) &&
          (params.instructions === undefined || isString(params.instructions)))
        ? ok(params)
        : fail("invalid agent.compact params", { method });
    case "agent.navigateTree":
      return exactObject(params, ["targetId"]) &&
        isString(params.targetId) &&
        params.targetId.length > 0
        ? ok(params)
        : fail("invalid agent.navigateTree params", { method });
    case "session.fork":
      return exactObject(params, ["entryId"], ["position"]) &&
        isString(params.entryId) &&
        params.entryId.length > 0 &&
        (params.position === undefined || params.position === "before" || params.position === "at")
        ? ok(params)
        : fail("invalid session.fork params", { method });
    case "session.export":
      return exactObject(params, ["format"], ["path"]) &&
        (params.format === "html" || params.format === "jsonl") &&
        (params.path === undefined || (isString(params.path) && params.path.length > 0))
        ? ok(params)
        : fail("invalid session.export params", { method });
    case "agent.setAutoCompaction":
    case "agent.setAutoRetry":
      return exactObject(params, ["enabled"]) && isBoolean(params.enabled)
        ? ok(params)
        : fail(`invalid ${method} params`, { method });
    case "agent.setActiveTools":
      return exactObject(params, ["names"]) && isStringArray(params.names)
        ? ok(params)
        : fail("agent.setActiveTools names must be string[]", { method });
    case "provider.save":
      return exactObject(params, ["provider"], ["originalId", "apiKey", "clearApiKey"]) &&
        isProviderDraft(params.provider) &&
        (params.originalId === undefined || isNonEmptyString(params.originalId)) &&
        (params.apiKey === undefined || isNonEmptyString(params.apiKey)) &&
        (params.clearApiKey === undefined || isBoolean(params.clearApiKey)) &&
        !(params.apiKey !== undefined && params.clearApiKey === true)
        ? ok(params)
        : fail("invalid provider.save params", { method });
    case "provider.setEnabled":
      return exactObject(params, ["providerId", "enabled"]) &&
        isNonEmptyString(params.providerId) &&
        isBoolean(params.enabled)
        ? ok(params)
        : fail("invalid provider.setEnabled params", { method });
    case "provider.remove":
    case "provider.fetchModels":
    case "provider.logout":
    case "provider.builtinModels":
      return exactObject(params, ["providerId"]) && isNonEmptyString(params.providerId)
        ? ok(params)
        : fail(`invalid ${method} params`, { method });
    case "provider.setBuiltinModels":
      return exactObject(params, ["providerId", "modelIds"]) &&
        isNonEmptyString(params.providerId) &&
        Array.isArray(params.modelIds) &&
        params.modelIds.every(isNonEmptyString)
        ? ok(params)
        : fail("invalid provider.setBuiltinModels params", { method });
    case "provider.loginStart":
      return exactObject(params, ["providerId", "authType"]) &&
        isNonEmptyString(params.providerId) &&
        (params.authType === "oauth" || params.authType === "api_key")
        ? ok(params)
        : fail("invalid provider.loginStart params", { method });
    case "provider.loginRespond":
      return exactObject(params, ["loginId", "promptId", "value"]) &&
        isNonEmptyString(params.loginId) &&
        isNonEmptyString(params.promptId) &&
        isString(params.value)
        ? ok(params)
        : fail("invalid provider.loginRespond params", { method });
    case "provider.loginCancel":
      return exactObject(params, ["loginId"]) && isNonEmptyString(params.loginId)
        ? ok(params)
        : fail("invalid provider.loginCancel params", { method });
    case "provider.checkConnection":
      return exactObject(params, ["providerId"], ["modelId"]) &&
        isNonEmptyString(params.providerId) &&
        (params.modelId === undefined || isNonEmptyString(params.modelId))
        ? ok(params)
        : fail("invalid provider.checkConnection params", { method });
    case "model.setCurrent":
      return exactObject(params, ["provider", "modelId"]) &&
        isNonEmptyString(params.provider) &&
        isNonEmptyString(params.modelId)
        ? ok(params)
        : fail("invalid model.setCurrent params", { method });
    case "model.setThinkingLevel":
      return exactObject(params, ["level"]) && isNonEmptyString(params.level)
        ? ok(params)
        : fail("invalid model.setThinkingLevel params", { method });
    case "package.list":
      return exactObject(params, ["scope"], ["includeResources"]) &&
        ["user", "project", "all"].includes(String(params.scope)) &&
        (params.includeResources === undefined || isBoolean(params.includeResources))
        ? ok(params)
        : fail("invalid package.list params", { method });
    case "package.catalog":
      return exactObject(params, [], ["refresh"]) &&
        (params.refresh === undefined || isBoolean(params.refresh))
        ? ok(params)
        : fail("invalid package.catalog params", { method });
    case "package.install":
      return exactObject(params, ["source", "scope"]) &&
        isNonEmptyString(params.source) &&
        ["user", "project"].includes(String(params.scope))
        ? ok(params)
        : fail("invalid package.install params", { method });
    case "package.remove":
    case "package.update":
    case "package.getResources":
      return exactObject(params, ["packageId"]) && isNonEmptyString(params.packageId)
        ? ok(params)
        : fail(`invalid ${method} params`, { method });
    case "package.checkUpdates":
      return params === null ||
        (exactObject(params, [], ["packageId"]) &&
          (params.packageId === undefined || isNonEmptyString(params.packageId)))
        ? ok(params)
        : fail("invalid package.checkUpdates params", { method });
    case "resource.setPreference":
      return isResourcePreferenceUpdate(params)
        ? ok(params)
        : fail("invalid resource.setPreference params", { method });
    case "resource.setPreferences":
      return exactObject(params, ["updates"]) &&
        Array.isArray(params.updates) &&
        params.updates.every(isResourcePreferenceUpdate)
        ? ok(params)
        : fail("invalid resource.setPreferences params", { method });
    case "extensionUi.configure":
      return exactObject(params, ["extensionDecisionPresentation"]) &&
        ["legacy-modal", "auto", "inline-first"].includes(
          String(params.extensionDecisionPresentation),
        )
        ? ok(params)
        : fail("invalid extensionUi.configure params", { method });
    case "extensionUi.respond":
      return exactObject(params, ["requestId", "status"], ["value"]) &&
        isUuid(params.requestId) &&
        (params.status === "resolved" || params.status === "cancelled") &&
        (params.value === undefined || isJsonValue(params.value))
        ? ok(params)
        : fail("invalid extensionUi.respond params", { method });
    case "extensionUi.customInput":
      return exactObject(params, ["requestId", "data"]) &&
        isUuid(params.requestId) &&
        isNonEmptyString(params.data)
        ? ok(params)
        : fail("invalid extensionUi.customInput params", { method });
    case "extensionUi.customResize":
      return exactObject(params, ["requestId", "cols", "rows"]) &&
        isUuid(params.requestId) &&
        typeof params.cols === "number" &&
        Number.isInteger(params.cols) &&
        params.cols >= 20 &&
        params.cols <= 1000 &&
        typeof params.rows === "number" &&
        Number.isInteger(params.rows) &&
        params.rows >= 4 &&
        params.rows <= 1000
        ? ok(params)
        : fail("invalid extensionUi.customResize params", { method });
    default:
      // Exhaustiveness guard: adding a HostMethod without a params validator
      // is a compile error here, not a silently-undefined result at runtime.
      return assertNeverMethod(method);
  }
}

function assertNeverMethod(method: never): never {
  throw new Error(`No params validator registered for method: ${String(method)}`);
}

export type ParsedHostRequest = {
  [M in HostMethod]: {
    protocolVersion: 1;
    id: string;
    method: M;
    context: HostContextMap[M];
    params: HostRequestParams[M];
  };
}[HostMethod];

export function parseHostRequest(raw: unknown): ValidationResult<ParsedHostRequest> {
  if (!exactObject(raw, ["protocolVersion", "id", "method", "context", "params"])) {
    return fail("request envelope has missing or unexpected fields");
  }
  if (raw.protocolVersion !== 1) return fail("protocolVersion must be 1");
  if (!isUuid(raw.id)) return fail("request id must be UUID");
  if (!isHostMethod(raw.method)) {
    return {
      ok: false,
      error: createHostError("UNSUPPORTED_METHOD", `Unknown method: ${String(raw.method)}`, {
        details: { method: String(raw.method) },
      }),
    };
  }
  const context = validateMethodContext(raw.method, raw.context);
  if (!context.ok) return context;
  const params = validateRequestParams(raw.method, raw.params);
  if (!params.ok) return params;
  return {
    ok: true,
    value: {
      protocolVersion: 1,
      id: raw.id,
      method: raw.method,
      context: context.value,
      params: params.value,
    } as ParsedHostRequest,
  };
}

export type HostResponseMessage = HostResponseEnvelope;
export type HostEventMessage = HostEventEnvelope;

const identityKeys = [
  "hostInstanceId",
  "workspaceId",
  "workspaceRevision",
  "sessionId",
  "sessionRevision",
  "packageRevision",
] as const;

function hasHostIdentity(value: Record<string, unknown>): boolean {
  return (
    isUuid(value.hostInstanceId) &&
    (value.workspaceId === null || isUuid(value.workspaceId)) &&
    isSafeRevision(value.workspaceRevision) &&
    (value.sessionId === null || isUuid(value.sessionId)) &&
    isSafeRevision(value.sessionRevision) &&
    isSafeRevision(value.packageRevision)
  );
}

export function isHostResponse(value: unknown): value is HostResponseMessage {
  if (
    !isPlainObject(value) ||
    value.protocolVersion !== 1 ||
    !isUuid(value.id) ||
    !isHostMethod(value.method)
  ) {
    return false;
  }
  if (!hasHostIdentity(value) || typeof value.ok !== "boolean") return false;
  if (value.ok) {
    if (
      !hasExactKeys(value, ["protocolVersion", ...identityKeys, "id", "method", "ok", "result"])
    ) {
      return false;
    }
    return validateMethodResultShape(value.method, value.result) === null;
  }
  if (!hasExactKeys(value, ["protocolVersion", ...identityKeys, "id", "method", "ok", "error"])) {
    return false;
  }
  return isHostErrorRecord(value.error);
}

export function isHostEvent(value: unknown): value is HostEventMessage {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      "protocolVersion",
      ...identityKeys,
      "event",
      "sequence",
      "timestamp",
      "payload",
    ]) ||
    value.protocolVersion !== 1 ||
    !isHostEventName(value.event) ||
    !hasHostIdentity(value) ||
    !isSafeRevision(value.sequence) ||
    value.sequence < 1 ||
    typeof value.timestamp !== "number" ||
    !Number.isFinite(value.timestamp) ||
    value.timestamp < 0
  ) {
    return false;
  }
  return validateEventPayloadShape(value.event, value.payload) === null;
}

export function validateSuccessResult(
  method: HostMethod,
  result: unknown,
): ValidationResult<unknown> {
  const error = validateMethodResultShape(method, result);
  return error ? fail(error, { method }) : { ok: true, value: result };
}

export function validateEventPayload(
  event: HostEventName,
  payload: unknown,
): ValidationResult<unknown> {
  const error = validateEventPayloadShape(event, payload);
  return error ? fail(error, { event }) : { ok: true, value: payload };
}

export function parseHostResponse(raw: unknown): ValidationResult<HostResponseMessage> {
  return isHostResponse(raw) ? { ok: true, value: raw } : fail("invalid Host response");
}

export function parseHostEvent(raw: unknown): ValidationResult<HostEventMessage> {
  return isHostEvent(raw) ? { ok: true, value: raw } : fail("invalid Host event");
}

export function validateSerializableAgentToolResult(value: unknown): ValidationResult<{
  content: unknown[];
  details: JsonValue;
  addedToolNames?: string[];
  terminate?: boolean;
}> {
  if (!exactObject(value, ["content", "details"], ["addedToolNames", "terminate"])) {
    return fail("tool result has missing or unexpected fields");
  }
  if (!Array.isArray(value.content) || !value.content.every(isSerializableAgentContent)) {
    return fail("content must contain valid agent content parts");
  }
  if (!isJsonValue(value.details)) return fail("details must be JSON-serializable");
  if (value.addedToolNames !== undefined && !isStringArray(value.addedToolNames)) {
    return fail("addedToolNames must be string[]");
  }
  if (value.terminate !== undefined && !isBoolean(value.terminate)) {
    return fail("terminate must be boolean");
  }
  return {
    ok: true,
    value: {
      content: value.content,
      details: value.details,
      ...(value.addedToolNames !== undefined ? { addedToolNames: value.addedToolNames } : {}),
      ...(value.terminate !== undefined ? { terminate: value.terminate } : {}),
    },
  };
}

export function isJsonValue(value: unknown): value is JsonValue {
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

export function toJsonValue(value: unknown, seen = new WeakSet<object>()): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    if (typeof value === "number" && !Number.isFinite(value)) return String(value);
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return `[${typeof value}]`;
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return { type: "Buffer", length: value.length, base64: value.toString("base64") };
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    return value.map((item) => toJsonValue(item, seen));
  }
  if (typeof value === "object") {
    if (seen.has(value as object)) return "[Circular]";
    seen.add(value as object);
    const output: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      // Omit undefined-valued keys like JSON.stringify does, so live objects
      // serialize identically to their persisted round-trip. Mapping them to
      // null instead breaks strict payload validators (e.g. message usage).
      if (item === undefined) continue;
      output[key] = toJsonValue(item, seen);
    }
    return output;
  }
  return String(value);
}

// Narrow helpers exported for focused tests and Host outbound checks.
export const protocolDto = {
  isHostStatusSnapshot,
  isWorkspaceSnapshot,
  isSessionSnapshot,
  isToolSnapshot,
  isPackageSnapshot,
};
