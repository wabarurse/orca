// Chapter rules for the pinned header. Labels are display-only; navigation and
// storage continue to use the immutable project IDs held by App.
import { bold, dim, fit, sanitize, visibleLength, wrap } from "./render";

export interface Tab { name: string; busy?: boolean }
export interface Chapter {
  tabs: Tab[];
  active: number;
  model: string;
  directory: string;
  remote: string;
  agent?: string;
  context?: string;
  review?: string;
}

const plain = (s: string) => Bun.stripANSI(sanitize(s.replace(/[\r\n\t]/g, " ")));
const tabSpan = (labels: string[], start: number, end: number) => `${start > 0 ? "… " : ""}${labels.slice(start, end + 1).join(" ")}${end < labels.length - 1 ? " …" : ""}`;

/** Add whole neighbours only; the active tab can never be pushed off the edge. */
function tabWindow(labels: string[], active: number, cols: number): [number, number] {
  let start = active, end = active;
  while (true) {
    if (start > 0 && visibleLength(tabSpan(labels, start - 1, end)) <= cols) start--;
    else if (end < labels.length - 1 && visibleLength(tabSpan(labels, start, end + 1)) <= cols) end++;
    else return [start, end];
  }
}

function clippedTab(name: string, cols: number): string {
  // Keep the plain-text active marker and brackets even without colour.
  return bold(cols < 4 ? ">" + "─".repeat(cols - 1) : `>[${fit(plain(name), cols - 3)}]`);
}

/** One bounded row, including explicit markers for omitted neighbours. */
export function tabRow(tabs: Tab[], active: number, cols: number): string {
  if (!tabs.length || cols < 1) return "";
  const at = Math.max(0, Math.min(active, tabs.length - 1));
  const labels = tabs.map((t, i) => `${i === at ? ">" : ""}[${plain(t.name)}]${t.busy && i !== at ? " •" : ""}`);
  const [start, end] = tabWindow(labels, at, cols);
  if (visibleLength(tabSpan(labels, start, end)) > cols) return clippedTab(tabs[at]!.name, cols);
  const styled = labels.map((s, i) => i === at ? bold(s) : dim(s));
  return tabSpan(styled, start, end);
}

/** Height budget shared by App's input geometry and the sticky renderer. */
export const headerHeight = (rows: number) => Math.max(0, Math.min(Math.floor(rows / 3), rows - 3));

/** Keep every metadata field before giving long fields a second row. */
function details(fields: string[], cols: number, budget: number): string[] {
  const heights = fields.map(() => 1);
  let spare = budget - fields.length;
  for (let i = 0; i < fields.length && spare > 0; i++) {
    if (visibleLength(plain(fields[i]!)) > cols) { heights[i] = 2; spare--; }
  }
  return fields.flatMap((field, i) => {
    const rows = wrap(plain(field), cols);
    return heights[i] === 2 ? [rows[0]!, fit(rows.slice(1).join(""), cols)] : [fit(plain(field), cols)];
  }).slice(0, budget).map(dim);
}

/** No brand or heavy fill: the selected identities sit directly in the rule. */
export function chapterRows(c: Chapter, cols: number, budget = 10): string[] {
  if (budget < 1) return [];
  cols = Math.max(1, cols);
  const inset = cols >= 12 ? 4 : 0;
  const tabs = tabRow(c.tabs, c.active, cols - inset);
  const head = inset ? `${dim("── ")}${tabs}${dim(" " + "─".repeat(Math.max(0, cols - 4 - visibleLength(tabs))))}` : tabs;
  if (budget === 1) return [head];
  const fields = [...(c.context || c.review ? [[c.context, c.review].filter(Boolean).join(" · ")] : []), `model ${c.model}`, c.directory, c.remote, ...(c.agent ? [`view ${c.agent}`] : [])];
  return [head, ...details(fields, cols, budget - 2), dim("─".repeat(cols))];
}
