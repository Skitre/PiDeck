/**
 * Extension terminal frame bus — routes extensionUi.customFrame data from the
 * host event handler to the mounted xterm instance without going through
 * React state (frames can be high-frequency during TUI animations).
 *
 * Frames that arrive before the terminal component mounts (the gap between
 * customStarted and the xterm mount) are buffered per requestId and replayed
 * on subscribe, preserving order.
 */

type FrameListener = (data: string) => void;

const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

const buffers = new Map<string, string>();
const listeners = new Map<string, FrameListener>();

export function pushExtensionTerminalFrame(requestId: string, data: string): void {
  const listener = listeners.get(requestId);
  if (listener) {
    listener(data);
    return;
  }
  const buffered = (buffers.get(requestId) ?? "") + data;
  // Keep the tail — the newest output wins if a panel is never mounted.
  buffers.set(
    requestId,
    buffered.length > MAX_BUFFERED_BYTES ? buffered.slice(-MAX_BUFFERED_BYTES) : buffered,
  );
}

export function subscribeExtensionTerminal(
  requestId: string,
  listener: FrameListener,
): () => void {
  const buffered = buffers.get(requestId);
  buffers.delete(requestId);
  if (buffered) listener(buffered);
  listeners.set(requestId, listener);
  return () => {
    if (listeners.get(requestId) === listener) listeners.delete(requestId);
  };
}

export function clearExtensionTerminal(requestId: string): void {
  buffers.delete(requestId);
  listeners.delete(requestId);
}
