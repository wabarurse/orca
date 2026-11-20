// The link under a column of a laid-out row: its OSC 8 target, else a web address written out there. Mouse reporting
// keeps clicks from the terminal, so the TUI finds and opens links itself (http, https and mailto only).
import { cells } from "./text";

const ESCAPE = /\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)|\x1b\[[0-9;:?<>]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/y;
const BARE_URL = /https?:\/\/[^\s<>"'`\x1b]+/g;
/** Only these are ever handed to the desktop, whatever a transcript printed. */
export const OPENABLE = /^(?:https?:\/\/|mailto:)\S+$/i;

export function linkAt(row: string, col: number): string | undefined {
  let url: string | undefined, x = 0, i = 0;
  const openable = (found: string | undefined) => found && OPENABLE.test(found) ? found : undefined;
  while (i < row.length && col >= x) {
    ESCAPE.lastIndex = i;
    const m = row[i] === "\x1b" ? ESCAPE.exec(row) : null;
    if (m) { if (m[1] !== undefined) url = m[1] || undefined; i += m[0].length; continue; }
    let j = row.indexOf("\x1b", i + 1);
    if (j === -1) j = row.length;
    for (const c of cells(row, i, j)) {
      if (col < x + c.width) return openable(url) ?? bareLink(Bun.stripANSI(row), col);
      x += c.width;
    }
    i = j;
  }
}

function bareLink(plain: string, col: number): string | undefined {
  for (const m of plain.matchAll(BARE_URL)) {
    const text = m[0].replace(/[.,;:!?)\]}]+$/, ""), start = Bun.stringWidth(plain.slice(0, m.index));
    if (col >= start && col < start + Bun.stringWidth(text)) return text;
  }
}
