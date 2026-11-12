// The one full-screen page every list view renders through (Agents, Tasks,
// Questions, Images, Projects): a tab line, a table, a rule naming the selected
// item, its details as short sections, and a single status/input line. Pure:
// the caller owns the items, selection, scrolling and keys (work-page.ts).
import { bold, cells, dim, fit, LINK_CLOSE, linkOpen, plainText, visibleLength, wordWrap, wrap } from "./text";

export const ARCHIVED_SECTION = ":archived";
export const archiveTitle = (count: number, expanded: boolean) => `${expanded ? "▾" : "▸"} Archived (${count})`;

/** One table row. `lead` is drawn dim before the name and is not searched (tree connectors, a pin). */
export interface WorkRow { id: string; name: string; lead?: string; status?: string; color?: number; info?: string }
/** A details block: wrapped text, `key value` fields (a third element makes the value a link), or numbered options. */
export interface WorkSection {
  title: string; text?: string; fields?: [string, string, string?][];
  /** `cursor` is set while an option is being chosen; the last row is the caller's "Other…". */
  options?: { items: string[]; cursor?: number; default?: number };
}
export interface WorkPage {
  cols: number; rows: number;
  tabs: { name: string; count?: number }[]; active: number;
  items: WorkRow[]; selected: number; empty: string;
  /** The find text: its first match in each name is marked. */
  query?: string;
  sections: WorkSection[]; detailTop?: number;
  /** The last line, already composed: hints, a notice, a confirmation or an input. */
  footer: string;
}
export interface WorkPageRender {
  lines: string[];
  /** Screen row of the first table row, the first item shown and how many fit. */
  table: { y: number; top: number; rows: number };
  detail: { top: number; max: number; rows: number };
}

/** The header is a selectable row, so arrows, Enter and mouse share navigation. */
export function withArchiveSection<T extends WorkRow & { archived?: boolean }>(items: T[], expanded: boolean): (T | WorkRow & { section: true })[] {
  const archived = items.filter(item => item.archived);
  return [...items.filter(item => !item.archived), ...(archived.length ? [{ id: ARCHIVED_SECTION, name: archiveTitle(archived.length, expanded), section: true as const }, ...(expanded ? archived : [])] : [])];
}

/** The index of the next item (from `from`, stepping `dir`, wrapping) whose name contains `query`; -1 when none does. */
export function findItem(items: readonly WorkRow[], query: string, from: number, dir: 1 | -1 = 1): number {
  const q = query.toLowerCase(), n = items.length;
  if (q) for (let k = 0; k < n; k++) { const i = (((from + dir * k) % n) + n) % n; if (items[i]!.name.toLowerCase().includes(q)) return i; }
  return -1;
}

/** How many table rows a page of `rows` shows: a third of the height, at least three where they fit. */
export function tableRows(rows: number): number {
  if (rows < 9) return Math.max(0, rows - 2);
  return Math.min(Math.max(3, Math.floor(rows / 3)), rows - 6);
}

const pad = (s: string, w: number) => { const cut = fit(s, w); return cut + " ".repeat(Math.max(0, w - visibleLength(cut))); };
const paint = (code: number | undefined, s: string) => code === undefined || !s ? s : `\x1b[${code}m${s}\x1b[0m`;
const safe = (text: string, w: number) => wordWrap(plainText(text), w).flatMap(line => wrap(line, w));

/** One bottom-line input: `label` then the text around the cursor, then a dim hint when it fits. The cursor's column comes back. */
export function inputLine(label: string, text: string, cursor: number, hint: string, cols: number): { line: string; col: number } {
  const shown = text.replace(/\r\n?|\n/g, "↵"), room = Math.max(1, cols - visibleLength(label) - 1);
  const before = cells(plainText(shown.slice(0, cursor))), after = cells(plainText(shown.slice(cursor)));
  let left = "", used = 0;
  for (const c of before.reverse()) { if (used + c.width > room - 1) break; left = c.text + left; used += c.width; }
  let right = "";
  for (const c of after) { if (used + c.width > room) break; right += c.text; used += c.width; }
  const body = fit(label + bold(left + right), cols), col = Math.min(Math.max(0, cols - 1), visibleLength(label) + visibleLength(left));
  const rest = cols - visibleLength(body) - 3;
  return { line: rest >= 12 && hint ? body + "   " + dim(fit(hint, rest)) : body, col };
}

function name(item: WorkRow, selected: boolean, query: string | undefined): string {
  const text = plainText(item.name), q = query?.toLowerCase() ?? "", lower = text.toLowerCase();
  const at = q && lower.length === text.length ? lower.indexOf(q) : -1;
  const body = at < 0 ? text : `${text.slice(0, at)}\x1b[7m${text.slice(at, at + q.length)}\x1b[27m${text.slice(at + q.length)}`;
  return (item.lead ? dim(item.lead) : "") + (selected ? `\x1b[1m${body}\x1b[0m` : body);
}

/** NAME takes what STATUS and INFO leave: INFO goes first on narrow terminals, then STATUS shortens. */
function widths(cols: number, items: readonly WorkRow[]): { name: number; status: number; info: number } {
  const widest = Math.max(6, ...items.map(item => visibleLength(item.status ?? "")));
  const status = cols < 24 ? 0 : Math.min(cols < 44 ? 8 : 16, widest);
  const info = cols < 60 ? 0 : Math.floor(cols * 0.26);
  return { name: Math.max(1, cols - 2 - (status ? status + 1 : 0) - (info ? info + 1 : 0)), status, info };
}

function tabLine(page: WorkPage): string {
  const at = page.items.length ? `${page.selected + 1} of ${page.items.length}` : "";
  const tab = (t: WorkPage["tabs"][number], i: number, counts: boolean) =>
    (i === page.active ? `\x1b[1;4m${t.name}\x1b[0m` : dim(t.name)) + (counts && t.count !== undefined ? dim(` ${t.count}`) : "");
  const active = page.tabs[page.active];
  const forms = [page.tabs.map((t, i) => tab(t, i, true)).join("   "), page.tabs.map((t, i) => tab(t, i, false)).join("  "),
    active ? `${dim(`${page.active + 1}/${page.tabs.length}`)} ${tab(active, page.active, true)}` : ""];
  const line = forms.find(form => visibleLength(form) + (at ? at.length + 2 : 0) <= page.cols) ?? forms.find(form => visibleLength(form) <= page.cols) ?? fit(forms[2]!, page.cols);
  const gap = page.cols - visibleLength(line) - at.length;
  return gap >= 2 && at ? line + " ".repeat(gap) + dim(at) : line;
}

/** A section's rows at `w` columns, and the row its option cursor sits on. */
function sectionRows(section: WorkSection, w: number): { rows: string[]; cursor?: number } {
  const rows: string[] = [bold(fit(section.title, w))];
  let cursor: number | undefined;
  if (section.options) {
    const { items, default: preset } = section.options;
    items.forEach((option, k) => {
      const on = k === section.options!.cursor, body = safe(option, Math.max(1, w - 5));
      if (on) cursor = rows.length;
      body.forEach((row, n) => rows.push(fit((n ? "     " : `${on ? "› " : "  "}${dim(`${k + 1}  `)}`) + (on ? bold(row) : row)
        + (k === preset && n === body.length - 1 ? dim("   default") : ""), w)));
    });
  } else if (section.fields) {
    const key = Math.min(Math.max(1, w - 8), Math.max(0, ...section.fields.map(([k]) => visibleLength(k))) + 2);
    for (const [k, value, url] of section.fields) safe(value, Math.max(1, w - key)).forEach((row, n) =>
      rows.push(dim(pad(n ? "" : k, key)) + (url ? linkOpen(url) + row + LINK_CLOSE : row)));
    if (!section.fields.length) rows.push(dim("none"));
  } else {
    const text = (section.text ?? "").split("\n").flatMap(line => line.trim() ? safe(line, w) : []);
    rows.push(...(text.length ? text : [dim("none")]));
  }
  return { rows, cursor };
}

/** The whole page, `rows` lines of at most `cols` columns; tiny sizes drop the header, rule and details before the table. */
export function renderWorkPage(page: WorkPage): WorkPageRender {
  const cols = Math.max(1, Math.floor(page.cols)), rows = Math.max(0, Math.floor(page.rows));
  const footer = fit(page.footer, cols), size = tableRows(rows), full = rows >= 9;
  const top = Math.max(0, Math.min(page.selected - Math.floor(size / 2), page.items.length - size));
  const w = widths(cols, page.items);
  const table = page.items.slice(top, top + size).map((item, k) => {
    const selected = top + k === page.selected;
    return fit((selected ? "› " : "  ") + pad(name(item, selected, page.query), w.name)
      + (w.status ? " " + pad(paint(item.color, plainText(item.status ?? "")), w.status) : "")
      + (w.info ? " " + dim(fit(plainText(item.info ?? ""), w.info)) : ""), cols);
  });
  if (!table.length && size) table.push(fit(dim("  " + page.empty), cols));
  while (table.length < size) table.push("");
  const tabs = fit(tabLine({ ...page, cols }), cols);
  if (rows < 2) return { lines: rows ? [footer] : [], table: { y: 0, top, rows: 0 }, detail: { top: 0, max: 0, rows: 0 } };
  if (!full) return { lines: [tabs, ...table, footer], table: { y: 1, top, rows: size }, detail: { top: 0, max: 0, rows: 0 } };
  const head = fit("  " + dim(pad("NAME", w.name) + (w.status ? " " + pad("STATUS", w.status) : "") + (w.info ? " INFO" : "")), cols);
  const selected = page.items[page.selected], title = plainText(selected?.name ?? ""), spaced = rows >= 14;
  const label = fit(title, Math.max(0, cols - 8));
  const rule = label ? dim("── ") + bold(label) + " " + dim("─".repeat(Math.max(0, cols - 4 - visibleLength(label)))) : dim("─".repeat(cols));
  const indent = cols >= 24 ? "  " : "", inner = cols - indent.length;
  const detail: string[] = [];
  let cursor: number | undefined;
  for (const section of page.sections) {
    const made = sectionRows(section, inner);
    if (made.cursor !== undefined) cursor = detail.length + made.cursor;
    detail.push(...made.rows, "");
  }
  detail.pop();
  const room = rows - 5 - size - (spaced ? 1 : 0), max = Math.max(0, detail.length - room);
  let from = Math.max(0, Math.min(page.detailTop ?? 0, max));
  if (cursor !== undefined) from = Math.max(Math.min(from, cursor), Math.min(max, cursor - room + 2));
  const body = Array.from({ length: room }, (_, i) => detail[from + i] === undefined ? "" : fit(indent + detail[from + i], cols));
  return { lines: [tabs, "", head, ...table, rule, ...(spaced ? [""] : []), ...body, footer],
    table: { y: 3, top, rows: size }, detail: { top: from, max, rows: room } };
}
