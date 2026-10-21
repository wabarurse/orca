// The terminal behind the TUI: raw mode, bracketed paste, size and key
// events. No alternate screen: the TUI is inline, writing into the normal
// screen and its scrollback. The real one wraps stdin/stdout; tests pass a fake with the same shape.

import { keyReader, type Key } from "./keys";

export interface Terminal {
  cols: number;
  rows: number;
  write(s: string): void;
  onKey(cb: (key: Key) => void): void;
  onResize(cb: () => void): void;
  /** Enter raw mode and bracketed paste. */
  open(): void;
  /** Undo open(); safe to call twice. */
  close(): void;
}

// Bracketed paste, so a pasted newline is text, not Enter. Leaving keeps the screen as it is.
const ENTER = "\x1b[?2004h";
const LEAVE = "\x1b[?2004l\x1b[?25h";

export function realTerminal(stdin = process.stdin, stdout = process.stdout): Terminal {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("parallels start needs a terminal; run it from an interactive shell");
  let opened = false;
  const keyHandlers: ((k: Key) => void)[] = [];
  const reader = keyReader((key) => { for (const h of keyHandlers) h(key); });
  const onData = (chunk: string) => reader.feed(chunk);
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
      reader.close();
      stdin.setRawMode(false);
      stdin.pause();
    },
  };
}
