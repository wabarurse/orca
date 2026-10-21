// The orchestrator's questions for the user: a durable FIFO queue under
// questions/, one file per question, named like inbox messages so a sorted
// listing is ask order. Unlike the inbox, files stay after they are answered
// or skipped; the status field records it. The answer travels back to the
// orchestrator as an ordinary inbox message from "user".

import { mkdirSync } from "node:fs";
import { readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "./config";
import { put } from "./inbox";

export type Status = "open" | "answered" | "skipped";

export interface Question {
  id: string;
  text: string;
  options?: string[];
  default?: string;
  status: Status;
  answer?: string;
  ts: string;
}

export type NewQuestion = Pick<Question, "text" | "options" | "default">;

const file = (project: string, id: string) => join(paths.questions(project), `${id}.json`);

async function write(project: string, q: Question): Promise<void> {
  const d = paths.questions(project);
  mkdirSync(d, { recursive: true });
  const tmp = join(d, `.${q.id}.${crypto.randomUUID().slice(0, 8)}.tmp`);
  await Bun.write(tmp, JSON.stringify(q) + "\n");
  await rename(tmp, file(project, q.id));
}

let seq = 0;

/** Append questions to the queue in order; returns them with their ids. */
export async function ask(project: string, items: NewQuestion[]): Promise<Question[]> {
  const out: Question[] = [];
  for (const item of items) {
    const ts = new Date().toISOString();
    const id = `${ts.replaceAll(":", "-")}-${String(seq++).padStart(6, "0")}-${crypto.randomUUID().slice(0, 8)}`;
    const q: Question = { id, text: item.text, status: "open", ts };
    if (item.options?.length) q.options = item.options;
    if (item.default) q.default = item.default;
    await write(project, q);
    out.push(q);
  }
  return out;
}

/** Every question, oldest first. */
export async function all(project: string): Promise<Question[]> {
  const names = (await readdir(paths.questions(project)).catch(() => [])).filter((n) => n.endsWith(".json")).sort();
  const out: Question[] = [];
  for (const name of names) {
    try {
      out.push((await Bun.file(join(paths.questions(project), name)).json()) as Question);
    } catch {
      // Unreadable; skip it.
    }
  }
  return out;
}

/** Open questions, oldest first. */
export async function list(project: string): Promise<Question[]> {
  return (await all(project)).filter((q) => q.status === "open");
}

async function close(project: string, id: string, status: Exclude<Status, "open">, answer?: string): Promise<Question> {
  const f = Bun.file(file(project, id));
  if (!(await f.exists())) throw new Error(`no question ${id}`);
  const q = (await f.json()) as Question;
  if (q.status !== "open") throw new Error(`question ${id} is already ${q.status}`);
  const next: Question = { ...q, status, ...(answer === undefined ? {} : { answer }) };
  await write(project, next);
  return next;
}

/** Answer an open question and tell the orchestrator. */
export async function answer(project: string, id: string, text: string): Promise<Question> {
  const a = text.trim();
  if (!a) throw new Error("empty answer");
  const q = await close(project, id, "answered", a);
  await put(project, "orchestrator", { from: "user", text: `answer to "${q.text}": ${a}` });
  return q;
}

/** Skip an open question; the orchestrator falls back to its default. */
export async function skip(project: string, id: string): Promise<Question> {
  const q = await close(project, id, "skipped");
  const def = q.default ? ` (${q.default})` : "";
  await put(project, "orchestrator", { from: "user", text: `skipped "${q.text}"; use your default${def}` });
  return q;
}
