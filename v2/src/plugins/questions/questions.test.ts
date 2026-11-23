import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversation } from "../../core/conversations";
import type { PluginContext, Row, TabAction } from "../../core/plugins";
import { item, pluginContext, present, recordingHost, toolContext, unwrap, type HostAnswers } from "../../core/plugins/testing";
import plugin from "./index";
import ui from "./ui";
import { getQuestion } from "./store";

const home = mkdtempSync(join(tmpdir(), "orca2-questions-"));
const tool = item(plugin.tools, 0).tool;
const tab = item(ui.tabs, 0);
const count = item(ui.counts, 0);

async function setup() {
  const conversation = await createConversation(home, "q");
  return { ctx: toolContext(conversation.id, home), pctx: pluginContext(conversation.id, "questions", home) };
}

const action = (key: string): TabAction => present(tab.actions.find(a => a.key === key), `action ${key}`);
const ids = (text: string): string[] => text.replace(/^queued \d+: /, "").split(", ");
const ask = async (input: Record<string, unknown>, ctx: Awaited<ReturnType<typeof setup>>["ctx"]): Promise<string> => String(await tool.run(input, ctx));

async function question(pctx: PluginContext, id: string) {
  return unwrap(await getQuestion(unwrap(await pctx.data("conversation")), id));
}

async function act(key: string, row: Row, pctx: PluginContext, answers: HostAnswers) {
  const recorded = recordingHost(pctx, answers);
  await action(key).run(row, recorded.host);
  return recorded;
}

test("ask queues at once, list shows open ones, the tab answers with an option and the count drops", async () => {
  const { ctx, pctx } = await setup();
  const out = await ask({ action: "ask", questions: [
    { text: "Which database?", options: ["sqlite", "postgres"], default: "sqlite" },
    { text: "Ship today?" },
  ] }, ctx);
  expect(out).toMatch(/^queued 2: q-/);
  const queued = ids(out);
  const db = item(queued, 0), ship = item(queued, 1);
  expect(await ask({ action: "list" }, ctx)).toContain("Which database? [options: sqlite | postgres] [suggested: sqlite]");
  expect(await count.count(pctx)).toBe(2);

  const rows = await tab.rows(pctx);
  expect(rows.map(r => r.status)).toEqual(["open", "open"]);
  const first = await act("enter", item(rows, 0), pctx, { pick: 1, input: null, confirm: true });
  expect(first.said).toEqual([`[${db}] postgres`]);
  expect((await question(pctx, db)).answer).toBe("postgres");
  expect(await count.count(pctx)).toBe(1);

  const again = await act("enter", item(rows, 0), pctx, { pick: 0, input: null, confirm: true });
  expect(again.said).toEqual([]);

  const typed = await act("enter", item(rows, 1), pctx, { pick: null, input: "yes, after CI", confirm: true });
  expect(typed.said).toEqual([`[${ship}] yes, after CI`]);
  expect((await tab.details(item(await tab.rows(pctx), 0), pctx)).map(s => s.title)).toContain("Answer");
});

test("skip sends nothing and never applies the default; close refuses an answered question and quotes it", async () => {
  const { ctx, pctx } = await setup();
  const queued = ids(await ask({ action: "ask", questions: [{ text: "Delete the cache?", default: "yes" }, { text: "Rename it?" }] }, ctx));
  const a = item(queued, 0), b = item(queued, 1);
  const rows = await tab.rows(pctx);
  await act("s", item(rows, 0), pctx, { pick: null, input: null, confirm: false });
  expect((await question(pctx, a)).status).toBe("open");
  const skip = await act("s", item(rows, 0), pctx, { pick: null, input: null, confirm: true });
  const skipped = await question(pctx, a);
  expect([skipped.status, skipped.answer, skip.said.length]).toEqual(["skipped", null, 0]);

  await act("enter", item(rows, 1), pctx, { pick: null, input: "no", confirm: true });
  expect(await ask({ action: "close", ids: [b], reason: "answered in chat" }, ctx)).toBe(`not closed ${b}: question ${b} is already answered: no`);
  expect(await ask({ action: "close", ids: [b] }, ctx)).toBe("refused: close needs a short reason");
});

test("an answer after the orchestrator's close is still recorded and delivered once", async () => {
  const { ctx, pctx } = await setup();
  const id = item(ids(await ask({ action: "ask", questions: [{ text: "Use tabs?" }] }, ctx)), 0);
  expect(await ask({ action: "close", ids: [id], reason: "outdated" }, ctx)).toBe(`closed ${id}`);
  const row = item(await tab.rows(pctx), 0);
  const first = await act("enter", row, pctx, { pick: null, input: "spaces", confirm: true });
  expect(first.said).toEqual([`[${id}] spaces`]);
  const q = await question(pctx, id);
  expect([q.status, q.answer, q.reason]).toEqual(["answered", "spaces", "outdated"]);
  const second = await act("enter", row, pctx, { pick: null, input: "tabs", confirm: true });
  expect(second.said).toEqual([]);
});

test("a failed delivery rolls the answer back so it can be sent again", async () => {
  const { ctx, pctx } = await setup();
  const id = item(ids(await ask({ action: "ask", questions: [{ text: "Proceed?" }] }, ctx)), 0);
  const row = item(await tab.rows(pctx), 0);
  const broken = recordingHost(pctx, { pick: null, input: "go", confirm: true });
  broken.host.say = async () => { throw new Error("daemon down"); };
  await action("enter").run(row, broken.host);
  expect(broken.notes).toEqual(["not answered: daemon down"]);
  expect((await question(pctx, id)).status).toBe("open");
  const retry = await act("enter", row, pctx, { pick: null, input: "go", confirm: true });
  expect(retry.said).toEqual([`[${id}] go`]);
});

test("bad input is refused; only the orchestrator asks; the fold lists question texts", async () => {
  const { ctx } = await setup();
  expect(await ask({ action: "ask", questions: [] }, ctx)).toBe("refused: ask needs questions");
  expect(await ask({ action: "ask", questions: [{ text: "x", options: ["only one"] }] }, ctx)).toBe("refused: question 1 needs 2 to 6 options, or none");
  expect(await ask({ action: "ask", questions: Array.from({ length: 5 }, () => ({ text: "x" })) }, ctx)).toBe("refused: at most 4 questions in one call");
  expect(await ask({ action: "ask", questions: [{ text: "a\u202eb" }] }, ctx)).toBe("refused: question 1 text has control or bidi characters");
  expect(await ask({ action: "list" }, { ...ctx, role: "worker" })).toBe("refused: only the orchestrator asks the user");
  const input = { action: "ask", questions: [{ text: "A?" }, { text: "B?" }] };
  const fold = present(ui.folds.ask, "ask fold"), line = present(ui.toolLines.ask, "ask line");
  expect(fold.items(input, { ok: true, text: "queued 2: q-1, q-2" })).toEqual(["A?", "B?"]);
  expect(fold.items(input, { ok: true, text: "refused: no" })).toEqual([]);
  expect(line.label(input)).toBe("ask(A?)");
});
