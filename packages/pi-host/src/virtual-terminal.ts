/**
 * VirtualTerminal — pi-tui Terminal implementation with no real TTY.
 *
 * Drives a real pi-tui TUI instance inside the host process for
 * ExtensionUIContext.custom() panels. Everything the TUI writes (ANSI
 * escape stream) is forwarded to `onData`, which the extension UI bridge
 * batches into extensionUi.customFrame events rendered by xterm.js in the
 * desktop frontend. Keyboard input travels the reverse path: xterm onData →
 * extensionUi.customInput → input() → the TUI's input handler. Terminal
 * probe queries emitted by the TUI (e.g. OSC 11 background color) reach the
 * real xterm.js instance, whose replies come back through the same input
 * path — no synthesized responses needed.
 */
import type { Terminal } from "@earendil-works/pi-tui";

export const VIRTUAL_TERMINAL_DEFAULT_COLS = 100;
export const VIRTUAL_TERMINAL_DEFAULT_ROWS = 32;

const MIN_COLS = 20;
const MAX_COLS = 1000;
const MIN_ROWS = 4;
const MAX_ROWS = 1000;

export class VirtualTerminal implements Terminal {
  private cols: number;
  private rowCount: number;
  private inputHandler?: (data: string) => void;
  private resizeHandler?: () => void;
  private readonly onData: (data: string) => void;

  constructor(options: {
    onData: (data: string) => void;
    cols?: number;
    rows?: number;
  }) {
    this.onData = options.onData;
    this.cols = clamp(options.cols ?? VIRTUAL_TERMINAL_DEFAULT_COLS, MIN_COLS, MAX_COLS);
    this.rowCount = clamp(options.rows ?? VIRTUAL_TERMINAL_DEFAULT_ROWS, MIN_ROWS, MAX_ROWS);
  }

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.inputHandler = onInput;
    this.resizeHandler = onResize;
  }

  stop(): void {
    this.inputHandler = undefined;
    this.resizeHandler = undefined;
  }

  async drainInput(): Promise<void> {}

  write(data: string): void {
    this.onData(data);
  }

  get columns(): number {
    return this.cols;
  }

  get rows(): number {
    return this.rowCount;
  }

  get kittyProtocolActive(): boolean {
    return false;
  }

  moveBy(lines: number): void {
    if (lines > 0) {
      this.onData(`\x1b[${lines}B`);
    } else if (lines < 0) {
      this.onData(`\x1b[${-lines}A`);
    }
  }

  hideCursor(): void {
    this.onData("\x1b[?25l");
  }

  showCursor(): void {
    this.onData("\x1b[?25h");
  }

  clearLine(): void {
    this.onData("\x1b[K");
  }

  clearFromCursor(): void {
    this.onData("\x1b[J");
  }

  clearScreen(): void {
    this.onData("\x1b[2J\x1b[H");
  }

  setTitle(title: string): void {
    this.onData(`\x1b]0;${title}\x07`);
  }

  setProgress(_active: boolean): void {}

  /** Inject keyboard/paste data (or terminal query replies) from the frontend. */
  input(data: string): void {
    this.inputHandler?.(data);
  }

  /** Resize the viewport (frontend fit) and notify the TUI. */
  resize(cols: number, rows: number): void {
    const nextCols = clamp(Math.floor(cols), MIN_COLS, MAX_COLS);
    const nextRows = clamp(Math.floor(rows), MIN_ROWS, MAX_ROWS);
    if (nextCols === this.cols && nextRows === this.rowCount) return;
    this.cols = nextCols;
    this.rowCount = nextRows;
    this.resizeHandler?.();
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
