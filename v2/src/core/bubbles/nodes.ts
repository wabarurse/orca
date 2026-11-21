import { mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { withStorageLock } from "../lock";
import { errorCode, fail, ok, parseJson, type Result } from "../result";
import { bubbleDir, writeFileAtomic } from "./store";

export type Entry = { text: string; at: string; author: string; sources: string[]; retired: string | null };
export type MemoryNode = { id: string; title: string; summary: string; keywords: string[]; updated: string; revision: number; entries: Entry[] };
export type NodeWrite = {
  node: string; title: string | null; summary: string | null; keywords: string[] | null;
  add: { text: string; sources: string[] }[]; retire: number[]; revision: number | null;
};
const EntryMeta = z.object({ n: z.number(), at: z.unknown(), author: z.unknown(), sources: z.array(z.unknown()).nullish(), retired: z.string().nullish() });

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

function nodeIdProblem(id: string): string | null {
  return NODE_ID.test(id) ? null : `invalid memory node id ${JSON.stringify(id)}: use "${OVERVIEW}" or <branch>/<slug> with a branch of ${Object.keys(BRANCHES).join(", ")}`;
}
const memoryDir = (bubble: string) => join(bubbleDir(bubble), "memory");
const nodeFile = (bubble: string, id: string) => join(memoryDir(bubble), `${id}.md`);
const versionFile = (bubble: string) => join(memoryDir(bubble), ".version");
const line = (text: string) => text.replace(/\s+/g, " ").replaceAll("<!--", "").replaceAll("-->", "").trim();

export function serializeNode(node: MemoryNode): string {
  const head = ["---", `id: ${node.id}`, `title: ${node.title}`, `summary: ${node.summary}`, `keywords: ${node.keywords.join(", ")}`,
    `updated: ${node.updated}`, `revision: ${node.revision}`, "---"];
  const entry = (e: Entry, n: number) => `- ${e.text} <!-- ${JSON.stringify({ n, at: e.at, author: e.author, sources: e.sources, retired: e.retired })} -->`;
  const active = node.entries.flatMap((e, n) => e.retired === null ? [entry(e, n)] : []);
  const retired = node.entries.flatMap((e, n) => e.retired !== null ? [entry(e, n)] : []);
  return [...head, "## Current", ...active, ...(retired.length > 0 ? ["## Retired (replaced by a later entry; kept as history)", ...retired] : []), ""].join("\n");
}
export function parseNode(text: string): MemoryNode | null {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (match === null) return null;
  const [, front = "", body = ""] = match;
  const head = new Map(front.split("\n").map(row => { const at = row.indexOf(":"); return [row.slice(0, at).trim(), row.slice(at + 1).trim()] as const; }));
  const id = head.get("id") ?? "", revision = Number(head.get("revision"));
  if (!NODE_ID.test(id) || !Number.isSafeInteger(revision)) return null;
  const rows: { n: number; entry: Entry }[] = [];
  for (const row of body.split("\n")) {
    const found = /^- (.*) <!-- (\{.*\}) -->$/.exec(row);
    if (found === null) continue;
    const [, text = "", json = ""] = found;
    const raw = parseJson(json);
    const meta = raw.ok ? EntryMeta.safeParse(raw.data) : null;
    if (meta === null || !meta.success) continue;
    rows.push({ n: meta.data.n, entry: { text, at: String(meta.data.at), author: String(meta.data.author), sources: (meta.data.sources ?? []).map(String), retired: meta.data.retired ?? null } });
  }
  return { id, title: head.get("title") ?? "", summary: head.get("summary") ?? "", keywords: (head.get("keywords") ?? "").split(",").map(k => k.trim()).filter(k => k !== ""),
    updated: head.get("updated") ?? "", revision, entries: rows.sort((a, b) => a.n - b.n).map(r => r.entry) };
}

const loaded = new Map<string, { version: string; nodes: MemoryNode[] }>();
async function version(bubble: string): Promise<string> {
  const file = Bun.file(versionFile(bubble));
  return await file.exists() ? await file.text() : "";
}
async function walk(dir: string, prefix = ""): Promise<string[]> {
  const names = await readdir(dir, { withFileTypes: true }).catch((error: unknown) => { if (errorCode(error) === "ENOENT") return []; throw error; });
  const out: string[] = [];
  for (const entry of names.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) out.push(...await walk(join(dir, entry.name), `${prefix}${entry.name}/`));
    else if (entry.name.endsWith(".md")) out.push(`${prefix}${entry.name}`);
  }
  return out;
}
export async function memoryNodes(bubble: string): Promise<MemoryNode[]> {
  const current = await version(bubble), cached = loaded.get(bubble);
  if (cached !== undefined && cached.version === current) return cached.nodes;
  const files = await walk(memoryDir(bubble));
  const nodes = (await Promise.all(files.map(async file => parseNode(await Bun.file(join(memoryDir(bubble), file)).text())))).filter((n): n is MemoryNode => n !== null);
  nodes.sort((a, b) => a.id.localeCompare(b.id));
  loaded.set(bubble, { version: current, nodes });
  return nodes;
}
export async function readNode(bubble: string, id: string): Promise<Result<MemoryNode | null>> {
  const problem = nodeIdProblem(id);
  if (problem !== null) return fail(problem);
  return ok((await memoryNodes(bubble)).find(node => node.id === id) ?? null);
}

function writeProblem(write: NodeWrite): string | null {
  const badLength = (text: string, max: number): boolean => line(text) === "" || line(text).length > max;
  const idProblem = nodeIdProblem(write.node);
  if (idProblem !== null) return idProblem;
  if (write.title !== null && badLength(write.title, LIMITS.title)) return `title must be 1-${LIMITS.title} characters`;
  if (write.summary !== null && badLength(write.summary, LIMITS.summary)) return `summary must be 1-${LIMITS.summary} characters: one line that states the fact itself`;
  if (write.keywords !== null && (write.keywords.length > LIMITS.keywords || write.keywords.some(k => badLength(k, LIMITS.keyword)))) return `at most ${LIMITS.keywords} keywords of up to ${LIMITS.keyword} characters`;
  for (const entry of write.add) {
    if (badLength(entry.text, LIMITS.entry)) return `an entry must be 1-${LIMITS.entry} characters; split a longer one`;
    if (entry.sources.length > LIMITS.sources || entry.sources.some(s => line(s).length > LIMITS.source)) return `at most ${LIMITS.sources} short sources per entry`;
  }
  if (write.add.length === 0 && write.retire.length === 0 && write.title === null && write.summary === null && write.keywords === null) return "nothing to write";
  return null;
}
export async function writeNode(bubble: string, write: NodeWrite, author: string, now = new Date().toISOString()): Promise<Result<MemoryNode>> {
  const problem = writeProblem(write);
  if (problem !== null) return fail(problem);
  return withStorageLock(join(bubbleDir(bubble), ".memory-lock"), async (): Promise<Result<MemoryNode>> => {
    loaded.delete(bubble);
    const found = await readNode(bubble, write.node);
    if (!found.ok) return found;
    const old = found.data;
    if (old === null && (write.title === null || write.summary === null)) return fail(`${write.node} does not exist yet: a new node needs a title and a summary`);
    const rewrites = write.retire.length > 0 || (old !== null && (write.title !== null || write.summary !== null || write.keywords !== null));
    if (old !== null && rewrites && write.revision !== old.revision) return fail(`${write.node} is at revision ${old.revision}, not ${write.revision ?? "none"}: read it again, then repeat the change with revision ${old.revision}`);
    const entries = (old?.entries ?? []).map(e => ({ ...e }));
    for (const n of write.retire) {
      const entry = entries[n];
      if (entry === undefined) return fail(`${write.node} has no entry ${n}`);
      entry.retired ??= now;
    }
    for (const entry of write.add) entries.push({ text: line(entry.text), at: now, author, sources: entry.sources.map(line).filter(source => source !== ""), retired: null });
    const active = entries.filter(e => e.retired === null).length;
    if (active > LIMITS.active) return fail(`${write.node} would hold ${active} current entries (limit ${LIMITS.active}): retire replaced entries or put the new facts in a more specific node`);
    const node: MemoryNode = { id: write.node, title: line(write.title ?? old?.title ?? ""), summary: line(write.summary ?? old?.summary ?? ""),
      keywords: (write.keywords ?? old?.keywords ?? []).map(k => line(k).toLowerCase()), updated: now, revision: (old?.revision ?? 0) + 1, entries };
    await mkdir(dirname(nodeFile(bubble, node.id)), { recursive: true });
    await writeFileAtomic(nodeFile(bubble, node.id), serializeNode(node));
    await writeFileAtomic(versionFile(bubble), crypto.randomUUID());
    loaded.delete(bubble);
    const all = await memoryNodes(bubble);
    await writeFileAtomic(join(memoryDir(bubble), "INDEX.md"), ["# Memory index", "Each line is a node file (`<id>.md` in this folder) and its one-line summary. Open the file for the dated detail.", "",
      ...all.map(n => `- ${n.id} — ${n.summary}`), ""].join("\n"));
    return ok(node);
  });
}
