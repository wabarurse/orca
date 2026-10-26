// Stable reading positions, independent of rendered block heights. Separators
// have their own identity; markdown parts expose content before repeated gutters.
import { cells } from "./editor";
import { historyRows, lineRows, type Shown } from "./lines";
import { renderBlock, renderLabelled, renderMarkdown, type RowTrace } from "./markdown";
import { sanitize, wrap } from "./render";

interface Position { part: number; offset: number }
export interface HistoryAnchor extends Position { line: number }

/** One position per rendered content row; part -1 is reserved for a separator. */
function positions(line: Shown, cols: number): Position[] {
  const out: Position[] = [];
  let part = 0;
  const trace: RowTrace = (rows, mode) => {
    let offset = 0;
    for (const row of rows) {
      out.push({ part, offset });
      if (mode !== "block") offset += cells(Bun.stripANSI(row)).filter(c => mode === "literal" || /\S/u.test(c.text)).length;
    }
    part++;
  };
  if (typeof line === "string" || "tool" in line || "calls" in line) return lineRows(line, cols).map((_, part) => ({ part, offset: 0 }));
  if ("user" in line) trace(wrap(sanitize(line.user), cols), "literal");
  else if (line.block) renderBlock(line.md, cols, trace);
  else if (line.label) renderLabelled(line.label, line.md, cols, trace);
  else renderMarkdown(line.md, cols, trace);
  return out;
}

function layout(lines: readonly Shown[], index: number, cols: number) {
  const line = lines[index]!;
  const content = positions(line, cols);
  const height = historyRows([line], cols, lines[index - 1]).length;
  return { content, height, separator: height - content.length };
}

/** Capture once per scroll intent, not once per resize (which would lose offsets). */
export function captureAnchor(lines: readonly Shown[], cols: number, top: number): HistoryAnchor {
  for (let line = 0; line < lines.length; line++) {
    const { content, height, separator } = layout(lines, line, cols);
    if (top < height) return { line, ...(content[top - separator] ?? { part: -1, offset: 0 }) };
    top -= height;
  }
  return { line: lines.length, part: 0, offset: 0 }; // transient tail: nearest durable boundary
}

/** The row containing the original content offset, not a fraction of block height. */
function contentRow(content: Position[], anchor: HistoryAnchor): number {
  const first = content.findIndex(p => p.part === anchor.part);
  if (first < 0) return 0;
  let row = first;
  while (row + 1 < content.length && content[row + 1]!.part === anchor.part && content[row + 1]!.offset <= anchor.offset && content[row + 1]!.offset > content[row]!.offset) row++;
  return row;
}

export function resolveAnchor(lines: readonly Shown[], cols: number, anchor: HistoryAnchor): number {
  let top = 0;
  for (let line = 0; line < Math.min(anchor.line, lines.length); line++) top += historyRows([lines[line]!], cols, lines[line - 1]).length;
  if (anchor.line >= lines.length || anchor.part === -1) return top;
  const { content, separator } = layout(lines, anchor.line, cols);
  return top + separator + contentRow(content, anchor);
}
