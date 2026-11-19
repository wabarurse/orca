// The terminal the TUI draws on: its size, key and resize events, raw output and a title. In production it is
// OpenTUI (tui/otui), which owns raw mode, the alternate screen, paste and mouse input and takes whole painted
// frames (`paint`); tests pass a fake that receives the escape-sequence diff instead.

import type { Key } from "./keys";
import { basename } from "node:path";

export const repositoryTitle = (directory: string): string => basename(directory) ? `orca · ${basename(directory)}` : "orca";

export interface Terminal {
  cols: number;
  rows: number;
  /** Confirmed by the terminal's inline-image cell-size reply, never TERM alone. */
  inlineImages?: boolean;
  imageCell?: { width: number; height: number };
  /** The image protocol this terminal speaks (from its environment), or null when it speaks none. */
  imageProtocol?: "kitty" | null;
  write(s: string): void;
  /** Terminal window/tab title; optional on test and embedded terminals. */
  setTitle?(title: string): void;
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
  /** A terminal that draws whole frames itself (OpenTUI) takes the painted rows and the cursor instead of escape-sequence diffs. */
  paint?(frame: PaintedFrame): void;
  /** Settles once close() has handed the screen back, so what is printed after it lands on the primary screen. */
  released?: Promise<void>;
}

/** One painted frame: its rows (with SGR and OSC 8) and the cursor's row and column, zero-based. */
export interface PaintedFrame { rows: string[]; cursor: number; col: number }
