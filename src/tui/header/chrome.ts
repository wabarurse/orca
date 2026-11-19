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

/** One ruled row: the tabs on the left and, on the right in dim, the agent being viewed, the account, the models and the
 * context; a narrow width clips that tail first, so the tabs, the account and the orchestrator's model survive longest. */
export function chapterRows(c: Chapter, cols: number, budget = 10): string[] {
  if (budget < 1) return [];
  cols = Math.max(1, cols);
  const inset = cols >= 12 ? 3 : 0;
  const meta = plain([c.agent ? `view ${c.agent}` : "", c.account ?? "", c.model, c.context ?? ""].filter(Boolean).join(" · "));
  const tabs = tabRow(c.tabs, c.active, Math.max(1, cols - inset - (inset ? 1 : 0) - Math.min(visibleLength(meta) + 6, 14)));
  if (!inset) return budget > 1 ? [tabs, ""] : [tabs];
  const room = cols - inset - visibleLength(tabs) - 6;
  const right = room >= 8 ? fit(meta, room) : "";
  const fill = cols - inset - visibleLength(tabs) - 1 - (right ? visibleLength(right) + 4 : 0);
  const head = `${dim("── ")}${tabs}${dim(" " + "─".repeat(Math.max(0, fill)))}${right ? dim(` ${right} ──`) : ""}`;
  return budget > 1 ? [head, ""] : [head];
}
