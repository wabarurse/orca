// Questions live in $ORCA_DATA/questions/ (conversation scope), one <id>.json per question, written whole (temp file,
// then rename). A question settles once: the first of answer, skip or close takes the exclusive `<id>.settled` claim.
// The user's answer wins over the orchestrator's close: an answer to a closed question is still recorded and
// delivered once, under its own `<id>.answered` claim. Skip and close never deliver anything.
import { mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

export type Status = "open" | "answered" | "skipped" | "closed";
export type Question = {
  id: string;
  text: string;
  options: string[];
  /** Only a suggestion the user may answer with; never applied by skip, close or silence. */
  default: string | null;
  status: Status;
  answer: string | null;
  /** Why the orchestrator closed it (answered in chat, outdated); null otherwise. */
  reason: string | null;
  askedAt: string;
  settledAt: string | null;
};
export type NewQuestion = { text: string; options: string[]; default: string | null };

export const limits = { questions: 4, text: 500, option: 100, minOptions: 2, maxOptions: 6, reason: 200, answer: 2000, close: 20 };

const ID = /^q-[a-z0-9]+-[a-z0-9]{6}$/;
const STATUSES: Status[] = ["open", "answered", "skipped", "closed"];

/** Trim, turn newlines and tabs into spaces, refuse control and bidi characters and over-long text. */
export function clean(value: unknown, max: number, what: string): string {
  const text = (typeof value === "string" ? value : "").replace(/[\r\n\t]+/g, " ").trim();
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(text)) throw new Error(`${what} has control or bidi characters`);
  if (text.length > max) throw new Error(`${what} is over ${max} characters`);
  return text;
}

/** Untrusted tool input into questions; throws a readable reason. */
export function cleanQuestions(raw: unknown): NewQuestion[] {
  const list: unknown[] = Array.isArray(raw) ? raw : [];
  if (list.length === 0) throw new Error("ask needs questions");
  if (list.length > limits.questions) throw new Error(`at most ${limits.questions} questions in one call`);
  return list.map((item, i) => {
    const r = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    const what = `question ${i + 1}`;
    const text = clean(r.text, limits.text, `${what} text`);
    if (text.length === 0) throw new Error(`${what} needs text`);
    const given = Array.isArray(r.options) ? r.options : [];
    const options = [...new Set(given.map(o => clean(o, limits.option, `${what} option`)).filter(o => o.length > 0))];
    if (options.length > 0 && (options.length < limits.minOptions || options.length > limits.maxOptions)) throw new Error(`${what} needs ${limits.minOptions} to ${limits.maxOptions} options, or none`);
    const suggested = clean(r.default, limits.option, `${what} default`);
    return { text, options, default: suggested.length > 0 ? suggested : null };
  });
}

const file = (dir: string, id: string): string => join(dir, `${id}.json`);

async function write(dir: string, q: Question): Promise<void> {
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${q.id}.${crypto.randomUUID().slice(0, 8)}.tmp`);
  try {
    await Bun.write(tmp, JSON.stringify(q, null, 2) + "\n");
    await rename(tmp, file(dir, q.id));
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

function checked(raw: unknown, name: string): Question {
  const q = raw as Question;
  const str = (v: unknown): boolean => typeof v === "string";
  const strOrNull = (v: unknown): boolean => v === null || typeof v === "string";
  if (typeof q !== "object" || q === null || !str(q.id) || `${q.id}.json` !== name || !str(q.text) || !STATUSES.includes(q.status)
    || !Array.isArray(q.options) || !q.options.every(str) || !strOrNull(q.default) || !strOrNull(q.answer) || !strOrNull(q.reason)
    || !str(q.askedAt) || !strOrNull(q.settledAt)) throw new Error(`invalid question record ${name}`);
  return q;
}

/** Every question, oldest first. A malformed record fails loudly rather than vanish from the count. */
export async function allQuestions(dir: string): Promise<Question[]> {
  const names = (await readdir(dir).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return []; throw e; }))
    .filter(n => n.endsWith(".json") && !n.startsWith(".")).sort();
  const out: Question[] = [];
  for (const name of names) {
    try { out.push(checked(await Bun.file(join(dir, name)).json(), name)); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  return out.sort((a, b) => a.askedAt.localeCompare(b.askedAt) || a.id.localeCompare(b.id));
}

export async function openQuestions(dir: string): Promise<Question[]> {
  return (await allQuestions(dir)).filter(q => q.status === "open");
}

export async function getQuestion(dir: string, id: string): Promise<Question> {
  if (!ID.test(id)) throw new Error(`no question ${id}`);
  const f = Bun.file(file(dir, id));
  if (!await f.exists()) throw new Error(`no question ${id}`);
  return checked(await f.json(), `${id}.json`);
}

/** Strictly increasing within a process, so questions asked in one call keep their order. */
let lastAsked = 0;

/** Append questions in order; returns them with their ids. Never waits for an answer. */
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

/** An exclusive claim file; false when another settle already holds it. */
async function claim(path: string): Promise<boolean> {
  try { await (await open(path, "wx")).close(); return true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") return false; throw e; }
}

/** Settle an open question under the `settled` claim (or a closed one under the `answered` claim, for an answer).
 * `deliver` runs after the record is written; if it throws, the record and claim are rolled back. */
async function settle(dir: string, id: string, next: (q: Question) => Question, deliver: ((q: Question) => Promise<void>) | null): Promise<Question> {
  const q = await getQuestion(dir, id);
  const answering = deliver !== null;
  let kind: "settled" | "answered";
  if (q.status === "open") kind = "settled";
  else if (q.status === "closed" && answering) kind = "answered";
  else throw new Error(q.status === "answered" ? `question ${id} is already answered: ${q.answer ?? ""}` : `question ${id} is already ${q.status}`);
  const lock = join(dir, `${id}.${kind}`);
  if (!await claim(lock)) {
    const now = await getQuestion(dir, id);
    if (now.status === "answered") throw new Error(`question ${id} is already answered: ${now.answer ?? ""}`);
    if (now.status === "closed" && answering) return settle(dir, id, next, deliver);
    throw new Error(`question ${id} is already being settled`);
  }
  const settled = next(q);
  let written = false;
  try {
    await write(dir, settled);
    written = true;
    if (deliver !== null) await deliver(settled);
  } catch (e) {
    if (written) await write(dir, q);
    await unlink(lock).catch(() => {});
    throw e;
  }
  return settled;
}

const now = (): string => new Date().toISOString();

/** The user's answer: recorded, then delivered once by `deliver` (the TUI sends it to the orchestrator). */
export async function answerQuestion(dir: string, id: string, text: string, deliver: (q: Question) => Promise<void>): Promise<Question> {
  const answer = clean(text, limits.answer, "answer");
  if (answer.length === 0) throw new Error("empty answer");
  return settle(dir, id, q => ({ ...q, status: "answered", answer, settledAt: now() }), deliver);
}

/** The user's skip: recorded, nothing sent, the default never applied. */
export async function skipQuestion(dir: string, id: string): Promise<Question> {
  return settle(dir, id, q => ({ ...q, status: "skipped", settledAt: now() }), null);
}

/** The orchestrator's close (answered in chat, outdated): recorded with its reason, no answer, nothing sent. */
export async function closeQuestion(dir: string, id: string, reason: string): Promise<Question> {
  const why = clean(reason, limits.reason, "reason");
  if (why.length === 0) throw new Error("close needs a reason");
  return settle(dir, id, q => ({ ...q, status: "closed", reason: why, settledAt: now() }), null);
}
