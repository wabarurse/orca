import { constants } from "node:fs";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fail, ok, paths, type Result } from "../../config";
import { listConversations, saveConversation, type Conversation } from "../conversations";
import { withStorageLock } from "../lock";
import { daemonPid } from "../daemon/channel";
import { listRuns, live } from "../runner/runs";
import { BEHAVIOR, behavior, replaceBehavior, type BehaviorLine } from "./behavior";
import { ensureDataDirs } from "./data";
import { LIMITS, memoryNodes, replaceNodes, type Entry, type MemoryNode } from "./nodes";
import { copyPages, pageIndex } from "./notebook";
import { listBubbles, readBubble, removeBubble, renameBubble, setBubblePlugin, type Bubble } from "./store";

export type MergeOptions = { dryRun: boolean; force: boolean; now: string };
export type MergePlan = {
  from: Bubble; into: Bubble; backupName: string;
  nodes: { added: string[]; merged: { id: string; entries: number }[]; overfull: { id: string; current: number }[] };
  pages: { added: string[]; renamed: { from: string; to: string }[] };
  behavior: { added: string[]; duplicates: string[]; rekeyed: { from: string; to: string }[]; dropped: string[] };
  conversations: string[];
  plugins: { on: string[]; off: string[]; conflicts: string[] };
  data: { copied: string[]; clashes: string[] };
  busy: string[];
};
type Staged = { plan: MergePlan; nodes: MemoryNode[]; renames: Map<string, string>; lines: BehaviorLine[]; moving: Conversation[] };
type Busy = { conversation: string; what: string };

export const UNDETECTED = "an open TUI with no running orchestrator or agent is not detected; close orca2 on both bubbles' chats before merging";

export async function findBubble(which: string): Promise<Result<Bubble>> {
  const matches = (await listBubbles()).filter(b => b.id === which || b.name === which);
  const found = matches[0];
  if (matches.length > 1) return fail(`${matches.length} bubbles are named ${which}; use its id (orca2 bubbles)`);
  return found === undefined ? fail(`no bubble ${which}`) : ok(found);
}

function rewrite(text: string, renames: ReadonlyMap<string, string>): string {
  return renames.size === 0 ? text : text.replace(/\bpage-[a-f0-9]{8}\b/g, id => renames.get(id) ?? id);
}

function rewriteNode(node: MemoryNode, renames: ReadonlyMap<string, string>): MemoryNode {
  return { ...node, title: rewrite(node.title, renames), summary: rewrite(node.summary, renames),
    entries: node.entries.map(e => ({ ...e, text: rewrite(e.text, renames), sources: e.sources.map(s => rewrite(s, renames)) })) };
}

const entryKey = (e: Entry): string => JSON.stringify([e.text, e.at, e.author, e.sources]);

export function unionEntries(into: readonly Entry[], from: readonly Entry[]): { entries: Entry[]; added: number; retired: number } {
  const seen = new Map<string, Entry>();
  let added = 0, retired = 0;
  for (const entry of into) seen.set(entryKey(entry), { ...entry });
  for (const entry of from) {
    const known = seen.get(entryKey(entry));
    if (known === undefined) { seen.set(entryKey(entry), { ...entry }); added++; }
    else if (known.retired === null && entry.retired !== null) { known.retired = entry.retired; retired++; }
  }
  const entries = [...seen.values()].map((entry, n) => ({ entry, n })).sort((a, b) => { const byDate = a.entry.at.localeCompare(b.entry.at); return byDate !== 0 ? byDate : a.n - b.n; }).map(row => row.entry);
  return { entries, added, retired };
}

export function mergeNode(into: MemoryNode, from: MemoryNode, now: string): { node: MemoryNode; added: number } {
  const { entries, added, retired } = unionEntries(into.entries, from.entries);
  const keywords = [...new Set([...into.keywords, ...from.keywords])].slice(0, LIMITS.keywords);
  const title = into.title !== "" ? into.title : from.title, summary = into.summary !== "" ? into.summary : from.summary;
  const changed = added > 0 || retired > 0 || title !== into.title || summary !== into.summary || keywords.length !== into.keywords.length;
  if (!changed) return { node: into, added: 0 };
  return { node: { ...into, title, summary, keywords, entries, updated: now, revision: into.revision + 1 }, added };
}

export const normalizeBehavior = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase().replace(/[.!;]+$/, "");

export function unionBehavior(into: readonly BehaviorLine[], from: readonly BehaviorLine[]): { lines: BehaviorLine[]; added: string[]; duplicates: string[]; rekeyed: { from: string; to: string }[] } {
  const texts = new Set(into.map(row => normalizeBehavior(row.text))), keys = new Set(into.map(row => row.key));
  const lines = [...into], added: string[] = [], duplicates: string[] = [], rekeyed: { from: string; to: string }[] = [];
  for (const row of from) {
    const norm = normalizeBehavior(row.text);
    if (texts.has(norm)) { duplicates.push(row.key); continue; }
    texts.add(norm);
    let key = row.key;
    for (let n = 2; keys.has(key); n++) key = `${row.key}-${n}`;
    if (key !== row.key) rekeyed.push({ from: row.key, to: key });
    keys.add(key);
    lines.push({ ...row, key });
    added.push(key);
  }
  return { lines, added, duplicates, rekeyed };
}

export function unionPlugins(into: Bubble["plugins"], from: Bubble["plugins"]): { on: string[]; off: string[]; conflicts: string[] } {
  const decided = new Set([...into.on, ...into.off]);
  const conflicts = [...from.on.filter(n => into.off.includes(n)), ...from.off.filter(n => into.on.includes(n))];
  return { on: from.on.filter(n => !decided.has(n)), off: from.off.filter(n => !decided.has(n) && !from.on.includes(n)), conflicts };
}

async function files(dir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) out.push(...await files(join(dir, entry.name), `${prefix}${entry.name}/`));
    else if (entry.isFile()) out.push(`${prefix}${entry.name}`);
  }
  return out;
}

export async function busyChats(bubbles: readonly string[]): Promise<Busy[]> {
  const chats = (await listConversations()).filter(c => c.bubble !== null && bubbles.includes(c.bubble));
  const busy: Busy[] = [];
  for (const chat of chats) {
    const pid = await daemonPid(chat.id);
    if (pid !== null) busy.push({ conversation: chat.id, what: `orchestrator (pid ${pid})` });
    for (const run of await listRuns(chat.id)) if (live(run) && run.agent !== "orchestrator") busy.push({ conversation: chat.id, what: `agent ${run.agent}` });
  }
  return busy;
}

function freshPageId(taken: Set<string>): string {
  for (;;) {
    const id = `page-${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
    if (!taken.has(id)) { taken.add(id); return id; }
  }
}

async function stage(from: Bubble, into: Bubble, options: MergeOptions, busy: readonly Busy[]): Promise<Result<Staged>> {
  const fromPages = await pageIndex(from.id), intoPages = await pageIndex(into.id);
  if (!fromPages.ok) return fromPages;
  if (!intoPages.ok) return intoPages;
  const taken = new Set([...fromPages.data, ...intoPages.data].map(p => p.id)), intoIds = new Set(intoPages.data.map(p => p.id));
  const renames = new Map<string, string>();
  for (const page of fromPages.data) if (intoIds.has(page.id)) renames.set(page.id, freshPageId(taken));

  const intoNodes = new Map((await memoryNodes(into.id)).map(n => [n.id, n]));
  const nodes: MemoryNode[] = [], added: string[] = [], merged: { id: string; entries: number }[] = [];
  for (const raw of await memoryNodes(from.id)) {
    const incoming = rewriteNode(raw, renames), existing = intoNodes.get(incoming.id);
    if (existing === undefined) { nodes.push(incoming); added.push(incoming.id); continue; }
    const result = mergeNode(existing, incoming, options.now);
    if (result.node !== existing) { nodes.push(result.node); merged.push({ id: incoming.id, entries: result.added }); }
  }
  const overfull = nodes.flatMap(n => { const current = n.entries.filter(e => e.retired === null).length; return current > LIMITS.active ? [{ id: n.id, current }] : []; });

  const fromLines = (await behavior({ kind: "bubble", bubble: from.id })).map(row => ({ ...row, text: rewrite(row.text, renames), source: rewrite(row.source, renames) }));
  const intoLines = await behavior({ kind: "bubble", bubble: into.id });
  const union = unionBehavior(intoLines, fromLines);
  let lines = union.lines, dropped: string[] = [];
  if (lines.length > BEHAVIOR.lines) {
    if (!options.force) {
      const over = lines.length - BEHAVIOR.lines, list = lines.map(row => `  ${intoLines.some(l => l.key === row.key) ? into.name : from.name}: ${row.key} — ${row.text}`);
      return fail(`the merged behavior would hold ${lines.length} lines (limit ${BEHAVIOR.lines}). Nothing was written. Remove ${over} of these lines from either bubble first, or pass --force to keep ${into.name}'s lines first and drop the rest of ${from.name}'s:\n${list.join("\n")}`);
    }
    dropped = lines.slice(BEHAVIOR.lines).map(row => row.key);
    lines = lines.slice(0, BEHAVIOR.lines);
  }

  const moving = (await listConversations()).filter(c => c.bubble === from.id);
  const plugins = unionPlugins(into.plugins, from.plugins);
  const intoData = new Set(await files(paths.bubbleData(into.id))), fromData = await files(paths.bubbleData(from.id));
  const backupName = `${from.name} (merged into ${into.name})`;
  const plan: MergePlan = {
    from, into, backupName,
    nodes: { added, merged, overfull },
    pages: { added: fromPages.data.map(p => renames.get(p.id) ?? p.id), renamed: [...renames].map(([a, b]) => ({ from: a, to: b })) },
    behavior: { added: union.added.filter(key => !dropped.includes(key)), duplicates: union.duplicates, rekeyed: union.rekeyed, dropped },
    conversations: moving.map(c => c.id),
    plugins,
    data: { copied: fromData.filter(f => !intoData.has(f)), clashes: fromData.filter(f => intoData.has(f)) },
    busy: busy.map(b => `${b.conversation}: ${b.what}`),
  };
  return ok({ plan, nodes, renames, lines, moving });
}

async function apply(staged: Staged): Promise<Result<null>> {
  const { plan, nodes, renames, lines, moving } = staged, from = plan.from.id, into = plan.into.id;
  const pages = await copyPages(from, into, renames);
  if (!pages.ok) return pages;
  const written = await replaceNodes(into, nodes);
  if (!written.ok) return written;
  if (plan.behavior.added.length > 0) {
    const saved = await replaceBehavior({ kind: "bubble", bubble: into }, lines);
    if (!saved.ok) return saved;
  }
  if (plan.plugins.on.length > 0) { const on = await setBubblePlugin(into, plan.plugins.on, "on"); if (!on.ok) return on; }
  if (plan.plugins.off.length > 0) { const off = await setBubblePlugin(into, plan.plugins.off, "off"); if (!off.ok) return off; }
  for (const file of plan.data.copied) {
    const target = join(paths.bubbleData(into), file);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(join(paths.bubbleData(from), file), target, constants.COPYFILE_EXCL);
  }
  for (const chat of moving) {
    await saveConversation({ ...chat, bubble: into, noBubble: false });
    const linked = await ensureDataDirs(chat.id);
    if (!linked.ok) return linked;
  }
  const renamed = await renameBubble(from, plan.backupName);
  return renamed.ok ? ok(null) : renamed;
}

export async function mergeBubbles(fromName: string, intoName: string, options: MergeOptions): Promise<Result<MergePlan>> {
  const from = await findBubble(fromName), into = await findBubble(intoName);
  if (!from.ok) return from;
  if (!into.ok) return into;
  if (from.data.id === into.data.id) return fail("a bubble cannot be merged into itself");
  return withStorageLock(join(paths.runtime, "bubble-merge-lock"), async (): Promise<Result<MergePlan>> => {
    const busy = await busyChats([from.data.id, into.data.id]);
    if (busy.length > 0 && !options.dryRun) return fail(`a bubble is in use; stop these first (orca2 daemon stop --conversation id):\n${busy.map(b => `  ${b.conversation}: ${b.what}`).join("\n")}`);
    const fresh = [await readBubble(from.data.id), await readBubble(into.data.id)];
    const [f, i] = fresh;
    if (f === null || f === undefined || i === null || i === undefined) return fail("a bubble disappeared while merging");
    const staged = await stage(f, i, options, busy);
    if (!staged.ok) return staged;
    if (options.dryRun) return ok(staged.data.plan);
    const applied = await apply(staged.data);
    return applied.ok ? ok(staged.data.plan) : fail(`${applied.error} (the merge stopped part way; ${f.name} is still on disk)`);
  });
}

export function renderMerge(plan: MergePlan, dryRun: boolean): string {
  const list = (items: readonly string[]): string => items.length === 0 ? "none" : items.join(", ");
  const { from, into } = plan;
  const rows = [
    `${dryRun ? "Would merge" : "Merged"} ${from.name} (${from.id}) into ${into.name} (${into.id})`,
    `memory: ${plan.nodes.added.length} new nodes (${list(plan.nodes.added)}); ${plan.nodes.merged.length} same-id nodes merged (${list(plan.nodes.merged.map(m => `${m.id} +${m.entries}`))})`,
    ...plan.nodes.overfull.map(n => `  warning: ${n.id} holds ${n.current} current entries (limit ${LIMITS.active}); retire some before adding more`),
    `notebook: ${plan.pages.added.length} pages (${list(plan.pages.added)}); ${plan.pages.renamed.length} id clashes renamed (${list(plan.pages.renamed.map(r => `${r.from} → ${r.to}`))}), references in merged memory rewritten`,
    `behavior: ${plan.behavior.added.length} lines added (${list(plan.behavior.added)}); ${plan.behavior.duplicates.length} duplicates skipped (${list(plan.behavior.duplicates)})`,
    ...(plan.behavior.rekeyed.length > 0 ? [`  renamed keys: ${list(plan.behavior.rekeyed.map(r => `${r.from} → ${r.to}`))}`] : []),
    ...(plan.behavior.dropped.length > 0 ? [`  dropped by --force (over ${BEHAVIOR.lines} lines): ${list(plan.behavior.dropped)}`] : []),
    `chats re-pointed: ${list(plan.conversations)}`,
    `plugins: on ${list(plan.plugins.on)}; off ${list(plan.plugins.off)}; conflicts kept as in ${into.name}: ${list(plan.plugins.conflicts)}`,
    `plugin data: ${plan.data.copied.length} files copied (${list(plan.data.copied)}); ${plan.data.clashes.length} clashes skipped (${list(plan.data.clashes)})`,
    dryRun ? `${from.name} would be kept as "${plan.backupName}", with no chats` : `${from.name} is kept as "${plan.backupName}", with no chats; remove it with: orca2 bubble remove ${from.id}`,
    ...(plan.busy.length > 0 ? [`in use (a real merge refuses until these stop): ${list(plan.busy)}`] : []),
    `note: ${UNDETECTED}`,
  ];
  return `${rows.join("\n")}\n`;
}

export async function removeUnusedBubble(which: string): Promise<Result<Bubble>> {
  const found = await findBubble(which);
  if (!found.ok) return found;
  const chats = (await listConversations()).filter(c => c.bubble === found.data.id);
  if (chats.length > 0) return fail(`${found.data.name} still has chats: ${chats.map(c => c.id).join(", ")}; merge it or move them first`);
  await removeBubble(found.data.id);
  return ok(found.data);
}
