import { lstatSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { conversationIds, paths } from "../../config";
import { pruneBuildScratch } from "../../core/install";
import { cleanup, ownership } from "../../core/tmux";
const { retire } = ownership;
import { stopDaemon } from "../../core/agent-loop/orc";
import { listVerifications, pruneSettledProcesses } from "../../core/data/processes";
import { directories, displayName, workspaces } from "../../core/data/projects";
import { ARCHIVE_DAYS, listBubbles, orphanBubbles, purgeNotebook, removeBubble } from "../../core/data/bubbles";
import { pruneProjectOutputs } from "../../core/tools/bash";
import { pastel } from "../../tui/components";

/** The caller selects preview or deletion explicitly; only owned disposable resources qualify. */
/** Removing an archived conversation for good: whatever still runs under it is stopped first (so a leftover command
 * or PR watch never keeps it), then the ownership cascade removes it, saving its worktrees' local changes to branches. */
async function purgeArchived(project: string): Promise<{ saved: string[] }> {
  const stopped = await retire.stopTree(project, { stop: stopDaemon });
  if (stopped.problems.length) throw new Error(stopped.problems.join("; "));
  return ownership.deleteProject(project, { stop: stopDaemon });
}
export async function cleanStorage(apply: boolean, purge: (project: string) => Promise<{ saved: string[] }> = purgeArchived) {
  const changes: { path: string; disposition: string }[] = [];
  // A conversation the user deleted was only archived (core/tmux/retire.ts): this is where it is removed for good.
  // The purge is the ownership cascade, with its refusals: a worktree holding uncommitted files keeps the conversation.
  for (const project of conversationIds(paths.root)) {
    const archive = directories.projectArchive(project);
    if (!archive) continue;
    const name = await displayName(project).catch(() => project);
    try {
      const saved = apply ? (await purge(project)).saved : [];
      changes.push({ path: paths.project(project), disposition: `${apply ? "removed" : "would remove"}: conversation "${name}" deleted ${archive.at.slice(0, 10)}${saved.length ? `; local changes saved to ${saved.join(", ")}` : ""}` });
    } catch (error) { changes.push({ path: paths.project(project), disposition: `kept: conversation "${name}" could not be removed (${error instanceof Error ? error.message : error})` }); }
  }
  const current = conversationIds(paths.root);
  const projects = new Set([...current, ...workspaces.list().filter(w => !w.cleanedAt).map(w => w.members[0]!.project)]);
  for (const project of projects) {
    try {
      if (current.includes(project)) for (const v of await listVerifications(project)) changes.push({ path: v.id, disposition: `verification ${v.state}` });
      // One preview overlay for both: the outputs discovery would register count as registered here too.
      const inspect = async () => {
        changes.push(...await cleanup.cleanManagedWorkspaces(project, apply));
        if (current.includes(project)) changes.push(...await pruneProjectOutputs(project, apply));
      };
      await (apply ? inspect() : workspaces.preview(inspect));
      if (current.includes(project)) changes.push(...await pruneSettledProcesses(project, apply));
    } catch (error) { changes.push({ path: project, disposition: `kept: inspection failed (${error})` }); }
  }
  // Bubbles: notebook pages archived longer than the retention go, and so does a bubble no conversation is attached to.
  try {
    const orphans = await orphanBubbles();
    for (const bubble of orphans) {
      if (apply) await removeBubble(bubble.id);
      changes.push({ path: join(paths.bubbles, bubble.id), disposition: `${apply ? "removed" : "would remove"}: bubble "${bubble.name}" has no conversation` });
    }
    for (const bubble of (await listBubbles()).filter(b => !orphans.some(o => o.id === b.id))) {
      for (const page of await purgeNotebook(bubble.id, Date.now(), ARCHIVE_DAYS, apply)) {
        changes.push({ path: join(paths.bubbles, bubble.id, "notebook", page.id), disposition: `${apply ? "removed" : "would remove"}: notebook page "${page.title}" archived over ${ARCHIVE_DAYS} days ago` });
      }
    }
  } catch (error) { changes.push({ path: paths.bubbles, disposition: `kept: inspection failed (${error})` }); }
  changes.push(...await pruneBuildScratch(join(paths.runtime, "app"), apply));
  return changes;
}

/** One clean result: what it is, what happened to it, and its size on disk (measured before anything was removed). */
export interface CleanRow { path: string; disposition: string; bytes: number }
/** What cleanStorage and the stores it calls report; some know their size already. */
type Found = { path: string; disposition: string; bytes?: number };

/** What a row is, for the table; null for rows that are only reported (a verification's state). */
function kind(disposition: string): string | null {
  if (/conversation "/.test(disposition)) return "deleted conversations";
  if (/worktree|workspace|archived session|build files/.test(disposition)) return "archived worktrees";
  if (/tool output/.test(disposition)) return "old tool outputs";
  if (/process output/.test(disposition)) return "finished process output";
  if (/bubble "|notebook page/.test(disposition)) return "bubbles and notebook pages";
  if (/scratch|build cache/.test(disposition)) return "build scratch";
  return null;
}
const kept = (disposition: string) => /^(kept|partial):/.test(disposition);

/** The size on disk of a file or folder, symlinks not followed; 0 when it is gone. */
export function sizeOf(path: string): number {
  let stat;
  try { stat = lstatSync(path); } catch { return 0; }
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  try { for (const entry of readdirSync(path)) total += sizeOf(join(path, entry)); } catch { /* unreadable: counted as far as read */ }
  return total;
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes, unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${units[unit]}`;
}

/** C1/C2: a WHAT · ITEMS · SIZE table with a total, then what was kept and why, then the saved branches or the next step. */
export function cleanReport(rows: CleanRow[], apply: boolean, colour: boolean): string {
  const style = (code: string) => (text: string) => colour ? `\x1b[${code}m${text}\x1b[0m` : text;
  const dim = style("2"), bold = style("1"), green = style(pastel.green), yellow = style(pastel.yellow);
  const pad = (text: string, width: number) => text.length >= width ? text : text + " ".repeat(width - text.length);
  const right = (text: string, width: number) => text.length >= width ? text : " ".repeat(width - text.length) + text;
  const count = (n: number) => n.toLocaleString("en-US");
  const groups = new Map<string, { items: number; bytes: number }>();
  for (const row of rows) {
    const what = kind(row.disposition);
    if (!what || kept(row.disposition)) continue;
    const group = groups.get(what) ?? { items: 0, bytes: 0 };
    group.items++; group.bytes += row.bytes;
    groups.set(what, group);
  }
  const held = rows.filter(row => kept(row.disposition));
  const saved = rows.flatMap(row => /local changes saved to (.+)$/.exec(row.disposition)?.[1]?.split(", ") ?? []);
  const lines: string[] = [];
  if (!groups.size) lines.push(`${green("✓")} nothing to clean`);
  else {
    const total = [...groups.values()].reduce((sum, g) => ({ items: sum.items + g.items, bytes: sum.bytes + g.bytes }), { items: 0, bytes: 0 });
    lines.push(dim(`  ${pad(apply ? "REMOVED" : "WHAT", 30)}${right("ITEMS", 7)}${right("SIZE", 10)}`));
    for (const [what, g] of [...groups].sort((a, b) => b[1].bytes - a[1].bytes)) lines.push(`  ${pad(what, 30)}${right(count(g.items), 7)}${right(formatBytes(g.bytes), 10)}`);
    lines.push(dim(`  ${"─".repeat(47)}`));
    lines.push("  " + bold(`${pad(apply ? "freed" : "total", 30)}${right(count(total.items), 7)}${right(formatBytes(total.bytes), 10)}`));
  }
  if (held.length) {
    lines.push("");
    const shown = held.slice(0, 3).map(row => `${basename(row.path)} ${dim(`(${row.disposition.replace(/^(kept|partial):\s*/, "").split(";")[0]})`)}`);
    lines.push(`  ${yellow("kept")} ${shown.join(dim(" · "))}${held.length > 3 ? dim(` · +${held.length - 3} more`) : ""}`);
  }
  for (const branch of saved) lines.push(`${green("✓")} saved local changes to ${branch}`);
  if (!apply && groups.size) lines.push("", dim("  run ") + bold("orca clean") + dim(" to remove these"));
  return lines.join("\n");
}

/** `orca clean [--preview]`: sizes come from a preview taken before anything is removed. */
export async function cleanCommand(apply: boolean, colour: boolean, clean: (apply: boolean) => Promise<Found[]> = cleanStorage): Promise<string> {
  const preview = (await clean(false)).map(row => ({ ...row, bytes: row.bytes ?? sizeOf(row.path) }));
  if (!apply) return cleanReport(preview, false, colour);
  const sizes = new Map(preview.map(row => [row.path, row.bytes]));
  const done = (await clean(true)).map(row => ({ ...row, bytes: row.bytes ?? sizes.get(row.path) ?? 0 }));
  return cleanReport(done, true, colour);
}
