// The terminal behind the TUI: raw mode, the alternate screen, size and key
// events. The real one wraps stdin/stdout; tests pass a fake with the same shape.

import { parseKeys, type Key } from "./keys";

export interface Terminal {
  cols: number;
  rows: number;
  write(s: string): void;
  onKey(cb: (key: Key) => void): void;
  onResize(cb: () => void): void;
  /** Enter the alternate screen and raw mode. */
  open(): void;
  /** Undo open(); safe to call twice. */
  close(): void;
}

// Kitty keyboard protocol (disambiguate flag) and xterm modifyOtherKeys, so
// Ctrl+, and Ctrl+. reach us as distinct keys where the terminal supports them.
const ENTER = "\x1b[?1049h\x1b[H\x1b[2J\x1b[>1u\x1b[>4;2m";
const LEAVE = "\x1b[<u\x1b[>4;0m\x1b[?25h\x1b[?1049l";

export function realTerminal(stdin = process.stdin, stdout = process.stdout): Terminal {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("parallels start needs a terminal; run it from an interactive shell");
  let opened = false;
  const keyHandlers: ((k: Key) => void)[] = [];
  const onData = (chunk: string) => {
    for (const key of parseKeys(chunk)) for (const h of keyHandlers) h(key);
  };
  return {
    get cols() { return stdout.columns || 80; },
    get rows() { return stdout.rows || 24; },
    write: (s) => { stdout.write(s); },
    onKey: (cb) => { keyHandlers.push(cb); },
    onResize: (cb) => { stdout.on("resize", cb); },
    open() {
      if (opened) return;
      opened = true;
      stdin.setRawMode(true);
      stdin.setEncoding("utf8");
      stdin.on("data", onData);
      stdin.resume();
      stdout.write(ENTER);
    },
    close() {
      if (!opened) return;
      opened = false;
      stdout.write(LEAVE);
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    },
  };
}
