import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { withStorageLock } from "../lock";
import { bubbleDir, readJson, rows as validRows, writeFileAtomic } from "./store";
import { fail, ok, type Result } from "../../config";

export type Page = { id: string; title: string; summary: string; bytes: number; author: string; createdAt: string; usedAt: string; archivedAt: string | null };
const PageRow = z.object({ id: z.string(), title: z.string(), summary: z.string(), bytes: z.number(), author: z.string(), createdAt: z.string(), usedAt: z.string(), archivedAt: z.string().nullable() });
export const NOTEBOOK = { pages: 200, bytes: 256 * 1024 * 1024, page: 8 * 1024 * 1024, title: 120, summary: 240, read: 24_000, matches: 60 };
export const ARCHIVE_DAYS = 14;

const dir = (bubble: string) => join(bubbleDir(bubble), "notebook");
const indexFile = (bubble: string) => join(dir(bubble), "index.json");
const pageFile = (bubble: string, page: Page) => join(dir(bubble), page.archivedAt !== null ? "archive" : "", `${page.id}.txt`);
const one = (text: string) => text.replace(/\s+/g, " ").trim();
async function index(bubble: string): Promise<Result<Page[]>> {
  const json = await readJson(indexFile(bubble));
  return json.ok ? ok(validRows(json.data, PageRow)) : json;
}
const locked = <T>(bubble: string, action: (pages: Page[]) => Promise<Result<T>>): Promise<Result<T>> =>
  withStorageLock(join(bubbleDir(bubble), ".notebook-lock"), async () => {
    const pages = await index(bubble);
    return pages.ok ? action(pages.data) : pages;
  });
async function save(bubble: string, pages: Page[]): Promise<void> {
  await mkdir(join(dir(bubble), "archive"), { recursive: true });
  await writeFileAtomic(indexFile(bubble), JSON.stringify(pages));
}
async function evict(bubble: string, pages: Page[], keep: string, now: string): Promise<void> {
  const live = () => pages.filter(p => p.archivedAt === null);
  while (live().length > NOTEBOOK.pages || live().reduce((sum, p) => sum + p.bytes, 0) > NOTEBOOK.bytes) {
    const coldest = live().filter(p => p.id !== keep).sort((a, b) => a.usedAt.localeCompare(b.usedAt))[0];
    if (coldest === undefined) break;
    const from = pageFile(bubble, coldest);
    coldest.archivedAt = now;
    await rename(from, pageFile(bubble, coldest));
  }
}
export async function listPages(bubble: string): Promise<Page[]> {
  const pages = await index(bubble);
  return pages.ok ? pages.data.sort((a, b) => b.usedAt.localeCompare(a.usedAt)) : [];
}
export async function putPage(bubble: string, input: { title: string; summary: string; content: string }, author: string, now = new Date().toISOString()): Promise<Result<Page>> {
  const title = one(input.title), summary = one(input.summary), bytes = Buffer.byteLength(input.content);
  if (title === "" || title.length > NOTEBOOK.title) return fail(`a page needs a title of 1-${NOTEBOOK.title} characters`);
  if (summary === "" || summary.length > NOTEBOOK.summary) return fail(`a page needs a one-line summary of 1-${NOTEBOOK.summary} characters saying what it holds`);
  if (bytes === 0 || bytes > NOTEBOOK.page) return fail(`page content must be 1 byte to ${NOTEBOOK.page / 1024 / 1024} MiB`);
  return locked(bubble, async pages => {
    const page: Page = { id: `page-${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`, title, summary, bytes, author, createdAt: now, usedAt: now, archivedAt: null };
    await mkdir(join(dir(bubble), "archive"), { recursive: true });
    await Bun.write(pageFile(bubble, page), input.content);
    pages.push(page);
    await evict(bubble, pages, page.id, now);
    await save(bubble, pages);
    return ok(page);
  });
}
async function open(bubble: string, id: string, now: string): Promise<Result<{ page: Page; text: string }>> {
  return locked(bubble, async pages => {
    const page = pages.find(p => p.id === id);
    if (page === undefined) return fail(`no notebook page ${id}; list the notebook for its pages`);
    const file = Bun.file(pageFile(bubble, page));
    if (!await file.exists()) return fail(`${id} ("${page.title}") was archived and its content has since been removed; only its summary remains: ${page.summary}`);
    const text = await file.text();
    if (page.archivedAt !== null) {
      const from = pageFile(bubble, page);
      page.archivedAt = null;
      await rename(from, pageFile(bubble, page));
    }
    page.usedAt = now;
    await evict(bubble, pages, page.id, now);
    await save(bubble, pages);
    return ok({ page, text });
  });
}
export async function readPage(bubble: string, id: string, start = 1, lines = 400, now = new Date().toISOString()): Promise<Result<string>> {
  const opened = await open(bubble, id, now);
  if (!opened.ok) return opened;
  const { page, text } = opened.data;
  const all = text.split("\n"), from = Math.max(1, Math.floor(start)), chosen = all.slice(from - 1, from - 1 + Math.max(1, Math.floor(lines)));
  let body = chosen.join("\n"), shown = chosen.length;
  while (body.length > NOTEBOOK.read && shown > 1) { shown = Math.ceil(shown / 2); body = chosen.slice(0, shown).join("\n"); }
  const end = from + shown - 1;
  return ok(`${page.id} "${page.title}" lines ${from}-${end} of ${all.length}${end < all.length ? ` (continue with start_line ${end + 1})` : ""}\n${body.slice(0, NOTEBOOK.read)}`);
}
export async function queryPage(bubble: string, id: string, pattern: string, now = new Date().toISOString()): Promise<Result<string>> {
  if (pattern === "" || pattern.length > 300) return fail("query needs a pattern of 1-300 characters");
  const opened = await open(bubble, id, now);
  if (!opened.ok) return opened;
  const { page, text } = opened.data;
  let test: (line: string) => boolean;
  try { const re = new RegExp(pattern, "i"); test = row => re.test(row); }
  catch { const plain = pattern.toLowerCase(); test = row => row.toLowerCase().includes(plain); }
  const rows = text.split("\n"), found: string[] = [];
  let total = 0;
  rows.forEach((row, n) => { if (!test(row)) return; total++; if (found.length < NOTEBOOK.matches) found.push(`${n + 1}: ${row.slice(0, 400)}`); });
  return ok(`${page.id} "${page.title}": ${total} matching line${total === 1 ? "" : "s"} of ${rows.length}${total > found.length ? `, first ${found.length} shown` : ""}\n${found.join("\n")}`);
}
export async function purgeNotebook(bubble: string, now = Date.now(), days = ARCHIVE_DAYS, apply = true): Promise<Result<Page[]>> {
  return locked(bubble, async pages => {
    const expired = pages.filter(p => p.archivedAt !== null && now - Date.parse(p.archivedAt) > days * 86_400_000);
    if (!apply || expired.length === 0) return ok(expired);
    for (const page of expired) await rm(pageFile(bubble, page), { force: true });
    await save(bubble, pages.filter(p => !expired.includes(p)));
    return ok(expired);
  });
}
export function renderPages(pages: Page[], limit = 30): string {
  const rows = pages.slice(0, limit).map(p => `- ${p.id} — ${p.title}: ${p.summary} (${p.bytes} bytes${p.archivedAt !== null ? ", archived: reading it restores it" : ""})`);
  return [...rows, ...(pages.length > limit ? [`(${pages.length - limit} older pages: notebook list)`] : [])].join("\n");
}
