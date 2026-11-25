import type { Key } from "./keys";
import type { Screen, ScreenAction } from "./screen-view";
import { basename } from "node:path";

export const repositoryTitle = (directory: string): string => basename(directory) !== "" ? `orca2 · ${basename(directory)}` : "orca2";

export type Terminal = {
  cols: number;
  rows: number;
  inlineImages?: boolean;
  imageCell?: { width: number; height: number };
  imageProtocol?: "kitty" | null;
  write(s: string): void;
  setTitle?(title: string): void;
  onKey(cb: (key: Key) => void): void;
  onResize(cb: () => void): void;
  open(): void;
  close(): void;
  eraseOnExit(text: string): void;
  show(screen: Screen): void;
  scroll(by: "up" | "down" | "page-up" | "page-down" | "home" | "end"): void;
  onAction(cb: (action: ScreenAction) => void): void;
  selection(): string;
  copyOsc52?(text: string): boolean;
  handOver(argv: string[]): Promise<number>;
  released?: Promise<void>;
};
