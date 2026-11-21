import type { Row, Section, Tone } from "../core/plugins/types";
import { bold, dim, fit, pastel, sanitize, visibleLength } from "./components";

export type WorkTab = { id: string; title: string; count: number | null };
export type WorkView = { tabs: WorkTab[]; active: number; rows: Row[]; index: number; details: Section[]; detailTop: number; status: string; error: string | null };

const tone = (t: Tone, s: string): string => t === "good" ? `\x1b[${pastel.green}m${s}\x1b[0m` : t === "warn" ? `\x1b[${pastel.yellow}m${s}\x1b[0m`
  : t === "bad" ? `\x1b[${pastel.red}m${s}\x1b[0m` : t === "dim" ? dim(s) : s;

export function renderWork(view: WorkView, cols: number, rows: number): string[] {
  const tabLine = view.tabs.map((tab, i) => {
    const label = `${tab.title}${tab.count === null ? "" : ` ${tab.count}`}`;
    return i === view.active ? bold(`[${label}]`) : dim(label);
  }).join("   ");
  const position = view.rows.length > 0 ? `${view.index + 1} of ${view.rows.length}` : "";
  const head = fit(`${tabLine}${" ".repeat(Math.max(1, cols - visibleLength(tabLine) - position.length))}${dim(position)}`, cols);
  const nameW = Math.max(10, Math.floor(cols * 0.45)), statusW = cols >= 60 ? 14 : 8;
  const infoW = Math.max(0, cols - nameW - statusW - 4);
  const line = (name: string, status: string, info: string): string => `${fit(name, nameW).padEnd(nameW)}  ${fit(status, statusW).padEnd(statusW)}  ${fit(info, infoW)}`;
  const tableRows = Math.max(3, Math.floor(rows / 3));
  const start = Math.max(0, Math.min(view.index - tableRows + 1, view.rows.length - tableRows));
  const table = view.error !== null ? [tone("bad", fit(view.error, cols))] : view.rows.length === 0 ? [dim("nothing here")]
    : view.rows.slice(start, start + tableRows).map((row, i) => {
      const selected = start + i === view.index;
      const text = line(sanitize(row.name), sanitize(row.status), sanitize(row.info));
      return `${selected ? bold("› ") : "  "}${tone(row.tone, selected ? bold(text) : text)}`;
    });
  const selected = view.rows[view.index];
  const rule = dim(fit(`── ${selected === undefined ? "" : sanitize(selected.name)} ${"─".repeat(cols)}`, cols));
  const detailLines = view.details.flatMap(section => [bold(sanitize(section.title)), ...section.lines.map(l => `  ${sanitize(l)}`), ""]);
  const fixed = [head, "", dim(line("NAME", "STATUS", "INFO")), ...table, rule];
  const room = Math.max(0, rows - fixed.length - 1);
  const details = detailLines.slice(view.detailTop, view.detailTop + room).map(l => fit(l, cols));
  const filler = Array.from({ length: Math.max(0, room - details.length) }, () => "");
  return [...fixed, ...details, ...filler, fit(view.status, cols)].slice(0, rows);
}
