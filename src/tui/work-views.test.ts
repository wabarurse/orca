import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { appFixture } from "../test/app-fixture";
import { App, type AppDeps } from "./app";
import { all, ask } from "../core/data/inbox/questions";
import type { AgentInfo } from "../protocol";

const { home, fakeTerm, fakeOrchestrators, until, projectList } = appFixture();

async function setup(project: string, extra: Partial<AppDeps> = {}) {
  const term = fakeTerm(120, 28), fake = fakeOrchestrators();
  const app = new App({ term, pollMs: 100_000, agents: async () => [], taskCount: async () => [],
    questionDelayMs: 0, openOrchestrator: fake.openOrchestrator, ...extra });
  const running = app.run(project);
  await until(() => app.page?.project === project);
  return { app, term, fake, stop: async () => { app.quit(); await running; } };
}
const key = (app: App, text: string) => app.onKey({ name: "char", text });
const names = (app: App) => app.work.state!.items.map(item => item.name);
const selected = (app: App) => { const state = app.work.state!; return state.items[state.index]?.name; };
const agents = (...list: string[]): AgentInfo[] => list.map(name => ({ name, live: true, status: "running", queuedMessages: 0 }));
const SIX = agents("worker-alpha", "worker-beta", "reviewer-beta", "worker-gamma", "worker-delta", "reviewer-omega");

test("one page, five tabs: digits, Tab, Shift+Tab and h/l switch; chords open their tab, switch to it and close it", async () => {
  const { app, term, stop } = await setup("tabs", { agents: async () => SIX });
  try {
    app.input = { text: "keep this draft", cursor: 4 };
    term.press({ name: "a", ctrl: true });
    await until(() => term.screen().includes("worker-alpha"));
    await until(() => /^Agents 6 {3}Tasks 0 {3}Questions 0 {3}Images 0 {3}Projects \d+ +1 of 6$/.test(term.display.screen()[0]!));
    expect(term.display.screen()[2]).toMatch(/^ {2}NAME +STATUS +INFO$/);
    expect(term.display.screen().at(-1)).toContain("j/k move");
    for (const [typed, kind] of [["2", "tasks"], ["3", "questions"], ["4", "images"], ["5", "projects"], ["1", "agents"]] as const) { await key(app, typed); expect(app.work.kind).toBe(kind); }
    await app.onKey({ name: "tab" }); expect(app.work.kind).toBe("tasks");
    await app.onKey({ name: "tab", shift: true }); await app.onKey({ name: "tab", shift: true }); expect(app.work.kind).toBe("projects");
    await key(app, "l"); expect(app.work.kind).toBe("agents");
    await key(app, "h"); await key(app, "h"); expect(app.work.kind).toBe("images");
    await app.onKey({ name: "left" }); expect(app.work.kind).toBe("questions");
    term.press({ name: "t", ctrl: true }); expect(app.work.kind).toBe("tasks");
    term.press({ name: "q", ctrl: true }); expect(app.work.kind).toBe("questions");
    term.press({ name: "b", ctrl: true }); expect(app.work.kind).toBe("projects");
    term.press({ name: "b", ctrl: true }); expect(app.work.open).toBe(false); // the same chord closes
    term.press({ name: "t", ctrl: true }); await key(app, "q"); expect(app.work.open).toBe(false);
    expect(app.input).toEqual({ text: "keep this draft", cursor: 4 });
  } finally { await stop(); }
});

test("j/k, gg, G and Ctrl+D/Ctrl+U move the selection; the page is the same with Vim keys on", async () => {
  const { app, term, stop } = await setup("moves", { agents: async () => SIX });
  try {
    for (const vim of [false, true]) {
      if (vim) { term.type("/vim\r"); await until(() => term.screen().includes("[NORMAL]")); }
      term.press({ name: "a", ctrl: true }); await until(() => app.work.state?.items.length === 6);
      await key(app, "j"); await key(app, "j"); expect(selected(app)).toBe("reviewer-beta");
      await key(app, "k"); expect(selected(app)).toBe("worker-beta");
      await key(app, "G"); expect(selected(app)).toBe("reviewer-omega");
      await key(app, "g"); expect(selected(app)).toBe("reviewer-omega"); await key(app, "g"); expect(selected(app)).toBe("worker-alpha");
      await app.onKey({ name: "d", ctrl: true }); expect(selected(app)).toBe("worker-delta"); // half of the nine table rows
      await app.onKey({ name: "u", ctrl: true }); expect(selected(app)).toBe("worker-alpha");
      await app.onKey({ name: "escape" }); expect(app.work.open).toBe(false);
    }
  } finally { await stop(); }
});

test("find jumps as you type and marks the match; Enter keeps, Esc restores; n/N walk the matches and wrap", async () => {
  const { app, term, stop } = await setup("finds", { agents: async () => SIX });
  try {
    term.press({ name: "a", ctrl: true }); await until(() => app.work.state?.items.length === 6);
    await key(app, "j");
    await key(app, "f"); expect(app.work.typing).toBe(true);
    term.type("BETA"); expect(selected(app)).toBe("worker-beta"); // from the row the find started on
    await until(() => term.display.screen().at(-1)!.startsWith("find › BETA"));
    expect(term.raw()).toContain("worker-\x1b[7mbeta\x1b[27m");
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
    await until(() => term.display.screen().at(-1)!.includes("f starts a find")); // the find text does not follow to another tab
  } finally { await stop(); }
});

test("a question with options: Enter chooses from the default; a digit sends at once; Enter sends the row; Other… and no options take a typed answer", async () => {
  const project = "choose", { app, term, fake, stop } = await setup(project);
  try {
    const [first, second, third, fourth] = await ask(project, [{ text: "Pick a database?", options: ["postgres", "sqlite", "duckdb"], default: "sqlite" },
      { text: "Pick a queue?", options: ["redis", "sqs"] }, { text: "Name the release", options: ["v1", "v2"] }, { text: "What should the note say?" }]);
    term.press({ name: "q", ctrl: true });
    await until(() => app.work.state?.items.length === 4);
    await app.onKey({ name: "enter" });
    await until(() => term.screen().includes("› 2  sqlite   default")); // starts on the default
    expect(term.screen()).toContain("  4  Other…");
    expect(term.display.screen().at(-1)).toContain("j/k choose · 1–4 pick · enter send · esc cancel");
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
    term.type("v3 qf1"); await until(() => term.display.screen().at(-1)!.startsWith("answer › v3 qf1"));
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
    await until(() => term.display.screen().at(-1)!.includes("Closed question"));
  } finally { await stop(); }
});

test("q backs out of pages and menus; chat and answer drafts stay apart; Vim letters are text while answering", async () => {
  const { app, term, stop } = await setup("vim-question-drafts");
  try {
    await ask(app.page!.project, [{ text: "Describe the result" }]);
    term.type("/vim\r"); await until(() => term.screen().includes("NORMAL"));
    term.type("ichat draft"); await until(() => app.input.text === "chat draft");
    term.press({ name: "escape" });
    for (const command of ["A", "T", "P", "B", "M", "?"]) {
      await key(app, command); await key(app, "q");
      expect(app.menu).toBeNull(); expect(app.work.open).toBe(false);
      expect(app.input.text).toBe("chat draft");
    }
    await key(app, "Q"); await until(() => app.work.state?.items.length === 1);
    await app.onKey({ name: "enter" });
    term.type("qHL: answer"); await until(() => app.input.text === "qHL: answer");
    expect(app.work.kind).toBe("questions");
    term.press({ name: "escape" }); // form -> list
    expect(app.page!.questions.expanded).toBe(false); expect(app.input.text).toBe("chat draft");
    await key(app, "q"); expect(app.work.open).toBe(false);
    await key(app, "Q"); await app.onKey({ name: "enter" });
    expect(app.input.text).toBe("qHL: answer");
    term.press({ name: "a", ctrl: true }); // another tab puts the form away without taking its answer
    expect(app.page!.questions.expanded).toBe(false); expect(app.input.text).toBe("chat draft");
    await key(app, "Q"); await app.onKey({ name: "enter" }); await app.onKey({ name: "enter" });
    await until(() => app.page!.questions.open.length === 0);
    expect((await all(app.page!.project))[0]!.answer).toBe("qHL: answer");
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
    expect(names(app)).toEqual(["worker-live", "worker-queued", "▸ Archived (1)"]);
    expect(term.display.screen()[3]).toMatch(/^› worker-live +running/);
    await key(app, "a"); await until(() => term.screen().includes("worker-old"));
    await key(app, "D"); await until(() => term.screen().includes("Archive 1 finished agents?"));
    await key(app, "y"); await until(() => removed.length === 1);
    expect(removed).toEqual([["worker-old"]]);
  } finally { await stop(); }
});

test("Tasks is the outline as rows: h/l and ←/→ fold instead of switching tabs; abandoning asks and keeps the task and its dependents", async () => {
  const { registerTask, getTask, setTaskDependencies } = await import("../core/data/tasks/tasks");
  const project = "tasks-page";
  const { app, term, stop } = await setup(project, { taskCount: undefined });
  try {
    const parent = await registerTask(project, { name: "Parent", summary: "Keep the ledger", branch: "feat/parent", authorized: true });
    const child = await registerTask(project, { name: "Child", summary: "Dependent work", branch: "feat/child", authorized: true });
    await setTaskDependencies(project, child.id, [parent.id]);
    term.press({ name: "t", ctrl: true });
    await until(() => term.screen().includes("Task #1 Parent"));
    expect(term.display.screen().slice(3, 5).map(row => row.trimEnd().replace(/ {2,}/g, " | "))).toEqual(["› ▾ #1 Parent | queued", " | └─ #2 Child | queued"]);
    expect(term.screen()).toContain("Keep the ledger");
    await key(app, "h"); expect(app.work.kind).toBe("tasks"); expect(names(app)).toEqual(["#1 Parent"]);
    await app.onKey({ name: "right" }); expect(names(app)).toEqual(["#1 Parent", "#2 Child"]);
    await key(app, "l"); expect(selected(app)).toBe("#2 Child"); await key(app, "h"); expect(selected(app)).toBe("#1 Parent");
    await key(app, "c"); await until(() => term.screen().includes("1 dependents retained"));
    await key(app, "n"); expect((await getTask(project, parent.id)).attention).toBeUndefined();
    await key(app, "c"); await key(app, "y"); await until(() => term.screen().includes("Task abandoned"));
    expect((await getTask(project, parent.id)).attention?.kind).toBe("cancelled");
    expect((await getTask(project, child.id)).dependsOn).toEqual([parent.id]);
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
    await key(app, "5"); await app.onKey({ name: "enter" });
    await until(() => app.page?.project === "projects-first");
    expect(app.work.open).toBe(false);
  } finally { await stop(); }
});

test("only the kept commands exist; a removed one is unknown; key paths replace the rest", async () => {
  const { app, term, stop } = await setup("commands");
  try {
    expect([...app.commands.keys()].sort()).toEqual(["/accounts", "/clear-context", "/compact", "/effort", "/fast", "/help", "/login", "/model", "/quit", "/rename", "/vim"]);
    for (const gone of ["/stop", "/paste-image", "/remove-image", "/runtime", "/usage", "/refresh", "/projects", "/retry-images", "/keys", "/new", "/close", "/tasks", "/agents", "/images", "/clear", "/project", "/project-defaults", "/questions", "/back"]) {
      term.type(`${gone}\r`);
      await until(() => term.screen().includes(`unknown command ${gone}`));
      expect(app.work.open).toBe(false); expect(app.menu).toBeNull(); expect(app.pages).toHaveLength(1);
    }
    term.type("/rename Kept name\r"); await until(() => app.page!.name === "Kept name");
    term.type("/help\r"); await until(() => app.frame().help !== null);
    expect(app.frame().help!.lines.join("\n")).not.toMatch(/\/(?:agents|tasks|questions|projects|refresh|keys|back|new|close|stop|usage|runtime)\b/);
    term.press({ name: "escape" });
    term.press({ name: "g", ctrl: true }); expect(app.keyEcho).toBe(true); term.press({ name: "escape" }); expect(app.keyEcho).toBe(false);
    term.type("/vim\r"); await until(() => term.screen().includes("[NORMAL]"));
    term.type(":agen"); term.press({ name: "tab" }); term.press({ name: "enter" });
    await until(() => term.screen().includes("unknown command /agen")); // no completion for a removed command
    term.type(":qu"); term.press({ name: "tab" }); await until(() => term.screen().includes(":quit")); term.press({ name: "escape" });
  } finally { await stop(); }
});

test("Vim's Shift letters call their actions directly, with legacy and modified-key input, and never in Insert, a command line or a confirmation", async () => {
  const { app, term, stop } = await setup("shift-routing");
  try {
    await app.openPage("shift-other");
    term.type("/vim\r"); await until(() => term.screen().includes("NORMAL"));
    term.type("\x1b[104;2u"); await until(() => app.page?.project === "shift-routing");
    term.type("\x1b[27;2;108~"); await until(() => app.page?.project === "shift-other");
    for (const [letter, kind] of [["A", "agents"], ["T", "tasks"], ["Q", "questions"], ["P", "images"], ["B", "projects"]] as const) {
      await key(app, letter); expect(app.work.kind).toBe(kind);
      await app.onKey({ name: "escape" }); await app.onKey({ name: letter.toLowerCase(), shift: true }); expect(app.work.kind).toBe(kind);
    }
    await key(app, "?"); expect(app.work.open).toBe(false); expect(app.frame().help).not.toBeNull();
    await key(app, "U"); await until(() => app.menu?.title.includes("accounts") === true);
    await key(app, "M"); await until(() => app.menu?.title.includes("model role") === true);
    await key(app, "F"); await until(() => app.menu?.title.includes("Fast mode") === true);
    await key(app, "S"); await until(() => app.menu?.title.includes("Stop this conversation") === true);
    await app.onKey({ name: "escape" });
    await key(app, "R"); expect(app.menu).toBeNull(); expect(app.work.open).toBe(false); // /refresh is gone, and so is its letter
    await key(app, "i");
    for (const letter of "ATQPBUEMFSVX") await app.onKey({ name: letter.toLowerCase(), shift: true });
    expect(app.input.text).toBe("ATQPBUEMFSVX"); expect(app.work.open).toBe(false); expect(app.menu).toBeNull();
    await app.onKey({ name: "escape" });
    term.type(":HLTA"); await until(() => term.screen().includes(":HLTA"));
    expect(app.page!.project).toBe("shift-other"); expect(app.work.open).toBe(false);
    await app.onKey({ name: "escape" });
    app.page!.orch.checkClear = async () => {};
    app.page!.orch.clear = async () => { throw new Error("must not clear"); };
    await app.commands.get("/clear-context")!.run("", app.page);
    expect(app.menu?.title).toContain("clear conversation");
    await key(app, "H"); await key(app, "A");
    expect(app.page!.project).toBe("shift-other"); expect(app.work.open).toBe(false);
    await app.onKey({ name: "escape" });
  } finally { await stop(); }
});

test("Vim keeps drafts, switches project tabs from chat, pages and menus, and tags the page's status line", async () => {
  const { app, term, fake, stop } = await setup("vim-first");
  try {
    await app.openPage("vim-second");
    term.type("/vim\r"); await until(() => term.screen().includes("[NORMAL]"));
    expect(term.display.screen().some(row => row.startsWith("┌─ [NORMAL]"))).toBe(true);
    term.type("gT"); await until(() => app.page?.project === "vim-first");
    term.type("idraft text"); await until(() => app.input.text === "draft text");
    term.press({ name: "escape" }); await until(() => term.screen().includes("[NORMAL]"));
    await key(app, "h"); await key(app, "l"); expect(app.page!.project).toBe("vim-first"); // plain h/l move in the draft
    term.type("L"); await until(() => app.page?.project === "vim-second");
    term.type("T"); await until(() => term.display.screen().at(-1)!.startsWith("[NORMAL] "));
    expect(term.display.screen()[0]).not.toContain("[NORMAL]");
    term.type("H"); await until(() => app.page?.project === "vim-first"); expect(app.work.open).toBe(false);
    term.type("M"); await until(() => app.menu?.title.includes("model role") === true);
    term.type("G"); await until(() => app.menu?.index === 3);
    term.type("gg"); await until(() => app.menu?.index === 0);
    term.type("L"); await until(() => app.page?.project === "vim-second"); expect(app.menu).toBeNull();
    term.type("B"); await until(() => app.work.kind === "projects");
    term.type("H"); await until(() => app.page?.project === "vim-first"); expect(app.work.open).toBe(false);
    term.type("P"); term.resize(30, 12); await until(() => term.display.screen().at(-1)!.startsWith("[NORMAL] "));
    term.press({ name: "escape" });
    expect(app.input.text).toBe("draft text");
    expect(Object.values(fake.said).flat()).toEqual([]);
    term.type(":vim\r"); await until(() => !term.screen().includes("[NORMAL]"));
    expect(app.input.text).toBe("draft text");
  } finally { await stop(); }
});
