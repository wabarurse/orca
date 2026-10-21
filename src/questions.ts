// The orchestrator's questions for the user: a durable FIFO queue under
// questions/, one file per question, named like inbox messages so a sorted
// listing is ask order. Unlike the inbox, files stay after they are answered
// or skipped; the status field records it. The answer travels back to the
// orchestrator as an ordinary inbox message from "user".

import { mkdirSync } from "node:fs";
import { open, readdir, rename } from "node:fs/promises";
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

export const limits = { text: 500, option: 100, options: 8, questions: 10, answer: 2000 };

/** Trim, turn newlines and tabs into spaces, refuse control characters and over-long text. */
export function clean(value: string, max: number, what: string): string {
  const s = value.replace(/[\r\n\t]+/g, " ").trim();
  if (/[\u0000-\u001f\u007f-\u009f]/.test(s)) throw new Error(`${what} has control characters`);
  if (s.length > max) throw new Error(`${what} is over ${max} characters`);
  return s;
}

function cleanOne(raw: unknown, i: number): NewQuestion {
  const r = (raw ?? {}) as Record<string, unknown>;
  const text = typeof r.text === "string" ? clean(r.text, limits.text, `question ${i + 1} text`) : "";
  if (!text) throw new Error(`question ${i + 1} needs text`);
  const strings = Array.isArray(r.options) ? r.options.filter((o): o is string => typeof o === "string") : [];
  const options = [...new Set(strings.map((o) => clean(o, limits.option, `question ${i + 1} option`)).filter(Boolean))];
  if (options.length > limits.options) throw new Error(`question ${i + 1} has over ${limits.options} options`);
  const def = typeof r.default === "string" ? clean(r.default, limits.option, `question ${i + 1} default`) : "";
  return { text, ...(options.length ? { options } : {}), ...(def ? { default: def } : {}) };
}

/** Validate untrusted tool input into questions; throws a readable reason. */
export function cleanQuestions(raw: unknown): NewQuestion[] {
  const list = Array.isArray(raw) ? raw : [];
  if (!list.length) throw new Error("no questions");
  if (list.length > limits.questions) throw new Error(`over ${limits.questions} questions in one call`);
  return list.map(cleanOne);
}

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

/** Every question, oldest first. Reads every file on each call: answered and
 * skipped files are kept as history, so this grows with the project. */
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
  if (!/^[\w.-]+$/.test(id) || id.includes("..")) throw new Error(`bad question id ${id}`);
  const f = Bun.file(file(project, id));
  if (!(await f.exists())) throw new Error(`no question ${id}`);
  const q = (await f.json()) as Question;
  if (q.status !== "open") throw new Error(`question ${id} is already ${q.status}`);
  // Claim it exclusively so two concurrent closes can't both pass the check.
  try {
    await (await open(join(paths.questions(project), `${id}.closed`), "wx")).close();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`question ${id} is already closed`);
    throw e;
  }
  const next: Question = { ...q, status, ...(answer === undefined ? {} : { answer }) };
  await write(project, next);
  return next;
}

/** Answer an open question and tell the orchestrator. */
export async function answer(project: string, id: string, text: string): Promise<Question> {
  const a = clean(text, limits.answer, "answer");
  if (!a) throw new Error("empty answer");
  const q = await close(project, id, "answered", a);
  await put(project, "orchestrator", { from: "user", text: `[${q.id}] answer to "${q.text}": ${a}` });
  return q;
}

/** Skip an open question; the orchestrator falls back to its default. */
export async function skip(project: string, id: string): Promise<Question> {
  const q = await close(project, id, "skipped");
  const tail = q.default ? `; use your default (${q.default})` : " (no default given); decide yourself";
  await put(project, "orchestrator", { from: "user", text: `[${q.id}] skipped "${q.text}"${tail}` });
  return q;
}
