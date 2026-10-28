import { appFixture } from "../test/app-fixture";
import { describe, expect, test } from "bun:test";
import { mkdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import type { Orchestrator } from "../core/agent-loop/orc/orchestrator";
import { paths } from "../config/config";
import { App, helpLines, parseCommand, type Clock, type ToolEvents } from "./app";
import { createOrchestrator } from "../core/agent-loop/orc/orchestrator";
import { drain, put } from "../core/data/inbox/inbox";
import type { Message } from "../protocol/inbox";
import { all as allQuestions, answer as answerQuestion, ask as askQuestions } from "../core/data/inbox/questions";
import { answeredNote, fileStore, queuedAnswer, type QuestionStore } from "./footer/questions";
import { fakeProvider, text as said, toolUse } from "../test/fake-provider";
import { message } from "../core/tools/message";
import { registerTask } from "../core/data/tasks/tasks";
import { makeSpawn } from "../core/tools/spawn";
import { open as openTranscript } from "../core/data/transcripts/transcript";
import { bold, dim } from "./components/text";
import { setUserFill } from "./components/style";
import { Calls } from "./conversation/tools";

const { home, screenErrors, USER_BG, strip, raw, fakeTerm, bodyStart, bodyRows, clickRow, fakeOrchestrators, settle, NO_REPLY_WINDOW, until } = appFixture();

describe("markdown replies", () => {
  const TABLE = "| Branch | What it does |\n|---|---|\n| tui-markdown | Render markdown in the chat area |\n";

  test("streamed markdown is rendered block by block; held blocks show raw in the live region; the rest stays plain", async () => {
    const term = fakeTerm(60, 12);
    const orchs = fakeOrchestrators();
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000 });
    const running = app.run("alpha");
    await until(() => !!app.page);
    term.type("keep **this** raw\r");
    await until(() => term.screen().includes("> keep **this** raw"));
    const write = orchs.writers.alpha! as (t: string, plain?: boolean) => void;
    write("Some **bold** and snake_case\n| Branch | What");
    await until(() => term.screen().includes("Some bold and snake_case"));
    await until(() => term.display.screen().some((r) => r === "| Branch | What")); // held, raw, in the live region
    write(TABLE.slice("| Branch | What".length));
    await settle();
    expect(term.screen()).not.toContain("┬");
    write("\x1b[2m▸ bash {\"command\":\"**ls**\"}\x1b[0m\n", true); // a tool line ends the table and stays plain
    await until(() => term.screen().includes('▸ bash {"command":"**ls**"}'));
    expect(term.screen()).toContain("│ tui-markdown │ Render markdown in the chat area │");
    // The footer gap costs one body row: the table's top is reachable by scrolling,
    // rather than requiring the whole table AND the trailing tool to fit at once.
    term.press({ name: "pageup" });
    await until(() => term.screen().includes("┬"));
    expect(app.page!.lines.slice(-3).map((l) => (typeof l === "string" ? "plain" : "md" in l ? l.md : "user" in l ? l.user : l.tool))).toEqual(["Some **bold** and snake_case", TABLE.trimEnd(), "plain"]);
    app.quit();
    await running;
  });

  test("replies render as markdown after their sender, and a resize re-lays out a table from the raw text", async () => {
    const term = fakeTerm(60, 50);
    const orchs = fakeOrchestrators();
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000 });
    const running = app.run("alpha");
    await until(() => !!app.page);
    const page = app.page!;
    (page.orch as { turn: () => Promise<unknown> }).turn = async () => {
      orchs.writers.alpha!(`Plan:\n${TABLE}`);
      return [{ from: "orchestrator", text: `**Done**: see below\n\n${TABLE}`, ts: "t" }];
    };
    term.type("go\r");
    await until(() => term.screen().includes("orchestrator Done: see below"));
    const wide = "│ tui-markdown │ Render markdown in the chat area │";
    await until(() => term.screen().split(wide).length === 3);
    expect(page.lines.some((l) => typeof l === "string" && l.includes("┌"))).toBe(false); // raw kept, not rendered rows
    term.resize(34, 60);
    await Bun.sleep(150);
    await until(() => term.screen().includes("orchestrator Done: see below"));
    const shown = term.screen().split("\n");
    expect(shown).not.toContain(wide);
    expect(shown.filter((r) => r === "│ tui-markdown │ Render markdown │").length).toBe(2);
    expect(shown.every((r) => Bun.stringWidth(r) <= 34)).toBe(true);
    app.quit();
    await running;
  });
});

describe("restored pages", () => {
  test("a page restores its transcript between the bars, including after switching back", async () => {
    const t = openTranscript(paths.transcript("resumed", "orchestrator"));
    await t.append({ type: "meta", role: "orchestrator", model: "m" });
    await t.append({ type: "message", message: { role: "user", content: "[user] what changed?" } });
    await t.append({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "**Two** things:\n- a\n- b\n", citations: null }, { type: "tool_use", id: "x1", name: "bash", input: { command: "ls" } }] } });
    await t.append({ type: "message", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x1", content: "SECRET-RESULT" }, { type: "text", text: "[worker-feat] all done" }] } });
    await t.append({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Worker done.", citations: null }] } });
    const term = fakeTerm(50, 40);
    term.display.write("shell$ orca start\r\n");
    const orchs = fakeOrchestrators();
    // The page is built from the transcript its orchestrator loaded.
    const openOrchestrator: typeof orchs.openOrchestrator = async (...args) => ({ ...(await orchs.openOrchestrator(...args)), entries: () => (args[0] === "resumed" ? t.branch() : []) });
    const app = new App({ term, openOrchestrator, pollMs: 100_000 });
    const running = app.run("resumed");
    await until(() => term.screen().includes("Worker done."));
    const restored = ["[resumed]", "> what changed?", "Two things:", "- a", "- b", "⏺ bash(ls)", "  ⎿  1 line", "from worker-feat: all done", "Worker done."];
    const rows = term.screen().split("\n");
    expect(rows[0]).toContain(">[resumed]");
    expect(bodyRows(term).filter(Boolean).slice(0, restored.length - 1)).toEqual(restored.slice(1));
    expect(term.display.buf[term.display.top + term.display.row]!.join("").trimEnd()).toMatch(/^│> +│$/); // boxed input before the counts
    expect(term.screen()).not.toContain("SECRET-RESULT");
    expect(term.display.clears).toBe(0); // printed under the shell's output, nothing cleared

    // Typing continues the page under the restored lines.
    term.type("more\r");
    await until(() => term.screen().includes("resumed says hi"));
    expect(term.screen().indexOf("Worker done.")).toBeLessThan(term.screen().indexOf("> more"));

    // Another page, then back: the restored history is reprinted with the rest.
    term.type("/new elsewhere\r");
    await until(() => app.page?.project === "elsewhere");
    await until(() => !term.screen().includes("Worker done."));
    term.type("\x1a"); // Ctrl+Z
    await until(() => term.screen().includes("Worker done.") && term.screen().includes("resumed says hi"));
    expect(bodyRows(term).filter(Boolean).slice(0, restored.length - 1)).toEqual(restored.slice(1));
    app.quit();
    await running;
  });

  test("a restored page shows what it showed live: real orchestrator, scripted model", async () => {
    mkdirSync(paths.project("fidelity"), { recursive: true });
    const taskId = (await registerTask("fidelity", { name: "Feature", summary: "Test work", branch: "feat", authorized: true })).id;
    const TABLE_MD = "| a | b |\n|---|---|\n| 1 | 2 |";
    const runner = { async start() { await put("fidelity", "orchestrator", { from: "worker-feat", text: "Report:\n\nall green" }); }, async stop() {}, async running() { return []; } };
    const tools = { spawn: makeSpawn(runner), message };
    const provider = fakeProvider([
      [said(`Plan:\n${TABLE_MD}\nthen *go*`), toolUse("t1", "spawn", { taskId, prompt: "do it", branch: "feat" })],
      [said("```ts\nconst x = 1;\n"), toolUse("t2", "message", { to: "user", text: "Started **feat**." })],
      [said("All set.")],
      // A second turn, started by the poll: a message from `orca msg` and a report, nothing typed here.
      [said("Got it."), toolUse("t3", "message", { to: "user", text: "Second." })],
      [said("Done.")],
    ]);
    const open = (p: string, _u: string | undefined, write: (t: string, plain?: boolean) => void, onInbox?: (msgs: Message[]) => void, events?: ToolEvents) =>
      createOrchestrator({ project: p, provider, tools, write, onInbox, ...events });
    // Both lines are typed before the first turn reads the inbox: its turn waits for the second say to land.
    const typed: Promise<void>[] = [];
    const openLive: typeof open = async (...args) => {
      const orch = await open(...args);
      return { ...orch, say: (t) => { const p = orch.say(t); typed.push(p); return p; }, turn: async () => { await until(() => typed.length === 2); await Promise.all(typed); return orch.turn(); } };
    };
    const term = fakeTerm(60, 50);
    const app = new App({ term, openOrchestrator: openLive, pollMs: 30, watchdog: async () => {}, merges: async () => {} });
    const running = app.run("fidelity");
    await until(() => !!app.page);
    term.type("go\nnow\r");
    await until(() => term.screen().includes("orchestrator Started feat."));
    await until(() => !app.page!.busy);
    await put("fidelity", "orchestrator", { from: "user", text: "from the cli" });
    await put("fidelity", "orchestrator", { from: "worker-feat", text: "more" });
    await until(() => term.screen().includes("orchestrator Second."));
    await until(() => !app.page!.busy);
    const live = app.page!.lines;
    expect(live.map(raw)).toContain("All set.");
    expect(live.filter((l) => typeof l !== "string" && "tool" in l)).toEqual([
      { tool: "spawn(feat, worker)", summary: "spawned worker-feat", failed: false },
      { tool: "message(user: Started **feat**.)", summary: "sent to user", failed: false },
      { tool: "message(user: Second.)", summary: "sent to user", failed: false },
    ]);
    expect(term.screen()).toContain("⏺ spawn(feat, worker)\n  ⎿  spawned worker-feat");
    expect(live.map(raw).filter((l) => l.endsWith("> go") || l.endsWith("m go"))).toEqual([`${bold(">")} go`]); // typed here: shown once
    expect(live.map(raw)).toContain(`${bold(">")} from the cli`);
    expect(live.map(raw).some((l) => l.includes("from worker-feat: Report:…"))).toBe(true);
    app.quit();
    await running;

    const again = new App({ term: fakeTerm(60, 30), openOrchestrator: open, pollMs: 100_000 });
    const running2 = again.run("fidelity");
    await until(() => !!again.page);
    expect(again.page!.lines).toEqual(live);
    again.quit();
    await running2;
  });

  test("input history is saved per project and survives a restart; blanks and repeats are not saved", async () => {
    mkdirSync(paths.project("remembers"), { recursive: true }); // what openOrchestrator's ensureProject makes
    const term = fakeTerm();
    const app = new App({ term, openOrchestrator: fakeOrchestrators().openOrchestrator, pollMs: 100_000 });
    const running = app.run("remembers");
    await until(() => !!app.page);
    for (const t of ["one\r", "one\r", "   \r", "two\x1b\rlines\r", "/help\r"]) { term.type(t); await settle(); }
    await until(() => app.page!.inputHistory.length === 3);
    const page = app.page!;
    app.quit();
    await running;
    await page.savingHistory;
    expect(await Bun.file(paths.inputHistory("remembers")).text()).toBe(['"one"', '"two\\nlines"', '"/help"', ""].join("\n"));

    const term2 = fakeTerm();
    const again = new App({ term: term2, openOrchestrator: fakeOrchestrators().openOrchestrator, pollMs: 100_000 });
    const running2 = again.run("remembers");
    await until(() => !!again.page);
    term2.press({ name: "up" });
    expect(again.input.text).toBe("/help");
    term2.press({ name: "up" });
    expect(again.input.text).toBe("two\nlines");
    term2.press({ name: "up" }); // first row of the multi-line entry, then on to history
    term2.press({ name: "up" });
    expect(again.input.text).toBe("one");
    term2.press({ name: "up" });
    expect(again.input.text).toBe("one"); // oldest
    // Another project has its own history.
    term2.type("\x1b"); // Esc clears
    term2.type("/new fresh\r");
    await until(() => again.page?.project === "fresh");
    term2.press({ name: "up" });
    expect(again.input.text).toBe("");
    term2.type("\x1a"); // Ctrl+Z: back to the page "/new fresh" was typed on
    term2.press({ name: "up" });
    expect(again.input.text).toBe("/new fresh");
    again.quit();
    await running2;
  });

  test("secrets never reach the input history: /login, credentials in a /new URL, anything typed while signing in", async () => {
    mkdirSync(paths.project("secrets"), { recursive: true });
    let finish!: (s: string) => void;
    const login = async () => new Promise<string>((r) => (finish = r));
    const term = fakeTerm();
    const app = new App({ term, openOrchestrator: fakeOrchestrators().openOrchestrator, pollMs: 100_000, login });
    const running = app.run("secrets");
    await until(() => !!app.page);
    const page = app.page!;
    term.type("hello\r");
    term.type("/login claude work\r");
    await until(() => app.loggingIn);
    term.type("my api key is TOKEN-1\r"); // typed while signing in
    await until(() => term.screen().includes("queued; runs after sign-in"));
    finish("signed in");
    await until(() => !app.loggingIn);
    term.type("/new other https://me:TOKEN-2@github.com/a/b.git\r");
    await until(() => app.page?.project === "other");
    term.type("\x1a"); // back to secrets
    await until(() => app.page === page);
    term.type("/agents\r");
    await until(() => page.inputHistory.length === 2);
    await page.savingHistory;
    const saved = await Bun.file(paths.inputHistory("secrets")).text();
    expect(saved).toBe('"hello"\n"/agents"\n');
    expect(page.inputHistory).toEqual(["hello", "/agents"]);
    app.quit();
    await running;
  });
});

describe("orchestrator questions", () => {
  const PICK = "↑↓ or 1–9 choose · enter pick · type to answer · esc/tab later";
  const ANSWER = "enter send · esc/tab close";
  const GUARD = "send or clear your message to answer";
  const live = (term: ReturnType<typeof fakeTerm>) => term.display.screen().join("\n"), note = (app: App) => strip(app.frame().inputArea!.lines.join("\n"));
  const ask1 = (project: string, text: string, options?: string[], def?: string) => askQuestions(project, [{ text, ...(options ? { options } : {}), ...(def ? { default: def } : {}) }]);
  const statusOf = async (project: string) => (await allQuestions(project)).map((q) => [q.text, q.status, q.answer ?? null]);
  /** An app on `project` with a fake orchestrator whose inbox callback is kept, no question delay unless given. */
  async function start(project: string, extra: Partial<ConstructorParameters<typeof App>[0]> = {}) {
    const term = fakeTerm(70, 24); // Leave room for the temporary status row and question choices.
    const orchs = fakeOrchestrators();
    let onInbox: ((msgs: Message[]) => void) | undefined;
    const openOrchestrator = async (p: string, u: string | undefined, w: (t: string, plain?: boolean) => void, inbox?: (msgs: Message[]) => void) => { onInbox = inbox; return orchs.openOrchestrator(p, u, w); };
    const app = new App({ term, openOrchestrator, pollMs: 20, watchdog: async () => {}, merges: async () => {}, questionDelayMs: 0, ...extra });
    const running = app.run(project);
    await until(() => !!app.page);
    if (!extra.questions && (await allQuestions(project)).some((q) => q.status === "open")) await app.questions.command(app.page); // explicit opt-in
    return { term, orchs, app, running, inbox: (msgs: Message[]) => onInbox!(msgs), stop: async () => { app.quit(); await running; } };
  }

  test("enter on an option answers it; its '? … → …' is a transient note, not conversation; the inbox message reaches the orchestrator", async () => {
    const [q] = await ask1("qa-opt", "Which db?", ["postgres", "sqlite"], "sqlite");
    const { term, orchs, app, stop } = await start("qa-opt");
    await until(() => live(term).includes("? Which db?") && live(term).includes("❯ 1. postgres"));
    expect(live(term)).toContain("type your own answer");
    // The new section heading costs one row at 70x16; decisions scroll to selection.
    expect(app.frame().question?.default).toBe("sqlite");
    expect(live(term)).toContain(PICK);
    expect(live(term)).toContain("inbox 1");
    term.press({ name: "down" });
    await until(() => live(term).includes("❯ 2. sqlite"));
    term.press({ name: "enter" });
    await until(() => term.screen().includes("? Which db? → sqlite"));
    expect(await statusOf("qa-opt")).toEqual([["Which db?", "answered", "sqlite"]]);
    await until(() => !live(term).includes(PICK));
    expect(live(term)).toContain("inbox 0");
    expect(orchs.said["qa-opt"]).toEqual([]); // not sent as a chat message
    const inbox = await drain("qa-opt", "orchestrator");
    expect(inbox.map((m) => [m.from, m.text])).toEqual([["user", `[${q!.id}] answer to "Which db?": sqlite`]]);
    expect([note(app).includes(answeredNote("Which db?", "sqlite")), app.page!.lines]).toEqual([true, []]);
    await stop();
  });

  test("digits 1–9 pick an option on an option row; a digit past the options starts a typed answer", async () => {
    await askQuestions("qa-digit", [{ text: "Which db?", options: ["postgres", "sqlite"] }, { text: "Port?", options: ["80"] }]);
    const { term, app, stop } = await start("qa-digit");
    await until(() => live(term).includes("❯ 1. postgres"));
    term.type("2");
    await until(() => live(term).includes("? Port?"));
    expect([note(app).includes("Which db?"), app.frame().queued?.texts]).toEqual([true, ["? Which db? → sqlite"]]); // Status remains above input while the next question is open
    term.type("9");
    await until(() => live(term).includes("answer> 9"));
    expect(app.page!.questions.open).toHaveLength(1);
    await stop();
  });

  test("arrival never steals a chat draft; ctrl+q opens explicitly and closing preserves it", async () => {
    const { term, app, stop } = await start("qa-guard");
    term.type("hel");
    await ask1("qa-guard", "Which db?", ["postgres"]);
    await until(() => app.page!.questions.open.length === 1);
    expect(app.questions.view()).toBeNull();
    expect(app.input.text).toBe("hel");
    term.press({ name: "q", ctrl: true });
    await until(() => !!app.questions.view());
    expect(app.input.text).toBe("");
    term.press({ name: "escape" });
    await until(() => !app.questions.view());
    expect(app.input.text).toBe("hel");
    expect(await statusOf("qa-guard")).toEqual([["Which db?", "open", null]]);
    await stop();
  });

  test("enter, digits and typing do nothing for a moment after a question first shows", async () => {
    await ask1("qa-delay", "Which db?", ["postgres", "sqlite"]);
    const { term, app, stop } = await start("qa-delay", { questionDelayMs: 400 });
    await until(() => live(term).includes("❯ 1. postgres"));
    term.press({ name: "enter" });
    term.type("2");
    term.type("x");
    await settle();
    expect(await statusOf("qa-delay")).toEqual([["Which db?", "open", null]]);
    expect(app.input.text).toBe("");
    expect(live(term)).toContain("❯ 1. postgres");
    await Bun.sleep(450);
    term.press({ name: "enter" });
    await until(() => term.screen().includes("? Which db? → postgres"));
    await stop();
  });

  test("typing answers in answer mode and keeps the chat draft aside; a question without options goes straight to answer mode; bad text is refused", async () => {
    const { term, orchs, app, stop } = await start("qa-typed");
    await ask1("qa-typed", "Which db?", ["postgres"], "postgres");
    await app.questions.command(app.page);
    await until(() => live(term).includes("? Which db?"));
    term.type("mysql");
    await until(() => live(term).includes("answer> mysql") && live(term).includes(ANSWER));
    expect(live(term)).toContain("❯ type your own answer");
    term.press({ name: "up" }); // back to an option: the typed answer waits
    await until(() => live(term).includes("❯ 1. postgres"));
    expect(app.input.text).toBe("");
    term.press({ name: "down" });
    await until(() => live(term).includes("answer> mysql"));
    term.press({ name: "enter" });
    await until(() => term.screen().includes("? Which db? → mysql"));
    expect(orchs.said["qa-typed"]).toEqual([]);

    await ask1("qa-typed", "Project name?");
    await app.questions.command(app.page);
    await until(() => live(term).includes("? Project name?") && live(term).includes("answer>"));
    term.press({ name: "paste", text: "x".repeat(2001) });
    term.press({ name: "enter" });
    await until(() => term.screen().includes("not sent: answer is over 2000 characters"));
    expect((await allQuestions("qa-typed")).at(-1)!.status).toBe("open");
    term.press({ name: "u", ctrl: true });
    term.type("  shiny  ");
    term.press({ name: "enter" });
    await until(() => term.screen().includes("? Project name? → shiny"));
    expect((await allQuestions("qa-typed")).at(-1)!.answer).toBe("shiny");
    await stop();
  });

  test("esc preserves the answer without sending; only explicit skip silently removes each question", async () => {
    await askQuestions("qa-esc", [{ text: "Port?", options: ["80", "8080"], default: "8080" }, { text: "Host?" }]);
    const { term, app, stop } = await start("qa-esc");
    await until(() => live(term).includes("? Port? (1 of 2)"));
    term.press({ name: "escape" }); // empty input: put off, like Tab
    await until(() => !live(term).includes("? Port?"));
    expect(live(term)).toContain("inbox 2");
    term.type("/questions\r");
    await until(() => live(term).includes("? Port? (1 of 2)"));
    term.type("90");
    await until(() => live(term).includes("answer> 90"));
    term.press({ name: "escape" }); // close, preserving the answer
    await until(() => !live(term).includes("? Port?"));
    expect(await statusOf("qa-esc")).toEqual([["Port?", "open", null], ["Host?", "open", null]]);
    term.type("/questions\r");
    await until(() => live(term).includes("answer> 90")); // preserved
    term.press({ name: "down" }); // to the skip row
    await until(() => live(term).includes("❯ skip — remove from inbox"));
    term.press({ name: "enter" });
    await until(() => live(term).includes("? Host?") && live(term).includes("  skip — remove from inbox"));
    expect(note(app)).toContain("? Port? → skipped"); // Temporary feedback is visible above the answer input
    term.press({ name: "down" }); // a question without options: own answer, then skip
    term.press({ name: "enter" });
    await until(() => term.screen().includes("? Host? → skipped, removed from inbox"));
    expect(await statusOf("qa-esc")).toEqual([["Port?", "skipped", null], ["Host?", "skipped", null]]);
    expect(await drain("qa-esc", "orchestrator")).toEqual([]);
    expect(app.page!.sent).toEqual([]);
    expect(app.status(app.page!)).toEndWith("inbox 0");
    expect([app.page!.lines, note(app).includes(answeredNote("Host?", null))]).toEqual([[], true]); // a skip is a transient note, never a line or a default
    expect(app.input.text).toBe("");
    await stop();
  });

  test("in an agent view inbox Questions is guarded; esc closes it before leaving the separate view", async () => {
    const transcript = paths.transcript("qa-view", "worker-v");
    mkdirSync(join(transcript, ".."), { recursive: true });
    await Bun.write(transcript, JSON.stringify({ type: "message", message: { role: "assistant", content: "worker line" } }) + "\n");
    await ask1("qa-view", "Which db?", ["postgres"]);
    const { term, app, stop } = await start("qa-view", { agents: async () => [{ name: "worker-v", live: false }] });
    await until(() => live(term).includes("? Which db?"));
    term.press({ name: "tab" });
    term.type("/agents\r");
    await until(() => !!app.menu);
    term.press({ name: "enter" });
    await until(() => term.screen().includes("worker line"));
    term.type("/questions\r"); // shown again, but not over an agent view
    await until(() => live(term).includes("questions belong to the project orchestrator"));
    expect(live(term)).not.toContain("Which db?");
    expect(live(term)).toContain("inbox 1");
    expect(live(term)).toContain("questions belong to the project orchestrator");
    term.type("1");
    term.press({ name: "enter" });
    expect(app.input.text).toBe("");
    term.press({ name: "escape" }); // inbox, not agent
    expect(app.page!.view).not.toBeNull();
    term.press({ name: "escape" });
    await until(() => !app.page!.view);
    term.press({ name: "q", ctrl: true });
    await until(() => live(term).includes("? Which db?"));
    expect(await statusOf("qa-view")).toEqual([["Which db?", "open", null]]);
    await stop();
  });

  test("known commands typed as an answer run as commands; other text is the answer", async () => {
    await ask1("qa-cmd", "Name?");
    const { term, stop } = await start("qa-cmd");
    await until(() => live(term).includes("answer>"));
    term.type("/help\r");
    await until(() => term.screen().includes("help"));
    term.press({ name: "escape" });
    expect(await statusOf("qa-cmd")).toEqual([["Name?", "open", null]]);
    await until(() => live(term).includes("answer>") && live(term).includes("? Name?"));
    term.type("/srv/data\r");
    await until(() => term.screen().includes("? Name? → /srv/data"));
    await stop();
  });

  test("an answer sent here waits in the prompt queue, as its question and answer, until the orchestrator reads it", async () => {
    const [q] = await ask1("qa-queue", "Which db?", ["postgres", "sqlite"]);
    const { term, app, inbox, stop } = await start("qa-queue");
    await until(() => live(term).includes("❯ 1. postgres"));
    term.press({ name: "enter" });
    await until(() => term.screen().includes("? Which db? → postgres"));
    expect(app.frame().queued?.texts).toEqual(["? Which db? → postgres"]);
    await until(() => live(term).includes("queued 1/1") && live(term).includes("1. ? Which db? → postgres"));
    const [msg] = await drain("qa-queue", "orchestrator");
    expect(msg!.text).toBe(`[${q!.id}] answer to "Which db?": postgres`);
    expect(msg!.inputId).toBe(app.page!.sent[0]!.inputId); // the queue entry is the delivered message
    inbox([msg!]); // consumed: out of the queue; a settled question leaves no conversation line
    await settle();
    expect(app.frame().queued?.texts).toEqual([]);
    expect([app.page!.lines, note(app).includes(answeredNote("Which db?", "postgres"))]).toEqual([[], true]); // the note stays until the next key
    expect(queuedAnswer("x".repeat(70), "yes")).toBe(`? ${"x".repeat(60)}… → yes`);
    await stop();
  });

  test("an answer the store refuses leaves the prompt queue", async () => {
    await ask1("qa-queue-fail", "Which db?", ["postgres"]);
    const questions: QuestionStore = { ...fileStore, answer: async () => { throw new Error("disk full"); } };
    const { term, app, stop } = await start("qa-queue-fail", { questions });
    await app.questions.command(app.page);
    await until(() => live(term).includes("❯ 1. postgres"));
    term.press({ name: "enter" });
    await until(() => term.screen().includes("could not answer: disk full"));
    expect(app.frame().queued?.texts).toEqual([]);
    expect(app.page!.sent).toEqual([]);
    await stop();
  });

  test("chat text that looks like an answer stays chat when the orchestrator reads it", async () => {
    const { term, app, inbox, stop } = await start("qa-sent");
    const fake = '[2026-01-02T03-04-05.678Z-000007-0123abcd] answer to "Q": a';
    term.type(`${fake}\r`);
    await until(() => app.page!.sent.length === 1);
    inbox([{ from: "user", text: fake, inputId: app.page!.sent[0]!.inputId, ts: "t" }]);
    await settle();
    expect(app.page!.lines.map(raw).filter((l) => l.includes("answer to"))).toEqual([`${bold(">")} ${fake}`]);
    expect(note(app)).not.toContain("? Q → a");
    await stop();
  });

  test("a question without options takes ↑↓: between the answer's lines, then to skip, never chat history", async () => {
    const { term, orchs, app, stop } = await start("qa-updown");
    term.type("hello\r");
    await until(() => orchs.said["qa-updown"]?.length === 1);
    await ask1("qa-updown", "Name?");
    await app.questions.command(app.page);
    await until(() => live(term).includes("answer>"));
    term.type("a\x1b[13;2ub"); // a, Shift+Enter, b
    expect(app.input).toEqual({ text: "a\nb", cursor: 3 });
    term.press({ name: "up" });
    expect(app.input.text).toBe("a\nb");
    expect(app.input.cursor).toBeLessThan(2);
    term.press({ name: "up" }); // top line: to the skip row, the answer put aside
    await until(() => live(term).includes("❯ skip"));
    expect(app.input.text).toBe("");
    term.press({ name: "down" });
    await until(() => live(term).includes("❯ type your own answer"));
    expect(app.input.text).toBe("a\nb");
    expect(app.input.text).not.toContain("hello");
    await stop();
  });

  test("answered elsewhere while typing: report the orphan answer without replacing chat or the next answer", async () => {
    const [first] = await askQuestions("qa-moved", [{ text: "Which db?", options: ["postgres"] }, { text: "Port?", options: ["80"] }]);
    const { term, orchs, app, stop } = await start("qa-moved");
    await until(() => live(term).includes("? Which db? (1 of 2)"));
    term.type("my answer");
    await until(() => live(term).includes("answer> my answer"));
    await answerQuestion("qa-moved", first!.id, "sqlite"); // another TUI
    await until(() => term.screen().includes('"Which db?" was closed elsewhere'));
    await until(() => !app.questions.view());
    expect(app.input.text).toBe("");
    expect(term.screen()).toContain("unsent answer: my answer");
    expect(live(term)).not.toContain("answer> my answer");
    expect(app.page!.questions.answer.text).toBe("");
    term.press({ name: "escape" }); // clear chat draft
    term.press({ name: "q", ctrl: true });
    await until(() => live(term).includes(PICK));
    expect(app.input.text).toBe("");
    expect(orchs.said["qa-moved"]).toEqual([]);
    expect((await allQuestions("qa-moved")).at(-1)!.status).toBe("open");
    await stop();
  });

  test("closed elsewhere before enter: said, the typed answer kept; a reply read later (another TUI's or ours) leaves no line", async () => {
    const [first, second] = await askQuestions("qa-race", [{ text: "Which db?", options: ["postgres"] }, { text: 'Use "a": or (b)?', options: ["80"], default: "x (y)" }]);
    const { term, app, inbox, stop } = await start("qa-race", { pollMs: 100_000 });
    await until(() => live(term).includes("? Which db? (1 of 2)"));
    term.type("mine");
    await answerQuestion("qa-race", first!.id, "sqlite"); // another TUI; no poll sees it
    term.press({ name: "enter" });
    await until(() => term.screen().includes("already closed elsewhere; your answer was not sent"));
    expect(app.input.text).toBe("");
    expect(app.page!.lines.map(raw).join(" ")).not.toContain("unsent answer: mine");
    expect(note(app)).toContain("already closed elsewhere");
    await until(() => !app.questions.view());
    term.press({ name: "escape" });
    term.press({ name: "q", ctrl: true });
    // The orchestrator reads the other TUI's answer: a settled question, no line, as a restored page shows it.
    inbox(await drain("qa-race", "orchestrator"));
    await settle(); expect(term.screen()).not.toContain("? Which db? → sqlite");
    // An option picked here, closed elsewhere first: said too.
    await answerQuestion("qa-race", second!.id, "81");
    await until(() => live(term).includes(PICK));
    term.press({ name: "enter" });
    await until(() => term.screen().split("already closed elsewhere").length === 2);
    inbox(await drain("qa-race", "orchestrator"));
    await settle(); expect(term.screen()).not.toContain('? Use "a": or (b)? → 81');
    // Answered here: the note, and nothing when read.
    await ask1("qa-race", "Again?", ["yes"]);
    term.type("/questions\r");
    await until(() => live(term).includes("? Again?"));
    term.press({ name: "enter" });
    await until(() => note(app).includes(answeredNote("Again?", "yes")));
    inbox(await drain("qa-race", "orchestrator"));
    await settle();
    expect(app.page!.lines.map(raw).join("\n")).not.toContain("Again?");
    await stop();
  });

  test("an answer while a reply streams never splits the reply: the note is above the composer, the partial line continues", async () => {
    await ask1("qa-stream", "Which db?", ["postgres"]);
    const { term, orchs, app, stop } = await start("qa-stream");
    await until(() => live(term).includes("? Which db?"));
    (orchs.writers["qa-stream"] as (t: string, plain?: boolean) => void)("half a rep");
    await until(() => app.page!.md.pending === "half a rep");
    term.press({ name: "enter" });
    await until(() => note(app).includes(answeredNote("Which db?", "postgres")));
    expect(app.page!.md.pending).toBe("half a rep");
    (orchs.writers["qa-stream"] as (t: string, plain?: boolean) => void)("ly\n");
    (orchs.writers["qa-stream"] as (t: string, plain?: boolean) => void)("▸ tool\n", true); // ends the markdown
    await until(() => app.page!.lines.map(raw).join("|") === "half a reply|▸ tool");
    await stop();
  });

  test("Tab puts the queue off so chat works; a new question or /questions shows it again; /questions lists several", async () => {
    await ask1("qa-tab", "Which db?", ["postgres", "sqlite"]);
    const { term, orchs, stop } = await start("qa-tab");
    await until(() => live(term).includes("? Which db?"));
    term.press({ name: "tab" });
    await until(() => !live(term).includes("? Which db?"));
    expect(live(term)).toContain("inbox 1"); // still counted
    term.type("hello\r");
    await until(() => orchs.said["qa-tab"]?.length === 1);
    expect(orchs.said["qa-tab"]).toEqual(["hello"]);
    term.press({ name: "up" }); // history, not the question
    await until(() => live(term).includes("> hello"));
    term.press({ name: "u", ctrl: true });

    await ask1("qa-tab", "Port?");
    await until(() => live(term).includes("inbox 2")); // arrival only updates the count
    await until(() => !live(term).includes("? Which db?"));
    term.type("/questions\r");
    await until(() => live(term).includes("? Which db? (1 of 2)"));
    expect(live(term)).toContain("(1 of 2)");
    expect(orchs.said["qa-tab"]).toEqual(["hello"]);
    await stop();
  });

  test("background pages show their count in the status line", async () => {
    const { term, app, stop } = await start("qa-fg");
    term.type("/new qa-bg\r");
    await until(() => app.page?.project === "qa-bg" && app.pages.length === 2);
    term.type("\x1a"); // back to qa-fg
    await until(() => app.page?.project === "qa-fg");
    await askQuestions("qa-bg", [{ text: "One?" }, { text: "Two?" }]);
    await until(() => live(term).includes("(+2 elsewhere)"));
    expect(live(term)).not.toContain("One?");
    term.type("\x18");
    await until(() => app.page?.project === "qa-bg");
    term.press({ name: "q", ctrl: true });
    await until(() => live(term).includes("? One? (1 of 2)"));
    expect(live(term)).toContain("inbox 2");
    expect(live(term)).not.toContain("qa-bg: 2");
    await stop();
  });

  test("modifier chords never pick, put off or clear a question; ctrl+c cancels, twice quits", async () => {
    await ask1("qa-chord", "Which db?", ["postgres", "sqlite"], "sqlite");
    const { term, app, running } = await start("qa-chord");
    await until(() => live(term).includes("❯ 1. postgres"));
    for (const k of [{ name: "down", ctrl: true }, { name: "down", alt: true }, { name: "enter", ctrl: true }, { name: "escape", alt: true }, { name: "j", ctrl: true }, { name: "2", alt: true }]) term.press(k);
    await settle();
    expect(live(term)).toContain("❯ 1. postgres");
    expect(app.page!.questions.open).toHaveLength(1);
    expect(app.page!.questions.hidden).toBeNull();
    expect(await statusOf("qa-chord")).toEqual([["Which db?", "open", null]]);
    term.press({ name: "c", ctrl: true });
    expect(term.closed).toBe(false);
    term.press({ name: "c", ctrl: true });
    await running;
  });

  test("polls never overlap, and an unchanged questions dir is not re-read", async () => {
    let inFlight = 0;
    let most = 0;
    let lists = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let stamp = 0;
    const store: QuestionStore = {
      stamp: async () => ++stamp, // always changed
      list: async () => { lists++; inFlight++; most = Math.max(most, inFlight); await gate; inFlight--; return []; },
      answer: async () => {}, skip: async () => {},
    };
    const { stop } = await start("qa-poll", { pollMs: 5, questions: store });
    await Bun.sleep(60);
    expect(lists).toBe(1);
    release();
    await until(() => lists > 2);
    expect(most).toBe(1);
    await stop();

    // The real store: a dir unchanged for a while is stat'ed, not read.
    await ask1("qa-mtime", "Which db?");
    const past = new Date(Date.now() - 60_000);
    utimesSync(paths.questions("qa-mtime"), past, past);
    let reads = 0;
    const counting: QuestionStore = { ...fileStore, list: (p) => { reads++; return fileStore.list(p); } };
    const second = await start("qa-mtime", { pollMs: 5, questions: counting });
    await second.app.questions.command(second.app.page);
    await until(() => live(second.term).includes("? Which db?"));
    await Bun.sleep(60);
    expect(reads).toBeLessThanOrEqual(2); // opening explicitly may re-read once
    await ask1("qa-mtime", "Port?"); // the dir changes: read again
    await until(() => live(second.term).includes("(1 of 2)"));
    expect(reads).toBeGreaterThanOrEqual(2);
    await second.stop();
  });

  test("a poll that reads the answer before the close ends is not 'answered elsewhere'; the typed answer leaves the input", async () => {
    await ask1("qa-race", "Which db?", ["postgres"]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let written = false;
    let listsAfter = 0;
    // The answer file is written, then the close waits (as for its inbox message) while polls read it as answered.
    const store: QuestionStore = {
      ...fileStore,
      list: async (p) => { const open = await fileStore.list(p); if (written) listsAfter++; return open; },
      answer: async (p, id, text) => { const q = await fileStore.answer(p, id, text); written = true; await gate; return q; },
    };
    const { term, app, stop } = await start("qa-race", { pollMs: 5, questions: store });
    await app.questions.command(app.page);
    await until(() => live(term).includes("? Which db?"));
    term.type("mysql");
    await until(() => live(term).includes("answer> mysql"));
    term.press({ name: "enter" });
    await until(() => listsAfter >= 2);
    release();
    await until(() => term.screen().includes("? Which db? → mysql"));
    await until(() => !live(term).includes("answer>"));
    expect(term.screen()).not.toContain("answered elsewhere");
    expect(app.input.text).toBe("");
    await ask1("qa-race", "Project name?");
    await app.questions.command(app.page);
    await until(() => live(term).includes("? Project name?") && live(term).includes("answer>"));
    await stop();
  });

  test("a restored page shows a settled question the way the live page did, without its line: real orchestrator, scripted model", async () => {
    await ask1("qa-restore", 'Use "a": or (b)?', ["postgres", "sqlite"], "sqlite");
    const provider = fakeProvider([[said("Noted, sqlite.")]]);
    const open = (p: string, _u: string | undefined, write: (t: string, plain?: boolean) => void, onInbox?: (msgs: Message[]) => void) =>
      createOrchestrator({ project: p, provider, tools: { message }, write, onInbox });
    const { term, app, stop } = await start("qa-restore", { openOrchestrator: open, pollMs: 20 });
    await until(() => live(term).includes("❯ 1. postgres"));
    term.press({ name: "down" });
    term.press({ name: "enter" });
    await until(() => term.screen().includes("Noted, sqlite."));
    await until(() => !app.page!.busy);
    const shown = app.page!.lines;
    expect(shown.map(raw)).toEqual(["Noted, sqlite."]);
    expect(note(app)).toContain("completed");
    await stop();

    const again = await start("qa-restore", { openOrchestrator: open, pollMs: 100_000 });
    expect(again.app.page!.lines).toEqual(shown);
    expect(note(again.app)).not.toContain("→");
    await again.stop();
  });
});

describe("command and key tables", () => {
  const bare = () => new App({ term: fakeTerm(), openOrchestrator: fakeOrchestrators().openOrchestrator, pollMs: 100_000 });

  test("/help is built from all command handlers, with /back contextual and diagnostics grouped last", () => {
    const app = bare();
    const help = helpLines(app.commands, false).join("\n");
    const inView = helpLines(app.commands, true).join("\n");
    for (const name of app.commands.keys()) {
      expect(inView).toContain(name);
      if (name !== "/back") expect(help).toContain(name);
    }
    expect(help).not.toContain("/back");
    expect(help.indexOf("advanced & diagnostics")).toBeGreaterThan(help.indexOf("keyboard · editing"));
    expect(help.indexOf("/keys")).toBeGreaterThan(help.indexOf("advanced & diagnostics"));
    expect([...app.commands.keys()].sort()).toEqual(["/accounts", "/agents", "/back", "/clear", "/close", "/compact", "/dynamic-dispatch", "/effort", "/fast", "/help", "/inbox", "/keys", "/login", "/model", "/new", "/projects", "/questions", "/quit", "/refresh", "/rename", "/retry-images", "/review-rounds", "/runtime", "/usage"]);
  });

  test("parsing: name up to the first space, arguments trimmed; arguments to a command that takes none make it unknown", () => {
    const { commands } = bare();
    expect(parseCommand("hello /quit", commands)).toBeNull();
    expect(parseCommand("  /quit", commands)).toBeNull(); // an indented line is plain text
    expect(parseCommand("/new  a  b", commands)).toMatchObject({ name: "/new", args: "a  b", command: commands.get("/new") });
    expect(parseCommand("/login", commands)).toMatchObject({ name: "/login", args: "", command: commands.get("/login") });
    expect(parseCommand("/quit", commands)!.command).toBe(commands.get("/quit")!);
    expect(parseCommand("/quit now", commands)).toMatchObject({ name: "/quit", command: undefined });
    expect(parseCommand("/new\tx", commands)).toMatchObject({ name: "/new\tx", command: undefined });
    expect(parseCommand("/nope x", commands)).toMatchObject({ name: "/nope", command: undefined });
    for (const [name, c] of commands) if (c.needsPage) expect(["/agents", "/compact", "/runtime", "/usage"]).toContain(name);
  });

  test("unknown commands note 'unknown command /x' (the name only) above the composer, never in the conversation", async () => {
    const term = fakeTerm(80);
    const orchs = fakeOrchestrators();
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000 });
    const running = app.run("alpha");
    await until(() => !!app.page);
    const notes: string[] = [];
    for (const t of ["/nope", "/nope with args", "/quit now", "/help me"]) { term.type(`${t}\r`); await settle(); notes.push(app.frame().inputArea!.lines[0]!); }
    expect(notes).toEqual(["unknown command /nope", "unknown command /nope", "unknown command /quit", "unknown command /help"].map(dim));
    expect(app.page!.lines).toEqual([]);
    expect(orchs.said.alpha).toEqual([]);
    app.quit();
    await running;
  });

  test("guard: with no page, commands that need none run; /agents, unknown commands and plain text open a fresh page instead", async () => {
    const term = fakeTerm(80);
    const orchs = fakeOrchestrators();
    let listed = 0;
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000, agents: async () => { listed++; return []; } });
    const running = app.run("alpha");
    await until(() => !!app.page);
    for (const t of ["/agents", "/nope", "hello"]) {
      term.type("/close\r");
      await until(() => app.pages.length === 0);
      await until(() => app.frame().status === null && term.screen().includes("│>")); // let the close's reprint land first (a reprint with no page drops lines said before it)
      term.type("/help\r"); // needs no page: runs with none
      await until(() => term.screen().includes("help"));
      term.press({ name: "escape" });
      expect(app.pages.length).toBe(0);
      term.type(`${t}\r`);
      await until(() => app.pages.length === 1);
      await Bun.sleep(30);
      expect(app.page!.project).toMatch(/^orch-/);
      expect(orchs.said[app.page!.project]).toEqual([]); // dropped, not sent
    }
    expect(term.screen()).not.toContain("unknown command");
    expect(app.menu).toBeNull(); // background agent-count polling may list agents
    term.type("/agents\r"); // with a page it runs
    await until(() => listed > 0);
    app.quit();
    await running;
  });

  test("guard: in an agent view every command runs; plain text follows the visible recipient", async () => {
    const term = fakeTerm(80);
    const orchs = fakeOrchestrators();
    const feedback: string[] = [];
    const app = new App({ term, feedback: async (project, agent, text) => { feedback.push(`${project}/${agent}: ${text}`); return `delivered to ${agent}`; }, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000 });
    const running = app.run("viewer");
    await until(() => !!app.page);
    const view = { name: "worker-x", lines: [] as string[], leave: () => {}, live: false, calls: new Calls() };
    app.page!.view = view;
    term.type("/keys\r");
    await until(() => app.keyEcho);
    term.press({ name: "escape" });
    term.type("/review-rounds 2\r/nope\r");
    await until(() => app.frame().inputArea!.lines[0] === dim("unknown command /nope")); term.type("hello\r"); // a note, shown over the view too
    await until(() => feedback.length === 1);
    expect(feedback).toEqual(["viewer/worker-x: hello"]);
    expect([view.lines.join("\n").includes("unknown command"), app.page!.lines]).toEqual([false, []]);
    expect(orchs.said.viewer).toEqual([]);
    app.quit();
    await running;
  });

  test("guard: while signing in commands run (a second /login is refused) and plain text is queued", async () => {
    const term = fakeTerm(80);
    const orchs = fakeOrchestrators();
    let finish!: () => void;
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000, login: async () => { await new Promise<void>((r) => (finish = r)); return "signed in"; } });
    const running = app.run("signer");
    await until(() => !!app.page);
    term.type("/login codex\r");
    await until(() => app.loggingIn);
    term.type("/login openai\r");
    await until(() => term.screen().includes("already signing in"));
    term.type("/keys\r");
    await until(() => app.keyEcho && term.screen().includes("press keys; esc ends"));
    term.press({ name: "escape" });
    term.type("hi\r");
    await until(() => term.screen().includes("queued; runs after sign-in"));
    expect(orchs.said.signer).toEqual([]);
    finish();
    await until(() => orchs.said.signer?.length === 1);
    app.quit();
    await running;
  });

  test("key layers run in the documented order", () => {
    expect(bare().keyLayers.map((l) => l.name)).toEqual(["clear", "keyEcho", "chords", "projects", "menu", "help", "inbox", "questions", "images", "escape", "enter", "editor"]);
  });

  test("a key two layers could take goes to the earlier one", async () => {
    const term = fakeTerm(80, 20);
    const orchs = fakeOrchestrators();
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000, projects: { live: async () => [], kill: async () => {} } });
    const running = app.run("alpha");
    await until(() => !!app.page);

    // keyEcho before chords and Esc: Ctrl+N is echoed, Esc ends the echo and keeps the input.
    app.input = { text: "draft", cursor: 5 };
    app.keyEcho = true;
    term.press({ name: "n", ctrl: true });
    term.press({ name: "escape" });
    await until(() => !app.keyEcho);
    expect(app.pages.length).toBe(1);
    expect(app.input.text).toBe("draft");

    // menu before Esc / Enter / editor: Esc closes it (input kept), Enter picks (nothing sent), j moves.
    let picked = "";
    app.openMenu("pick", [{ value: "x", label: "x" }, { value: "y", label: "y" }], (v) => { picked = v; });
    term.type("j");
    term.press({ name: "enter" });
    await until(() => picked === "y");
    expect(app.input.text).toBe("draft");
    app.openMenu("pick", [{ value: "x", label: "x" }], () => {});
    term.press({ name: "escape" });
    expect(app.menu).toBeNull();
    expect(app.input.text).toBe("draft");

    // projects before menu: Ctrl+B with a menu up opens the list and drops the menu.
    app.openMenu("pick", [{ value: "x", label: "x" }], () => {});
    term.press({ name: "b", ctrl: true });
    await until(() => !!app.projectList);
    expect(app.menu).toBeNull();
    // projects before Esc and the editor: j moves the list, Esc closes it and keeps the input.
    term.type("j");
    expect(app.input.text).toBe("draft");
    term.press({ name: "escape" });
    await until(() => !app.projectList);
    expect(app.input.text).toBe("draft");

    // chords before projects: Ctrl+N with the list open opens a page.
    term.press({ name: "b", ctrl: true });
    await until(() => !!app.projectList);
    term.press({ name: "n", ctrl: true });
    await until(() => app.pages.length === 2);

    // Esc before the editor, Enter before the editor; Shift+Enter is the editor's newline.
    app.projectList = null;
    app.input = { text: "a", cursor: 1 };
    term.press({ name: "enter", shift: true });
    expect(app.input.text).toBe("a\n");
    term.press({ name: "escape" });
    expect(app.input.text).toBe("");
    app.quit();
    await running;
  });
});

describe("user background", () => {
  test("sent messages and the input are on the user background, full width, live and after a resize reprint", async () => {
    const term = fakeTerm(30, 20);
    const orchs = fakeOrchestrators();
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000 });
    const running = app.run("alpha");
    await until(() => !!app.page);
    term.type("a message long enough to wrap\r");
    await until(() => term.screen().includes("worker-x done"));
    term.type("draft");
    await until(() => term.screen().includes("> draft"));
    const filled = (cols: number) => term.display.backgrounds().map((r) => r.length === cols && r.every((b) => b === "48;5;236"));
    const check = (cols: number) => {
      const text = term.display.text().split("\n");
      const bg = filled(cols);
      const at = (s: string) => text.findIndex((l) => l.startsWith(s));
      expect([bg[at("> a message")], bg[at("> a message") + 1], bg[at("alpha says hi")]]).toEqual([true, true, false]);
      const row = term.display.top + term.display.row;
      expect(term.display.buf[row]!.join("").trimEnd()).toBe("│> draft" + " ".repeat(cols - 9) + "│");
      expect([bg[row], bg[row + 1]]).toEqual([true, true]); // input, bottom status
      expect(term.display.col).toBe(8);
    };
    check(30);
    term.resize(24, 20);
    await Bun.sleep(150);
    check(24);
    app.quit();
    await running;
  });
});

describe("terminal background", () => {
  test("the first page is committed only once the terminal's background is known, in its shade; the input is redrawn in it", async () => {
    const t = openTranscript(paths.transcript("shaded", "orchestrator"));
    await t.append({ type: "meta", role: "orchestrator", model: "m" });
    await t.append({ type: "message", message: { role: "user", content: "[user] earlier question" } });
    const term = fakeTerm(30, 10);
    let answer!: () => void;
    term.background = new Promise<void>((resolve) => { answer = () => { setUserFill("\x1b[48;5;254m"); resolve(); }; });
    const orchs = fakeOrchestrators();
    const openOrchestrator: typeof orchs.openOrchestrator = async (...args) => ({ ...(await orchs.openOrchestrator(...args)), entries: () => t.branch() });
    const app = new App({ term, openOrchestrator, pollMs: 100_000 });
    const running = app.run("shaded");
    await until(() => !!app.page);
    await Bun.sleep(40);
    expect(term.screen()).not.toContain("earlier question"); // held until the shade is known
    answer();
    await until(() => term.screen().includes("> earlier question"));
    const row = term.display.text().split("\n").indexOf("> earlier question");
    expect(term.display.backgrounds()[row]!.every((b) => b === "48;5;254")).toBe(true);
    const input = term.display.top + term.display.row;
    expect(term.display.backgrounds()[input]![0]).toBe("48;5;254");
    app.quit();
    await running;
  });
});

describe("tool calls", () => {
  /** An orchestrator whose turn runs the tool calls the test drives through `events`, on an injected clock. */
  function scripted() {
    const state = { now: 1000, events: null as ToolEvents | null, finish: null as (() => void) | null, ticks: [] as (() => void)[] };
    const clock: Clock = { now: () => state.now, every: (fn) => { state.ticks.push(fn); return () => { state.ticks.splice(state.ticks.indexOf(fn), 1); }; } };
    const openOrchestrator = async (_p: string, _u: string | undefined, _w: (t: string, plain?: boolean) => void, _i?: unknown, events?: ToolEvents): Promise<Orchestrator> => {
      state.events = events!;
      return { async say() {}, async pending() { return false; }, turn: () => new Promise((r) => (state.finish = () => r([]))) };
    };
    return { state, clock, openOrchestrator };
  }

  test("a running call shimmers in the live region; when it ends its ⏺ line and ⎿ summary go to the scrollback; a failure is red", async () => {
    const term = fakeTerm(50, 12);
    const { state, clock, openOrchestrator } = scripted();
    const app = new App({ term, openOrchestrator, pollMs: 100_000, clock });
    const running = app.run("tooly");
    await until(() => !!app.page);
    term.type("go\r");
    await until(() => !!state.finish);
    state.events!.onTool({ id: "c1", name: "bash", input: { command: "git status" } });
    await until(() => term.screen().includes("⏺ bash(git status)"));
    expect(app.page!.lines.some((l) => typeof l !== "string" && "tool" in l)).toBe(false); // live only, not committed
    expect(term.screen()).not.toContain("working…"); // the tool itself owns the tail animation
    const frame = () => app.frame().running!.join("");
    const first = frame();
    expect(frame()).toBe(first); // same instant, same frame
    state.now += 400;
    expect(frame()).not.toBe(first); // the band moved
    expect(state.ticks.length).toBe(1); // the animation timer runs while the turn does
    state.events!.onToolResult({ id: "c1", ok: true, text: "M a.ts\nM b.ts\n" });
    await until(() => term.screen().includes("⏺ bash(git status)\n  ⎿  2 lines"));
    expect(app.frame().running).toEqual([]);
    state.events!.onTool({ id: "c2", name: "bash", input: { command: "make" } });
    await until(() => term.screen().includes("⏺ bash(make)"));
    expect(term.screen()).toContain("⏺ bash(git status)\n  ⎿  2 lines\n⏺ bash(make)"); // a lone finished call keeps its lines while the next runs below
    state.events!.onToolResult({ id: "c2", ok: true, text: "x: error 1\n[exit 2]" });
    // Two finished calls in a row fold into one summary line; the failure is counted, and the marker is red.
    await until(() => term.screen().includes("▸ 2 tool calls · bash ×2 · 1 failed"));
    expect(term.screen()).not.toContain("⎿");
    expect(term.screen()).not.toContain("bash(make)");
    expect(term.raw()).toContain("\x1b[31m▸");
    state.finish!();
    await until(() => !app.page!.busy);
    expect(state.ticks.length).toBe(0); // nothing runs: no timer
    app.quit();
    await running;
  });

  test("live: finished calls fold into the summary while the running rows stay below it; a durable sync draws the same rows", async () => {
    const term = fakeTerm(60, 24);
    const { state, clock, openOrchestrator } = scripted();
    const t = openTranscript(paths.transcript("foldy", "orchestrator"));
    await t.append({ type: "meta", role: "orchestrator", model: "m" });
    const app = new App({ term, clock, pollMs: 100_000, openOrchestrator: async (...args) => ({ ...await openOrchestrator(...args), entries: () => t.branch() }) });
    const running = app.run("foldy");
    await until(() => !!app.page);
    term.type("go\r");
    await until(() => !!state.finish);
    const body = () => bodyRows(term).map(row => row.trimEnd()).filter(row => /^(⏺|▸|  ⎿)/.test(row)); // the tool rows: history, then the running ones
    const calls = [{ id: "c1", name: "bash", input: { command: "ls" } }, { id: "c2", name: "read", input: { path: "x" } }, { id: "c3", name: "bash", input: { command: "false" } }];
    for (const call of calls) state.events!.onTool(call);
    await until(() => body().length === 3);
    expect(body()).toEqual(["⏺ bash(ls)", "⏺ read(x)", "⏺ bash(false)"]); // all running
    state.events!.onToolResult({ id: "c1", ok: true, text: "a\n" });
    await until(() => body().includes("  ⎿  1 line"));
    expect(body()).toEqual(["⏺ bash(ls)", "  ⎿  1 line", "⏺ read(x)", "⏺ bash(false)"]); // one finished: its own lines, the running rows below
    state.events!.onToolResult({ id: "c3", ok: true, text: "boom\n[exit 1]" });
    await until(() => body().includes("▸ 2 tool calls · bash ×2 · 1 failed"));
    expect(body()).toEqual(["▸ 2 tool calls · bash ×2 · 1 failed", "⏺ read(x)"]); // two finished fold; the third still runs below
    state.events!.onToolResult({ id: "c2", ok: false, text: "refused" });
    await until(() => body().includes("▸ 3 tool calls · bash ×2, read ×1 · 2 failed"));
    expect(body()).toEqual(["▸ 3 tool calls · bash ×2, read ×1 · 2 failed"]);
    expect(app.page!.lines).toHaveLength(3); // the history keeps the calls themselves
    expect(app.frame().running).toEqual([]);
    // The durable record lands (the same calls, in the order they ended): the page re-renders from it to the same rows.
    const before = term.display.screen();
    await t.append({ type: "message", message: { role: "assistant", content: calls.map(c => ({ type: "tool_use", ...c })) } });
    await t.append({ type: "message", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "c1", content: "a\n" }, { type: "tool_result", tool_use_id: "c3", content: "boom\n[exit 1]" }, { type: "tool_result", tool_use_id: "c2", content: "refused", is_error: true },
    ] } });
    const lines = [...app.page!.lines];
    state.events!.onRefresh!();
    await until(() => app.page!.lines !== lines);
    await Bun.sleep(40);
    expect(app.page!.lines.map(l => JSON.stringify(l))).toEqual([lines[0], lines[2], lines[1]].map(l => JSON.stringify(l))); // the record's order
    expect(term.display.screen()).toEqual(before);
    state.finish!();
    await until(() => !app.page!.busy);
    expect(body()).toEqual(["▸ 3 tool calls · bash ×2, read ×1 · 2 failed"]);
    app.quit();
    await running;
  });

  test("a click on a folded summary opens that group alone and closes it again; it survives a durable sync; the exit replay shows every call", async () => {
    const term = fakeTerm(60, 40); // tall enough for the whole conversation, as a click pins the scroll like any mousedown
    const orchs = fakeOrchestrators();
    const t = openTranscript(paths.transcript("clicky", "orchestrator"));
    await t.append({ type: "meta", role: "orchestrator", model: "m" });
    const calls = [{ id: "s1", name: "bash", input: { command: "ls" } }, { id: "s2", name: "bash", input: { command: "false" } }];
    const results = (ids: string[]) => ids.map(id => ({ type: "tool_result" as const, tool_use_id: id, content: id.startsWith("s2") ? "boom\n[exit 1]" : "a\n" }));
    await t.append({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "first", citations: null }, ...calls.map(c => ({ type: "tool_use" as const, ...c }))] } });
    await t.append({ type: "message", message: { role: "user", content: results(["s1", "s2"]) } });
    await t.append({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "between", citations: null }, ...calls.map(c => ({ type: "tool_use" as const, ...c, id: `${c.id}b` }))] } });
    await t.append({ type: "message", message: { role: "user", content: results(["s1b", "s2b"]) } });
    let events!: ToolEvents;
    const openOrchestrator: ConstructorParameters<typeof App>[0]["openOrchestrator"] = async (project, url, write, inbox, tools) => {
      if (project === "clicky") events = tools!;
      return { ...(await orchs.openOrchestrator(project, url, write, inbox)), entries: () => (project === "clicky" ? t.branch() : []) };
    };
    const app = new App({ term, openOrchestrator, pollMs: 100_000 });
    const running = app.run("clicky");
    const body = () => bodyRows(term).slice(0, -4).map(row => row.trimEnd()).filter(Boolean); // the conversation, without the composer and status
    const summary = "▸ 2 tool calls · bash ×2 · 1 failed";
    const opened = ["▾ 2 tool calls · bash ×2 · 1 failed", "  ⏺ bash(ls)", "    ⎿  1 line", "  ⏺ bash(false)", "    ⎿  exit 1: boom"];
    await until(() => body().join("\n") === ["first", summary, "between", summary].join("\n"));
    // The second group opens; the first stays folded.
    const y = term.display.screen().findLastIndex(row => row.includes("2 tool calls")) + 1;
    await app.onKey({ name: "mousedown", x: 3, y }); await app.onKey({ name: "mouseup", x: 3, y });
    await until(() => body().join("\n") === ["first", summary, "between", ...opened].join("\n"));
    expect(app.page!.lines).toHaveLength(6); // the history is untouched
    // A drag (release elsewhere) is a selection, not a click; a click on an open group's call is not on its summary.
    await app.onKey({ name: "mousedown", x: 3, y }); await app.onKey({ name: "mouseup", x: 9, y });
    await app.onKey({ name: "mousedown", x: 3, y: y + 1 }); await app.onKey({ name: "mouseup", x: 3, y: y + 1 });
    await settle();
    expect(body().join("\n")).toBe(["first", summary, "between", ...opened].join("\n"));
    // The durable record re-renders the page (syncTranscript): the opened group stays open, matched by its run's order.
    await t.append({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "after", citations: null }] } });
    const lines = app.page!.lines;
    events.onRefresh!();
    await until(() => app.page!.lines !== lines && body().includes("after"));
    expect(body().join("\n")).toBe(["first", summary, "between", ...opened, "after"].join("\n"));
    // A click on the open group's summary folds it again.
    await clickRow(app, term, "bash(ls)"); // its call: not the summary row
    await settle();
    expect(body()).toContain("  ⏺ bash(ls)");
    const ys = term.display.screen().findLastIndex(row => row.includes("2 tool calls")) + 1;
    await app.onKey({ name: "mousedown", x: 3, y: ys }); await app.onKey({ name: "mouseup", x: 3, y: ys });
    await until(() => body().join("\n") === ["first", summary, "between", summary, "after"].join("\n"));
    expect(term.raw()).toContain("\x1b[31m▸"); // the marker red: a call failed
    // A click before another page's frame is painted never reaches this page's groups.
    await app.openPage("clicky-other");
    await app.onKey({ name: "mousedown", x: 3, y: ys }); await app.onKey({ name: "mouseup", x: 3, y: ys });
    await until(() => !term.screen().includes("between"));
    app.active = 0; app.reprint();
    await until(() => body().join("\n") === ["first", summary, "between", summary, "after"].join("\n"));
    app.quit();
    await running;
    // The exit replay cannot be clicked: it shows every call.
    expect(term.display.screen().join("\n")).toContain("first\n\n⏺ bash(ls)\n  ⎿  1 line\n\n⏺ bash(false)\n  ⎿  exit 1: boom\n\nbetween\n\n⏺ bash(ls)\n  ⎿  1 line\n\n⏺ bash(false)\n  ⎿  exit 1: boom\n\nafter");
  });

  test("the /agents view shows a followed agent's running call live, then its lines when the result lands", async () => {
    const term = fakeTerm(60, 12);
    const orchs = fakeOrchestrators();
    const transcript = paths.transcript("toolview", "worker-t");
    mkdirSync(join(transcript, ".."), { recursive: true });
    const line = (role: string, content: unknown) => JSON.stringify({ type: "message", message: { role, content } }) + "\n";
    await Bun.write(transcript, line("assistant", [{ type: "text", text: "checking" }, { type: "tool_use", id: "u1", name: "bash", input: { command: "bun test" } }]));
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000, agents: async () => [{ name: "worker-t", live: true }] });
    const running = app.run("toolview");
    await until(() => !!app.page);
    term.type("/agents\r");
    await until(() => !!app.menu);
    term.press({ name: "enter" });
    await until(() => term.screen().includes("checking") && term.screen().includes("⏺ bash(bun test)"));
    expect(app.page!.view!.lines.some((l) => typeof l !== "string" && "tool" in l)).toBe(false); // still running
    const { appendFileSync } = await import("node:fs");
    appendFileSync(transcript, line("user", [{ type: "tool_result", tool_use_id: "u1", content: "1 pass\n0 fail\n" }]));
    await until(() => term.screen().includes("⏺ bash(bun test)\n  ⎿  2 lines"));
    expect(app.page!.view!.calls.size).toBe(0);
    app.quit();
    await running;
  });
});

test("queued user messages show only when consumed, in order, alongside external users", async () => {
  const term = fakeTerm(80, 12);
  let inbox!: (msgs: Message[]) => void;
  let done!: () => void;
  const app = new App({ term, pollMs: 100_000, openOrchestrator: async (_p, _u, _w, read) => {
    inbox = read!;
    return { async say() {}, async pending() { return false; }, turn: () => new Promise((r) => { done = () => r([]); }) };
  } });
  const running = app.run("consume");
  await until(() => !!app.page);
  term.type("one\r");
  await until(() => !!done);
  term.type("two\r");
  await until(() => app.page!.sent.length === 2);
  expect(app.page!.lines.map(raw).join("\n")).not.toContain("> one");
  expect(strip(app.status(app.page!))).toContain("2 messages queued");
  inbox(["one", "two", "external"].map((text, i) => ({ from: "user", text, inputId: app.page!.sent[i]?.inputId, ts: "" })));
  expect(app.page!.sent).toEqual([]);
  expect(app.page!.lines.map(raw).map(strip)).toEqual(["> one", "> two", "> external"]);
  done();
  app.quit();
  await running;
});

test("unfinished calls commit red in turns and finished agent transcripts", async () => {
  const term = fakeTerm(80, 14);
  const project = "interrupted-ui";
  const transcript = paths.transcript(project, "worker-ended");
  mkdirSync(join(transcript, ".."), { recursive: true });
  await Bun.write(transcript, JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "tool_use", id: "v1", name: "bash", input: { command: "sleep forever" } }] } }) + "\n");
  const app = new App({ term, pollMs: 100_000, agents: async () => [{ name: "worker-ended", live: false }], openOrchestrator: async (_p, _u, _w, _i, tools) => ({
    async say() {}, async pending() { return false; },
    async turn() { tools!.onTool({ id: "a", name: "bash", input: { command: "wait" } }); return []; },
  }) });
  const running = app.run(project);
  await until(() => !!app.page);
  term.type("go\r");
  await until(() => term.screen().includes("⏺ bash(wait)\n  ⎿  interrupted"));
  expect(app.page!.calls.size).toBe(0);
  expect(term.raw()).toContain("\x1b[31m⏺");
  term.type("/agents\r");
  await until(() => !!app.menu);
  term.press({ name: "enter" });
  await until(() => term.screen().includes("⏺ bash(sleep forever)\n  ⎿  interrupted"));
  expect(app.page!.view!.calls.size).toBe(0);
  app.quit();
  await running;
});

test("scrolling and new output keep both bars fixed, preserve the draft, and follow the latest again at the end", async () => {
  const term = fakeTerm(100, 16);
  const orchs = fakeOrchestrators();
  const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000 });
  const running = app.run("sticky-scroll");
  try {
    await until(() => !!app.page);
    for (let i = 0; i < 60; i++) app.say(`history row ${i}`);
    term.type("my draft");
    await until(() => term.screen().includes("history row 59"));
    const top = bodyStart(term);
    const header = term.display.screen().slice(0, top);
    const footer = term.display.screen().slice(-4);
    term.press({ name: "pageup" });
    await until(() => !term.screen().includes("history row 59"));
    const body = term.display.screen().slice(top, -4);
    app.say("new output while reading");
    await Bun.sleep(30);
    expect(term.display.screen().slice(top, -4)).toEqual(body);
    expect(term.display.screen().slice(0, top)).toEqual(header);
    expect(term.display.screen().slice(-4)).toEqual(footer);
    expect(app.input.text).toBe("my draft");
    const firstRow = Number(body[0]!.match(/\d+/)![0]);
    term.type("\x1b[<64;10;8M".repeat(3));
    await until(() => term.display.screen()[top] === `history row ${firstRow - 9}`);
    for (let i = 0; i < 3; i++) { term.press({ name: "pagedown" }); await Bun.sleep(20); }
    await until(() => term.screen().includes("new output while reading"));
    app.say("following again");
    await until(() => term.screen().includes("following again"));
    expect(term.display.row).toBe(13);
  } finally { app.quit(); await running; }
});
