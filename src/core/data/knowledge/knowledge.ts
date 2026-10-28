import { join } from "node:path";
import { paths, projectStateScope, readProjectState, readState, updateState } from "../../../config";
import { withStorageLock } from "../storage-lock";
import type { HumanMessage } from "./sources";

/** `source` is the canonical human message id for an explicit fact (with `quote`, a short excerpt of it), free text otherwise. */
export interface Fact { key: string; text: string; source: string; quote?: string; confidence: "explicit" | "tentative"; updatedAt: string; project: string }
export interface WorkingContext {
  goal?: string; decisions?: string[]; results?: { label: string; location: string; revision?: string; evidence?: string; status: "reported" | "verified"; processId?: string; observedAt?: string }[];
  latest?: { id: string; text: string; at: string }[];
}
const factScope = (project: string, scope: "user" | "project") => scope === "user" ? "user" : projectStateScope(project);
// Capture the project incarnation before waiting: an old operation must never
// publish into a newly created project with the same name.
const contextLock = (project: string) => join(paths.runtime, "knowledge-locks", project);
export async function facts(project: string, scope: "user" | "project"): Promise<Fact[]> {
  return (scope === "project" ? readProjectState<Fact[]>(project, "facts") : readState<Fact[]>(paths.memory, "user", "facts")) ?? [];
}
export async function remember(project: string, scope: "user" | "project", fact: Fact | { key: string }): Promise<void> {
  updateState<Fact[]>(paths.memory, factScope(project, scope), "facts", old => {
    const rows = (old ?? []).filter(f => f.key !== fact.key);
    if ("text" in fact) rows.push(fact);
    if (rows.length > 200) throw new Error("memory capacity reached; consolidate or forget obsolete entries");
    return rows;
  });
}
export async function workingContext(project: string): Promise<WorkingContext> {
  return readProjectState<WorkingContext>(project, "working-context") ?? {};
}
function publishContext(scope: string, value: WorkingContext): void {
  if (Buffer.byteLength(JSON.stringify(value)) > 16000) throw new Error("working context exceeds 16 KiB; retain concise decisions and evidence references");
  updateState<WorkingContext>(paths.memory, scope, "working-context", () => value);
}
export async function updateContext(project: string, patch: Partial<WorkingContext>): Promise<WorkingContext> {
  const scope = projectStateScope(project);
  return withStorageLock(contextLock(project), async () => {
    const value = { ...readState<WorkingContext>(paths.memory, scope, "working-context"), ...patch };
    publishContext(scope, value); return value;
  });
}
/** Publish an empty brief before the transcript boundary, so a crash cannot
 * reintroduce a pre-clear goal. A failed boundary publication restores the brief;
 * a crash between publications can discard the brief, never original history. */
export async function clearWorkingContext(project: string, commit?: () => Promise<unknown>): Promise<void> {
  const scope = projectStateScope(project);
  await withStorageLock(contextLock(project), async () => {
    const previous = readState<WorkingContext>(paths.memory, scope, "working-context") ?? {};
    publishContext(scope, { decisions: [], results: [], latest: [] });
    try { await commit?.(); }
    catch (error) { publishContext(scope, previous); throw error; }
  });
}
/** How many recent human messages stay in the brief (every prompt carries them) and, outside it, as provenance for explicit preferences. */
const BRIEF_MESSAGES = 3, SOURCE_MESSAGES = 30;
/** The project's recent human messages, oldest first: the provenance `remember` accepts for explicit preferences.
 * Kept apart from the brief, so retaining more costs no prompt space; bounded in count and per-message size. */
export async function humanSources(project: string): Promise<HumanMessage[]> {
  return readProjectState<HumanMessage[]>(project, "human-sources") ?? [];
}
export async function recordCorrection(project: string, correction: { id: string; text: string; at: string }) {
  const scope = projectStateScope(project);
  await withStorageLock(contextLock(project), async () => {
    const ctx = readState<WorkingContext>(paths.memory, scope, "working-context") ?? {};
    // Originals remain in the transcript. A bounded verbatim tail keeps newer
    // human corrections separate from inferred preferences and historical summaries.
    const text = correction.text.length > 2000 ? `${correction.text.slice(0, 2000)}\n[continued in source message ${correction.id}]` : correction.text;
    ctx.latest = [...(ctx.latest ?? []).filter(c => c.id !== correction.id), { ...correction, text }].slice(-BRIEF_MESSAGES);
    updateState<HumanMessage[]>(paths.memory, scope, "human-sources", old => [...(old ?? []).filter(c => c.id !== correction.id), { ...correction, text }].slice(-SOURCE_MESSAGES));
    while (Buffer.byteLength(JSON.stringify(ctx)) > 16000 && ctx.results?.length) ctx.results.shift();
    while (Buffer.byteLength(JSON.stringify(ctx)) > 16000 && ctx.decisions?.length) ctx.decisions.shift();
    publishContext(scope, ctx);
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
