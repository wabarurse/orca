// The terminal behind the TUI: raw mode, bracketed paste, size and key
// events. The alternate screen keeps sticky bars separate from the shell's
// scrollback; mouse reporting supports wheel scrolling and in-app drag selection.
// DECSET 1000/1002 consumes native drag selection and
// link gestures, and the portable mouse protocol cannot identify macOS Cmd.
// Leave those gestures to the terminal/OSC 8 instead of spawning a browser. Tests pass a
// fake with the same shape. Opening asks the terminal for its background
// colour (OSC 11) once, without blocking: a reply within BG_REPLY_MS sets the
// user background's shade (style.ts) and settles `background` (so does the
// timeout), which the app awaits before committing its first page; later or
// other OSC replies are dropped, none of them ever reaches the app as keys,
// and a close inside the window keeps reading stdin until it ends.

import { keyReader, type Key, type SetTimer } from "./keys";
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
  /** Settles once the terminal's background is known or will not be (the OSC 11 reply or its timeout); the app commits the first page after it. */
  background?: Promise<void>;
}

// Restore the primary screen and disable all modes we enabled on every exit path.
const ENTER = "\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?2004h";
const LEAVE = "\x1b[0m\x1b[?1002l\x1b[?1006l\x1b[?1000l\x1b[?2004l\x1b[?1049l\x1b[?25h";
/** On a crash or signal: end any synchronized update, paste mode and a hidden cursor first. */
const RESCUE = `\x1b[?2026l${LEAVE}`;

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

/** Clock and timers for the background query's window; tests pass manual ones. */
export interface TermClock { now: () => number; setTimer: SetTimer }
/** Kept referenced, unlike the key reader's: closing waits out the reply window before the shell gets the terminal back. */
const realClock: TermClock = { now: Date.now, setTimer: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); } };

export function realTerminal(stdin = process.stdin, stdout = process.stdout, proc: Proc = process, clock: TermClock = realClock): Terminal {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("orca start needs a terminal; run it from an interactive shell");
  return new RealTerminal(stdin, stdout, proc, clock);
}

class RealTerminal implements Terminal {
  private opened = false;
  /** Closed, but waiting out the reply window with stdin still read (and dropped) in raw mode. */
  private draining = false;
  private eraser = "";
  private readonly keyHandlers: ((k: Key) => void)[] = [];
  /** When the background query went out; null once answered or its window is over. It goes out once. */
  private asked: number | null = null;
  private queried = false;
  private settle: (() => void) | null = null;
  private stopWait: (() => void) | null = null;
  /** Resolves once the background reply came or its window ended; resolved until open() asks. */
  background: Promise<void> = Promise.resolve();
  private readonly reader = keyReader((key) => this.key(key), 300, undefined, () => this.awaiting());
  private readonly onData = (chunk: string | Uint8Array) => this.reader.feed(chunk);
  private readonly handlers: [string, Handler][];

  constructor(private readonly stdin: typeof process.stdin, private readonly stdout: typeof process.stdout, private readonly proc: Proc, private readonly clock: TermClock) {
    this.handlers = exitHandlers(() => this.rescue(), proc);
  }

  get cols() { return this.stdout.columns || 80; }
  get rows() { return this.stdout.rows || 24; }
  write(s: string): void { this.stdout.write(s); }
  onKey(cb: (k: Key) => void): void { this.keyHandlers.push(cb); }
  onResize(cb: () => void): void { this.stdout.on("resize", cb); }
  eraseOnExit(text: string): void { this.eraser = text; }

  /** Whether the background reply is still expected. */
  private awaiting(): boolean {
    return this.asked !== null && this.clock.now() - this.asked <= BG_REPLY_MS;
  }

  /** A key from the reader: OSC replies are taken here, and nothing reaches the app once closed. */
  private key(k: Key): void {
    if (k.name === "osc") return this.reply(k.text ?? "");
    if (!this.opened) return;
    for (const h of this.keyHandlers) h(k);
  }

  /** An OSC reply: the first background reply in time sets the shade; anything else is dropped. */
  private reply(body: string): void {
    const bg = body.startsWith("11;") ? parseBgReply(body) : null;
    if (!bg || this.asked === null) return;
    if (this.awaiting()) useTerminalBackground(bg);
    this.windowOver();
  }

  /** Send the background query and open its window: `background` settles on the reply or when the window ends. */
  private ask(): void {
    this.asked = this.clock.now();
    this.background = new Promise<void>((resolve) => { this.settle = resolve; });
    this.stdout.write(BG_QUERY);
    this.stopWait = this.clock.setTimer(() => this.windowOver(), BG_REPLY_MS);
  }

  /** The reply came or the window ended: settle `background`, and finish a close that was waiting for it. */
  private windowOver(): void {
    this.asked = null;
    this.stopWait?.();
    this.stopWait = null;
    this.settle?.();
    this.settle = null;
    if (this.draining) this.release();
  }

  private install(on: boolean): void {
    for (const [event, fn] of this.handlers) (on ? this.proc.on : this.proc.off).call(this.proc, event as "exit", fn);
  }

  /** Put the terminal back after a crash or signal: no sync, paste or hidden cursor, no live region, cooked mode. */
  private rescue(): void {
    if (this.draining) return this.release();
    if (!this.opened) return;
    this.opened = false;
    attempt(() => this.stdout.write(RESCUE + this.eraser));
    this.release();
  }

  open(): void {
    if (this.opened || this.draining) return;
    this.opened = true;
    this.install(true);
    this.stdin.setRawMode(true);
    // Keep raw bytes: legacy X10 payloads are not UTF-8; the reader decodes text.
    this.stdin.on("data", this.onData);
    this.stdin.resume();
    this.stdout.write(ENTER);
    if (!this.queried) { this.queried = true; this.ask(); }
  }

  /** Leave paste mode at once; while the background reply is still expected, keep reading (and dropping) stdin until it comes or the window ends, so it never lands at the shell prompt. */
  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.stdout.write(LEAVE);
    if (this.awaiting()) { this.draining = true; return; }
    this.release();
  }

  /** Hand the terminal back: no handlers, no reader, cooked mode. */
  private release(): void {
    this.draining = false;
    this.install(false);
    this.stdin.off("data", this.onData);
    this.reader.close();
    attempt(() => this.stdin.setRawMode(false));
    this.stdin.pause();
  }
}
