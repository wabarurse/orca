import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { appFixture } from "../test/app-fixture";
import { App, type AppDeps } from "./app";
import { all, ask } from "../core/data/inbox/questions";
import type { AgentInfo } from "../protocol";
import { processDirectory, saveProcess } from "../core/data/processes";
import { existsSync } from "node:fs";
import { paths } from "../config";

const { home, fakeTerm, fakeOrchestrators, until, projectList } = appFixture();

async function setup(project: string, extra: Partial<AppDeps> = {}) {
  const term = fakeTerm(120, 28), fake = fakeOrchestrators();
  const app = new App({ term, pollMs: 100_000, agents: async () => [], taskCount: async () => [],
    questionDelayMs: 0, openOrchestrator: fake.openOrchestrator, ...extra });
  const running = app.run(project);
  await until(() => app.page?.project === project);
  return { app, term, fake, stop: async () => { app.quit(); await running; } };
}
/** The status line: the last painted row (the frame text ends in a newline, so `display.screen()` has a blank row after it). */
const lastRow = (term: { screen(): string }) => term.screen().split("\n").at(-1)!;
const key = (app: App, text: string) => app.onKey({ name: "char", text });
const names = (app: App) => app.work.state!.items.map(item => item.name);
const selected = (app: App) => { const state = app.work.state!; return state.items[state.index]?.name; };
const agents = (...list: string[]): AgentInfo[] => list.map(name => ({ name, live: true, status: "running", queuedMessages: 0 }));
const SIX = agents("worker-alpha", "worker-beta", "reviewer-beta", "worker-gamma", "worker-delta", "reviewer-omega");

test("one page, six tabs: digits, Tab, Shift+Tab and h/l switch; chords open their tab, switch to it and close it", async () => {
  const { app, term, stop } = await setup("tabs", { agents: async () => SIX });
  try {
    app.input = { text: "keep this draft", cursor: 4 };
    term.press({ name: "a", ctrl: true });
    await until(() => term.screen().includes("worker-alpha"));
    await until(() => /^Agents 6 {3}Tasks 0 {3}Questions 0 {3}Images 0 {3}Processes 0 {3}Bubbles \d+ +1 of 6$/.test(term.display.screen()[0]!));
    expect(term.display.screen()[2]).toMatch(/^ {2}NAME +STATUS +INFO$/);
    expect(lastRow(term)).toContain("j/k move");
    for (const [typed, kind] of [["2", "tasks"], ["3", "questions"], ["4", "images"], ["5", "processes"], ["6", "projects"], ["1", "agents"]] as const) { await key(app, typed); expect(app.work.kind).toBe(kind); }
    await app.onKey({ name: "tab" }); expect(app.work.kind).toBe("tasks");
    await app.onKey({ name: "tab", shift: true }); await app.onKey({ name: "tab", shift: true }); expect(app.work.kind).toBe("projects");
    await key(app, "l"); expect(app.work.kind).toBe("agents");
    await key(app, "h"); await key(app, "h"); expect(app.work.kind).toBe("processes"); await key(app, "h"); expect(app.work.kind).toBe("images");
    await app.onKey({ name: "left" }); expect(app.work.kind).toBe("questions");
    term.press({ name: "t", ctrl: true }); expect(app.work.kind).toBe("tasks");
    term.press({ name: "q", ctrl: true }); expect(app.work.kind).toBe("questions");
    term.press({ name: "b", ctrl: true }); expect(app.work.kind).toBe("projects");
    term.press({ name: "b", ctrl: true }); expect(app.work.open).toBe(false); // the same chord closes
    term.press({ name: "t", ctrl: true }); await key(app, "q"); expect(app.work.open).toBe(false);
    expect(app.input).toEqual({ text: "keep this draft", cursor: 4 });
  } finally { await stop(); }
});

test("j/k, gg, G and Ctrl+D/Ctrl+U move the selection", async () => {
  const { app, term, stop } = await setup("moves", { agents: async () => SIX });
  try {
    {
      term.press({ name: "a", ctrl: true }); await until(() => app.work.state?.items.length === 7);
      await key(app, "j"); await key(app, "j"); expect(selected(app)).toBe("reviewer-beta");
      await key(app, "k"); expect(selected(app)).toBe("worker-beta");
      await key(app, "G"); expect(selected(app)).toBe("reviewer-omega");
      await key(app, "g"); expect(selected(app)).toBe("reviewer-omega"); await key(app, "g"); expect(selected(app)).toBe("▾ Today (6)"); // the day heading is the first row
      await key(app, "j"); expect(selected(app)).toBe("worker-alpha");
      await app.onKey({ name: "d", ctrl: true }); expect(selected(app)).toBe("worker-delta"); // half of the nine table rows
      await app.onKey({ name: "u", ctrl: true }); expect(selected(app)).toBe("worker-alpha");
      // The heading folds its day: Enter or ← shuts it (the count stays), Enter or → opens it again.
      await key(app, "k"); await app.onKey({ name: "enter" }); expect(names(app)).toEqual(["▸ Today (6)"]);
      await app.onKey({ name: "right" }); expect(names(app).length).toBe(7); expect(app.work.kind).toBe("agents");
      await app.onKey({ name: "left" }); expect(names(app)).toEqual(["▸ Today (6)"]); await app.onKey({ name: "right" }); expect(names(app)[0]).toBe("▾ Today (6)");
      await app.onKey({ name: "escape" }); expect(app.work.open).toBe(false);
    }
  } finally { await stop(); }
});

test("find jumps as you type and marks the match; Enter keeps, Esc restores; n/N walk the matches and wrap", async () => {
  const { app, term, stop } = await setup("finds", { agents: async () => SIX });
  try {
    term.press({ name: "a", ctrl: true }); await until(() => app.work.state?.items.length === 7);
    await key(app, "j");
    await key(app, "f"); expect(app.work.typing).toBe(true);
    term.type("BETA"); expect(selected(app)).toBe("worker-beta"); // from the row the find started on
    await until(() => lastRow(term).startsWith("find › BETA"));
    expect(term.shown?.kind === "page" ? term.shown.rows.join("\n") : "").toContain("worker-\x1b[7mbeta\x1b[27m"); // the page rows as shown carry the reverse-video mark
    await app.onKey({ name: "backspace" }); await app.onKey({ name: "backspace" }); await app.onKey({ name: "backspace" }); await app.onKey({ name: "backspace" });
    term.type("gamma"); expect(selected(app)).toBe("worker-gamma");
    await app.onKey({ name: "escape" }); expect(selected(app)).toBe("worker-beta"); expect(app.work.open).toBe(true);
    await key(app, "/"); term.type("q1j"); expect(app.work.state!.find).toBe("q1j"); expect(app.work.kind).toBe("agents"); // every printable key is find text
    await app.onKey({ name: "escape" });
    await key(app, "f"); term.type("reviewer"); await app.onKey({ name: "enter" });
    expect(selected(app)).toBe("reviewer-beta"); expect(app.work.typing).toBe(false);
    await key(app, "n"); expect(selected(app)).toBe("reviewer-omega");
    await key(app, "n"); expect(selected(app)).toBe("reviewer-beta");
    await key(app, "N"); expect(selected(app)).toBe("reviewer-omega");
    await key(app, "2"); await key(app, "1"); await key(app, "n");
    await until(() => lastRow(term).includes("f starts a find")); // the find text does not follow to another tab
  } finally { await stop(); }
});

test("a question with options: Enter chooses from the default; a digit sends at once; Enter sends the row; Other… and no options take a typed answer", async () => {
  const project = "choose", { app, term, fake, stop } = await setup(project);
  try {
    const [first, second, third, fourth] = await ask(project, [{ text: "Pick a database?", options: ["postgres", "sqlite", "duckdb"], default: "sqlite" },
      { text: "Pick a queue?", options: ["redis", "sqs"] }, { text: "Name the release", options: ["v1", "v2"] }, { text: "What should the note say?" }]);
    term.press({ name: "q", ctrl: true });
    await until(() => app.work.state?.items.length === 5);
    await app.onKey({ name: "enter" });
    await until(() => term.screen().includes("› 2  sqlite   default")); // starts on the default
    expect(term.screen()).toContain("  4  Other…");
    expect(lastRow(term)).toContain("j/k choose · 1–4 pick · enter send · esc cancel");
    await key(app, "j"); expect(app.work.state!.option).toBe(2);
    await app.onKey({ name: "escape" }); // cancels without answering
    expect(app.page!.questions.expanded).toBe(false); expect((await all(project)).every(q => q.status === "open")).toBe(true);
    await app.onKey({ name: "enter" }); await key(app, "k"); await key(app, "k"); await key(app, "k"); await key(app, "j");
    await app.onKey({ name: "enter" }); // Enter sends the highlighted row
    await until(() => app.page!.questions.open.length === 3);
    expect((await all(project)).find(q => q.id === first!.id)?.answer).toBe("sqlite");
    expect(app.page!.sent.map(item => item.text)).toEqual(["? Pick a database? → sqlite"]); // joins the prompt queue under its inputId
    await until(() => selected(app) === "Pick a queue?");
    await app.onKey({ name: "enter" }); await key(app, "2"); // a digit picks and sends
    await until(() => app.page!.questions.open.length === 2);
    expect((await all(project)).find(q => q.id === second!.id)?.answer).toBe("sqs");
    await until(() => selected(app) === "Name the release");
    await app.onKey({ name: "enter" }); await key(app, "3"); // the row after the options is Other…
    expect(app.questions.answering()).toBe(true); expect(app.work.typing).toBe(true);
    term.type("v3 qf1"); await until(() => lastRow(term).startsWith("answer › v3 qf1"));
    await app.onKey({ name: "enter" });
    await until(() => app.page!.questions.open.length === 1);
    expect((await all(project)).find(q => q.id === third!.id)?.answer).toBe("v3 qf1");
    await until(() => selected(app) === "What should the note say?");
    await app.onKey({ name: "enter" }); // no options: straight to the typed answer
    expect(app.questions.answering()).toBe(true);
    await app.onKey({ name: "enter" }); expect((await all(project)).find(q => q.id === fourth!.id)?.status).toBe("open"); // nothing typed, nothing sent
    term.type("Edits no longer need a read."); await app.onKey({ name: "escape" }); // Esc cancels, the draft stays with the question
    expect(app.input.text).toBe(""); expect(app.work.kind).toBe("questions");
    await app.onKey({ name: "enter" }); expect(app.input.text).toBe("Edits no longer need a read.");
    await app.onKey({ name: "enter" });
    await until(() => app.page!.questions.open.length === 0);
    expect((await all(project)).map(q => q.answer)).toEqual(["sqlite", "sqs", "v3 qf1", "Edits no longer need a read."]);
    expect(fake.said[project]).toEqual([]); // answers reach the orchestrator through its inbox, never as typed chat
    await until(() => selected(app) === "▸ Archived (4)"); // answered questions fold away
    await app.onKey({ name: "enter" }); await key(app, "j"); await app.onKey({ name: "enter" });
    await until(() => lastRow(term).includes("Closed question"));
  } finally { await stop(); }
});

test("q backs out of pages and menus; chat and answer drafts stay apart; letters are text while answering", async () => {
  const { app, term, stop } = await setup("question-drafts");
  try {
    await ask(app.page!.project, [{ text: "Describe the result" }]);
    term.type("chat draft"); await until(() => app.input.text === "chat draft");
    for (const chord of ["a", "t", "g", "p", "b"]) {
      await app.onKey({ name: chord, ctrl: true }); await key(app, "q");
      expect(app.menu).toBeNull(); expect(app.work.open).toBe(false);
      expect(app.input.text).toBe("chat draft");
    }
    await app.onKey({ name: "q", ctrl: true }); await until(() => app.work.state?.items.length === 2);
    await app.onKey({ name: "enter" });
    term.type("qhl: answer"); await until(() => app.input.text === "qhl: answer");
    expect(app.work.kind).toBe("questions");
    term.press({ name: "escape" }); // form -> list
    expect(app.page!.questions.expanded).toBe(false); expect(app.input.text).toBe("chat draft");
    await key(app, "q"); expect(app.work.open).toBe(false);
    await app.onKey({ name: "q", ctrl: true }); await app.onKey({ name: "enter" });
    expect(app.input.text).toBe("qhl: answer");
    term.press({ name: "a", ctrl: true }); // another tab puts the form away without taking its answer
    expect(app.page!.questions.expanded).toBe(false); expect(app.input.text).toBe("chat draft");
    await app.onKey({ name: "q", ctrl: true }); await app.onKey({ name: "enter" }); await app.onKey({ name: "enter" });
    await until(() => app.page!.questions.open.length === 0);
    expect((await all(app.page!.project))[0]!.answer).toBe("qhl: answer");
    expect(app.input.text).toBe("chat draft");
  } finally { await stop(); }
});

test("Agents hides unverified rows, folds old ones under Archived and archives only eligible finished runs", async () => {
  const removed: string[][] = [];
  const rows: AgentInfo[] = [
    { name: "worker-live", live: true, status: "running", queuedMessages: 0 },
    { name: "worker-uncertain", live: false, status: "unknown" },
    { name: "worker-old", live: false, status: "exited", queuedMessages: 0, lastActiveAt: "2000-01-01" },
    { name: "worker-queued", live: false, status: "exited", queuedMessages: 2 },
  ];
  const { app, term, stop } = await setup("agents-page", { agents: async () => rows,
    archiveAgents: async (_project, list) => {
      removed.push(list);
      for (const row of rows) if (list.includes(row.name)) row.archived = true;
      return { archived: list, live: [] };
    },
  });
  try {
    term.press({ name: "a", ctrl: true });
    await until(() => term.screen().includes("worker-live"));
    expect(names(app)).toEqual(["▾ Today (1)", "worker-live", "▾ Earlier (1)", "worker-queued", "▸ Archived (1)"]);
    expect(term.display.screen()[4]).toMatch(/^› worker-live +running/);
    await key(app, "G"); await app.onKey({ name: "enter" }); await until(() => term.screen().includes("worker-old"));
    await key(app, "A"); await until(() => term.screen().includes("Archive 1 finished agents?"));
    await key(app, "y"); await until(() => removed.length === 1);
    expect(removed).toEqual([["worker-old"]]);
  } finally { await stop(); }
});

test("rows keep to one or two facts: INFO has no queued count, the divider is a plain rule, hints name only the tab's own keys", async () => {
  const rows: AgentInfo[] = [{ name: "worker-busy", live: true, status: "running", queuedMessages: 3, activity: "edit search/index.ts" }];
  const { app, term, stop } = await setup("agents-declutter", { agents: async () => rows });
  try {
    term.press({ name: "a", ctrl: true });
    await until(() => term.screen().includes("worker-busy"));
    const item = app.work.state!.items.find(row => row.name === "worker-busy")!;
    expect(item.info).toBe("edit search/index.ts");
    const screen = term.display.screen();
    expect(screen.some(row => /^─+$/.test(row))).toBe(true);
    expect(screen.some(row => row.startsWith("── worker-busy"))).toBe(false);
    expect(screen.join("\n")).toContain("Now");
    expect(screen.join("\n")).toContain("3 queued messages");
    expect(lastRow(term).trim()).toBe("j/k move · h/l tabs · enter view · s stop · a archive · f find · q close");
  } finally { await stop(); }
});

test("folding a day or the archive never changes a tab's count", async () => {
  const rows: AgentInfo[] = [
    { name: "worker-now", live: true, status: "running", queuedMessages: 0 },
    { name: "worker-old", live: false, status: "exited", queuedMessages: 1, lastActiveAt: "2000-01-01" },
  ];
  const { app, term, stop } = await setup("fold-counts", { agents: async () => rows });
  try {
    term.press({ name: "a", ctrl: true });
    await until(() => term.screen().includes("worker-now"));
    const count = () => /Agents (\d+)/.exec(term.display.screen()[0] ?? "")?.[1];
    expect(count()).toBe("2");
    expect(names(app)[0]).toBe("▾ Today (1)");
    while (!selected(app)?.startsWith("▾ Today")) await key(app, "k");
    term.press({ name: "enter" });
    await until(() => names(app)[0] === "▸ Today (1)" && term.screen().includes("▸ Today (1)"));
    expect(names(app)).not.toContain("worker-now");
    expect(count()).toBe("2");
    for (const heading of names(app).filter(name => name.startsWith("▾"))) {
      while (selected(app) !== heading) await key(app, "j");
      term.press({ name: "enter" });
    }
    await until(() => !names(app).some(name => name.startsWith("▾")) && !term.screen().includes("▾ "));
    expect(count()).toBe("2");
  } finally { await stop(); }
});

test("Tasks is the outline as rows: ←/→ fold, h/l switch tabs, and there is no abandon key", async () => {
  const { registerTask, getTask, setTaskDependencies } = await import("../core/data/tasks/tasks");
  const project = "tasks-page";
  const { app, term, stop } = await setup(project, { taskCount: undefined });
  try {
    const parent = await registerTask(project, { name: "Parent", summary: "Keep the ledger", branch: "feat/parent", authorized: true });
    const child = await registerTask(project, { name: "Child", summary: "Dependent work", branch: "feat/child", authorized: true });
    await setTaskDependencies(project, child.id, [parent.id]);
    term.press({ name: "t", ctrl: true });
    await until(() => term.screen().includes("Task #1 Parent"));
    expect(term.display.screen().slice(3, 6).map(row => row.trimEnd().replace(/ {2,}/g, " | ").replace(/─+/, "─"))).toEqual([" | ▾ Today (2) ─", "› ▾ #1 Parent | queued", " | └─ #2 Child | queued"]); // the cursor starts on a task, not the day heading
    expect(term.screen()).toContain("Keep the ledger");
    const left = () => app.onKey({ name: "left" }), right = () => app.onKey({ name: "right" });
    await left(); expect(app.work.kind).toBe("tasks"); expect(names(app)).toEqual(["▾ Today (2)", "#1 Parent"]);
    // ← again goes up to the day, and once more folds the whole day; → opens it and steps back in.
    await left(); expect(selected(app)).toBe("▾ Today (2)"); await left(); expect(names(app)).toEqual(["▸ Today (2)"]);
    await right(); expect(names(app)).toEqual(["▾ Today (2)", "#1 Parent"]); await right(); expect(selected(app)).toBe("#1 Parent");
    await right(); expect(names(app)).toEqual(["▾ Today (2)", "#1 Parent", "#2 Child"]);
    await right(); expect(selected(app)).toBe("#2 Child"); await left(); expect(selected(app)).toBe("#1 Parent");
    await key(app, "c"); expect(app.work.state!.confirm).toBeUndefined();
    expect((await getTask(project, parent.id)).attention).toBeUndefined();
    expect((await getTask(project, child.id)).dependsOn).toEqual([parent.id]);
    await key(app, "l"); expect(app.work.kind).toBe("questions"); await key(app, "h"); expect(app.work.kind).toBe("tasks");
  } finally { await stop(); }
});

test("Projects works with no conversation open; the other tabs say to open one; c closes a page and keeps its project", async () => {
  for (const name of ["projects-first", "projects-second"]) mkdirSync(join(home, "projects", name, "repo"), { recursive: true });
  const { app, term, stop } = await setup("projects-first");
  try {
    await app.openPage("projects-second");
    term.press({ name: "b", ctrl: true });
    await until(() => projectList(app)?.items.some(item => item.name === "projects-second") === true);
    expect(selected(app)).toContain("projects-second"); // starts on the open conversation
    await key(app, "c");
    await until(() => app.pages.length === 1);
    expect(app.work.kind).toBe("projects"); expect(projectList(app)!.status).toContain("its project and history are kept");
    await key(app, "f"); term.type("projects-first"); await app.onKey({ name: "enter" }); await key(app, "c");
    await until(() => app.pages.length === 0);
    expect(app.work.kind).toBe("projects"); expect(projectList(app)!.items.length).toBeGreaterThan(1);
    await key(app, "1");
    await until(() => term.display.screen()[3]!.includes("open a conversation first"));
    for (const typed of ["j", "d", "s", "a", "r", "f", "x"]) await key(app, typed); await app.onKey({ name: "escape" }); // nothing to act on, nothing throws
    await key(app, "6"); await app.onKey({ name: "enter" });
    await until(() => app.page?.project === "projects-first");
    expect(app.work.open).toBe(false);
  } finally { await stop(); }
});

test("only the kept commands exist; a removed one is unknown; key paths replace the rest", async () => {
  const { app, term, stop } = await setup("commands");
  try {
    expect([...app.commands.keys()].sort()).toEqual(["/accounts", "/clear-context", "/compact", "/effort", "/fast", "/help", "/login", "/model", "/mux", "/quit", "/rename"]);
    for (const gone of ["/vim", "/stop", "/paste-image", "/remove-image", "/runtime", "/usage", "/refresh", "/projects", "/retry-images", "/keys", "/new", "/close", "/tasks", "/agents", "/images", "/clear", "/project", "/project-defaults", "/questions", "/back"]) {
      term.type(`${gone}\r`);
      await until(() => term.screen().includes(`unknown command ${gone}`));
      expect(app.work.open).toBe(false); expect(app.menu).toBeNull(); expect(app.pages).toHaveLength(1);
    }
    term.type("/rename Kept name\r"); await until(() => app.page!.name === "Kept name");
    term.type("/help\r"); await until(() => app.frame().help !== null);
    expect(app.frame().help!.lines.join("\n")).not.toMatch(/\/(?:agents|tasks|questions|projects|refresh|keys|back|new|close|stop|usage|runtime)\b/);
    term.press({ name: "escape" });
    term.press({ name: "x", ctrl: true }); expect(app.keyEcho).toBe(true); term.press({ name: "escape" }); expect(app.keyEcho).toBe(false);
  } finally { await stop(); }
});

test("Ctrl+H/L switch project tabs from chat, pages and menus; Shift letters type; drafts stay", async () => {
  const { app, term, fake, stop } = await setup("tabs-first");
  try {
    await app.openPage("tabs-second");
    term.press({ name: "h", ctrl: true }); await until(() => app.page?.project === "tabs-first");
    term.type("draft text"); await until(() => app.input.text === "draft text");
    term.type("\x0c"); await until(() => app.page?.project === "tabs-second");
    term.press({ name: "t", ctrl: true }); await until(() => app.work.kind === "tasks");
    term.type("\x08"); await until(() => app.page?.project === "tabs-first"); expect(app.work.open).toBe(false);
    await app.commands.get("/effort")!.run("", app.page);
    term.type("\x0c"); await until(() => app.page?.project === "tabs-second"); expect(app.menu).toBeNull();
    term.press({ name: "b", ctrl: true }); await until(() => app.work.kind === "projects");
    term.type("\x08"); await until(() => app.page?.project === "tabs-first");
    expect(app.work.open).toBe(false);
    expect(app.input.text).toBe("draft text");
    for (const letter of "ATQPBUEMFSVXHL") await app.onKey({ name: letter.toLowerCase(), shift: true });
    expect(app.input.text).toBe("draft textATQPBUEMFSVXHL"); expect(app.work.open).toBe(false); expect(app.menu).toBeNull();
    expect(Object.values(fake.said).flat()).toEqual([]);
  } finally { await stop(); }
});

test("Processes lists background commands under a heading; s asks, then stops the selected one and says the orchestrator was told", async () => {
  const project = "processes-tab";
  const { app, term, stop } = await setup(project);
  try {
    const at = new Date(Date.now() - 90_000).toISOString(), id = "00000000-0000-4000-8000-000000000001";
    await saveProcess({ id, project, owner: "worker-feat", role: "worker", cwd: "/repo", command: "bun run stack", createdAt: at, updatedAt: at,
      state: "running", timeoutMs: 0, maxBytes: 0, notify: false, events: [] });
    term.press({ name: "a", ctrl: true }); await key(app, "5");
    await until(() => names(app).length === 2);
    expect(names(app)).toEqual(["▾ Commands · Today (1)", "bun run stack"]);
    expect(selected(app)).toBe("bun run stack"); // never starts on the heading
    await until(() => /Processes 1/.test(term.display.screen()[0]!) && term.screen().includes("no output yet"));
    expect(term.display.screen().find(row => row.includes("bun run stack") && row.includes("running"))).toContain("worker-feat · 1m 3");
    expect(lastRow(term)).toContain("s stop");
    await key(app, "s"); expect(app.work.state!.confirm).toBe("Stop this command?");
    await key(app, "n"); expect(existsSync(join(processDirectory(project, id), "stop"))).toBe(false);
    await key(app, "s"); await key(app, "y");
    await until(() => app.work.state?.notice === "Stop requested. The orchestrator was told.");
    expect(existsSync(join(processDirectory(project, id), "stop"))).toBe(true);
    await key(app, "k"); expect(selected(app)).toBe("▾ Commands · Today (1)"); // the cursor rests on a heading, where it folds
    await key(app, "s"); expect(app.work.state!.confirm).toBeUndefined(); // a heading is not a command
  } finally { await stop(); }
});

test("Processes lists a tmux session an agent opened itself; s asks, ends it and says the orchestrator was told", async () => {
  const project = "processes-sessions", killed: string[] = [];
  const pane = (window: string, command: string) => ({ session: "dev-stack", created: Date.now() - 3_600_000, window, pane: `%${window}`, path: join(paths.worktreeRoots(project)[0]!, "feat-x"), command, live: true });
  const { app, term, stop } = await setup(project, { sessions: {
    panes: async () => killed.length ? [] : [pane("web", "pnpm dev --port 15220"), pane("api", "")], tail: async id => id === "%web" ? "ready on http://127.0.0.1:15220" : "", kill: async name => { killed.push(name); } } });
  try {
    term.press({ name: "a", ctrl: true }); await key(app, "5");
    await until(() => names(app).length === 2);
    expect(names(app)).toEqual(["▾ tmux sessions (1)", "web: pnpm dev --port 15220 · api: shell"]);
    await until(() => /Processes 1/.test(term.display.screen()[0]!) && term.screen().includes("ready on http://127.0.0.1:15220"));
    expect(term.display.screen().find(row => row.includes("web: pnpm dev"))).toMatch(/tmux +dev-stack · 1h/);
    await key(app, "s"); expect(app.work.state!.confirm).toBe("End tmux session dev-stack (2 windows)?");
    await key(app, "n"); expect(killed).toEqual([]);
    await key(app, "s"); await key(app, "y");
    await until(() => app.work.state?.notice === "Session ended. The orchestrator was told.");
    expect(killed).toEqual(["dev-stack"]); expect(names(app)).toEqual([]);
  } finally { await stop(); }
});
