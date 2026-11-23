import { mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { asRecord, errorCode, errorMessage, fail, ok, parseJson, type Result } from "../../config";

const StatusSchema = z.enum(["open", "answered", "skipped", "closed"]);
const QuestionSchema = z.object({
  id: z.string(),
  text: z.string(),
  options: z.array(z.string()),
  default: z.string().nullable(),
  status: StatusSchema,
  answer: z.string().nullable(),
  reason: z.string().nullable(),
  askedAt: z.string(),
  settledAt: z.string().nullable(),
});

export type Status = z.infer<typeof StatusSchema>;
export type Question = z.infer<typeof QuestionSchema>;
export type NewQuestion = { text: string; options: string[]; default: string | null };

export const limits = { questions: 4, text: 500, option: 100, minOptions: 2, maxOptions: 6, reason: 200, answer: 2000, close: 20 };

const ID = /^q-[a-z0-9]+-[a-z0-9]{6}$/;
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

export function clean(value: unknown, max: number, what: string): Result<string> {
  const text = (typeof value === "string" ? value : "").replace(/[\r\n\t]+/g, " ").trim();
  if (UNSAFE.test(text)) return fail(`${what} has control or bidi characters`);
  if (text.length > max) return fail(`${what} is over ${max} characters`);
  return ok(text);
}

function cleanQuestion(item: unknown, index: number): Result<NewQuestion> {
  const raw = asRecord(item) ?? {};
  const what = `question ${index + 1}`;
  const text = clean(raw.text, limits.text, `${what} text`);
  if (!text.ok) return text;
  if (text.data.length === 0) return fail(`${what} needs text`);
  const given: unknown[] = Array.isArray(raw.options) ? raw.options : [];
  const options: string[] = [];
  for (const option of given) {
    const cleaned = clean(option, limits.option, `${what} option`);
    if (!cleaned.ok) return cleaned;
    if (cleaned.data.length > 0 && !options.includes(cleaned.data)) options.push(cleaned.data);
  }
  if (options.length > 0 && (options.length < limits.minOptions || options.length > limits.maxOptions)) return fail(`${what} needs ${limits.minOptions} to ${limits.maxOptions} options, or none`);
  const suggested = clean(raw.default, limits.option, `${what} default`);
  if (!suggested.ok) return suggested;
  return ok({ text: text.data, options, default: suggested.data.length > 0 ? suggested.data : null });
}

export function cleanQuestions(raw: unknown): Result<NewQuestion[]> {
  const list: unknown[] = Array.isArray(raw) ? raw : [];
  if (list.length === 0) return fail("ask needs questions");
  if (list.length > limits.questions) return fail(`at most ${limits.questions} questions in one call`);
  const out: NewQuestion[] = [];
  for (const [index, item] of list.entries()) {
    const question = cleanQuestion(item, index);
    if (!question.ok) return question;
    out.push(question.data);
  }
  return ok(out);
}

const file = (dir: string, id: string): string => join(dir, `${id}.json`);

async function write(dir: string, q: Question): Promise<void> {
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${q.id}.${crypto.randomUUID().slice(0, 8)}.tmp`);
  try {
    await Bun.write(tmp, JSON.stringify(q, null, 2) + "\n");
    await rename(tmp, file(dir, q.id));
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

async function readRecord(path: string, name: string): Promise<Result<Question | null>> {
  const source = Bun.file(path);
  if (!await source.exists()) return ok(null);
  const json = parseJson(await source.text());
  const parsed = json.ok ? QuestionSchema.safeParse(json.data) : null;
  if (parsed === null || !parsed.success || `${parsed.data.id}.json` !== name) return fail(`invalid question record ${name}`);
  return ok(parsed.data);
}

async function questionFiles(dir: string): Promise<Result<string[]>> {
  try { return ok((await readdir(dir)).filter(n => n.endsWith(".json") && !n.startsWith(".")).sort()); }
  catch (error) { return errorCode(error) === "ENOENT" ? ok([]) : fail(errorMessage(error)); }
}

function byAsked(a: Question, b: Question): number {
  const time = a.askedAt.localeCompare(b.askedAt);
  return time !== 0 ? time : a.id.localeCompare(b.id);
}

export async function allQuestions(dir: string): Promise<Result<Question[]>> {
  const names = await questionFiles(dir);
  if (!names.ok) return names;
  const out: Question[] = [];
  for (const name of names.data) {
    const record = await readRecord(join(dir, name), name);
    if (!record.ok) return record;
    if (record.data !== null) out.push(record.data);
  }
  return ok(out.sort(byAsked));
}

export async function openQuestions(dir: string): Promise<Result<Question[]>> {
  const all = await allQuestions(dir);
  return all.ok ? ok(all.data.filter(q => q.status === "open")) : all;
}

export async function getQuestion(dir: string, id: string): Promise<Result<Question>> {
  if (!ID.test(id)) return fail(`no question ${id}`);
  const record = await readRecord(file(dir, id), `${id}.json`);
  if (!record.ok) return record;
  return record.data === null ? fail(`no question ${id}`) : ok(record.data);
}

let lastAsked = 0;

export async function addQuestions(dir: string, items: NewQuestion[]): Promise<Question[]> {
  const out: Question[] = [];
  for (const item of items) {
    lastAsked = Math.max(Date.now(), lastAsked + 1);
    const askedAt = new Date(lastAsked).toISOString();
    const id = `q-${lastAsked.toString(36)}-${crypto.randomUUID().replaceAll("-", "").slice(0, 6)}`;
    const q: Question = { id, text: item.text, options: item.options, default: item.default, status: "open", answer: null, reason: null, askedAt, settledAt: null };
    await write(dir, q);
    out.push(q);
  }
  return out;
}

async function claim(path: string): Promise<boolean> {
  try { await (await open(path, "wx")).close(); return true; }
  catch (error) { if (errorCode(error) === "EEXIST") return false; throw error; }
}

const settledError = (q: Question): string =>
  q.status === "answered" ? `question ${q.id} is already answered: ${q.answer ?? ""}` : `question ${q.id} is already ${q.status}`;

async function settle(dir: string, id: string, next: (q: Question) => Question, deliver: ((q: Question) => Promise<void>) | null): Promise<Result<Question>> {
  const found = await getQuestion(dir, id);
  if (!found.ok) return found;
  const q = found.data;
  const answering = deliver !== null;
  const kind = q.status === "open" ? "settled" : q.status === "closed" && answering ? "answered" : null;
  if (kind === null) return fail(settledError(q));
  const lock = join(dir, `${id}.${kind}`);
  if (!await claim(lock)) {
    const now = await getQuestion(dir, id);
    if (!now.ok) return now;
    if (now.data.status === "answered") return fail(settledError(now.data));
    if (now.data.status === "closed" && answering) return settle(dir, id, next, deliver);
    return fail(`question ${id} is already being settled`);
  }
  const settled = next(q);
  let written = false;
  try {
    await write(dir, settled);
    written = true;
    if (deliver !== null) await deliver(settled);
  } catch (error) {
    if (written) await write(dir, q);
    await unlink(lock).catch(() => undefined);
    return fail(errorMessage(error));
  }
  return ok(settled);
}

const now = (): string => new Date().toISOString();

export async function answerQuestion(dir: string, id: string, text: string, deliver: (q: Question) => Promise<void>): Promise<Result<Question>> {
  const answer = clean(text, limits.answer, "answer");
  if (!answer.ok) return answer;
  if (answer.data.length === 0) return fail("empty answer");
  return settle(dir, id, q => ({ ...q, status: "answered", answer: answer.data, settledAt: now() }), deliver);
}

export async function skipQuestion(dir: string, id: string): Promise<Result<Question>> {
  return settle(dir, id, q => ({ ...q, status: "skipped", settledAt: now() }), null);
}

export async function closeQuestion(dir: string, id: string, reason: string): Promise<Result<Question>> {
  const why = clean(reason, limits.reason, "reason");
  if (!why.ok) return why;
  if (why.data.length === 0) return fail("close needs a reason");
  return settle(dir, id, q => ({ ...q, status: "closed", reason: why.data, settledAt: now() }), null);
}
