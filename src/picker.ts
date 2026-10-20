// An arrow-key menu for the REPL. Up/down (or j/k) move, Enter picks, Esc or q
// cancels. While it is open it borrows the input's keypress events from
// readline and gives them back afterwards; without a TTY it prints the items
// and returns null so scripts and tests never hang.

import { emitKeypressEvents } from "node:readline";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

export interface Choice<T> {
  value: T;
  /** One line, already styled; the cursor marker is added in front. */
  label: string;
  /** Mark the row with ● instead of leaving it blank. */
  current?: boolean;
}

export interface PickerIO {
  input: NodeJS.EventEmitter & { isTTY?: boolean };
  output: { write(s: string): unknown };
}

interface Key { name?: string; ctrl?: boolean; sequence?: string }

/** Show the choices and resolve with the picked value, or null when cancelled. */
export async function pick<T>(choices: Choice<T>[], opts: { title?: string; io?: PickerIO } = {}): Promise<T | null> {
  const io: PickerIO = opts.io ?? { input: process.stdin, output: process.stdout };
  const { input, output } = io;
  const marker = (c: Choice<T>) => (c.current ? "●" : " ");
  if (choices.length === 0) return null;
  if (!input.isTTY) {
    if (opts.title) output.write(opts.title + "\n");
    for (const c of choices) output.write(`  ${marker(c)} ${c.label}\n`);
    return null;
  }

  let index = Math.max(0, choices.findIndex((c) => c.current));
  const lines = choices.length + (opts.title ? 1 : 0);
  const draw = (first: boolean) => {
    const rows = choices.map((c, i) => `${i === index ? bold("❯") : " "} ${marker(c)} ${c.label}`);
    if (opts.title) rows.unshift(opts.title);
    // Move back to the top of the menu, then rewrite every line in place.
    output.write((first ? "" : `\x1b[${lines}A`) + rows.map((r) => `\x1b[2K\r${r}`).join("\n") + "\n");
  };

  emitKeypressEvents(input as NodeJS.ReadableStream);
  const borrowed = input.rawListeners("keypress");
  input.removeAllListeners("keypress");
  output.write("\x1b[?25l"); // hide the cursor
  draw(true);
  try {
    return await new Promise<T | null>((resolve) => {
      const onKey = (_: string | undefined, key: Key = {}) => {
        if (key.name === "up" || key.name === "k" || (key.ctrl && key.name === "p")) index = (index + choices.length - 1) % choices.length;
        else if (key.name === "down" || key.name === "j" || (key.ctrl && key.name === "n")) index = (index + 1) % choices.length;
        else if (key.name === "return" || key.name === "enter") return finish(choices[index]!.value);
        else if (key.name === "escape" || key.name === "q" || (key.ctrl && key.name === "c")) return finish(null);
        else return;
        draw(false);
      };
      const finish = (value: T | null) => {
        input.removeListener("keypress", onKey);
        resolve(value);
      };
      input.on("keypress", onKey);
    });
  } finally {
    output.write("\x1b[?25h");
    for (const l of borrowed) input.on("keypress", l as (...args: unknown[]) => void);
  }
}

export { dim, bold };
