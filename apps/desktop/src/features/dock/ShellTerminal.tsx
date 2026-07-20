import { Channel, invoke } from "@tauri-apps/api/core";
import type { Terminal } from "@xterm/xterm";
import { XtermSurface } from "./XtermSurface";

const INPUT_FLUSH_MS = 8;
const MAX_INPUT_CHUNK = 64 * 1024;

export function chunkTerminalInput(input: string, maxLength = MAX_INPUT_CHUNK): string[] {
  const chunks: string[] = [];
  let remaining = input;
  while (remaining) {
    let end = Math.min(maxLength, remaining.length);
    const lastCodeUnit = remaining.charCodeAt(end - 1);
    if (end < remaining.length && lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
      end -= 1;
    }
    if (end === 0) end = Math.min(2, remaining.length);
    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  return chunks;
}

type ShellTerminalEvent =
  | { type: "output"; data: string }
  | { type: "exited"; exitCode: number | null }
  | { type: "error"; message: string };

type ShellTerminalCreateResult = {
  terminalId: string;
  title: string;
  cwd: string;
};

export type ShellTerminalStatus = {
  state: "starting" | "running" | "exited" | "error";
  title: string;
  cwd: string;
  exitCode?: number | null;
  message?: string;
};

export type ShellTerminalProps = {
  cwd: string;
  generation: number;
  visible: boolean;
  onStatus: (status: ShellTerminalStatus) => void;
};

function cwdName(cwd: string): string {
  const parts = cwd.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts.at(-1) || cwd;
}

async function attachShell(
  terminal: Terminal,
  cwd: string,
  onStatus: (status: ShellTerminalStatus) => void,
): Promise<() => Promise<void>> {
  let terminalId: string | undefined;
  let shellTitle = "Shell";
  let disposed = false;
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  let inputTimer: ReturnType<typeof setTimeout> | undefined;
  let inputBuffer = "";
  let inputChain = Promise.resolve();

  const flushInput = () => {
    inputTimer = undefined;
    if (!terminalId || !inputBuffer) return;
    const chunks = chunkTerminalInput(inputBuffer);
    inputBuffer = "";
    for (const data of chunks) {
      inputChain = inputChain
        .then(() => invoke<void>("shell_terminal_write", { terminalId, data }))
        .catch(() => {});
    }
  };

  const dataSubscription = terminal.onData((data) => {
    if (!data || disposed) return;
    inputBuffer += data;
    if (inputBuffer.length >= MAX_INPUT_CHUNK) {
      flushInput();
    } else if (!inputTimer) {
      inputTimer = setTimeout(flushInput, INPUT_FLUSH_MS);
    }
  });
  const resizeSubscription = terminal.onResize(({ cols, rows }) => {
    if (!terminalId || disposed) return;
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = undefined;
      void invoke("shell_terminal_resize", { terminalId, cols, rows }).catch(() => {});
    }, 30);
  });

  const channel = new Channel<ShellTerminalEvent>();
  channel.onmessage = (event) => {
    if (disposed) return;
    if (event.type === "output") {
      terminal.write(event.data);
      return;
    }
    if (event.type === "error") {
      terminal.writeln(`\r\n${event.message}`);
      onStatus({ state: "error", title: shellTitle, cwd, message: event.message });
      return;
    }
    terminal.writeln(
      `\r\n[Process exited${event.exitCode === null ? "" : ` with code ${event.exitCode}`}]`,
    );
    onStatus({
      state: "exited",
      title: shellTitle,
      cwd,
      exitCode: event.exitCode,
    });
  };

  onStatus({ state: "starting", title: shellTitle, cwd });
  try {
    const result = await invoke<ShellTerminalCreateResult>("shell_terminal_create", {
      cwd,
      cols: terminal.cols,
      rows: terminal.rows,
      onEvent: channel,
    });
    terminalId = result.terminalId;
    shellTitle = result.title;
    flushInput();
    if (disposed) {
      await invoke("shell_terminal_close", { terminalId }).catch(() => false);
    } else {
      onStatus({
        state: "running",
        title: shellTitle,
        cwd: result.cwd,
      });
    }
  } catch (error) {
    dataSubscription.dispose();
    resizeSubscription.dispose();
    const message = error instanceof Error ? error.message : String(error);
    onStatus({ state: "error", title: shellTitle, cwd, message });
    throw error;
  }

  return async () => {
    disposed = true;
    dataSubscription.dispose();
    resizeSubscription.dispose();
    if (resizeTimer) clearTimeout(resizeTimer);
    if (inputTimer) clearTimeout(inputTimer);
    flushInput();
    await inputChain.catch(() => {});
    if (terminalId) {
      await invoke("shell_terminal_close", { terminalId }).catch(() => false);
    }
  };
}

export function ShellTerminal({ cwd, generation, visible, onStatus }: ShellTerminalProps) {
  return (
    <XtermSurface
      sessionKey={`shell:${generation}`}
      visible={visible}
      connect={(terminal) => attachShell(terminal, cwd, onStatus)}
    />
  );
}

export const shellTerminalLabel = cwdName;
