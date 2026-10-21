// The terminal behind the TUI: raw mode, bracketed paste, size and key
// events. No alternate screen: the TUI is inline, writing into the normal
// screen and its scrollback. The real one wraps stdin/stdout; tests pass a
// fake with the same shape. Opening asks the terminal for its background
// colour (OSC 11) without waiting: a reply within BG_REPLY_MS sets the user
// background's shade (style.ts); later or other OSC replies are dropped, and
// none of them ever reaches the app as keys.

import { keyReader, type Key } from "./keys";
import { BG_QUERY, BG_REPLY_MS, parseBgReply, useTerminalBackground } from "./style";

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
  /** What to write, on a crash or a signal, to take the live region off the screen (the app keeps it current). */
  eraseOnExit(text: string): void;
}

// Bracketed paste, so a pasted newline is text, not Enter. Leaving keeps the screen as it is.
const ENTER = "\x1b[?2004h";
const LEAVE = "\x1b[?2004l\x1b[?25h";
/** On a crash or signal: end any synchronized update, paste mode and a hidden cursor first. */
const RESCUE = "\x1b[?2026l\x1b[?2004l\x1b[?25h";

/** The parts of `process` the crash and signal handlers use; tests pass a fake. */
export interface Proc {
  on(event: string, fn: (...args: any[]) => void): unknown;
  off(event: string, fn: (...args: any[]) => void): unknown;
  exit(code?: number): never | void;
  stderr: { write(s: string): unknown };
}

type Handler = (...args: any[]) => void;

/** process handlers that tidy the terminal (`rescue`) before a signal or crash ends the process. */
function exitHandlers(rescue: () => void, proc: Proc): [string, Handler][] {
  const die = (code: number) => () => { rescue(); proc.exit(code); };
  const crash = (err: unknown) => {
    rescue();
    proc.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    proc.exit(1);
  };
  return [["exit", rescue], ["SIGTERM", die(143)], ["SIGHUP", die(129)], ["uncaughtException", crash]];
}

/** Write without throwing: on SIGHUP the terminal may be gone. */
function attempt(fn: () => void): void {
  try { fn(); } catch { /* nothing left to restore */ }
}

export function realTerminal(stdin = process.stdin, stdout = process.stdout, proc: Proc = process, now: () => number = Date.now): Terminal {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("parallels start needs a terminal; run it from an interactive shell");
  return new RealTerminal(stdin, stdout, proc, now);
}

class RealTerminal implements Terminal {
  private opened = false;
  private eraser = "";
  private readonly keyHandlers: ((k: Key) => void)[] = [];
  /** When the background query went out; null once answered (or never asked). It goes out once. */
  private asked: number | null = null;
  private queried = false;
  private readonly reader = keyReader((key) => {
    if (key.name === "osc") return this.reply(key.text ?? "");
    for (const h of this.keyHandlers) h(key);
  });
  private readonly onData = (chunk: string) => this.reader.feed(chunk);
  private readonly handlers: [string, Handler][];

  constructor(private readonly stdin: typeof process.stdin, private readonly stdout: typeof process.stdout, private readonly proc: Proc, private readonly now: () => number) {
    this.handlers = exitHandlers(() => this.rescue(), proc);
  }

  get cols() { return this.stdout.columns || 80; }
  get rows() { return this.stdout.rows || 24; }
  write(s: string): void { this.stdout.write(s); }
  onKey(cb: (k: Key) => void): void { this.keyHandlers.push(cb); }
  onResize(cb: () => void): void { this.stdout.on("resize", cb); }
  eraseOnExit(text: string): void { this.eraser = text; }

  /** An OSC reply: the first background reply in time sets the shade; anything else is dropped. */
  private reply(body: string): void {
    const bg = body.startsWith("11;") ? parseBgReply(body) : null;
    if (!bg || this.asked === null) return;
    if (this.now() - this.asked <= BG_REPLY_MS) useTerminalBackground(bg);
    this.asked = null;
  }

  private install(on: boolean): void {
    for (const [event, fn] of this.handlers) (on ? this.proc.on : this.proc.off).call(this.proc, event as "exit", fn);
  }

  /** Put the terminal back after a crash or signal: no sync, paste or hidden cursor, no live region, cooked mode. */
  private rescue(): void {
    if (!this.opened) return;
    this.opened = false;
    attempt(() => this.stdout.write(RESCUE + this.eraser));
    attempt(() => this.stdin.setRawMode(false));
    this.install(false);
  }

  open(): void {
    if (this.opened) return;
    this.opened = true;
    this.install(true);
    this.stdin.setRawMode(true);
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", this.onData);
    this.stdin.resume();
    this.stdout.write(ENTER);
    if (!this.queried) { this.queried = true; this.asked = this.now(); this.stdout.write(BG_QUERY); }
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.install(false);
    this.stdout.write(LEAVE);
    this.stdin.off("data", this.onData);
    this.reader.close();
    this.stdin.setRawMode(false);
    this.stdin.pause();
  }
}
