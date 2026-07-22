import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

export type ExtensionCommandOrigin = {
  readonly session: AgentSession;
  readonly runId: string;
  readonly invocation: string;
  active: boolean;
  widgetAttentionRequested: boolean;
};

const commandOriginStorage = new AsyncLocalStorage<ExtensionCommandOrigin>();

/** Mirror the SDK's extension-command parsing before AgentSession.prompt(). */
export function resolveExtensionCommandInvocation(
  session: AgentSession,
  text: string,
): string | undefined {
  if (!text.startsWith("/")) return undefined;
  const spaceIndex = text.indexOf(" ");
  const invocation = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
  if (!invocation) return undefined;
  try {
    return session.extensionRunner.getCommand(invocation) ? invocation : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Scope command provenance to this asynchronous handler chain. The active bit
 * prevents detached work created by a completed handler from being mistaken
 * for part of the command, while a widget factory may retain the captured
 * origin until its first successful render.
 */
export async function withExtensionCommandOrigin<T>(
  session: AgentSession,
  runId: string,
  invocation: string,
  run: () => Promise<T>,
): Promise<T> {
  const origin: ExtensionCommandOrigin = {
    session,
    runId,
    invocation,
    active: true,
    widgetAttentionRequested: false,
  };
  try {
    return await commandOriginStorage.run(origin, run);
  } finally {
    origin.active = false;
  }
}

export function getActiveExtensionCommandOrigin(
  session: AgentSession,
): ExtensionCommandOrigin | undefined {
  const origin = commandOriginStorage.getStore();
  return origin?.active && origin.session === session ? origin : undefined;
}

/** A command run may request widget attention at most once. */
export function claimExtensionCommandWidgetAttention(origin: ExtensionCommandOrigin): boolean {
  if (origin.widgetAttentionRequested) return false;
  origin.widgetAttentionRequested = true;
  return true;
}
