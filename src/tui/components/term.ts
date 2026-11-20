// The terminal the TUI draws on: its size, key, resize and click events, raw output and a title. It draws whole
// screens (`show`): OpenTUI in production (tui/otui), OpenTUI's test renderer in tests.

import type { Key } from "./keys";
import type { Screen, ScreenAction } from "./screen-view";
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
  /** Draw this screen (the chat or a full-screen page). */
  show(screen: Screen): void;
  /** Scroll the conversation: a row, a page, or to either end. */
  scroll(by: "up" | "down" | "page-up" | "page-down" | "home" | "end"): void;
  /** A click on the screen asked for something (open a fold, a link, a work-page item; copy a selection). */
  onAction(cb: (action: ScreenAction) => void): void;
  /** The text selected with the mouse, or "" when nothing is. */
  selection(): string;
  /** Settles once close() has handed the screen back, so what is printed after it lands on the primary screen. */
  released?: Promise<void>;
}
