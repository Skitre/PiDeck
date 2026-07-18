/** P0 Host error codes — PROJECT_SPEC §14 */
export const HOST_ERROR_CODES = [
  "INVALID_REQUEST",
  "UNSUPPORTED_METHOD",
  "HOST_NOT_READY",
  "HOST_SHUTTING_DOWN",
  "HOST_RESTART_REQUIRED",
  "STALE_REVISION",
  "SERVICE_GRAPH_BUSY",
  "WORKSPACE_SWITCH_FAILED",
  "TRUST_REQUIRED",
  "AGENT_NOT_READY",
  "AGENT_BUSY",
  "AGENT_ABORTED",
  "SESSION_NOT_FOUND",
  "SESSION_SWITCH_FAILED",
  "MODEL_NOT_FOUND",
  "AUTH_REQUIRED",
  "PACKAGE_NOT_FOUND",
  "PACKAGE_ALREADY_INSTALLED",
  "PACKAGE_INSTALL_FAILED",
  "PACKAGE_REMOVE_FAILED",
  "PACKAGE_UPDATE_FAILED",
  "PACKAGE_PARTIAL_FAILURE",
  "PACKAGE_RESOLVE_FAILED",
  "PACKAGE_MUTATION_BUSY",
  "PROJECT_NOT_SELECTED",
  "PROJECT_NOT_TRUSTED",
  "RESOURCE_NOT_FOUND",
  "RESOURCE_RELOAD_FAILED",
  "EXTENSION_UI_TIMEOUT",
  "SETTINGS_READ_FAILED",
  "SETTINGS_WRITE_FAILED",
  "INTERNAL_ERROR",
] as const;

export type HostErrorCode = (typeof HOST_ERROR_CODES)[number];

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type HostError = {
  code: HostErrorCode;
  message: string;
  retryable: boolean;
  details?: JsonValue;
};

export function isHostErrorCode(value: unknown): value is HostErrorCode {
  return typeof value === "string" && (HOST_ERROR_CODES as readonly string[]).includes(value);
}

export function createHostError(
  code: HostErrorCode,
  message: string,
  options?: { retryable?: boolean; details?: JsonValue },
): HostError {
  return {
    code,
    message,
    retryable: options?.retryable ?? false,
    ...(options?.details !== undefined ? { details: options.details } : {}),
  };
}
