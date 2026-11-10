import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, parseCommand, type AppDeps } from "../app";
import { taskInboxPanel, statusRows, type Frame } from "./render";
import { visibleLength } from "../components/text";
import { chapterRows, headerHeight } from "../header/chrome";
import { stickyRows, stickyUpdate } from "../screen/sticky";
import { FakeScreen } from "../components/testing";
import { Calls } from "../conversation/tools";
import type { Terminal } from "../components/term";
import type { Orchestrator } from "../../core/agent-loop/orc/orchestrator";
import { drain, pendingInput } from "../../core/data/inbox/inbox";
import type { Message } from "../../protocol/inbox";
import { fileStore, type QuestionStore } from "./questions";
import { paths, saveConfig } from "../../config/config";
import { ask, all as allQuestions } from "../../core/data/inbox/questions";
import type { Question } from "../../protocol/questions";
import { archiveMergedTasks, getTask, listTasks, observeTaskPR, prepareTaskRun, registerTask, setTaskAttention, startTaskRun, stopTaskRun } from "../../core/data/tasks/tasks";
import { taskStatuses, type TaskPR, type TaskRow } from "../../protocol/task/tasks";

const plain = (lines: string[]) => lines.map(line => Bun.stripANSI(line).trimEnd()).join("\n");
function deferred<T>() { let resolve!: (v: T) => void, reject!: (e: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const previous = process.env.ORCA_HOME;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); process.env.ORCA_HOME = previous; });
async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
}
async function setup(extra: Partial<AppDeps> = {}) {
  const home = mkdtempSync(join(tmpdir(), "task-inbox-ui-"));
  process.env.ORCA_HOME = home;
  await saveConfig({ model: "fake-model" });
  const screen = new FakeScreen(100, 28);
  let resize = () => {}, turns = 0, cancelled = 0, closed = false, exit = "";
  const sent: { project: string; text: string; inputId?: string }[] = [];
  const receive = new Map<string, (msgs: Message[]) => void>();
  const term: Terminal = { cols: 100, rows: 28, open() {}, close() { closed = true; }, eraseOnExit() {}, onKey() {}, onResize(cb) { resize = cb; }, write(s) { screen.write(s); if (closed) exit += s; } };
  const app = new App({ term, pollMs: 100_000, projectModel: async () => "fake-model", agents: async () => [], watchdog: async () => {}, merges: async () => {}, questionDelayMs: 0, taskCount: async () => [],
    projects: { live: async () => [], kill: async () => {} },
    openOrchestrator: async (project, _url, _write, inbox) => {
      mkdirSync(paths.repo(project), { recursive: true });
      if (inbox) receive.set(project, inbox);
      return { entries: () => [], pending: async () => false, turn: async () => { turns++; return []; }, say: async (text: string, _submission?: string, inputId?: string) => { sent.push({ project, text, inputId }); }, cancel: () => { cancelled++; } } as unknown as Orchestrator;
    }, ...extra });
  const running = app.run("a");
  await until(() => !!app.page);
  cleanups.push(async () => { app.quit(); await running; for (const p of app.pages) await p.savingHistory; rmSync(home, { recursive: true, force: true }); });
  return { app, screen, term, receive, sent, running, calls: () => ({ turns, cancelled }), exit: () => exit,
    // Drive the existing poll's watchers deterministically, without another timer.
    poll: () => (app as unknown as { watchPages(): void }).watchPages(),
    resize(cols: number, rows: number) { term.cols = cols; term.rows = rows; screen.resize(cols, rows); resize(); } };
}
const text = (app: App) => plain(app.frame().inbox?.lines ?? []);

const syntheticQuestion = (id = "q"): Question => ({ id, text: `Question ${id}?`, status: "open", ts: "2026-01-01T00:00:00Z" });
const fakeQuestions = (changes: Partial<QuestionStore> = {}): QuestionStore => ({
  stamp: async () => NaN, list: async () => [],
  answer: async () => { throw new Error("unexpected answer"); }, skip: async () => { throw new Error("unexpected skip"); }, ...changes,
});


async function toggleAnswer(app: App) {
  if (app.page?.questions.expanded) await app.onKey({ name: "escape" });
  else await app.questions.command(app.page);
}

test("question load/error states never fabricate zero; retry and external closure preserve chat and report the orphan answer safely", async () => {
  let fail = true, open = [syntheticQuestion()];
  const malicious = "bad\x1b]0;owned\x07\x1b[31mred\x1b[0m\u202e";
  const ui = await setup({ questions: fakeQuestions({ list: async () => { if (fail) throw new Error(malicious); return open; } }) }), { app } = ui;
  const chat = { text: "keep chat", cursor: 2 }; app.input = { ...chat }; app.draw();
  await app.questions.command(app.page);
  expect(app.status(app.page!)).toContain("? questions |");
  const panel = plain(taskInboxPanel(app.frame()).rows);
  expect(panel).toContain("questions unavailable"); expect(panel).not.toContain("No open questions");
  expect(taskInboxPanel(app.frame()).rows.join("")).not.toMatch(/\x1b\]|\x1b\[31m|\u202e/);
  await app.onKey({ name: "enter" }); expect(app.input).toEqual(chat);
  fail = false; await app.questions.command(app.page);
  expect(app.status(app.page!)).toContain("1 questions |");
  app.input = { text: "orphan\x1b]0;owned\x07\u202e", cursor: 4 }; app.draw();
  fail = true; app.questions.poll(app.pages); await app.page!.questions.polling;
  expect(app.status(app.page!)).toContain("? questions |");
  expect(plain(taskInboxPanel(app.frame()).rows)).toContain("questions unavailable");
  fail = false; open = []; app.questions.poll(app.pages); await app.page!.questions.polling;
  expect(app.input).toEqual(chat); expect(app.frame().inbox).toBeNull();
  expect(plain(app.frame().inputArea!.lines)).toContain("unsent answer: orphan");
  expect(JSON.stringify(app.page!.lines)).not.toContain("owned");
  expect(app.status(app.page!)).toContain("0 questions |");
});

test("in-flight answer stays single-flight across polls/sections; errors retain the answer and never consume queued prompts", async () => {
  const gate = deferred<void>(); let attempts = 0;
  const ui = await setup({ tasks: async () => [], questions: { ...fileStore, answer: async () => { attempts++; await gate.promise; } } }), { app } = ui;
  await ask("a", [{ text: "Pending?" }]);
  const chat = { text: "chat", cursor: 1 }, answer = { text: "typed answer", cursor: 6 };
  app.input = { ...chat }; await app.questions.command(app.page);
  app.input = { ...answer }; app.draw(); app.page!.sent.push({ inputId: "exact", text: "pending prompt" });
  const closing = app.onKey({ name: "enter" });
  expect(plain(taskInboxPanel(app.frame()).rows)).toContain("sending answer");
  await app.onKey({ name: "enter" }); await app.onKey({ name: "char", text: "not inserted" });
  expect(attempts).toBe(1); expect(app.input).toEqual(answer);
  await toggleAnswer(app); expect(app.input).toEqual(chat);
  app.questions.poll(app.pages); await app.page!.questions.polling;
  gate.reject(new Error("write failed\x1b[2J\u202e")); await closing;
  expect(app.frame().inbox).toBeNull(); expect(app.input).toEqual(chat);
  expect(plain(app.frame().inputArea!.lines)).toContain("could not answer: write failed");
  await toggleAnswer(app); expect(app.input).toEqual(answer);
  expect(app.page!.sent).toHaveLength(1); expect(app.page!.questions.closing).toBe(false);
  expect(plain(app.frame().inputArea!.lines)).toContain("could not answer: write failed");
  expect((await allQuestions("a"))[0]!.status).toBe("open");
});

for (const transition of ["close", "project", "recreate"] as const) {
  test(`late question command loads cannot reopen or steal input after ${transition}`, async () => {
    const gate = deferred<Question[]>(); let delayed = true;
    const ui = await setup({ tasks: async () => [], questions: fakeQuestions({ list: async () => delayed ? gate.promise : [] }) }), { app } = ui;
    const a = app.page!, chat = { text: "saved A", cursor: 3 }; app.input = { ...chat }; app.draw();
    const opening = app.questions.command(a);
    expect(app.frame().inbox?.section).toBe("questions");
    if (transition === "close") await app.onKey({ name: "escape" });
    if (transition === "project") await app.openPage("b");
    if (transition === "recreate") { app.closePage(); delayed = false; rmSync(paths.project("a"), { recursive: true }); await app.openPage("a"); }
    const current = app.page!, draft = { ...app.input };
    delayed = false; gate.resolve([syntheticQuestion("old")]); await opening; await current.questions.polling;
    expect(app.page).toBe(current); expect(app.input).toEqual(draft);
    expect(app.frame().inbox).toBeNull();
    expect(ui.sent).toEqual([]); expect(ui.calls().turns).toBe(0);
  });
}

test("answer feedback stays temporary; settling returns to the question list and the next key clears it", async () => {
  let open = [syntheticQuestion("q1"), syntheticQuestion("q2")];
  const ui = await setup({ questions: fakeQuestions({ list: async () => open, answer: async (_p, id) => { open = open.filter(q => q.id !== id); } }) }), { app } = ui;
  const page = app.page!;
  await app.questions.command(page);
  app.input = { text: "first", cursor: 5 }; app.draw();
  await app.onKey({ name: "enter" });
  await until(() => page.questions.open.length === 1);
  expect(app.frame().inbox).toBeNull(); // Answer form closes; the Questions list remains open.
  expect(plain(app.frame().inputArea!.lines)).toContain("? Question q1? → first");
  await app.onKey({ name: "escape" }); // closes the panel and clears the visible status
  expect(app.frame().inbox).toBeNull();
  expect(plain(app.frame().inputArea!.lines)).not.toContain("Question q1?");
  expect(page.lines).toEqual([]);
  await app.onKey({ name: "char", text: "x" });
  expect(plain(app.frame().inputArea!.lines)).not.toContain("Question q1?");
});

for (const transition of ["project", "recreate"] as const) {
  test(`a late question answer remains owned by its captured page after ${transition}`, async () => {
    const gate = deferred<void>(); let open = [syntheticQuestion()];
    const ui = await setup({ questions: fakeQuestions({ list: async () => open, answer: async () => { await gate.promise; } }) }), { app } = ui;
    const a = app.page!; await app.questions.command(a);
    app.input = { text: "answer A", cursor: 2 }; app.draw();
    const answering = app.onKey({ name: "enter" }); open = [];
    if (transition === "project") await app.openPage("b");
    else { app.closePage(); rmSync(paths.project("a"), { recursive: true }); await app.openPage("a"); }
    const next = app.page!, draft = { text: "new page draft", cursor: 5 }; app.input = { ...draft }; app.draw();
    gate.resolve(); await answering;
    expect(app.input).toEqual(draft); expect(next.lines).toEqual([]); expect(app.frame().inbox).toBeNull();
    expect(a.questions.mine.has("q")).toBe(transition === "project");
    expect(a.lines).toEqual([]); // a settled question is never a conversation line
    // Its "? … → …" is the captured page's transient note: shown once that page is active again, never on the new one.
    expect(plain(app.frame().inputArea!.lines)).not.toContain("Question q?");
    if (transition === "project") { await app.openPage("a"); expect(plain(app.frame().inputArea!.lines)).toContain("? Question q? → answer A"); }
  });
}

test("Questions panel sanitizes fields and stays bounded at narrow/tiny sizes; Escape always recovers drafts", async () => {
  const evil = "\x1b]8;;https://evil.invalid\x1b\\LINK\x1b]8;;\x1b\\\x1b[2J\x1b[31mRED\x1b[0m\u202e\x07";
  const ui = await setup({ questions: fakeQuestions({ list: async () => [{ ...syntheticQuestion(), text: evil.repeat(20), options: [evil], default: evil }] }) }), { app } = ui;
  const chat = { text: "draft 界", cursor: 3 }; app.input = { ...chat }; app.draw();
  for (const [cols, rows] of [[100, 28], [40, 24], [20, 12], [12, 8], [4, 4], [1, 1]]) {
    ui.term.cols = cols!; ui.term.rows = rows!;
    await app.questions.command(app.page);
    const f = app.frame(), screen = stickyRows(f, [], chapterRows({ tabs: [], active: 0, model: "fake-model", directory: "/tmp", remote: "" }, f.cols, headerHeight(f.rows)));
    expect(screen.rows).toHaveLength(rows!);
    expect(screen.rows.every(line => visibleLength(line) <= cols!)).toBe(true);
    expect(screen.rows.join("")).not.toMatch(/\x1b\]|\x1b\[2J|\x1b\[31m|\u202e|\x07/);
    await app.onKey({ name: "escape" }); expect(app.input).toEqual(chat); expect(app.frame().inbox).toBeNull();
  }
  expect(ui.sent).toEqual([]);
});

for (const outcome of ["answer", "error", "external"] as const) {
  test(`late question ${outcome} stays in its project status row, never either transcript`, async () => {
    const gate = deferred<void>(); let open = [syntheticQuestion()];
    const ui = await setup({ questions: fakeQuestions({ list: async () => open, answer: async () => { await gate.promise; } }) }), { app } = ui;
    const page = app.page!, chat = { text: "project draft", cursor: 4 }, answer = { text: "answer draft", cursor: 3 };
    app.input = { ...chat }; app.draw();
    await app.questions.command(page); app.input = { ...answer }; app.draw();
    const closing = outcome === "external" ? undefined : app.onKey({ name: "enter" });
    // Attaching to a transcript is independent of an outstanding question write/read.
    page.view = { name: "worker-a", lines: [], leave() {}, live: false, calls: new Calls() }; app.draw();
    expect(app.input).toEqual(chat); expect(app.questions.view()).toBeNull();
    if (outcome === "external") {
      open = []; app.questions.poll([page]); await page.questions.polling;
    } else {
      if (outcome === "error") gate.reject(new Error("answer write failed"));
      else gate.resolve();
      await closing;
    }
    expect(page.view.lines).toEqual([]); expect(app.input).toEqual(chat);
    // Every outcome uses the project status row, including over an agent view.
    if (outcome === "answer") { expect(plain(app.frame().inputArea!.lines)).toContain("? Question q? → answer draft"); expect(page.lines).toEqual([]); }
    else expect(plain(app.frame().inputArea!.lines)).toContain(outcome === "error" ? "answer write failed" : "unsent answer: answer draft");
    expect(page.lines).toEqual([]);
    expect(ui.sent).toEqual([]); expect(ui.calls().turns).toBe(0);
  });
}

test("even an empty or control-only question read error remains unknown, not inbox 0", async () => {
  let fail = false;
  const { app } = await setup({ questions: fakeQuestions({ list: async () => { if (fail) throw new Error("\x1b[2J"); return []; } }) });
  await app.questions.command(app.page);
  expect(app.status(app.page!)).toContain("0 questions |");
  fail = true; app.questions.poll(app.pages); await app.page!.questions.polling;
  expect(app.status(app.page!)).toContain("? questions |");
  expect(plain(taskInboxPanel(app.frame()).rows)).toContain("questions unavailable");
});

test("silent skip failure/retry is single-flight, keeps drafts/counts, and rejects stale resurrection", async () => {
  const gate = deferred<void>(); let attempts = 0, stale: Question[] | undefined;
  const ui = await setup({ tasks: async () => [], questions: { ...fileStore,
    list: async project => stale ?? fileStore.list(project),
    skip: async (project, id) => { attempts++; if (attempts === 1) await gate.promise; return fileStore.skip(project, id); },
  } }), { app } = ui;
  const qs = await ask("a", [{ text: "Remove?", default: "dangerous suggestion" }, { text: "Remaining?" }, { text: "Last?" }]);
  const chat = { text: "original chat", cursor: 3 }, answer = { text: "unsent custom", cursor: 5 };
  app.input = { ...chat }; await app.questions.command(app.page);
  app.input = { ...answer }; app.draw(); await app.onKey({ name: "down" });
  app.page!.sent.push({ inputId: "untouched", text: "queued before skip" });
  const closing = app.onKey({ name: "enter" });
  expect(plain(taskInboxPanel(app.frame()).rows)).toContain("removing from inbox");
  expect(plain(taskInboxPanel(app.frame()).rows)).not.toContain("Sending");
  await app.onKey({ name: "enter" }); await app.onKey({ name: "char", text: "1" });
  expect(attempts).toBe(1);
  // A read during persistence must not treat our close as external or lose its draft.
  stale = qs.slice(1); app.questions.poll(app.pages); await app.page!.questions.polling;
  expect(app.page!.questions.open.map(q => q.id)).toEqual(qs.map(q => q.id));
  await toggleAnswer(app); expect(app.input).toEqual(chat);
  gate.reject(new Error("persistence failed")); await closing;
  expect(app.frame().inbox).toBeNull();
  expect(app.page!.questions.answer).toEqual(answer);
  expect(app.status(app.page!)).toContain("3 questions |");
  expect(plain(app.frame().inputArea!.lines)).toContain("could not skip: persistence failed");
  expect(await allQuestions("a")).toEqual(qs);
  stale = undefined;
  await toggleAnswer(app); await app.onKey({ name: "enter" });
  expect(attempts).toBe(2);
  expect(app.page!.questions.open.map(q => q.id)).toEqual(qs.slice(1).map(q => q.id));
  expect(app.page!.questions.answer.text).toBe(""); // never reassigned to next head
  expect(app.input).toEqual(chat); // Returning to the list restores the chat draft.
  expect(app.status(app.page!)).toContain("2 questions |");
  expect(await pendingInput("a", "orchestrator")).toBe(false);
  expect(await drain("a", "orchestrator")).toEqual([]);
  expect(app.page!.sent).toEqual([{ inputId: "untouched", text: "queued before skip" }]);
  expect(JSON.stringify(app.page!.lines)).not.toContain("dangerous suggestion");
  await app.onKey({ name: "escape" }); expect(app.input).toEqual(chat);
  stale = qs; app.questions.poll(app.pages); await app.page!.questions.polling;
  expect(app.frame().inbox).toBeNull(); expect(app.input).toEqual(chat);
  await app.questions.command(app.page);
  expect(app.page!.questions.open.map(q => q.id)).toEqual(qs.slice(1).map(q => q.id));
  expect(app.input.text).toBe("");
  expect(ui.calls().turns).toBe(0); expect(ui.sent).toEqual([]);
});

for (const transition of ["close", "project", "recreate"] as const) {
  test(`late silent skip completion cannot reopen/change input after ${transition}`, async () => {
    const gate = deferred<void>();
    const ui = await setup({ tasks: async () => [], questions: { ...fileStore, skip: async (project, id) => { await gate.promise; return fileStore.skip(project, id); } } }), { app } = ui;
    const qs = await ask("a", [{ text: "Dismiss?", default: "yes" }, { text: "Next?" }]);
    const page = app.page!, chat = { text: "saved chat", cursor: 4 };
    app.input = { ...chat }; await app.questions.command(page);
    app.input = { text: "old answer", cursor: 3 }; app.draw(); await app.onKey({ name: "down" });
    const closing = app.onKey({ name: "enter" });
    if (transition === "close") await app.onKey({ name: "escape" });
    if (transition === "project") { await app.openPage("b"); app.input = { text: "B", cursor: 1 }; }
    if (transition === "recreate") { app.closePage(); await app.openPage("a"); app.input = { text: "new A", cursor: 2 }; }
    const input = { ...app.input }, section = app.frame().inbox?.section;
    gate.resolve(); await closing;
    expect(app.input).toEqual(input); expect(app.frame().inbox?.section).toBe(section);
    expect((await allQuestions("a")).map(q => q.status)).toEqual(["skipped", "open"]);
    expect(await pendingInput("a", "orchestrator")).toBe(false);
    expect(ui.sent).toEqual([]); expect(ui.calls().turns).toBe(0);
    if (transition === "close") {
      expect(page.questions.open.map(q => q.id)).toEqual([qs[1]!.id]);
      expect(page.questions.answer.text).toBe("");
    }
  });
}

test("external silent skip reports an orphan draft as closed, restores chat and never reassigns the answer", async () => {
  const ui = await setup(), { app } = ui;
  const qs = await ask("a", [{ text: "Closed elsewhere?", default: "yes" }, { text: "Next?" }]);
  const chat = { text: "keep chat", cursor: 3 };
  app.input = { ...chat }; await app.questions.command(app.page);
  app.input = { text: "orphan answer", cursor: 4 }; app.draw();
  await fileStore.skip("a", qs[0]!.id);
  app.questions.poll(app.pages); await app.page!.questions.polling;
  expect(app.input).toEqual(chat); expect(app.frame().inbox).toBeNull();
  expect(plain(app.frame().inputArea!.lines)).toContain("was closed elsewhere");
  expect(plain(app.frame().inputArea!.lines)).toContain("unsent answer: orphan answer");
  expect(JSON.stringify(app.page!.lines)).not.toContain("default");
  expect(app.page!.questions.answer.text).toBe("");
  expect(app.status(app.page!)).toContain("1 questions |");
  await app.questions.command(app.page);
  expect(app.input.text).toBe(""); expect(app.questions.view()?.text).toBe("Next?");
  expect(await drain("a", "orchestrator")).toEqual([]);
  expect(ui.calls().turns).toBe(0); expect(ui.sent).toEqual([]);
});

// Actual App + realTerminal adapter over isolated streams, NOT a production CLI
// or OS Cmd-click test. Captures preserve raw OSC 8 as well as visible cells.
