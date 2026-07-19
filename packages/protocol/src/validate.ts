import type { HostContextMap, HostRequestParams } from "./contracts.js";
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

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: HostError };

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
      value.every(
        (image) =>
          exactObject(image, ["mediaType", "data"]) &&
          isNonEmptyString(image.mediaType) &&
          isNonEmptyString(image.data),
      ))
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
        : scope === "nullableSession" || scope === "activeSession"
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

  if (scope === "activeSession" || scope === "toolMutation") {
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
      return exactObject(params, ["clientName", "clientVersion", "protocolVersion"]) &&
        isNonEmptyString(params.clientName) &&
        isNonEmptyString(params.clientVersion) &&
        params.protocolVersion === 1
        ? ok(params)
        : fail("invalid system.hello params", { method });
    case "system.getStatus":
    case "system.shutdown":
    case "workspace.getCurrent":
    case "session.list":
    case "session.cleanupArchived":
    case "session.reload":
    case "session.getSnapshot":
    case "session.getTree":
    case "session.getStats":
    case "session.getCommands":
    case "agent.abort":
    case "agent.clearQueue":
    case "agent.abortCompaction":
    case "agent.abortRetry":
    case "agent.getTools":
    case "provider.list":
    case "model.list":
    case "package.reloadResources":
    case "piSettings.get":
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
    case "workspace.setCurrent":
    case "workspace.getTrust":
      return exactObject(params, ["cwd"]) && isNonEmptyString(params.cwd)
        ? ok(params)
        : fail("params must be { cwd: string }", { method });
    case "workspace.setTrust":
      return exactObject(params, ["decision"]) &&
        ["trustOnce", "trust", "deny"].includes(String(params.decision))
        ? ok(params)
        : fail("invalid workspace.setTrust params", { method });
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
    case "session.getEntries":
      return params === null ||
        (exactObject(params, [], ["sinceEntryId"]) &&
          (params.sinceEntryId === undefined || isNonEmptyString(params.sinceEntryId)))
        ? ok(params)
        : fail("invalid session.getEntries params", { method });
    case "agent.prompt":
      return exactObject(params, ["text"], ["images", "streamingBehavior"]) &&
        isString(params.text) &&
        validateImages(params.images) &&
        (params.streamingBehavior === undefined ||
          params.streamingBehavior === "steer" ||
          params.streamingBehavior === "followUp")
        ? ok(params)
        : fail("invalid agent.prompt params", { method });
    case "agent.steer":
    case "agent.followUp":
      return exactObject(params, ["text"], ["images"]) &&
        isString(params.text) &&
        validateImages(params.images)
        ? ok(params)
        : fail(`invalid ${method} params`, { method });
    case "agent.compact":
      return params === null ||
        (exactObject(params, [], ["instructions"]) &&
          (params.instructions === undefined || isString(params.instructions)))
        ? ok(params)
        : fail("invalid agent.compact params", { method });
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
    case "provider.remove":
    case "provider.fetchModels":
      return exactObject(params, ["providerId"]) && isNonEmptyString(params.providerId)
        ? ok(params)
        : fail(`invalid ${method} params`, { method });
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
    case "package.updateAll":
      return exactObject(params, ["scope"]) &&
        ["user", "project", "all"].includes(String(params.scope))
        ? ok(params)
        : fail("invalid package.updateAll params", { method });
    case "package.setResourceEnabled":
      return exactObject(params, ["packageId", "resourceId", "enabled"]) &&
        isNonEmptyString(params.packageId) &&
        isNonEmptyString(params.resourceId) &&
        isBoolean(params.enabled)
        ? ok(params)
        : fail("invalid package.setResourceEnabled params", { method });
    case "package.setResourceTypeEnabled":
      return exactObject(params, ["packageId", "type", "enabled"]) &&
        isNonEmptyString(params.packageId) &&
        ["extension", "skill", "prompt", "theme"].includes(String(params.type)) &&
        isBoolean(params.enabled)
        ? ok(params)
        : fail("invalid package.setResourceTypeEnabled params", { method });
    case "resource.setTopLevelEnabled":
      return exactObject(params, ["resourceId", "enabled"]) &&
        isNonEmptyString(params.resourceId) &&
        isBoolean(params.enabled)
        ? ok(params)
        : fail("invalid resource.setTopLevelEnabled params", { method });
    case "piSettings.patch": {
      if (!exactObject(params, ["patch"]) || !isPlainObject(params.patch)) {
        return fail("invalid piSettings.patch params", { method });
      }
      const patch = params.patch;
      if (
        !hasExactKeys(
          patch,
          [],
          [
            "defaultThinkingLevel",
            "steeringMode",
            "followUpMode",
            "autoCompaction",
            "autoRetry",
            "defaultProjectTrust",
          ],
        ) ||
        (patch.defaultThinkingLevel !== undefined && !isString(patch.defaultThinkingLevel)) ||
        (patch.steeringMode !== undefined && !["all", "one-at-a-time"].includes(String(patch.steeringMode))) ||
        (patch.followUpMode !== undefined && !["all", "one-at-a-time"].includes(String(patch.followUpMode))) ||
        (patch.autoCompaction !== undefined && !isBoolean(patch.autoCompaction)) ||
        (patch.autoRetry !== undefined && !isBoolean(patch.autoRetry)) ||
        (patch.defaultProjectTrust !== undefined && !isString(patch.defaultProjectTrust))
      ) {
        return fail("invalid Pi settings patch", { method });
      }
      return ok(params);
    }
    case "extensionUi.respond":
      return exactObject(params, ["requestId", "status"], ["value"]) &&
        isUuid(params.requestId) &&
        (params.status === "resolved" || params.status === "cancelled") &&
        (params.value === undefined || isJsonValue(params.value))
        ? ok(params)
        : fail("invalid extensionUi.respond params", { method });
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
  if (!isPlainObject(value) || value.protocolVersion !== 1 || !isUuid(value.id) || !isHostMethod(value.method)) {
    return false;
  }
  if (!hasHostIdentity(value) || typeof value.ok !== "boolean") return false;
  if (value.ok) {
    if (!hasExactKeys(value, ["protocolVersion", ...identityKeys, "id", "method", "ok", "result"])) {
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
    !hasExactKeys(value, ["protocolVersion", ...identityKeys, "event", "sequence", "timestamp", "payload"]) ||
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

export function validateSerializableAgentToolResult(
  value: unknown,
): ValidationResult<{
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
