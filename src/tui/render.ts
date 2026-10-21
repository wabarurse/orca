// Draw one frame of the TUI as a string. Pure: state in, escape codes out.
//
//   ┌ tab bar: one tab per orchestrator page ─────────────┐
//   │ body: the page's scrollback (or a menu over it)      │
//   │ input line                                           │
//   └──────────────────────────────────────────────────────┘

export const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
export const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const inverse = (s: string) => `\x1b[7m${s}\x1b[0m`;

export interface Tab { title: string; active: boolean; busy: boolean }
export interface Menu { title: string; items: string[]; index: number }
export interface Input { prompt: string; text: string; cursor: number }

export interface Frame {
  cols: number;
  rows: number;
  tabs: Tab[];
  /** The active page's scrollback, oldest first. */
  lines: string[];
  /** How many lines up from the bottom the body is scrolled. */
  scroll: number;
  input: Input;
  menu: Menu | null;
}

const ANSI = /\x1b\[[0-9;?<>]*[A-Za-z]/g;
export const visibleLength = (s: string) => s.replace(ANSI, "").length;

/** Split a styled line into pieces at most `cols` visible characters wide. */
export function wrap(line: string, cols: number): string[] {
  if (cols <= 0) return [line];
  const out: string[] = [];
  let piece = "";
  let width = 0;
  let i = 0;
  while (i < line.length) {
    if (line[i] === "\x1b") {
      const m = line.slice(i).match(/^\x1b\[[0-9;?<>]*[A-Za-z]/);
      if (m) { piece += m[0]; i += m[0].length; continue; }
    }
    const cp = line.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    if (width === cols) { out.push(piece + "\x1b[0m"); piece = ""; width = 0; }
    piece += ch;
    width++;
    i += ch.length;
  }
  out.push(piece);
  return out;
}

function tabBar(tabs: Tab[], cols: number): string {
  if (tabs.length === 0) return "";
  const cells = tabs.map((t) => {
    const label = ` ${t.title}${t.busy ? " ·" : ""} `;
    return t.active ? inverse(label) : dim(label);
  });
  return wrap(cells.join(" "), cols)[0]!;
}

export function render(f: Frame): string {
  const bodyRows = Math.max(0, f.rows - 2);
  const wrapped = f.lines.flatMap((l) => wrap(l, f.cols));
  const end = Math.max(0, wrapped.length - f.scroll);
  const body = wrapped.slice(Math.max(0, end - bodyRows), end);
  while (body.length < bodyRows) body.unshift("");
  if (f.menu) {
    // The menu sits at the bottom of the body, on top of the scrollback.
    const rows = [f.menu.title, ...f.menu.items.map((item, i) => `${i === f.menu!.index ? bold("❯") : " "} ${item}`)];
    const shown = rows.slice(-bodyRows);
    body.splice(body.length - shown.length, shown.length, ...shown);
  }
  const out: string[] = [tabBar(f.tabs, f.cols), ...body];
  const inputLine = f.input.prompt + f.input.text;
  out.push(wrap(inputLine, f.cols).at(-1) ?? "");
  // Clear each row before writing so shorter lines never leave debris.
  const screen = out.map((row, i) => `\x1b[${i + 1};1H\x1b[2K${row}`).join("");
  const col = Math.min(f.cols, visibleLength(f.input.prompt) + f.input.cursor + 1);
  return `\x1b[?25l${screen}\x1b[${f.rows};${col}H\x1b[?25h`;
}
