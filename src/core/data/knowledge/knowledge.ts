import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { paths } from "../../../config";
import { withStorageLock } from "../storage-lock";

export interface Fact { key: string; text: string; source: string; confidence: "explicit" | "tentative"; updatedAt: string; project: string }
export interface WorkingContext {
  goal?: string; decisions?: string[]; results?: { label: string; location: string; revision?: string; evidence?: string; status: "reported" | "verified"; processId?: string; observedAt?: string }[];
  latest?: { id: string; text: string; at: string }[];
}
const factPath = (project: string, scope: "user" | "project") => scope === "user" ? join(paths.root, "preferences.json") : join(paths.project(project), "knowledge.json");
const contextPath = (project: string) => join(paths.project(project), "working-context.json");
async function json<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(file, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw error; }
}
async function publish(file: string, value: unknown) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); await rename(tmp, file);
}
export const facts = (project: string, scope: "user" | "project") => json<Fact[]>(factPath(project, scope), []);
export async function remember(project: string, scope: "user" | "project", fact: Fact | { key: string }): Promise<void> {
  const file = factPath(project, scope);
  await withStorageLock(`${file}.lock`, async () => {
    const rows = (await facts(project, scope)).filter(f => f.key !== fact.key);
    if ("text" in fact) rows.push(fact);
    if (rows.length > 200) throw new Error("memory capacity reached; consolidate or forget obsolete entries");
    await publish(file, rows);
  });
}
export const workingContext = (project: string) => json<WorkingContext>(contextPath(project), {});
export async function updateContext(project: string, patch: Partial<WorkingContext>): Promise<WorkingContext> {
  const file = contextPath(project);
  return withStorageLock(`${file}.lock`, async () => {
    const value = { ...await workingContext(project), ...patch };
    if (Buffer.byteLength(JSON.stringify(value)) > 16000) throw new Error("working context exceeds 16 KiB; retain concise decisions and evidence references");
    await publish(file, value); return value;
  });
}
/** Publish an empty brief before the transcript boundary, so a crash cannot
 * reintroduce a pre-clear goal. A failed boundary publication restores the brief;
 * a crash between publications can discard the brief, never original history. */
export async function clearWorkingContext(project: string, commit?: () => Promise<unknown>): Promise<void> {
  const file = contextPath(project);
  await withStorageLock(`${file}.lock`, async () => {
    const previous = await workingContext(project);
    await publish(file, { decisions: [], results: [], latest: [] });
    try { await commit?.(); }
    catch (error) { await publish(file, previous); throw error; }
  });
}
export async function recordCorrection(project: string, correction: { id: string; text: string; at: string }) {
  const file = contextPath(project);
  await withStorageLock(`${file}.lock`, async () => {
    const ctx = await workingContext(project);
    // Originals remain in the transcript. A bounded verbatim tail keeps newer
    // human corrections separate from inferred preferences and historical summaries.
    const text = correction.text.length > 2000 ? `${correction.text.slice(0, 2000)}\n[continued in source message ${correction.id}]` : correction.text;
    ctx.latest = [...(ctx.latest ?? []).filter(c => c.id !== correction.id), { ...correction, text }].slice(-3);
    while (Buffer.byteLength(JSON.stringify(ctx)) > 16000 && ctx.results?.length) ctx.results.shift();
    while (Buffer.byteLength(JSON.stringify(ctx)) > 16000 && ctx.decisions?.length) ctx.decisions.shift();
    await publish(file, ctx);
  });
}
/** Select only relevant knowledge; explicit current instructions always take precedence.
 * Inspired by Claude Code's scoped memory and on-demand context, adapted to
 * source-attributed, user-editable Orca records: https://code.claude.com/docs/en/memory */
export async function selectedKnowledge(project: string, query: string): Promise<string> {
  const terms = new Set(query.toLowerCase().match(/[a-z0-9_-]{3,}/g) ?? []);
  const all = [...(await facts(project, "user")).map(f => ({ ...f, scope: "user" })), ...(await facts(project, "project")).map(f => ({ ...f, scope: "project" }))];
  const score = (f: Fact) => [...terms].filter(t => `${f.key} ${f.text}`.toLowerCase().includes(t)).length;
  const selected = all.filter(f => score(f) > 0 || f.key.startsWith("always.")).sort((a, b) => score(b) - score(a) || a.key.localeCompare(b.key)).slice(0, 8);
  while (JSON.stringify(selected).length > 8000) selected.pop();
  return JSON.stringify(selected);
}
