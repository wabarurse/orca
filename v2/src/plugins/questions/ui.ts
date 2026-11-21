import { asRecord, fail, ok, type Result } from "../../config";
import { settled } from "../../core/tools/registry";
import { defineUi, type PluginContext, type PluginUi, type Row, type Tone, type UiHost } from "../../core/plugins";
import { allQuestions, answerQuestion, getQuestion, openQuestions, skipQuestion, type Question, type Status } from "./store";

const TONE: Record<Status, Tone> = { open: "warn", answered: "good", skipped: "dim", closed: "dim" };

async function shown(ctx: PluginContext): Promise<Question[]> {
  const dir = await ctx.data("conversation");
  return settled(dir.ok ? await allQuestions(dir.data) : dir);
}

const questionText = (value: unknown): unknown => asRecord(value)?.text;

function row(q: Question): Row {
  const info = q.status === "answered" ? `→ ${q.answer ?? ""}` : q.status === "closed" ? q.reason ?? "" : q.askedAt.slice(0, 16).replace("T", " ");
  return { id: q.id, name: q.text, status: q.status, info, tone: TONE[q.status] };
}

async function chooseAnswer(q: Question, host: UiHost): Promise<string | null> {
  const prompt = q.default !== null ? `${q.text} (suggested: ${q.default})` : q.text;
  if (q.options.length > 0) {
    const index = await host.pick(q.text, [...q.options, "Other…"]);
    if (index === null) return null;
    if (index < q.options.length) return q.options[index] ?? null;
  }
  const typed = await host.input(prompt, "");
  return typed === null || typed.trim().length === 0 ? null : typed;
}

async function answer(r: Row, host: UiHost): Promise<string> {
  const folder = await host.data("conversation");
  if (!folder.ok) return `not answered: ${folder.error}`;
  const found = await getQuestion(folder.data, r.id);
  if (!found.ok) return `not answered: ${found.error}`;
  const q = found.data;
  if (q.status === "answered" || q.status === "skipped") return `${q.id} is already ${q.status}`;
  const chosen = await chooseAnswer(q, host);
  if (chosen === null) return "";
  const answered = await answerQuestion(folder.data, q.id, chosen, async done => { await host.say(`[${done.id}] ${done.answer ?? chosen}`); });
  return answered.ok ? `answered ${q.id}` : `not answered: ${answered.error}`;
}

async function skip(r: Row, host: UiHost): Promise<Result<string>> {
  const folder = await host.data("conversation");
  if (!folder.ok) return fail(folder.error);
  const skipped = await skipQuestion(folder.data, r.id);
  return skipped.ok ? ok(`skipped ${r.id}`) : skipped;
}

const ui: PluginUi = defineUi({
  tabs: [{
    id: "questions",
    title: "Questions",
    chord: "q",
    rows: async ctx => {
      const all = await shown(ctx);
      const closed = all.filter(q => q.status !== "open").sort((a, b) => (b.settledAt ?? "").localeCompare(a.settledAt ?? ""));
      return [...all.filter(q => q.status === "open"), ...closed].map(row);
    },
    details: async (r, ctx) => {
      const q = (await shown(ctx)).find(x => x.id === r.id);
      if (q === undefined) return [];
      const sections = [{ title: "Question", lines: [q.text, `${q.id} · asked ${q.askedAt} · ${q.status}`] }];
      if (q.options.length > 0) sections.push({ title: "Options", lines: q.options.map((o, i) => `${i + 1}. ${o}`) });
      if (q.default !== null) sections.push({ title: "Suggested", lines: [`${q.default} (only applied if you choose it)`] });
      if (q.answer !== null) sections.push({ title: "Answer", lines: [q.answer] });
      if (q.reason !== null) sections.push({ title: "Closed by the orchestrator", lines: [q.reason] });
      return sections;
    },
    actions: [
      {
        key: "a", label: "answer",
        run: async (r, host) => {
          if (r === null) return;
          const note = await answer(r, host);
          if (note.length > 0) host.note(note);
        },
      },
      {
        key: "s", label: "skip",
        run: async (r, host) => {
          if (r === null || r.status !== "open") return;
          if (!await host.confirm(`skip "${r.name.slice(0, 60)}"? nothing is sent and the default is not applied`)) return;
          const skipped = await skip(r, host);
          host.note(skipped.ok ? skipped.data : `not skipped: ${skipped.error}`);
        },
      },
    ],
  }],
  counts: [{ id: "questions", count: async ctx => {
    const dir = await ctx.data("conversation");
    const open = dir.ok ? await openQuestions(dir.data) : dir;
    return open.ok ? open.data.length : null;
  }, label: n => `${n} question${n === 1 ? "" : "s"}` }],
  commands: [],
  toolLines: {
    ask: {
      label: input => {
        if (input.action === "list") return "ask(list)";
        if (input.action === "close") return `ask(close ${Array.isArray(input.ids) ? input.ids.length : 0})`;
        const first: unknown = Array.isArray(input.questions) ? questionText(input.questions[0]) : undefined;
        return `ask(${typeof first === "string" ? first.slice(0, 50) : ""})`;
      },
      summary: o => ({ summary: o.text.split("\n")[0] ?? "", failed: !o.ok || o.text.startsWith("refused") }),
    },
  },
  folds: {
    ask: {
      title: n => `${n} question${n === 1 ? "" : "s"}`,
      items: (input, o) => input.action === "ask" && o.ok && o.text.startsWith("queued") && Array.isArray(input.questions)
        ? input.questions.map(questionText).filter((t): t is string => typeof t === "string")
        : [],
      opens: "questions",
    },
  },
});

export default ui;
