// Chapter rules for the pinned header. Labels are display-only; navigation and
// storage continue to use the immutable project IDs held by App.
import type { RequestSettings } from "../../api/model";
import { bold, dim, fit, sanitize, visibleLength, type screens } from "../components";

export interface Tab { name: string; busy?: boolean }
/** One role's request settings as the header shows them: its model, its effort and whether fast mode is on. */
export interface RoleLine { role: "orchestrator" | "worker" | "reviewer"; model: string; effort: string; fast: boolean }
export interface Chapter {
  tabs: Tab[];
  active: number;
  /** The project's account (provider:profile); leads the details so narrow widths keep it. */
  account?: string;
  /** Every role, orchestrator first; one details row when they all agree, else a row each. */
  roles: RoleLine[];
  agent?: string;
  context?: string;
}

/** Each role's line: its /model override (with that model's own settings) or the project model and its settings. */
export function roleLines(model: string | undefined, settings: RequestSettings | undefined, roles: Partial<Record<RoleLine["role"], string>> | undefined, own: Partial<Record<RoleLine["role"], RequestSettings>> | undefined): RoleLine[] {
  return (["orchestrator", "worker", "reviewer"] as const).map(role => {
    const m = roles?.[role] ?? model, s = m === model ? settings : own?.[role];
    return { role, model: m ?? "loading model…", effort: s ? s.effort ?? "default" : "…", fast: !!s?.fast };
  });
}

const ROLE_LABEL: Record<RoleLine["role"], string> = { orchestrator: "orc", worker: "worker", reviewer: "reviewer" };
const settingsText = (r: RoleLine) => [r.model, r.effort, ...(r.fast ? ["fast"] : [])].join(" · ");

/** The details rows: `account · model · effort · [fast] · ctx x/y` when every role agrees, else `account · ctx x/y`
 * then `orc: …`, `worker: …`, `reviewer: …`. The agent being viewed leads the first row. */
export function detailRows(c: Chapter): string[] {
  const lead = [c.agent ? `view ${c.agent}` : "", c.account ?? ""];
  const first = c.roles[0];
  const same = !!first && c.roles.every(r => settingsText(r) === settingsText(first));
  const rows = same ? [[...lead, settingsText(first), c.context ?? ""]] : [[...lead, c.context ?? ""], ...c.roles.map(r => [`${ROLE_LABEL[r.role]}: ${settingsText(r)}`])];
  return rows.map(row => plain(row.filter(Boolean).join(" · ")));
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

/** A box open at the top edge of the terminal: the tabs, the details rows in dim (each clipped at its tail), then the
 * box's bottom line. With too few columns or rows for the box: the tabs, then as many details rows as fit. */
export function chapterRows(c: Chapter, cols: number, budget = 10): string[] {
  if (budget < 1) return [];
  cols = Math.max(1, cols);
  const details = detailRows(c);
  if (cols < 12 || budget < details.length + 2) {
    return [tabRow(c.tabs, c.active, cols), ...details.map(row => dim(fit(row, cols)))].slice(0, budget);
  }
  const inner = cols - 4;
  const side = (text: string) => `${dim("│")} ${text}${" ".repeat(Math.max(0, inner - visibleLength(text)))} ${dim("│")}`;
  return [side(tabRow(c.tabs, c.active, inner)), ...details.map(row => side(dim(fit(row, inner)))), dim("└" + "─".repeat(cols - 2) + "┘")];
}

/** The header as the screen shows it: the tabs, the account on its own row, then the details rows without it. */
export function headerView(c: Chapter, fin: screens.ScreenHeader["fin"]): screens.ScreenHeader {
  return {
    tabs: c.tabs.map((t, i) => ({ label: plain(t.name), active: i === c.active, busy: !!t.busy })),
    account: c.account ? plain(c.account) : null,
    details: detailRows({ ...c, account: undefined }),
    fin,
  };
}
