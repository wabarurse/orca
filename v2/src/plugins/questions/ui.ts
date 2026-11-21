// The Questions tab (Ctrl+Q): open questions first, then settled ones. `a` answers (a pick over the options plus
// "Other…", or typed text), sending `[<id>] <answer>` to the orchestrator; `s` skips after a confirm, sending nothing.
import { defineUi, type PluginContext, type PluginUi, type Row, type UiHost } from "../../core/plugins";
import { allQuestions, answerQuestion, getQuestion, openQuestions, skipQuestion, type Question } from "./store";

const dir = (ctx: PluginContext): Promise<string> => ctx.data("conversation");
const TONE = { open: "warn", answered: "good", skipped: "dim", closed: "dim" } as const;

function row(q: Question): Row {
  const info = q.status === "answered" ? `→ ${q.answer ?? ""}` : q.status === "closed" ? q.reason ?? "" : q.askedAt.slice(0, 16).replace("T", " ");
  return { id: q.id, name: q.text, status: q.status, info, tone: TONE[q.status] };
}

/** What the user answers: a picked option, or typed text ("Other…", or a question without options); null cancels. */
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

const message = (e: unknown): string => e instanceof Error ? e.message : String(e);

const ui: PluginUi = defineUi({
  tabs: [{
    id: "questions",
    title: "Questions",
    chord: "q",
    rows: async ctx => {
      const all = await allQuestions(await dir(ctx));
      const settled = all.filter(q => q.status !== "open").sort((a, b) => (b.settledAt ?? "").localeCompare(a.settledAt ?? ""));
      return [...all.filter(q => q.status === "open"), ...settled].map(row);
    },
    details: async (r, ctx) => {
      const q = (await allQuestions(await dir(ctx))).find(x => x.id === r.id);
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
          const folder = await dir(host);
          try {
            const q = await getQuestion(folder, r.id);
            if (q.status === "answered" || q.status === "skipped") { host.note(`${q.id} is already ${q.status}`); return; }
            const answer = await chooseAnswer(q, host);
            if (answer === null) return;
            await answerQuestion(folder, q.id, answer, async settled => { await host.say(`[${settled.id}] ${settled.answer ?? answer}`); });
            host.note(`answered ${q.id}`);
          } catch (e) { host.note(`not answered: ${message(e)}`); }
        },
      },
      {
        key: "s", label: "skip",
        run: async (r, host) => {
          if (r === null || r.status !== "open") return;
          if (!await host.confirm(`skip "${r.name.slice(0, 60)}"? nothing is sent and the default is not applied`)) return;
          try { await skipQuestion(await dir(host), r.id); host.note(`skipped ${r.id}`); }
          catch (e) { host.note(`not skipped: ${message(e)}`); }
        },
      },
    ],
  }],
  counts: [{ id: "questions", count: async ctx => (await openQuestions(await dir(ctx))).length, label: n => `${n} question${n === 1 ? "" : "s"}` }],
  commands: [],
  toolLines: {
    ask: {
      label: input => {
        if (input.action === "list") return "ask(list)";
        if (input.action === "close") return `ask(close ${Array.isArray(input.ids) ? input.ids.length : 0})`;
        const first = Array.isArray(input.questions) ? (input.questions[0] as { text?: unknown } | undefined)?.text : undefined;
        return `ask(${typeof first === "string" ? first.slice(0, 50) : ""})`;
      },
      summary: o => ({ summary: o.text.split("\n")[0] ?? "", failed: !o.ok || o.text.startsWith("refused") }),
    },
  },
  folds: {
    ask: {
      title: n => `${n} question${n === 1 ? "" : "s"}`,
      items: (input, o) => input.action === "ask" && o.ok && o.text.startsWith("queued") && Array.isArray(input.questions)
        ? input.questions.map(q => (q as { text?: unknown }).text).filter((t): t is string => typeof t === "string")
        : [],
      opens: "questions",
    },
  },
});

export default ui;
