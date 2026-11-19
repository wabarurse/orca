// Chapter rules for the pinned header. Labels are display-only; navigation and
// storage continue to use the immutable project IDs held by App.
import { bold, dim, fit, sanitize, visibleLength } from "../components";

export interface Tab { name: string; busy?: boolean }
export interface Chapter {
  tabs: Tab[];
  active: number;
  /** The project's account (provider:profile); leads the model field so narrow widths keep it. */
  account?: string;
  model: string;
  agent?: string;
  context?: string;
}

const plain = (s: string) => Bun.stripANSI(sanitize(s.replace(/[\r\n\t]/g, " ")));
const tabSpan = (labels: string[], start: number, end: number) => `${start > 0 ? "…   " : ""}${labels.slice(start, end + 1).join("   ")}${end < labels.length - 1 ? "   …" : ""}`;

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
  return bold(fit(plain(name), cols));
}

/** One bounded row, including explicit markers for omitted neighbours. */
export function tabRow(tabs: Tab[], active: number, cols: number): string {
  if (!tabs.length || cols < 1) return "";
  const at = Math.max(0, Math.min(active, tabs.length - 1));
  const labels = tabs.map((t, i) => `${plain(t.name)}${t.busy && i !== at ? " •" : ""}`);
  const [start, end] = tabWindow(labels, at, cols);
  if (visibleLength(tabSpan(labels, start, end)) > cols) return clippedTab(tabs[at]!.name, cols);
  const styled = labels.map((s, i) => i === at ? bold(s) : dim(s));
  return tabSpan(styled, start, end);
}

/** Height budget shared by App's input geometry and the sticky renderer. */
export const headerHeight = (rows: number) => Math.max(0, Math.min(Math.floor(rows / 3), rows - 3));

/** A box open at the top edge of the terminal: the tabs with the context (x/y) at the right, then in dim the agent being
 * viewed, the account and the models, clipped at its tail, then the box's bottom line. Under 12 columns or 3 rows, no box. */
export function chapterRows(c: Chapter, cols: number, budget = 10): string[] {
  if (budget < 1) return [];
  cols = Math.max(1, cols);
  const meta = plain([c.agent ? `view ${c.agent}` : "", c.account ?? "", c.model].filter(Boolean).join(" · "));
  const context = plain(c.context ?? "");
  if (cols < 12 || budget < 3) {
    const tabs = tabRow(c.tabs, c.active, cols);
    return budget > 1 ? [tabs, dim(fit(meta, cols))] : [tabs];
  }
  const inner = cols - 4, right = context && visibleLength(context) + 12 <= inner ? context : "";
  const tabs = tabRow(c.tabs, c.active, inner - (right ? visibleLength(right) + 2 : 0));
  const side = (text: string) => `${dim("│")} ${text}${" ".repeat(Math.max(0, inner - visibleLength(text)))} ${dim("│")}`;
  const top = right ? tabs + " ".repeat(Math.max(1, inner - visibleLength(tabs) - visibleLength(right))) + dim(right) : tabs;
  return [side(top), side(dim(fit(meta, inner))), dim("└" + "─".repeat(cols - 2) + "┘")];
}
