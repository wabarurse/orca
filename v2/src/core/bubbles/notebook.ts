// The bubble's notebook: bulky material that should not sit in anyone's context (tool output, documents, tables).
// Only each page's title and one-line summary are listed to the agents; the content is read or queried on demand.
// It is a least-recently-used cache: over the limits the coldest page is archived (its line stays, marked), an
// archived page read within `ARCHIVE_DAYS` comes back, and after that `purgeNotebook` deletes it.
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { withStorageLock } from "../lock";
import { bubbleDir, readJson, writeFileAtomic } from "./store";

export interface Page { id: string; title: string; summary: string; bytes: number; author: string; createdAt: string; usedAt: string; archivedAt: string | null }
export const NOTEBOOK = { pages: 200, bytes: 256 * 1024 * 1024, page: 8 * 1024 * 1024, title: 120, summary: 240, read: 24_000, matches: 60 } as const;
export const ARCHIVE_DAYS = 14;

const dir = (bubble: string) => join(bubbleDir(bubble), "notebook");
const indexFile = (bubble: string) => join(dir(bubble), "index.json");
const pageFile = (bubble: string, page: Page) => join(dir(bubble), page.archivedAt ? "archive" : "", `${page.id}.txt`);
const one = (text: string) => text.replace(/\s+/g, " ").trim();
const locked = <T>(bubble: string, action: (pages: Page[]) => Promise<T>) =>
  withStorageLock(join(bubbleDir(bubble), ".notebook-lock"), async () => action(await readJson<Page[]>(indexFile(bubble), [])));
async function save(bubble: string, pages: Page[]): Promise<void> {
  await mkdir(join(dir(bubble), "archive"), { recursive: true });
  await writeFileAtomic(indexFile(bubble), JSON.stringify(pages));
}
/** Archive the coldest live pages until the limits hold. `keep` is the page being written or read now. */
async function evict(bubble: string, pages: Page[], keep: string, now: string): Promise<void> {
  const live = () => pages.filter(p => !p.archivedAt);
  while (live().length > NOTEBOOK.pages || live().reduce((sum, p) => sum + p.bytes, 0) > NOTEBOOK.bytes) {
    const coldest = live().filter(p => p.id !== keep).sort((a, b) => a.usedAt.localeCompare(b.usedAt))[0];
    if (!coldest) break;
    const from = pageFile(bubble, coldest);
    coldest.archivedAt = now;
    await rename(from, pageFile(bubble, coldest));
  }
}
export async function listPages(bubble: string): Promise<Page[]> {
  return (await readJson<Page[]>(indexFile(bubble), [])).sort((a, b) => b.usedAt.localeCompare(a.usedAt));
}
export async function putPage(bubble: string, input: { title: string; summary: string; content: string }, author: string, now = new Date().toISOString()): Promise<Page> {
  const title = one(input.title), summary = one(input.summary), bytes = Buffer.byteLength(input.content);
  if (!title || title.length > NOTEBOOK.title) throw new Error(`a page needs a title of 1-${NOTEBOOK.title} characters`);
  if (!summary || summary.length > NOTEBOOK.summary) throw new Error(`a page needs a one-line summary of 1-${NOTEBOOK.summary} characters saying what it holds`);
  if (!bytes || bytes > NOTEBOOK.page) throw new Error(`page content must be 1 byte to ${NOTEBOOK.page / 1024 / 1024} MiB`);
  return locked(bubble, async pages => {
    const page: Page = { id: `page-${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`, title, summary, bytes, author, createdAt: now, usedAt: now, archivedAt: null };
    await mkdir(join(dir(bubble), "archive"), { recursive: true });
    await Bun.write(pageFile(bubble, page), input.content);
    pages.push(page);
    await evict(bubble, pages, page.id, now);
    await save(bubble, pages);
    return page;
  });
}
/** The page's text, moved to the front of the cache; an archived page is restored first. */
async function open(bubble: string, id: string, now: string): Promise<{ page: Page; text: string }> {
  return locked(bubble, async pages => {
    const page = pages.find(p => p.id === id);
    if (!page) throw new Error(`no notebook page ${id}; list the notebook for its pages`);
    const file = Bun.file(pageFile(bubble, page));
    if (!await file.exists()) throw new Error(`${id} ("${page.title}") was archived and its content has since been removed; only its summary remains: ${page.summary}`);
    const text = await file.text();
    if (page.archivedAt) {
      const from = pageFile(bubble, page);
      page.archivedAt = null;
      await rename(from, pageFile(bubble, page));
    }
    page.usedAt = now;
    await evict(bubble, pages, page.id, now);
    await save(bubble, pages);
    return { page, text };
  });
}
/** A line range of a page (1-based), cut to what fits one tool result. */
export async function readPage(bubble: string, id: string, start = 1, lines = 400, now = new Date().toISOString()): Promise<string> {
  const { page, text } = await open(bubble, id, now);
  const all = text.split("\n"), from = Math.max(1, Math.floor(start)), chosen = all.slice(from - 1, from - 1 + Math.max(1, Math.floor(lines)));
  let body = chosen.join("\n"), shown = chosen.length;
  while (body.length > NOTEBOOK.read && shown > 1) { shown = Math.ceil(shown / 2); body = chosen.slice(0, shown).join("\n"); }
  const end = from + shown - 1;
  return `${page.id} "${page.title}" lines ${from}-${end} of ${all.length}${end < all.length ? ` (continue with start_line ${end + 1})` : ""}\n${body.slice(0, NOTEBOOK.read)}`;
}
/** The lines of a page that match a pattern (a regular expression, else plain text), with line numbers. */
export async function queryPage(bubble: string, id: string, pattern: string, now = new Date().toISOString()): Promise<string> {
  if (!pattern || pattern.length > 300) throw new Error("query needs a pattern of 1-300 characters");
  const { page, text } = await open(bubble, id, now);
  let test: (line: string) => boolean;
  try { const re = new RegExp(pattern, "i"); test = row => re.test(row); }
  catch { const plain = pattern.toLowerCase(); test = row => row.toLowerCase().includes(plain); }
  const rows = text.split("\n"), found: string[] = [];
  let total = 0;
  rows.forEach((row, n) => { if (!test(row)) return; total++; if (found.length < NOTEBOOK.matches) found.push(`${n + 1}: ${row.slice(0, 400)}`); });
  return `${page.id} "${page.title}": ${total} matching line${total === 1 ? "" : "s"} of ${rows.length}${total > found.length ? `, first ${found.length} shown` : ""}\n${found.join("\n")}`;
}
/** Delete the content of pages archived more than `days` ago; their lines leave the index too. Returns what was removed. */
export async function purgeNotebook(bubble: string, now = Date.now(), days = ARCHIVE_DAYS, apply = true): Promise<Page[]> {
  return locked(bubble, async pages => {
    const expired = pages.filter(p => p.archivedAt && now - Date.parse(p.archivedAt) > days * 86_400_000);
    if (!apply || !expired.length) return expired;
    for (const page of expired) await rm(pageFile(bubble, page), { force: true });
    await save(bubble, pages.filter(p => !expired.includes(p)));
    return expired;
  });
}
export function renderPages(pages: Page[], limit = 30): string {
  const rows = pages.slice(0, limit).map(p => `- ${p.id} — ${p.title}: ${p.summary} (${p.bytes} bytes${p.archivedAt ? ", archived: reading it restores it" : ""})`);
  return [...rows, ...(pages.length > limit ? [`(${pages.length - limit} older pages: notebook list)`] : [])].join("\n");
}
