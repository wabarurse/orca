import { basename } from "node:path";
import { createInterface } from "node:readline";
import { cleanStorage, quietProgress, sizeOf, type CleanProgress } from "../../core/clean";
import type { Change } from "../../core/install";
import { pastel } from "../../tui/components";

export type CleanRow = { path: string; disposition: string; bytes: number };
export type ReportMode = "preview" | "confirm" | "removed";
export type CleanIO = { colour: boolean; confirm: ((table: string) => Promise<boolean>) | null; progress: CleanProgress };
type Clean = (apply: boolean, progress: CleanProgress) => Promise<Change[]>;

export function terminalProgress(stream: { isTTY: boolean; columns: number; write: (text: string) => unknown }, colour: boolean): CleanProgress {
  if (!stream.isTTY) return quietProgress;
  const paint = (code: string, text: string): string => colour && text.length > 0 ? `\x1b[${code}m${text}\x1b[0m` : text;
  let drawn = false;
  return {
    step(label, done, total) {
      const text = `${label} ${done}/${total}…`, width = 20;
      const filled = total > 0 ? Math.round(width * done / total) : 0;
      const bar = paint(pastel.cyan, "━".repeat(filled)) + paint(pastel.grey, "━".repeat(width - filled));
      const room = Math.max(0, (stream.columns > 0 ? stream.columns : 80) - 1);
      stream.write(`\r\x1b[2K${room >= text.length + width + 2 ? `  ${bar} ${paint("2", text)}` : text.slice(0, room)}`);
      drawn = true;
    },
    end() { if (drawn) stream.write("\r\x1b[2K"); drawn = false; },
  };
}

export function askYes(question: string, input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<boolean> {
  const lines = createInterface({ input, output, terminal: false });
  output.write(question);
  return new Promise(resolve => {
    let answered = false;
    lines.once("line", line => {
      answered = true;
      if (Reflect.get(input, "isTTY") !== true) output.write(`${line}\n`);
      lines.close();
      resolve(["y", "Y"].includes(line.trim()));
    });
    lines.once("close", () => { if (!answered) { output.write("\n"); resolve(false); } });
  });
}

function kind(disposition: string): string | null {
  if (/conversation "/.test(disposition)) return "deleted conversations";
  if (/worktree/.test(disposition)) return "archived worktrees";
  if (/tool output/.test(disposition)) return "old tool outputs";
  if (/bubble "|notebook page/.test(disposition)) return "bubbles and notebook pages";
  if (/scratch/.test(disposition)) return "build scratch";
  return null;
}
const kept = (disposition: string): boolean => /^(kept|partial):/.test(disposition);

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes, unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${units[unit] ?? ""}`;
}

function removable(rows: CleanRow[]): Map<string, { items: number; bytes: number }> {
  const groups = new Map<string, { items: number; bytes: number }>();
  for (const row of rows) {
    const what = kind(row.disposition);
    if (what === null || kept(row.disposition)) continue;
    const group = groups.get(what) ?? { items: 0, bytes: 0 };
    group.items++;
    group.bytes += row.bytes;
    groups.set(what, group);
  }
  return groups;
}

export function cleanReport(rows: CleanRow[], mode: ReportMode, colour: boolean): string {
  const apply = mode === "removed";
  const style = (code: string) => (text: string): string => colour ? `\x1b[${code}m${text}\x1b[0m` : text;
  const dim = style("2"), bold = style("1"), green = style(pastel.green), yellow = style(pastel.yellow);
  const pad = (text: string, width: number): string => text.padEnd(width);
  const right = (text: string, width: number): string => text.padStart(width);
  const count = (n: number): string => n.toLocaleString("en-US");
  const groups = removable(rows);
  const held = rows.filter(row => kept(row.disposition));
  const lines: string[] = [];
  if (groups.size === 0) lines.push(`${green("✓")} nothing to clean`);
  else {
    const total = [...groups.values()].reduce((sum, g) => ({ items: sum.items + g.items, bytes: sum.bytes + g.bytes }), { items: 0, bytes: 0 });
    lines.push(dim(`  ${pad(apply ? "REMOVED" : "WHAT", 30)}${right("ITEMS", 7)}${right("SIZE", 10)}`));
    for (const [what, g] of [...groups].sort((a, b) => b[1].bytes - a[1].bytes)) lines.push(`  ${pad(what, 30)}${right(count(g.items), 7)}${right(formatBytes(g.bytes), 10)}`);
    lines.push(dim(`  ${"─".repeat(47)}`));
    lines.push(`  ${bold(`${pad(apply ? "freed" : "total", 30)}${right(count(total.items), 7)}${right(formatBytes(total.bytes), 10)}`)}`);
  }
  if (held.length > 0) {
    lines.push("");
    const shown = held.slice(0, 3).map(row => `${basename(row.path)} ${dim(`(${row.disposition.replace(/^(kept|partial):\s*/, "").split(";")[0] ?? ""})`)}`);
    lines.push(`  ${yellow("kept")} ${shown.join(dim(" · "))}${held.length > 3 ? dim(` · +${held.length - 3} more`) : ""}`);
  }
  if (mode === "preview" && groups.size > 0) lines.push("", `${dim("  run ")}${bold("orca2 clean")}${dim(" to remove these")}`);
  return lines.join("\n");
}

export async function cleanCommand(apply: boolean, io: CleanIO, clean: Clean = cleanStorage): Promise<string> {
  const preview = await Promise.all((await clean(false, io.progress)).map(async row => ({ ...row, bytes: await sizeOf(row.path) })));
  if (!apply || removable(preview).size === 0) return cleanReport(preview, "preview", io.colour);
  if (io.confirm !== null && !await io.confirm(cleanReport(preview, "confirm", io.colour))) return "nothing removed";
  const sizes = new Map(preview.map(row => [row.path, row.bytes]));
  const done = (await clean(true, io.progress)).map(row => ({ ...row, bytes: sizes.get(row.path) ?? 0 }));
  return cleanReport(done, "removed", io.colour);
}

export async function runClean(args: string[], out: (text: string) => void): Promise<number> {
  if (args.length > 3 || args.some(arg => !["--preview", "--apply", "--dry-run", "--json", "--yes", "-y"].includes(arg))) { out("usage: orca2 clean [--preview] [--yes] [--json]\n"); return 2; }
  const apply = !args.includes("--preview") && !args.includes("--dry-run");
  const yes = args.includes("--yes") || args.includes("-y");
  const colour = process.env.NO_COLOR === undefined;
  const progress = terminalProgress({ isTTY: process.stderr.isTTY, columns: process.stderr.columns, write: text => process.stderr.write(text) }, process.stderr.isTTY && colour);
  if (args.includes("--json")) {
    if (apply && !yes) { out("clean --json cannot ask before removing: add --yes, or --preview to only list\n"); return 2; }
    out(`${JSON.stringify(await cleanStorage(apply, progress), null, 2)}\n`);
    return 0;
  }
  const confirm = async (table: string): Promise<boolean> => { out(`${table}\n`); return askYes("Delete these? [y/N] ", process.stdin, process.stderr); };
  out(`${await cleanCommand(apply, { colour: process.stdout.isTTY && colour, confirm: yes ? null : confirm, progress })}\n`);
  return 0;
}
