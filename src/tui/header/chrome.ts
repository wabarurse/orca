// Chapter rules for the pinned header. Labels are display-only; navigation and
// storage continue to use the immutable project IDs held by App.
import { bold, dim, fit, sanitize, visibleLength, wrap } from "../components";
import { finRows } from "./whale";

export interface Tab { name: string; busy?: boolean }
export interface Chapter {
  tabs: Tab[];
  active: number;
  /** The project's account (provider:profile); leads the model field so narrow widths keep it. */
  account?: string;
  model: string;
  directory: string;
  remote: string;
  agent?: string;
  context?: string;
  fin?: { time: number; active: boolean };
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

/** Keep project identity and metadata before making room for the fin. */
export function chapterRows(c: Chapter, cols: number, budget = 10): string[] {
  if (budget < 1) return [];
  cols = Math.max(1, cols);
  const inset = cols >= 12 ? 4 : 0;
  const tabs = tabRow(c.tabs, c.active, cols - inset);
  const head = inset ? `${dim("── ")}${tabs}${dim(" " + "─".repeat(Math.max(0, cols - 4 - visibleLength(tabs))))}` : tabs;
  if (budget === 1) return [head];
  const metadata = details(chapterFields(c, cols), cols, budget - 2);
  if (c.fin) {
    const { time, active } = c.fin;
    const artCols = Math.min(32, cols - 35);
    const detailCols = cols - artCols - 3;
    if (artCols >= 24) {
      const fields = chapterFields(c, detailCols);
      const art = finRows(artCols, budget - 2, time, active);
      if (art.length && fields.length <= budget - 2) {
        const info = details(fields, detailCols, budget - 2);
        const rows = Array.from({ length: Math.max(art.length, info.length) }, (_, i) => {
          const label = info[i] ?? "";
          return label + " ".repeat(detailCols - visibleLength(label) + 3) + (art[i] ?? "");
        });
        return [head, ...rows, dim("─".repeat(cols))];
      }
    }
  }
  return [head, ...metadata, dim("─".repeat(cols))];
}

function chapterFields(c: Chapter, cols: number): string[] {
  const telemetry = [c.context].filter(Boolean).join(" · ");
  // One field: the account, then the model (each role's), then effort/fast; a narrow width wraps it once when a row is spare,
  // else clips its tail, so the account and the orchestrator's model survive before workers/reviewers and the settings.
  const model = `${c.account ? `account ${c.account} · ` : ""}model ${c.model}`;
  // Narrow telemetry stacks without sacrificing the selected model to telemetry.
  // Agent identity precedes paths in constrained views.
  return telemetry && visibleLength(plain(telemetry)) > cols
    ? [c.context, model, ...(c.agent ? [`view ${c.agent}`] : []), c.directory, c.remote].filter((f): f is string => !!f)
    : [...(telemetry ? [telemetry] : []), model, ...(c.agent ? [`view ${c.agent}`] : []), c.directory, c.remote];
}
