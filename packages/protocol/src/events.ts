export const HOST_EVENT_NAMES = [
  "host.ready",
  "host.statusChanged",
  "host.fatal",
  "workspace.changed",
  "session.snapshot",
  "session.infoChanged",
  "session.runtimeChanged",
  "agent.event",
  "agent.toolsChanged",
  "agent.queueChanged",
  "agent.compactionChanged",
  "agent.retryChanged",
  "model.changed",
  "package.progress",
  "package.snapshot",
  "package.resourcesChanged",
  "package.diagnostic",
  "extensionUi.request",
  "extensionUi.statusChanged",
  "extensionUi.widgetChanged",
  "extensionUi.notification",
  "extensionUi.customStarted",
  "extensionUi.customFrame",
  "extensionUi.customClosed",
] as const;

export type HostEventName = (typeof HOST_EVENT_NAMES)[number];

export function isHostEventName(value: unknown): value is HostEventName {
  return typeof value === "string" && (HOST_EVENT_NAMES as readonly string[]).includes(value);
}
