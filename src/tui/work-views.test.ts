import { expect, test } from "bun:test";
import { appFixture } from "../test/app-fixture";
import { App, type AppDeps } from "./app";
import { all, ask } from "../core/data/inbox/questions";
import type { AgentInfo } from "../protocol";

const { fakeTerm, fakeOrchestrators, until } = appFixture();

async function setup(project: string, extra: Partial<AppDeps> = {}) {
  const term = fakeTerm(120, 28), fake = fakeOrchestrators();
  let spaceChords = false;
  Object.assign(term, { setSpaceChords: (enabled: boolean) => { spaceChords = enabled; } });
  const app = new App({ term, pollMs: 100_000, agents: async () => [], taskCount: async () => [],
    questionDelayMs: 0, openOrchestrator: fake.openOrchestrator, ...extra });
  const running = app.run(project);
  await until(() => app.page?.project === project);
  return { app, term, fake, get spaceChords() { return spaceChords; }, stop: async () => { app.quit(); await running; } };
}

test("held-Space events repeat across pages, with no sticky prefix or changes to typing", async () => {
  const fixture = await setup("held-first");
  const { app, term, fake, stop } = fixture;
  const chord = (text: string) => app.onKey({ name: "space-chord", text });
  const char = (text: string) => app.onKey({ name: "char", text });
  try {
    await app.openPage("held-second");
    expect(fixture.spaceChords).toBe(false);
    await chord("h"); expect(app.page!.project).toBe("held-second");
    term.type("/vim\r"); await until(() => fixture.spaceChords);
    for (const [key, project] of [["h", "held-first"], ["l", "held-second"], ["h", "held-first"]] as const) {
      await chord(key); expect(app.page!.project).toBe(project);
    }
    for (const [key, title] of [["a", "AGENTS"], ["t", "TASKS"], ["q", "QUESTIONS"], ["p", "IMAGES"]] as const) {
      await chord(key); await until(() => term.screen().includes(title));
      expect(fixture.spaceChords).toBe(true);
    }
    await chord("b"); expect(app.projectList).not.toBeNull();
    await chord("l"); expect(app.page!.project).toBe("held-second");
    expect(app.projectList).toBeNull();
    await chord("m"); expect(app.menu?.title).toContain("model role");
    await chord("h"); expect(app.menu).toBeNull();
    await char("l"); expect(app.page!.project).toBe("held-first"); // released: local motion
    await char("i"); expect(fixture.spaceChords).toBe(false);
    await char("draft h l"); await chord("l");
    expect(app.input.text).toBe("draft h l"); expect(app.page!.project).toBe("held-first");
    await app.onKey({ name: "escape" }); expect(fixture.spaceChords).toBe(true);
    await char(":"); expect(fixture.spaceChords).toBe(false);
    await chord("l"); await char("help");
    expect(app.page!.project).toBe("held-first");
    await app.onKey({ name: "escape" }); expect(fixture.spaceChords).toBe(true);
    expect(app.input.text).toBe("draft h l");
    expect(Object.values(fake.said).flat()).toEqual([]);
  } finally { await stop(); }
});

test("Vim keeps drafts, switches project tabs and routes commands without Ctrl chords", async () => {
  const { app, term, fake, stop } = await setup("vim-first");
  try {
    await app.openPage("vim-second");
    term.type("/vim\r"); await until(() => term.screen().includes("[NORMAL]"));
    expect(term.display.screen()[0]).not.toContain("[NORMAL]");
    expect(term.display.screen().some(row => row.startsWith("┌─ [NORMAL]"))).toBe(true);
    term.type("gT"); await until(() => app.page?.project === "vim-first");
    term.type("idraft text"); await until(() => app.input.text === "draft text");
    await until(() => term.screen().includes("[INSERT]"));
    const cursor = [term.display.row, term.display.col];
    expect(term.display.screen()[0]).not.toContain("[INSERT]");
    expect(term.display.screen().some(row => row.startsWith("┌─ [INSERT]"))).toBe(true);
    term.press({ name: "escape" }); await until(() => term.screen().includes("[NORMAL]"));
    expect([term.display.row, term.display.col]).toEqual(cursor);
    expect(app.input.text).toBe("draft text");
    term.type("gt"); await until(() => app.page?.project === "vim-second");
    term.type("gT"); await until(() => app.page?.project === "vim-first");
    expect(app.input.text).toBe("draft text");
    term.type(" m"); await until(() => app.menu?.title.includes("model role") === true);
    term.press({ name: "escape" });
    term.type(" f"); await until(() => app.menu?.title.includes("Fast mode") === true);
    term.press({ name: "escape" });
    term.type(":tasks\r"); await until(() => term.screen().includes("TASKS"));
    expect(term.display.screen()[0]).not.toContain("[NORMAL]");
    expect(term.display.screen().slice(-2).join("\n")).toContain("[NORMAL]");
    term.press({ name: "escape" }); await until(() => !term.screen().includes("TASKS"));
    expect(app.input.text).toBe("draft text");
    expect(Object.values(fake.said).flat()).toEqual([]);
    term.type(":vim\r"); await until(() => !term.screen().includes("[NORMAL]"));
    expect(app.input.text).toBe("draft text");
  } finally { await stop(); }
});

test("Normal Space+h/l switches tabs from chat, work pages and menus, while Insert and commands keep text", async () => {
  const { app, term, stop } = await setup("zx-first");
  try {
    await app.openPage("zx-second");
    term.type("/vim\r"); await until(() => term.screen().includes("NORMAL"));
    await app.onKey({ name: "char", text: "H" }); await app.onKey({ name: "char", text: "L" });
    expect(app.page!.project).toBe("zx-second"); // The old Shift shortcuts no longer change projects.
    term.type(" h"); await until(() => app.page?.project === "zx-first");
    term.type("izx h l"); await until(() => app.input.text === "zx h l");
    expect(app.page!.project).toBe("zx-first");
    term.press({ name: "escape" }); term.type(" l"); await until(() => app.page?.project === "zx-second");
    term.type(" q"); await until(() => term.screen().includes("QUESTIONS"));
    term.type(" h"); await until(() => app.page?.project === "zx-first");
    expect(app.input.text).toBe("zx h l");
    term.type(" m"); await until(() => app.menu?.title.includes("model role") === true);
    term.type(" l"); await until(() => app.page?.project === "zx-second");
    expect(app.menu).toBeNull();
    term.type(" b"); await until(() => app.projectList !== null);
    term.type(" h"); await until(() => app.page?.project === "zx-first");
    expect(app.projectList).toBeNull();
    await app.onKey({ name: "char", text: " " }); await app.onKey({ name: "char", text: "x" });
    expect(app.page!.project).toBe("zx-first");
    term.type(":zx"); await until(() => term.screen().includes(":zx"));
    expect(app.page!.project).toBe("zx-first");
  } finally { await stop(); }
});

test("Questions displays its own split view and answers the selected question", async () => {
  const { app, term, stop } = await setup("questions-split");
  try {
    const questions = await ask("questions-split", [{ text: "First question?", options: ["one"] }, { text: "Second question?", options: ["two"] }]);
    await app.refreshSessions();
    await until(() => term.screen().includes("0 agents | 0 tasks | 2 questions"));
    expect(app.commands.has("/inbox")).toBe(false);
    term.type("/vim\r"); await until(() => term.screen().includes("NORMAL"));
    term.type(" q");
    await until(() => term.screen().includes("QUESTIONS") && term.screen().includes("Second question?") && term.screen().includes(" │ "));
    term.type("j");
    term.press({ name: "enter" });
    await until(() => app.frame().question?.text === "Second question?");
    expect(term.screen()).toContain("QUESTIONS");
    expect(term.screen()).not.toContain("0 agents | 0 tasks");
    await app.onKey({ name: "char", text: "1" });
    await until(() => app.page!.questions.open.length === 1);
    const stored = await all("questions-split");
    expect(stored.find(q => q.id === questions[0]!.id)?.status).toBe("open");
    expect(stored.find(q => q.id === questions[1]!.id)?.answer).toBe("two");
  } finally { await stop(); }
});

test("q backs out of pages and menus; question drafts survive and Insert q/H/L remain text", async () => {
  const { app, term, stop } = await setup("vim-question-drafts");
  try {
    await ask(app.page!.project, [{ text: "Describe the result" }]);
    term.type("/vim\r"); await until(() => term.screen().includes("NORMAL"));
    term.type("ichat draft"); await until(() => app.input.text === "chat draft");
    term.press({ name: "escape" });
    for (const command of ["a", "t", "p", "b", "m", "?"]) {
      await app.onKey({ name: "char", text: " " }); await app.onKey({ name: "char", text: command });
      await app.onKey({ name: "char", text: "q" });
      expect(app.menu).toBeNull(); expect(app.projectList).toBeNull();
      expect(app.input.text).toBe("chat draft");
    }
    term.type(" q"); await until(() => term.screen().includes("Describe the result"));
    await app.onKey({ name: "enter" });
    await app.onKey({ name: "char", text: "i" });
    term.type("qHL answer"); await until(() => app.input.text === "qHL answer");
    expect(term.screen()).toContain("QUESTIONS");
    await until(() => term.screen().includes("[INSERT]"));
    expect(term.display.screen()[0]).not.toContain("INSERT");
    expect(term.display.screen().findIndex(row => row.includes("[INSERT]"))).toBeGreaterThan(0);
    term.press({ name: "escape" }); // Insert -> Normal, preserving answer
    await app.onKey({ name: "char", text: "q" }); // form -> list
    expect(app.page!.questions.expanded).toBe(false);
    expect(app.input.text).toBe("chat draft");
    await app.onKey({ name: "char", text: "q" }); // list -> chat
    await until(() => !term.screen().includes("QUESTIONS"));
    expect(term.screen()).not.toContain("Describe the result");
    term.type(" q"); await until(() => term.screen().includes("QUESTIONS"));
    await app.onKey({ name: "enter" });
    expect(app.input.text).toBe("qHL answer");
    // Opening another page restores the chat buffer; it cannot capture unseen answers.
    term.type(" m"); await until(() => app.menu !== null);
    expect(app.page!.questions.expanded).toBe(false);
    expect(app.input.text).toBe("chat draft");
    await app.onKey({ name: "char", text: "q" });
    term.type(" q"); await until(() => term.screen().includes("QUESTIONS"));
    await app.onKey({ name: "enter" });
    await app.onKey({ name: "enter" });
    await until(() => app.page!.questions.open.length === 0);
    expect((await all(app.page!.project))[0]!.answer).toBe("qHL answer");
    expect(app.input.text).toBe("chat draft");
  } finally { await stop(); }
});

test("Agents history hides unverified rows and archives only eligible finished runs", async () => {
  const removed: string[][] = [];
  const agents: AgentInfo[] = [
    { name: "worker-live", live: true, status: "running", queuedMessages: 0 },
    { name: "worker-uncertain", live: false, status: "unknown" },
    { name: "worker-old", live: false, status: "exited", queuedMessages: 0, lastActiveAt: "2000-01-01" },
    { name: "worker-queued", live: false, status: "exited", queuedMessages: 2 },
  ];
  const { app, term, stop } = await setup("agents-split", { agents: async () => agents,
    archiveAgents: async (_project, names) => {
      removed.push(names);
      for (const row of agents) if (names.includes(row.name)) row.archived = true;
      return { archived: names, live: [] };
    },
  });
  try {
    await app.commands.get("/agents")!.run("", app.page);
    await until(() => term.screen().includes("worker-live"));
    expect(term.screen()).not.toContain("worker-uncertain");
    expect(term.screen()).not.toContain("worker-old");
    expect(term.screen()).not.toContain("hidden");
    term.type("a"); await until(() => term.screen().includes("worker-old"));
    term.type("D"); await until(() => term.screen().includes("Archive 1 finished agents?"));
    term.type("y"); await until(() => removed.length === 1);
    expect(removed).toEqual([["worker-old"]]);
  } finally { await stop(); }
});

test("Tasks confirms abandonment and retains the task and its dependents", async () => {
  const { registerTask, getTask, setTaskDependencies } = await import("../core/data/tasks/tasks");
  const project = "tasks-abandon";
  const fixture = await setup(project, { taskCount: undefined });
  const { app, term, stop } = fixture;
  try {
    const parent = await registerTask(project, { name: "Parent", summary: "Keep the ledger", branch: "feat/parent", authorized: true });
    const child = await registerTask(project, { name: "Child", summary: "Dependent work", branch: "feat/child", authorized: true });
    await setTaskDependencies(project, child.id, [parent.id]);
    term.type("/vim\r"); await until(() => fixture.spaceChords);
    await app.commands.get("/tasks")!.run("", app.page);
    await until(() => term.screen().includes("Task #1 · queued"));
    term.type("A"); await until(() => term.screen().includes("1 dependents retained"));
    expect(fixture.spaceChords).toBe(false);
    await app.onKey({ name: "space-chord", text: "y" });
    await app.onKey({ name: "space-chord", text: "h" });
    expect(app.page!.project).toBe(project);
    expect((await getTask(project, parent.id)).attention).toBeUndefined();
    term.type("n"); expect((await getTask(project, parent.id)).attention).toBeUndefined();
    expect(fixture.spaceChords).toBe(true);
    term.type("A"); await until(() => term.screen().includes("1 dependents retained"));
    term.type("y"); await until(() => term.screen().includes("Task abandoned"));
    expect((await getTask(project, parent.id)).attention?.kind).toBe("cancelled");
    expect((await getTask(project, child.id)).dependsOn).toEqual([parent.id]);
  } finally { await stop(); }
});

test("Ctrl+Q and Ctrl+A open work pages from chat and other work pages without changing drafts", async () => {
  const { app, term, stop } = await setup("work-shortcuts");
  try {
    await ask("work-shortcuts", [{ text: "Choose one", options: ["A", "B"] }]);
    app.input = { text: "keep this draft", cursor: 4 };
    term.press({ name: "q", ctrl: true });
    await until(() => term.screen().includes("QUESTIONS") && term.screen().includes("Choose one"));
    expect(app.page!.questions.expanded).toBe(false);
    expect(app.input.text).toBe("keep this draft");
    term.press({ name: "a", ctrl: true });
    await until(() => term.screen().includes("AGENTS"));
    term.press({ name: "t", ctrl: true });
    await until(() => term.screen().includes("TASKS"));
    term.press({ name: "q", ctrl: true });
    await until(() => term.screen().includes("QUESTIONS"));
    term.press({ name: "escape" });
    expect(app.input).toEqual({ text: "keep this draft", cursor: 4 });
  } finally { await stop(); }
});

test("Normal mode navigates work pages, settings, help and projects and switches between them", async () => {
  const { app, term, stop } = await setup("work-vim");
  try {
    term.type("/vim\r"); await until(() => term.screen().includes("NORMAL"));
    term.type(" q"); await until(() => term.screen().includes("QUESTIONS"));
    term.type(" a"); await until(() => term.screen().includes("AGENTS"));
    term.type(" t"); await until(() => term.screen().includes("TASKS"));
    term.type(" p"); await until(() => term.screen().includes("IMAGES"));
    term.type(" m"); await until(() => app.menu?.title.includes("model role") === true);
    term.type("G"); await until(() => app.menu?.index === 3);
    term.type("gg"); await until(() => app.menu?.index === 0);
    term.type("jk"); await until(() => app.menu?.index === 0);
    term.type(" ?"); await until(() => app.frame().help !== null);
    term.type("G"); await until(() => (app.frame().help?.top ?? 0) > 0);
    term.type("gg"); await until(() => app.frame().help?.top === 0);
    term.type(" b"); await until(() => app.projectList !== null);
    // Keep filesystem discovery independent from navigation coverage.
    app.projectList!.items = [
      { name: "first", label: "First", pinned: false },
      { name: "second", label: "Second", pinned: false },
    ];
    term.type("G"); await until(() => app.projectList!.index === 1);
    term.type("gg"); await until(() => app.projectList!.index === 0);
    term.type("jk"); await until(() => app.projectList!.index === 0);
    term.type(" p"); await until(() => term.screen().includes("IMAGES"));
    term.resize(30, 12);
    await until(() => term.screen().includes("IMAGES"));
    expect(term.display.screen()[0]).not.toContain("NORMAL");
    expect(term.display.screen().slice(-2).join("\n")).toContain("[NORMAL]");
    expect(app.input.text).toBe("");
  } finally { await stop(); }
});
