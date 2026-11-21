import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversation } from "../../core/conversations";
import { pluginData } from "../../core/bubbles";
import type { UiHost } from "../../core/plugins";
import plugin from "./index";
import ui from "./ui";
import { getQuestion } from "./store";

const home = mkdtempSync(join(tmpdir(), "orca2-questions-"));
beforeAll(() => { process.env.ORCA2_HOME = home; });
afterAll(() => { rmSync(home, { recursive: true, force: true }); });

const tool = plugin.tools[0]!.tool;
type Ctx = Parameters<typeof tool.run>[1];

async function setup() {
  const conversation = await createConversation(home, "q");
  const data = join(home, "conversations", conversation.id, "data");
  const ctx = { conversation: conversation.id, agent: "orchestrator", role: "orchestrator", data } as Ctx;
  const pctx = { plugin: "questions", conversation: conversation.id, agent: "orchestrator", role: "orchestrator" as const, branch: null, cwd: home,
    data: (scope: "conversation" | "bubble" | "global") => pluginData(conversation.id, "questions", scope) };
  return { ctx, pctx };
}

function host(pctx: Awaited<ReturnType<typeof setup>>["pctx"], answers: { pick: number | null; input: string | null; confirm: boolean }) {
  const said: string[] = [], notes: string[] = [];
  const h: UiHost = { ...pctx, note: t => { notes.push(t); }, confirm: async () => answers.confirm, input: async () => answers.input,
    pick: async () => answers.pick, say: async t => { said.push(t); }, open: async () => {} };
  return { h, said, notes };
}

const ids = (text: string): string[] => text.replace(/^queued \d+: /, "").split(", ");

test("ask queues at once, list shows open ones, the tab answers with an option and the count drops", async () => {
  const { ctx, pctx } = await setup();
  const out = String(await tool.run({ action: "ask", questions: [
    { text: "Which database?", options: ["sqlite", "postgres"], default: "sqlite" },
    { text: "Ship today?" },
  ] }, ctx));
  expect(out).toMatch(/^queued 2: q-/);
  const [db, ship] = ids(out) as [string, string];
  expect(String(await tool.run({ action: "list" }, ctx))).toContain("Which database? [options: sqlite | postgres] [suggested: sqlite]");
  expect(await ui.counts[0]!.count(pctx)).toBe(2);

  const tab = ui.tabs[0]!;
  const rows = await tab.rows(pctx);
  expect(rows.map(r => r.status)).toEqual(["open", "open"]);
  const { h, said } = host(pctx, { pick: 1, input: null, confirm: true });
  await tab.actions.find(a => a.key === "a")!.run(rows[0]!, h);
  expect(said).toEqual([`[${db}] postgres`]);
  expect((await getQuestion(await pctx.data("conversation"), db)).answer).toBe("postgres");
  expect(await ui.counts[0]!.count(pctx)).toBe(1);

  // A second answer is refused, nothing more is sent.
  const again = host(pctx, { pick: 0, input: null, confirm: true });
  await tab.actions.find(a => a.key === "a")!.run(rows[0]!, again.h);
  expect(again.said).toEqual([]);

  // Typed answer for a question without options; settled rows sort after open ones.
  const typed = host(pctx, { pick: null, input: "yes, after CI", confirm: true });
  await tab.actions.find(a => a.key === "a")!.run(rows[1]!, typed.h);
  expect(typed.said).toEqual([`[${ship}] yes, after CI`]);
  expect((await tab.details((await tab.rows(pctx))[0]!, pctx)).map(s => s.title)).toContain("Answer");
});

test("skip sends nothing and never applies the default; close refuses an answered question and quotes it", async () => {
  const { ctx, pctx } = await setup();
  const [a, b] = ids(String(await tool.run({ action: "ask", questions: [{ text: "Delete the cache?", default: "yes" }, { text: "Rename it?" }] }, ctx))) as [string, string];
  const tab = ui.tabs[0]!;
  const rows = await tab.rows(pctx);
  const declined = host(pctx, { pick: null, input: null, confirm: false });
  await tab.actions.find(x => x.key === "s")!.run(rows[0]!, declined.h);
  expect((await getQuestion(await pctx.data("conversation"), a)).status).toBe("open");
  const skip = host(pctx, { pick: null, input: null, confirm: true });
  await tab.actions.find(x => x.key === "s")!.run(rows[0]!, skip.h);
  const skipped = await getQuestion(await pctx.data("conversation"), a);
  expect([skipped.status, skipped.answer, skip.said.length]).toEqual(["skipped", null, 0]);

  const answer = host(pctx, { pick: null, input: "no", confirm: true });
  await tab.actions.find(x => x.key === "a")!.run(rows[1]!, answer.h);
  expect(String(await tool.run({ action: "close", ids: [b], reason: "answered in chat" }, ctx))).toBe(`not closed ${b}: question ${b} is already answered: no`);
  expect(String(await tool.run({ action: "close", ids: [b] }, ctx))).toBe("refused: close needs a short reason");
});

test("an answer after the orchestrator's close is still recorded and delivered once", async () => {
  const { ctx, pctx } = await setup();
  const [id] = ids(String(await tool.run({ action: "ask", questions: [{ text: "Use tabs?" }] }, ctx))) as [string];
  expect(String(await tool.run({ action: "close", ids: [id], reason: "outdated" }, ctx))).toBe(`closed ${id}`);
  const row = (await ui.tabs[0]!.rows(pctx))[0]!;
  const first = host(pctx, { pick: null, input: "spaces", confirm: true });
  await ui.tabs[0]!.actions.find(x => x.key === "a")!.run(row, first.h);
  expect(first.said).toEqual([`[${id}] spaces`]);
  const q = await getQuestion(await pctx.data("conversation"), id);
  expect([q.status, q.answer, q.reason]).toEqual(["answered", "spaces", "outdated"]);
  const second = host(pctx, { pick: null, input: "tabs", confirm: true });
  await ui.tabs[0]!.actions.find(x => x.key === "a")!.run(row, second.h);
  expect(second.said).toEqual([]);
});

test("a failed delivery rolls the answer back so it can be sent again", async () => {
  const { ctx, pctx } = await setup();
  const [id] = ids(String(await tool.run({ action: "ask", questions: [{ text: "Proceed?" }] }, ctx))) as [string];
  const row = (await ui.tabs[0]!.rows(pctx))[0]!;
  const broken = host(pctx, { pick: null, input: "go", confirm: true });
  broken.h.say = async () => { throw new Error("daemon down"); };
  await ui.tabs[0]!.actions.find(x => x.key === "a")!.run(row, broken.h);
  expect(broken.notes).toEqual(["not answered: daemon down"]);
  expect((await getQuestion(await pctx.data("conversation"), id)).status).toBe("open");
  const retry = host(pctx, { pick: null, input: "go", confirm: true });
  await ui.tabs[0]!.actions.find(x => x.key === "a")!.run(row, retry.h);
  expect(retry.said).toEqual([`[${id}] go`]);
});

test("bad input is refused; only the orchestrator asks; the fold lists question texts", async () => {
  const { ctx } = await setup();
  expect(String(await tool.run({ action: "ask", questions: [] }, ctx))).toBe("refused: ask needs questions");
  expect(String(await tool.run({ action: "ask", questions: [{ text: "x", options: ["only one"] }] }, ctx))).toBe("refused: question 1 needs 2 to 6 options, or none");
  expect(String(await tool.run({ action: "ask", questions: Array.from({ length: 5 }, () => ({ text: "x" })) }, ctx))).toBe("refused: at most 4 questions in one call");
  expect(String(await tool.run({ action: "ask", questions: [{ text: "a\u202eb" }] }, ctx))).toBe("refused: question 1 text has control or bidi characters");
  expect(String(await tool.run({ action: "list" }, { ...ctx, role: "worker" }))).toBe("refused: only the orchestrator asks the user");
  const input = { action: "ask", questions: [{ text: "A?" }, { text: "B?" }] };
  expect(ui.folds.ask!.items(input, { ok: true, text: "queued 2: q-1, q-2" })).toEqual(["A?", "B?"]);
  expect(ui.folds.ask!.items(input, { ok: true, text: "refused: no" })).toEqual([]);
  expect(ui.toolLines.ask!.label(input)).toBe("ask(A?)");
});
