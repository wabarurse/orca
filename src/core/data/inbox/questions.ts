import { inputEpoch } from "./user-input";
// The orchestrator's questions for the user: a durable FIFO queue under
// questions/, one file per question, named like inbox messages so a sorted
// listing is ask order. Unlike the inbox, files stay after they are answered
// or skipped; the status field records it. The answer travels back to the
// orchestrator as an ordinary inbox message from "user". Skips (the user's
// Skip or delete) and the orchestrator's withdrawals (a question answered in
// chat or outdated, with a reason) are durable dismissals only: no reply,
// default application or agent wakeup. A user's answer wins over a withdrawal.

import { mkdirSync } from "node:fs";
import { open, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../../../config";
import { put } from "./inbox";
import { limits, type NewQuestion, type Question } from "../../../protocol";

/** Trim, turn newlines and tabs into spaces, refuse control, line-separator and bidi characters and over-long text. */
export function clean(value: string, max: number, what: string): string {
  const s = value.replace(/[\r\n\t]+/g, " ").trim();
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(s)) throw new Error(`${what} has control or bidi characters`);
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
  try {
    await Bun.write(tmp, JSON.stringify(q) + "\n");
    await rename(tmp, file(project, q.id));
  } finally {
    await unlink(tmp).catch(() => {});
  }
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

/** Validate both listing and closing; malformed records must never be rewritten. */
function checkedQuestion(raw: unknown, name: string): Question {
  const q = raw as Question;
  if (!q || typeof q.id !== "string" || `${q.id}.json` !== name || typeof q.text !== "string" || typeof q.ts !== "string"
    || !["open", "answered", "skipped"].includes(q.status)
    || (q.options !== undefined && (!Array.isArray(q.options) || q.options.some(o => typeof o !== "string")))
    || (q.default !== undefined && typeof q.default !== "string")
    || (q.answer !== undefined && typeof q.answer !== "string")
    || (q.reason !== undefined && typeof q.reason !== "string")) throw new Error(`invalid question record: ${name}`);
  return q;
}

/** Every question, oldest first. Reads every file on each call: answered and
 * skipped files are kept as history, so this grows with the project. */
export async function all(project: string): Promise<Question[]> {
  const names = (await readdir(paths.questions(project)).catch(err => { if (err.code === "ENOENT") return []; throw err; })).filter((n) => n.endsWith(".json")).sort();
  const out: Question[] = [];
  for (const name of names) {
    try {
      const q = checkedQuestion(await Bun.file(join(paths.questions(project), name)).json(), name);
      out.push(q);
    } catch (err) {
      // A disappearing file may have been removed with the project. Other
      // failures must reach the UI, not fabricate a zero unanswered badge.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return out;
}

/** Open questions, oldest first. */
export async function list(project: string): Promise<Question[]> {
  return (await all(project)).filter((q) => q.status === "open");
}

/** One validated record; a bad id or a missing record is refused before any claim. */
async function load(project: string, id: string): Promise<Question> {
  if (!/^[\w.-]+$/.test(id) || id.includes("..")) throw new Error(`bad question id ${id}`);
  const f = Bun.file(file(project, id));
  if (!(await f.exists())) throw new Error(`no question ${id}`);
  return checkedQuestion(await f.json(), `${id}.json`);
}

/** An exclusive claim file, so two concurrent closes can't both pass the status check. False when another holds it. */
async function claim(path: string): Promise<boolean> {
  try {
    await (await open(path, "wx")).close();
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
}

const claimFile = (project: string, id: string, kind: "closed" | "answered") => join(paths.questions(project), `${id}.${kind}`);

/** Withdrawn by the orchestrator (a reason, no answer): the one closed state a user's answer may still settle. */
const withdrawn = (q: Question) => q.status === "skipped" && q.reason !== undefined;

/** How one close settles: an explicit answer (the only delivery payload), the orchestrator's reason, or neither (the user's Skip or delete). */
interface Settle { reply?: { answer: string; userEpoch: string; inputId?: string }; reason?: string }

/** How long a close waits for a competing close it lost the claim to, to see how that ended. */
const SETTLE_WAIT_MS = 2000;
const SETTLE_POLL_MS = 25;

/** Write `next` under the held claim and deliver an answer. On write or delivery
 * failure restore `q` before releasing the claim. If rollback itself fails,
 * retain the claim rather than allow duplicate delivery. */
async function persist(project: string, q: Question, next: Question, lock: string, reply?: Settle["reply"]): Promise<Question> {
  let written = false;
  try {
    await write(project, next);
    written = true;
    if (reply) await put(project, "orchestrator", {
      from: "user", text: `[${q.id}] answer to "${q.text}": ${reply.answer}`, userEpoch: reply.userEpoch,
      ...(reply.inputId ? { inputId: reply.inputId } : {}),
    });
  } catch (e) {
    if (written) await write(project, q);
    await unlink(lock);
    throw e;
  }
  return next;
}

/** Close an open question under the exclusive claim. Dismissal (Skip, delete,
 * withdrawal) never touches inboxes or input epochs. The user's answer wins over
 * the orchestrator's withdrawal either way round: a withdrawal finding it answered
 * is refused, and an answer finding it withdrawn (now, or once the close it lost
 * the claim to ends) is still recorded and delivered, under its own claim. */
async function close(project: string, id: string, how: Settle): Promise<Question> {
  const lock = claimFile(project, id, "closed");
  const until = Date.now() + SETTLE_WAIT_MS;
  for (;;) {
    const q = await load(project, id);
    if (q.status !== "open") {
      if (how.reply && withdrawn(q)) return answerWithdrawn(project, q, how.reply);
      throw new Error(`question ${id} is already ${q.status}`);
    }
    if (await claim(lock)) {
      const next: Question = { ...q, status: how.reply ? "answered" : "skipped" };
      if (how.reply) next.answer = how.reply.answer;
      else if (how.reason !== undefined) next.reason = how.reason;
      return persist(project, q, next, lock, how.reply);
    }
    // Another close holds the claim: wait briefly to see how it ends (an answer
    // may still settle a withdrawal; a withdrawal reports the user's answer).
    if (Date.now() > until) throw new Error(`question ${id} is already closed`);
    await Bun.sleep(SETTLE_POLL_MS);
  }
}

/** The user's answer to a question the orchestrator withdrew: recorded and delivered once (the "answered" claim), keeping the withdrawal reason as history. */
async function answerWithdrawn(project: string, q: Question, reply: NonNullable<Settle["reply"]>): Promise<Question> {
  const lock = claimFile(project, q.id, "answered");
  if (!(await claim(lock))) throw new Error(`question ${q.id} is already answered`);
  return persist(project, q, { ...q, status: "answered", answer: reply.answer }, lock, reply);
}

/** Answer an open question and tell the orchestrator. An optional inputId
 * identifies the delivered message at consumption, like a typed prompt's. */
export async function answer(project: string, id: string, text: string, inputId?: string): Promise<Question> {
  const a = clean(text, limits.answer, "answer");
  if (!a) throw new Error("empty answer");
  return close(project, id, { reply: { answer: a, userEpoch: inputEpoch(project), inputId } });
}

/** Silently remove an open question from Inbox, retaining its skipped history:
 * the user's Skip and delete. A stored default is only a suggestion, never an
 * implicit answer or approval. */
export async function skip(project: string, id: string): Promise<Question> {
  return close(project, id, {});
}

/** The orchestrator closes one of its open questions (answered in chat, or
 * outdated): skipped with its reason, no reply message, no answer invented. */
export async function withdraw(project: string, id: string, reason: string): Promise<Question> {
  const r = clean(reason, limits.reason, "reason");
  if (!r) throw new Error("a close needs a reason");
  return close(project, id, { reason: r });
}
