// Bubble memory: a tree of small markdown nodes (`memory/<branch>/<slug>.md`). A node has a one-line summary that
// states the fact (it sits in every member's context) and dated entries that carry the detail (read on demand).
// Adding an entry only needs the lock; changing a summary or retiring an entry also needs the revision the writer
// read, so two orchestrators cannot silently overwrite each other. A replaced fact is retired, never deleted.
import { mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withStorageLock } from "../storage-lock";
import { bubbleDir, writeFileAtomic } from "./store";

/** `retired` is when the entry stopped being true (a later entry replaced it), else null. */
export interface Entry { text: string; at: string; author: string; sources: string[]; retired: string | null }
export interface MemoryNode { id: string; title: string; summary: string; keywords: string[]; updated: string; revision: number; entries: Entry[] }
/** `revision` is required to change an existing node's title, summary or keywords, or to retire entries. */
export interface NodeWrite {
  node: string; title: string | null; summary: string | null; keywords: string[] | null;
  add: { text: string; sources: string[] }[]; retire: number[]; revision: number | null;
}

/** The fixed top level: it tells every writer where a fact belongs, so two orchestrators file it in one place. */
export const BRANCHES: Record<string, string> = {
  goals: "what the product or project is for and what the user wants achieved",
  decisions: "what the user decided, required, permitted or forbade about the product and the code",
  "how-it-works": "how the system behaves: stages, data flow, rules, names of flags, functions and files",
  "expected-behavior": "what should happen in a given case, with examples and what actually happened",
  "tried-and-rejected": "approaches tried and dropped, with the reason and any measured numbers",
  "open-questions": "what is still undecided, disputed or unverified, and who must decide",
  "work-log": "pull requests and tickets: what each does, its base, its state, anything unusual",
};
export const OVERVIEW = "overview";
export const LIMITS = { title: 80, summary: 200, entry: 700, keywords: 12, keyword: 40, sources: 8, source: 200, active: 40 } as const;
const SLUG = "[a-z0-9][a-z0-9-]{0,60}";
const NODE_ID = new RegExp(`^(?:${OVERVIEW}|(?:${Object.keys(BRANCHES).join("|")})(?:/${SLUG}){1,3})$`);

export function assertNodeId(id: string): void {
  if (!NODE_ID.test(id)) throw new Error(`invalid memory node id ${JSON.stringify(id)}: use "${OVERVIEW}" or <branch>/<slug> with a branch of ${Object.keys(BRANCHES).join(", ")}`);
}
const memoryDir = (bubble: string) => join(bubbleDir(bubble), "memory");
const nodeFile = (bubble: string, id: string) => join(memoryDir(bubble), `${id}.md`);
const versionFile = (bubble: string) => join(memoryDir(bubble), ".version");
const line = (text: string) => text.replace(/\s+/g, " ").replaceAll("<!--", "").replaceAll("-->", "").trim();

export function serializeNode(node: MemoryNode): string {
  const head = ["---", `id: ${node.id}`, `title: ${node.title}`, `summary: ${node.summary}`, `keywords: ${node.keywords.join(", ")}`,
    `updated: ${node.updated}`, `revision: ${node.revision}`, "---"];
  const entry = (e: Entry, n: number) => `- ${e.text} <!-- ${JSON.stringify({ n, at: e.at, author: e.author, sources: e.sources, retired: e.retired })} -->`;
  const active = node.entries.map((e, n) => e.retired ? "" : entry(e, n)).filter(Boolean);
  const retired = node.entries.map((e, n) => e.retired ? entry(e, n) : "").filter(Boolean);
  return [...head, "## Current", ...active, ...(retired.length ? ["## Retired (replaced by a later entry; kept as history)", ...retired] : []), ""].join("\n");
}
/** Null for a file that is not a node (hand-edited beyond recognition): readers skip it, nothing rewrites it. */
export function parseNode(text: string): MemoryNode | null {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!match) return null;
  const head = new Map(match[1]!.split("\n").map(row => { const at = row.indexOf(":"); return [row.slice(0, at).trim(), row.slice(at + 1).trim()] as const; }));
  const id = head.get("id") ?? "", revision = Number(head.get("revision"));
  if (!NODE_ID.test(id) || !Number.isSafeInteger(revision)) return null;
  const rows: { n: number; entry: Entry }[] = [];
  for (const row of match[2]!.split("\n")) {
    const found = /^- (.*) <!-- (\{.*\}) -->$/.exec(row);
    if (!found) continue;
    try {
      const meta = JSON.parse(found[2]!) as { n: number; at: string; author: string; sources: string[]; retired: string | null };
      rows.push({ n: meta.n, entry: { text: found[1]!, at: String(meta.at), author: String(meta.author), sources: (meta.sources ?? []).map(String), retired: meta.retired ?? null } });
    } catch { /* a hand-broken line is skipped */ }
  }
  return { id, title: head.get("title") ?? "", summary: head.get("summary") ?? "", keywords: (head.get("keywords") ?? "").split(",").map(k => k.trim()).filter(Boolean),
    updated: head.get("updated") ?? "", revision, entries: rows.sort((a, b) => a.n - b.n).map(r => r.entry) };
}

const loaded = new Map<string, { version: string; nodes: MemoryNode[] }>();
async function version(bubble: string): Promise<string> {
  const file = Bun.file(versionFile(bubble));
  return await file.exists() ? await file.text() : "";
}
async function walk(dir: string, prefix = ""): Promise<string[]> {
  const names = await readdir(dir, { withFileTypes: true }).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; });
  const out: string[] = [];
  for (const entry of names.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) out.push(...await walk(join(dir, entry.name), `${prefix}${entry.name}/`));
    else if (entry.name.endsWith(".md")) out.push(`${prefix}${entry.name}`);
  }
  return out;
}
/** Every node of the bubble, by id. Cached per process until any member writes (the version file changes). */
export async function memoryNodes(bubble: string): Promise<MemoryNode[]> {
  const current = await version(bubble), cached = loaded.get(bubble);
  if (cached && cached.version === current) return cached.nodes;
  const files = await walk(memoryDir(bubble));
  const nodes = (await Promise.all(files.map(async file => parseNode(await Bun.file(join(memoryDir(bubble), file)).text())))).filter((n): n is MemoryNode => n !== null);
  nodes.sort((a, b) => a.id.localeCompare(b.id));
  loaded.set(bubble, { version: current, nodes });
  return nodes;
}
export async function readNode(bubble: string, id: string): Promise<MemoryNode | null> {
  assertNodeId(id);
  return (await memoryNodes(bubble)).find(node => node.id === id) ?? null;
}

function checked(write: NodeWrite): void {
  assertNodeId(write.node);
  if (write.title !== null && (!line(write.title) || line(write.title).length > LIMITS.title)) throw new Error(`title must be 1-${LIMITS.title} characters`);
  if (write.summary !== null && (!line(write.summary) || line(write.summary).length > LIMITS.summary)) throw new Error(`summary must be 1-${LIMITS.summary} characters: one line that states the fact itself`);
  if (write.keywords !== null && (write.keywords.length > LIMITS.keywords || write.keywords.some(k => !line(k) || line(k).length > LIMITS.keyword))) throw new Error(`at most ${LIMITS.keywords} keywords of up to ${LIMITS.keyword} characters`);
  for (const entry of write.add) {
    if (!line(entry.text) || line(entry.text).length > LIMITS.entry) throw new Error(`an entry must be 1-${LIMITS.entry} characters; split a longer one`);
    if (entry.sources.length > LIMITS.sources || entry.sources.some(s => line(s).length > LIMITS.source)) throw new Error(`at most ${LIMITS.sources} short sources per entry`);
  }
  if (!write.add.length && !write.retire.length && write.title === null && write.summary === null && write.keywords === null) throw new Error("nothing to write");
}
/** Create a node or change one. Returns the node as written. A stale `revision` is refused with the current one, so the writer reads again and merges. */
export async function writeNode(bubble: string, write: NodeWrite, author: string, now = new Date().toISOString()): Promise<MemoryNode> {
  checked(write);
  return withStorageLock(join(bubbleDir(bubble), ".memory-lock"), async () => {
    loaded.delete(bubble);
    const old = await readNode(bubble, write.node);
    if (!old && (write.title === null || write.summary === null)) throw new Error(`${write.node} does not exist yet: a new node needs a title and a summary`);
    const rewrites = write.retire.length > 0 || (old !== null && (write.title !== null || write.summary !== null || write.keywords !== null));
    if (old && rewrites && write.revision !== old.revision) throw new Error(`${write.node} is at revision ${old.revision}, not ${write.revision ?? "none"}: read it again, then repeat the change with revision ${old.revision}`);
    const entries = (old?.entries ?? []).map(e => ({ ...e }));
    for (const n of write.retire) {
      const entry = entries[n];
      if (!entry) throw new Error(`${write.node} has no entry ${n}`);
      entry.retired ??= now;
    }
    for (const entry of write.add) entries.push({ text: line(entry.text), at: now, author, sources: entry.sources.map(line).filter(Boolean), retired: null });
    const active = entries.filter(e => !e.retired).length;
    if (active > LIMITS.active) throw new Error(`${write.node} would hold ${active} current entries (limit ${LIMITS.active}): retire replaced entries or put the new facts in a more specific node`);
    const node: MemoryNode = { id: write.node, title: line(write.title ?? old!.title), summary: line(write.summary ?? old!.summary),
      keywords: (write.keywords ?? old?.keywords ?? []).map(k => line(k).toLowerCase()), updated: now, revision: (old?.revision ?? 0) + 1, entries };
    await mkdir(dirname(nodeFile(bubble, node.id)), { recursive: true });
    await writeFileAtomic(nodeFile(bubble, node.id), serializeNode(node));
    await writeFileAtomic(versionFile(bubble), crypto.randomUUID());
    loaded.delete(bubble);
    // The entry point for tools that only read files (Codex, Claude Code): every node's id and summary, rewritten with each change.
    const all = await memoryNodes(bubble);
    await writeFileAtomic(join(memoryDir(bubble), "INDEX.md"), ["# Memory index", "Each line is a node file (`<id>.md` in this folder) and its one-line summary. Open the file for the dated detail.", "",
      ...all.map(n => `- ${n.id} — ${n.summary}`), ""].join("\n"));
    return node;
  });
}
