import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Orchestrator } from "../orchestrator";
import { displayName, newProjectName, setDisplayName } from "../commands";
import { loadConfig, paths } from "../config";
import { App, helpLines, parseCommand, type Clock, type Line, type ToolEvents } from "./app";
import { createOrchestrator } from "../orchestrator";
import { drain, put, type Message } from "../inbox";
import { all as allQuestions, answer as answerQuestion, ask as askQuestions } from "../questions";
import { fileStore, type QuestionStore } from "./questions";
import { answeredLine } from "./restore";
import { fakeProvider, text as said, toolUse } from "../test/fake-provider";
import { message } from "../tools/message";
import { makeSpawn } from "../tools/spawn";
import { open as openTranscript } from "../transcript";
import { parseKeys, type Key } from "./keys";
import { realTerminal, type Terminal } from "./term";
import { FakeScreen } from "./testing";
import { bold, dim } from "./render";
import { setUserFill } from "./style";
import { Calls } from "./tools";

const home = mkdtempSync(join(tmpdir(), "parallels-tui-"));
process.env.PARALLELS_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));

/** Anything the fake screen refused (an escape or control a real terminal would misread); checked after every test. */
const screenErrors: string[] = [];
afterEach(() => { expect(screenErrors).toEqual([]); screenErrors.length = 0; });
/** The user background on, whatever the environment says, so every test draws it (and pads the input). */
const USER_BG = "\x1b[48;5;236m";
beforeEach(() => setUserFill(USER_BG));

const strip = (s: string) => s.replace(/\x1b\[[0-9;?<>]*[A-Za-z]/g, "");
/** A history line's text: plain lines as they are, markdown as written. */
const raw = (l: Line) => (typeof l === "string" ? l : "user" in l ? l.user : "tool" in l ? `${l.tool} ⎿ ${l.summary}` : l.md);

/** A fake terminal: records every raw write and applies it to a FakeScreen, so `screen()` is the scrollback plus the screen. */
function fakeTerm(cols = 40, rows = 8) {
  const handlers: ((k: Key) => void)[] = [];
  const resizers: (() => void)[] = [];
  const display = new FakeScreen(cols, rows);
  const writes: string[] = [];
  const term: Terminal & { type(s: string): void; press(k: Key): void; screen(): string; raw(): string; writes: string[]; display: FakeScreen; resize(cols: number, rows: number): void; eraser: string; opened: boolean; closed: boolean } = {
    cols, rows, opened: false, closed: false, writes, display, eraser: "",
    eraseOnExit(text) { this.eraser = text; },
    write: (s) => {
      writes.push(s);
      try { display.write(s); } catch (err) { screenErrors.push(String(err)); throw err; }
    },
    onKey: (cb) => { handlers.push(cb); },
    onResize: (cb) => { resizers.push(cb); },
    resize(c, r) { this.cols = c; this.rows = r; display.resize(c, r); for (const cb of resizers) cb(); },
    open() { this.opened = true; },
    close() { this.closed = true; },
    press: (k) => { for (const h of handlers) h(k); },
    type: (s) => { for (const k of parseKeys(s)) for (const h of handlers) h(k); },
    screen: () => display.text(),
    raw: () => writes.join(""),
  };
  return term;
}

function fakeOrchestrators() {
  const opened: { project: string; url?: string }[] = [];
  const said: Record<string, string[]> = {};
  const writers: Record<string, (t: string) => void> = {};
  const openOrchestrator = async (project: string, url: string | undefined, write: (t: string) => void, onInbox?: (msgs: Message[]) => void): Promise<Orchestrator> => {
    opened.push({ project, url });
    said[project] = [];
    writers[project] = write;
    let queued = 0;
    let consumed = 0;
    return {
      async say(text) { said[project]!.push(text); queued++; },
      async pending() { return queued > 0; },
      async turn() {
        queued = 0;
        onInbox?.(said[project]!.slice(consumed).map((text) => ({ from: "user", text, ts: "" })));
        consumed = said[project]!.length;
        write(`${project} says hi\n`);
        return [{ from: "worker-x", text: "done", ts: "t" }];
      },
    };
  };
  return { opened, said, writers, openOrchestrator };
}

const settle = () => Bun.sleep(15);
/** A real terminal's clock whose background-reply window ends at once, as for a terminal that never answers (term.test.ts covers the window). */
const NO_REPLY_WINDOW = { now: Date.now, setTimer: (fn: () => void) => { fn(); return () => {}; } };
/** Wait until `cond` holds, up to two seconds. */
async function until(cond: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!cond() && Date.now() < deadline) await Bun.sleep(5);
  expect(cond()).toBe(true);
}

describe("tui app", () => {
  test("opens a page per project, types to its orchestrator and shows replies", async () => {
    const term = fakeTerm();
    const orchs = fakeOrchestrators();
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000 });
    const running = app.run("alpha");
    await until(() => !!app.page);
    expect(term.opened).toBe(true);
    expect(orchs.opened).toEqual([{ project: "alpha", url: undefined }]);
    term.type("build it\r");
    await until(() => orchs.said.alpha?.length === 1);
    expect(orchs.said.alpha).toEqual(["build it"]);
    await until(() => ["> build it", "alpha says hi", "worker-x done"].every((t) => term.screen().includes(t)));
    term.type("/quit\r");
    await running;
    expect(term.closed).toBe(true);
  });

  test("Ctrl+N starts orch-xxxx at once; Ctrl+Z and Ctrl+X switch pages", async () => {
    const term = fakeTerm();
    const orchs = fakeOrchestrators();
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000 });
    const running = app.run("alpha");
    await until(() => !!app.page);
    term.press({ name: "n", ctrl: true });
    await until(() => app.pages.length === 2);
    expect(orchs.opened[1]!.project).toMatch(/^orch-[a-z0-9]{4}$/);
    expect(orchs.opened[1]!.url).toBeUndefined();
    expect(app.page!.project).toBe(orchs.opened[1]!.project);
    await until(() => term.screen().includes("/rename <name> to rename"));

    term.type("\x1a"); // Ctrl+Z
    expect(app.page!.project).toBe("alpha");
    term.type("\x18"); // Ctrl+X
    expect(app.page!.project).toBe(orchs.opened[1]!.project);
    term.type("\x18"); // wraps around
    expect(app.page!.project).toBe("alpha");
    term.type("\x1b[1;5C"); // Ctrl+Right does nothing
    expect(app.page!.project).toBe("alpha");

    term.type("/new beta git@example.com:b.git\r");
    await until(() => app.page?.project === "beta");
    expect(orchs.opened[2]).toEqual({ project: "beta", url: "git@example.com:b.git" });
    term.type("/close\r");
    await until(() => app.pages.length === 2);
    expect(app.pages.map((p) => p.project)).toEqual(["alpha", orchs.opened[1]!.project]);
    term.press({ name: "c", ctrl: true });
    await running;
  });

  test("/rename sets a display name only, at any time, and refuses names in use", async () => {
    mkdirSync(join(home, "projects", "named", "repo"), { recursive: true });
    mkdirSync(join(home, "projects", "taken", "repo"), { recursive: true });
    const term = fakeTerm(200);
    const orchs = fakeOrchestrators();
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000 });
    const running = app.run("named");
    await until(() => !!app.page);
    const page = app.page!;
    const orch = page.orch;
    page.busy = true; // mid-turn
    term.type("/rename login page\r");
    await until(() => term.screen().includes("named → login page"));
    expect(page.project).toBe("named");
    expect(page.name).toBe("login page");
    expect(page.orch).toBe(orch); // not reopened
    expect(orchs.opened.map((o) => o.project)).toEqual(["named"]);
    expect(existsSync(join(home, "projects", "named", "repo"))).toBe(true);
    expect(await Bun.file(join(home, "projects", "named", "name")).text()).toBe("login page\n");
    await until(() => term.screen().includes("· login page · no remote · 1 page")); // the status line
    expect(await displayName("named")).toBe("login page");

    term.type("/rename taken\r");
    await until(() => term.screen().includes("another project is already called taken"));
    await setDisplayName("taken", "shown");
    term.type("/rename shown\r");
    await until(() => term.screen().includes("another project is already called shown"));
    expect(page.name).toBe("login page");
    page.busy = false;
    app.quit();
    await running;

    // Reopened later, the page shows its display name.
    const again = new App({ term: fakeTerm(), openOrchestrator: fakeOrchestrators().openOrchestrator, pollMs: 100_000 });
    const running2 = again.run("named");
    await until(() => again.page?.name === "login page");
    again.quit();
    await running2;
  });

  test("commands work while viewing an agent; plain text waits for /back", async () => {
    const term = fakeTerm();
    const orchs = fakeOrchestrators();
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000 });
    const running = app.run("viewer");
    await until(() => !!app.page);
    const page = app.page!;
    let left = 0;
    const view = { name: "worker-x", lines: [] as string[], leave: () => { left++; }, live: false, calls: new Calls() };
    page.view = view;
    term.type("/help\r");
    await until(() => view.lines.join("\n").includes("/back (or Esc) leaves the agent view"));
    term.type("hello\r");
    await until(() => view.lines.join("\n").includes("/back first"));
    expect(orchs.said.viewer).toEqual([]);
    term.type("/rename viewed\r");
    await until(() => page.name === "viewed");
    term.type("/new beta\r");
    await until(() => app.page?.project === "beta");
    term.type("/help\r");
    await until(() => app.page!.lines.join("\n").includes("/models [id]"));
    expect(app.page!.lines.join("\n")).not.toContain("/back");
    term.type("/back\r");
    await until(() => app.page!.lines.join("\n").includes("not viewing an agent"));
    term.type("\x1a"); // back to viewer
    term.type("/back\r");
    await until(() => left === 1);
    page.view = null;
    term.type("/close\r");
    await until(() => app.pages.length === 1);
    app.quit();
    await running;
  });

  test("commands work while signing in; /login does not start a second one; queued text runs when it ends", async () => {
    const term = fakeTerm();
    const orchs = fakeOrchestrators();
    let finish!: () => void;
    let logins = 0;
    const login = async () => { logins++; await new Promise<void>((r) => (finish = r)); return "signed in"; };
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000, login });
    const running = app.run("signer");
    await until(() => !!app.page);
    term.type("/login claude\r");
    await until(() => app.loggingIn);
    term.type("/login claude\r");
    await until(() => term.screen().includes("already signing in"));
    expect(logins).toBe(1);
    term.type("/rename signing\r");
    await until(() => app.page!.name === "signing");
    term.type("/help\r");
    await until(() => term.screen().includes("/models [id]"));
    term.type("hi\r");
    await until(() => term.screen().includes("queued; runs after sign-in"));
    expect(orchs.said.signer).toEqual([]); // held back until sign-in succeeds
    await Bun.sleep(30);
    expect(term.screen()).not.toContain("signer says hi"); // the turn waits for sign-in
    term.type("/new beta2\r");
    await until(() => app.page?.project === "beta2");
    term.type("\x1a");
    expect(app.page!.project).toBe("signer");
    finish(); // no poll runs (pollMs is huge): login() starts the queued turn itself
    await until(() => term.screen().includes("signer says hi"));
    expect(orchs.said.signer).toEqual(["hi"]);
    expect(app.loggingIn).toBe(false);
    app.quit();
    await running;
  });

  test("/review-rounds works while viewing an agent and while signing in", async () => {
    const term = fakeTerm();
    const orchs = fakeOrchestrators();
    let finish!: () => void;
    const login = async () => { await new Promise<void>((r) => (finish = r)); return "signed in"; };
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000, login });
    const running = app.run("rounds");
    await until(() => !!app.page);
    const page = app.page!;
    const view = { name: "worker-x", lines: [] as string[], leave: () => {}, live: false, calls: new Calls() };
    page.view = view;
    term.type("/review-rounds 3\r");
    await until(() => view.lines.join("\n").includes("review rounds set to 3"));
    expect((await loadConfig()).maxReviewRounds).toBe(3);
    page.view = null;
    term.type("/login claude\r");
    await until(() => app.loggingIn);
    term.type("/review-rounds 0\r");
    await until(() => page.lines.join("\n").includes("review rounds set to 0"));
    expect((await loadConfig()).maxReviewRounds).toBe(0);
    term.type("/review-rounds\r");
    await until(() => page.lines.join("\n").includes("review rounds: 0"));
    expect(page.lines.join("\n")).not.toContain("queued");
    finish();
    await until(() => !app.loggingIn);
    await Bun.sleep(20);
    expect(orchs.said.rounds).toEqual([]); // nothing was queued for the orchestrator
    app.quit();
    await running;
  });

  test("text queued during a sign-in that fails is dropped, not run", async () => {
    const term = fakeTerm(200);
    const orchs = fakeOrchestrators();
    let fail!: (err: Error) => void;
    const login = () => new Promise<string>((_, reject) => (fail = reject));
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 20, login });
    const running = app.run("failer");
    await until(() => !!app.page);
    term.type("/login claude\r");
    await until(() => app.loggingIn);
    term.type("one\r");
    term.type("two\r");
    await until(() => app.page!.lines.filter((l) => raw(l).includes("queued; runs after sign-in")).length === 2);
    fail(new Error("denied"));
    await until(() => term.screen().includes("sign-in failed; dropped 2 queued message(s)"));
    expect(term.screen()).toContain("login failed: denied");
    await Bun.sleep(60); // polls run, but nothing was queued in the inbox
    expect(orchs.said.failer).toEqual([]);
    expect(term.screen()).not.toContain("failer says hi");
    app.quit();
    await running;
  });

  test("/new and Ctrl+N ids never match another project's display name", async () => {
    mkdirSync(join(home, "projects", "shown-id", "repo"), { recursive: true });
    await setDisplayName("shown-id", "foo");
    const term = fakeTerm(200);
    const orchs = fakeOrchestrators();
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000 });
    const running = app.run("clash");
    await until(() => !!app.page);
    term.type("/new foo\r");
    await until(() => term.screen().includes("another project is already called foo"));
    expect(orchs.opened.map((o) => o.project)).toEqual(["clash"]);
    term.type("/new shown-id\r"); // its own id still opens it
    await until(() => app.page?.project === "shown-id");
    expect(app.page!.name).toBe("foo");

    // Ctrl+N skips an orch-xxxx another project displays as.
    const first = newProjectName([], () => 0.5);
    await setDisplayName("shown-id", first);
    app.page!.name = first;
    const rolls = [0.5, 0.25];
    const random = Math.random;
    Math.random = () => rolls.shift() ?? random();
    try {
      term.press({ name: "n", ctrl: true });
      await until(() => app.pages.length === 3);
    } finally { Math.random = random; }
    expect(app.page!.project).toMatch(/^orch-/);
    expect(app.page!.project).not.toBe(first);
    app.quit();
    await running;
  });

  test("/keys echoes parsed keys until Esc", async () => {
    const term = fakeTerm();
    const orchs = fakeOrchestrators();
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000 });
    const running = app.run("alpha");
    await until(() => !!app.page);
    term.type("/keys\r");
    await until(() => app.keyEcho && term.screen().includes("press keys; Esc ends"));
    term.type("\x1b[44;5u");
    term.press({ name: "escape" });
    await until(() => !app.keyEcho && term.screen().includes('{"name":",","ctrl":true}'));
    expect(app.keyEcho).toBe(false);
    expect(app.pages.length).toBe(1); // the chord was echoed, not acted on
    app.quit();
    await running;
  });

  test("the screen is bare until /help", async () => {
    const term = fakeTerm(200);
    const orchs = fakeOrchestrators();
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000 });
    const running = app.run("alpha");
    await until(() => !!app.page);
    expect(term.screen()).not.toContain("/models");
    term.type("/help\r");
    await until(() => app.page!.lines.join("\n").includes("/review-rounds"));
    const help = app.page!.lines.join("\n");
    for (const cmd of ["/keys", "/rename <name>", "/new [name] [git-url]", "/close closes this page", "/quit", "/agents", "/models [id]", "/accounts", "/login claude|codex", "/review-rounds [n]"]) expect(help).toContain(cmd);
    expect(help).not.toContain("/back");
    app.quit();
    await running;
  });

  test("with no project named it reopens every known project", async () => {
    mkdirSync(join(home, "projects", "p1", "repo"), { recursive: true });
    mkdirSync(join(home, "projects", "p2", "repo"), { recursive: true });
    const term = fakeTerm();
    const orchs = fakeOrchestrators();
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000 });
    const running = app.run();
    await until(() => ["p1", "p2"].every((n) => app.pages.some((p) => p.project === n)));
    app.quit();
    await running;
  });

  test("started inside a repo, it opens an orch-xxxx cloned from it, reused next time; Ctrl+N clones it too", async () => {
    const term = fakeTerm(200);
    const orchs = fakeOrchestrators();
    const source = "git@example.com:harness.git";
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000, source });
    const running = app.run();
    await until(() => !!app.page?.project.startsWith("orch-"));
    const first = orchs.opened.find((o) => o.url === source)!;
    expect(first.project).toMatch(/^orch-[a-z0-9]{4}$/);
    expect(app.page!.project).toBe(first.project);
    term.press({ name: "n", ctrl: true });
    await until(() => app.page!.project !== first.project);
    expect(orchs.opened.at(-1)!.project).toMatch(/^orch-/);
    expect(orchs.opened.at(-1)!.url).toBe(source);
    term.type("/new other\r"); // an explicit name without a url still clones the launch repo
    await until(() => app.page?.project === "other");
    expect(orchs.opened.at(-1)).toEqual({ project: "other", url: source });
    app.quit();
    await running;

    // A project with this remote on disk is reused instead of cloned again.
    const repo = join(home, "projects", "cloned", "repo");
    mkdirSync(repo, { recursive: true });
    await Bun.$`git init -q ${repo}`.quiet();
    await Bun.$`git -C ${repo} remote add origin ${source}`.quiet();
    const again = new App({ term: fakeTerm(), openOrchestrator: fakeOrchestrators().openOrchestrator, pollMs: 100_000, source });
    const running2 = again.run();
    await until(() => again.page?.project === "cloned");
    again.quit();
    await running2;
  });

  test("a report that lands while idle is picked up by the poll", async () => {
    const term = fakeTerm();
    const orchs = fakeOrchestrators();
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 20 });
    const running = app.run("alpha");
    await until(() => !!app.page);
    // Something arrives in the inbox without the user typing.
    await app.page!.orch.say("note");
    await until(() => term.screen().includes("worker-x done"));
    app.quit();
    await running;
  });

  test("menus move with arrows and pick with Enter; Esc cancels", async () => {
    const term = fakeTerm();
    const orchs = fakeOrchestrators();
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000 });
    const running = app.run("alpha");
    await until(() => !!app.page);
    let picked = "";
    app.openMenu("pick one", [{ value: "x", label: "x" }, { value: "y", label: "y" }], (v) => { picked = v; });
    term.press({ name: "down" });
    term.press({ name: "enter" });
    await until(() => picked === "y");
    app.openMenu("pick one", [{ value: "x", label: "x" }], (v) => { picked = v; });
    term.press({ name: "escape" });
    expect(app.menu).toBeNull();
    expect(picked).toBe("y");
    app.quit();
    await running;
  });

  test("line editing: cursor movement, backspace and history", async () => {
    const term = fakeTerm();
    const orchs = fakeOrchestrators();
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000 });
    const running = app.run("alpha");
    await until(() => !!app.page);
    term.type("helo");
    term.press({ name: "left" });
    term.type("l");
    expect(app.input).toEqual({ text: "hello", cursor: 4 });
    term.press({ name: "end" });
    term.press({ name: "backspace" });
    expect(app.input.text).toBe("hell");
    term.press({ name: "a", ctrl: true });
    term.press({ name: "k", ctrl: true });
    expect(app.input.text).toBe("");
    term.type("first\r");
    await until(() => app.input.text === "");
    term.press({ name: "up" });
    expect(app.input.text).toBe("first");
    app.quit();
    await running;
  });

  test("a busy page shows a spinner status line driven by an injected clock; agent views show it while live", async () => {
    let now = 0;
    const ticks: (() => void)[] = [];
    let started = 0, stopped = 0;
    const clock: Clock = {
      now: () => now,
      every: (fn) => { started++; ticks.push(fn); return () => { stopped++; ticks.splice(ticks.indexOf(fn), 1); }; },
    };
    let finish!: () => void;
    let write!: (t: string) => void;
    let live = true;
    let agentCalls = 0;
    let release: (() => void) | null = null;
    let hold = false;
    const agents = async () => {
      agentCalls++;
      if (hold) await new Promise<void>((r) => (release = r));
      return [{ name: "worker-x", live }];
    };
    const openOrchestrator = async (_p: string, _u: string | undefined, w: (t: string) => void): Promise<Orchestrator> => {
      write = w;
      return {
        async say() {},
        async pending() { return false; },
        turn: () => new Promise((r) => (finish = () => r([]))),
      };
    };
    const term = fakeTerm(100);
    let writesAfterClose = 0;
    const termWrite = term.write;
    term.write = (s) => { if (term.closed) writesAfterClose++; termWrite(s); };
    const app = new App({ term, openOrchestrator, pollMs: 100_000, clock, agents });
    const running = app.run("alpha");
    await until(() => !!app.page);
    expect(started).toBe(0); // idle: no timer
    term.type("go\r");
    await until(() => started === 1 && term.screen().includes("⠋ thinking… 0s"));
    expect(term.screen()).toContain("⠋ thinking… 0s · alpha") // cut to the width;
    now = 2_150;
    ticks[0]!();
    await until(() => term.screen().includes("⠙ thinking… 2s"));
    write("partial text");
    await until(() => term.screen().includes("working… 2s"));
    finish();
    await until(() => stopped === 1);
    expect(ticks.length).toBe(0);
    await until(() => !term.screen().includes("working…"));

    // Viewing a live agent through /agents shows the line until it finishes.
    term.type("/agents\r");
    await until(() => !!app.menu);
    term.press({ name: "enter" });
    await until(() => app.page!.view?.name === "worker-x" && started === 2 && term.screen().includes("following worker-x"));
    const calls = agentCalls;
    hold = true;
    now = 5_000;
    ticks[0]!();
    now = 6_000;
    ticks[0]!(); // the first check is still pending: no second call
    await settle();
    expect(agentCalls).toBe(calls + 1);
    live = false;
    release!();
    hold = false;
    await until(() => !term.screen().includes("following") && ticks.length === 0);

    // Busy while viewing a finished agent: the page's own turn shows.
    term.press({ name: "escape" }); // leave the view
    await until(() => !app.page!.view);
    term.type("again\r");
    await until(() => app.page!.busy);
    term.type("/agents\r");
    await until(() => !!app.menu);
    term.press({ name: "enter" });
    await until(() => app.page!.view?.live === false && term.screen().includes("thinking… "));

    // Quitting mid-turn clears the timer, and nothing restarts it or writes afterwards.
    expect(ticks.length).toBe(1);
    const startedBefore = started;
    app.quit();
    await running;
    expect(ticks.length).toBe(0);
    finish();
    await settle();
    expect(started).toBe(startedBefore);
    expect(ticks.length).toBe(0);
    expect(writesAfterClose).toBe(0);
  });

  test("multi-line input: Shift+Enter, paste, rows before history, word deletion", async () => {
    const term = fakeTerm();
    const orchs = fakeOrchestrators();
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000 });
    const running = app.run("alpha");
    await until(() => !!app.page);
    term.type("earlier\r");
    await until(() => orchs.said.alpha?.length === 1);
    term.type("one\x1b[13;2utwo\x1b\rthree");
    expect(app.input).toEqual({ text: "one\ntwo\nthree", cursor: 13 });
    term.type("\x1b[A");
    expect(app.input.cursor).toBe(7); // "two" row, same column
    term.type("\x1b[A");
    expect(app.input.cursor).toBe(3); // first row, not history yet
    term.type("\x1b[A");
    expect(app.input.text).toBe("earlier"); // first row: history
    term.press({ name: "escape" });
    term.type("\x1b[200~pasted\nlines\x1b[201~");
    expect(app.input.text).toBe("pasted\nlines");
    expect(orchs.said.alpha).toEqual(["earlier"]);
    term.type(" more words\x1b\x7f");
    expect(app.input.text).toBe("pasted\nlines more ");
    term.type("\r");
    await until(() => orchs.said.alpha?.length === 2);
    expect(orchs.said.alpha).toEqual(["earlier", "pasted\nlines more"]);
    app.quit();
    await running;
  });

  test("Ctrl+B and /projects open a list of every project: move, open, pin", async () => {
    for (const n of ["sb-a", "sb-b", "sb-c"]) mkdirSync(join(home, "projects", n, "repo"), { recursive: true });
    const term = fakeTerm(90);
    const orchs = fakeOrchestrators();
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000 });
    const running = app.run("sb-b");
    await until(() => !!app.page);
    term.type("\x02"); // Ctrl+B
    await until(() => !!app.projectList?.items.length);
    const names = () => app.projectList!.items.map((i) => i.name).filter((n) => n.startsWith("sb-"));
    expect(names()).toEqual(["sb-a", "sb-b", "sb-c"]);
    expect(app.projectList!.items[app.projectList!.index]!.name).toBe("sb-b"); // starts on the active page
    await until(() => term.screen().includes("● sb-b"));
    term.type("j"); // keys go to the list, not the input
    expect(app.input.text).toBe("");
    expect(app.projectList!.items[app.projectList!.index]!.name).toBe("sb-c");
    term.type("p");
    await until(() => app.projectList!.items[0]!.name === "sb-c");
    expect(app.projectList!.items[0]!.pinned).toBe(true);
    expect(app.projectList!.index).toBe(0); // the selection follows the pinned project
    term.press({ name: "enter" }); // opens a page for it like start <name>
    await until(() => app.page?.project === "sb-c");
    expect(orchs.opened.at(-1)).toEqual({ project: "sb-c", url: undefined });
    expect(app.projectList).toBeNull(); // Enter closes the list; keys go back to the input
    term.type("x");
    expect(app.input.text).toBe("x");
    term.press({ name: "b", ctrl: true }); // reopens
    await until(() => !!app.projectList);
    term.press({ name: "escape" }); // closes
    expect(app.projectList).toBeNull();
    term.type("\x7f/projects\r");
    await until(() => !!app.projectList);
    term.type("p"); // unpin sb-c again for the other tests
    await until(() => app.projectList!.items[0]!.name !== "sb-c");
    term.type("\x02");
    expect(app.projectList).toBeNull();
    app.quit();
    await running;
  });

  test("multi-line messages: one scrollback line per row, indent kept, history walks rows", async () => {
    const term = fakeTerm();
    const orchs = fakeOrchestrators();
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000 });
    const running = app.run("alpha");
    await until(() => !!app.page);
    term.type("old\r");
    await until(() => orchs.said.alpha?.length === 1);
    term.type("\x1b[200~\n  first\nsecond\n\n\x1b[201~\r");
    await until(() => orchs.said.alpha?.length === 2);
    expect(orchs.said.alpha).toEqual(["old", "  first\nsecond"]);
    const page = app.pages[0]!;
    expect(page.lines.map(raw).map(strip)).toContain(">   first");
    expect(page.lines.map(raw).map(strip)).toContain("  second");
    expect(page.lines.some((l) => raw(l).includes("\n"))).toBe(false);
    term.press({ name: "up" });
    expect(app.input).toEqual({ text: "  first\nsecond", cursor: 14 });
    term.press({ name: "up" });
    expect(app.input.text).toBe("  first\nsecond"); // moved to the first row
    expect(app.input.cursor).toBe(6);
    term.press({ name: "up" });
    expect(app.input.text).toBe("old");
    app.quit();
    await running;
  });

  test("deleting from the project list asks y/n, closes the page and removes the project", async () => {
    mkdirSync(join(home, "projects", "sb-del", "repo"), { recursive: true });
    const term = fakeTerm(90);
    const orchs = fakeOrchestrators();
    const killed: string[] = [];
    let checks = 0; // deleteProject calls live() synchronously, so a key that starts a delete shows up here at once
    const projects = { live: async () => { checks++; return []; }, kill: async (p: string) => { killed.push(p); } };
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000, projects });
    const running = app.run("alpha");
    await until(() => !!app.page);
    await app.openPage("sb-del");
    term.type("/projects\r");
    await until(() => app.projectList?.items[app.projectList.index]?.name === "sb-del");
    term.type("d");
    await until(() => term.screen().includes("delete sb-del? y/n"));
    term.type("n"); // anything but y cancels
    expect(app.projectList!.confirm).toBeNull();
    expect(checks).toBe(0);
    // Chords are not answers: Ctrl+Y, Alt+Y (legacy and kitty) and a char with alt cancel too.
    for (const answer of [() => term.type("\x19"), () => term.type("\x1by"), () => term.type("\x1b[121;3u"), () => term.press({ name: "char", text: "y", alt: true })]) {
      term.type("d");
      expect(app.projectList!.confirm?.name).toBe("sb-del");
      answer();
      expect(app.projectList!.confirm).toBeNull();
      expect(checks).toBe(0);
    }
    // Ctrl+D / Alt+D do not ask, Ctrl+P does not pin, and batched text like __proto__ does nothing.
    for (const chord of ["\x04", "\x1bd", "\x10", "__proto__", "constructor"]) {
      term.type(chord);
      expect(app.projectList!.confirm).toBeNull();
      expect(app.projectList!.status).toBe("");
    }
    // Had Ctrl+P pinned it, this p would unpin it.
    term.type("p");
    await until(() => app.projectList!.status !== "");
    expect(strip(app.projectList!.status)).toBe("pinned sb-del");
    term.type("p");
    await until(() => strip(app.projectList!.status) === "unpinned sb-del");
    expect(checks).toBe(0);
    expect(app.projectList!.items[app.projectList!.index]!.name).toBe("sb-del");
    term.type("d");
    term.type("y");
    await until(() => !existsSync(join(home, "projects", "sb-del")));
    await until(() => !app.projectList!.items.some((i) => i.name === "sb-del"));
    expect(app.pages.map((p) => p.project)).toEqual(["alpha"]);
    expect(app.page!.project).toBe("alpha");
    await until(() => term.screen().includes("deleted sb-del"));
    expect(killed).toEqual(["sb-del"]);
    app.quit();
    await running;
  });

  test("a multi-line message queued during sign-in is split in the scrollback and sent whole", async () => {
    const term = fakeTerm();
    const orchs = fakeOrchestrators();
    let finish!: () => void;
    const login = async () => { await new Promise<void>((r) => (finish = r)); return "signed in"; };
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000, login });
    const running = app.run("queuer");
    await until(() => !!app.page);
    term.type("/login claude\r");
    await until(() => app.loggingIn);
    term.type("\x1b[200~line one\nline two\x1b[201~\r");
    await until(() => term.screen().includes("queued; runs after sign-in"));
    const lines = app.page!.lines.map(raw).map(strip);
    expect(lines).not.toContain("> line one");
    expect(lines).not.toContain("  line two");
    expect(app.page!.lines.some((l) => raw(l).includes("\n"))).toBe(false);
    finish();
    await until(() => orchs.said.queuer?.length === 1);
    expect(orchs.said.queuer).toEqual(["line one\nline two"]);
    await until(() => app.page!.sent.length === 0);
    expect(app.page!.lines.map(raw).map(strip)).toContain("> line one");
    app.quit();
    await running;
  });

  test("a project with a display name shows it in the list; pin and delete use its id", async () => {
    mkdirSync(join(home, "projects", "sb-orch1", "repo"), { recursive: true });
    await Bun.write(join(home, "projects", "sb-orch1", "name"), "Shiny app\n");
    mkdirSync(join(home, "projects", "sb-ren", "repo"), { recursive: true });
    const term = fakeTerm(90);
    const orchs = fakeOrchestrators();
    const checked: string[] = [];
    const killed: string[] = [];
    const projects = { live: async (p: string) => { checked.push(p); return []; }, kill: async (p: string) => { killed.push(p); } };
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000, projects });
    const running = app.run("sb-ren");
    await until(() => !!app.page);
    term.type("\x02");
    await until(() => !!app.projectList);
    const at = app.projectList!.items.findIndex((i) => i.name === "sb-orch1");
    expect(app.projectList!.items[at]!.label).toBe("Shiny app");
    app.projectList!.index = at; // the fake screen is 8 rows; select it so the list scrolls to it
    app.draw();
    await until(() => term.screen().includes("❯    Shiny app"));
    expect(term.screen()).not.toContain("sb-orch1");

    term.type("p");
    await until(() => strip(app.projectList!.status) === "pinned Shiny app");
    expect((await loadConfig()).pinned).toContain("sb-orch1");
    expect(app.projectList!.items[0]!.name).toBe("sb-orch1");

    term.type("d");
    expect(strip(app.projectList!.status)).toBe("delete Shiny app? y/n");
    term.type("y");
    await until(() => strip(app.projectList!.status) === "deleted Shiny app");
    expect(checked).toEqual(["sb-orch1"]);
    expect(killed).toEqual(["sb-orch1"]);
    expect(existsSync(join(home, "projects", "sb-orch1"))).toBe(false);
    expect((await loadConfig()).pinned).not.toContain("sb-orch1");
    expect(app.projectList!.items.some((i) => i.name === "sb-orch1")).toBe(false);

    // A /rename while the list is open updates its label.
    await app.renamePage("Ren app");
    await until(() => app.projectList!.items.find((i) => i.name === "sb-ren")?.label === "Ren app");
    expect(strip(app.frame().projects!.items.find((i) => i.name === "sb-ren")!.label)).toBe("Ren app");
    app.quit();
    await running;
  });

  test("a project mid-turn, or one with live agents, is not deleted", async () => {
    mkdirSync(join(home, "projects", "sb-busy", "repo"), { recursive: true });
    const term = fakeTerm(90);
    let finish!: () => void;
    let turns = 0;
    let queued = false;
    const openOrchestrator = async (): Promise<Orchestrator> => ({
      async say() { queued = true; },
      async pending() { return queued; },
      async turn() { queued = false; turns++; await new Promise<void>((r) => (finish = r)); return []; },
    });
    let live: string[] = [];
    let checking: (() => void) | null = null;
    const projects = {
      live: async () => { await new Promise<void>((r) => (checking = r)); return live; },
      kill: async () => {},
    };
    const app = new App({ term, openOrchestrator, pollMs: 10, projects });
    const running = app.run("sb-busy");
    await until(() => !!app.page);
    const dir = join(home, "projects", "sb-busy");
    const askDelete = async (before = async () => {}) => {
      term.type("/projects\r");
      await until(() => app.projectList?.items[app.projectList.index]?.name === "sb-busy");
      term.type("d");
      await before();
      term.type("y"); // marks the page as deleting before the next poll tick
    };

    // Busy when asked: refused at once.
    term.type("go\r");
    await until(() => app.page!.busy);
    await askDelete();
    await until(() => !!app.projectList?.status.includes("mid-turn"));
    expect(existsSync(dir)).toBe(true);
    expect(app.pages.length).toBe(1);
    finish();
    await until(() => !app.page!.busy);

    // While the live-agent check runs, the poll does not start a turn on it.
    term.press({ name: "escape" });
    await askDelete(() => app.page!.orch.say("report"));
    await until(() => !!checking);
    await Bun.sleep(50);
    expect(turns).toBe(1);
    live = ["worker-x"];
    checking!();
    await until(() => !!app.projectList?.status.includes("live agents (worker-x)"));
    expect(existsSync(dir)).toBe(true);
    expect(app.pages.length).toBe(1);
    expect(app.page!.deleting).toBe(false);
    await until(() => turns === 2); // turns resume once the delete is refused
    finish();
    app.quit();
    await running;
  });
});

describe("inline screen", () => {
  const count = (hay: string, needle: string) => hay.split(needle).length - 1;
  const CLEAR = "\x1b[2J\x1b[3J\x1b[H";

  test("typing and sending appends to the scrollback once, without full redraws", async () => {
    const term = fakeTerm();
    const orchs = fakeOrchestrators();
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000 });
    term.display.write("$ parallels start\r\n"); // the shell's output stays above
    const running = app.run("alpha");
    await until(() => !!app.page && term.screen().includes(">"));
    term.type("build it");
    await until(() => term.screen().includes("> build it"));
    term.type("\r");
    await until(() => term.screen().includes("worker-x done"));
    const lines = term.screen().split("\n");
    expect(lines[0]).toBe("$ parallels start");
    expect(lines.slice(4).filter(Boolean).slice(0, 3)).toEqual(["> build it", "alpha says hi", "worker-x done"]);
    expect(lines.filter((l) => l === "> build it").length).toBe(1);
    expect(term.display.clears).toBe(0);
    expect(term.raw()).not.toContain("\x1b[2J");
    expect(term.raw()).not.toContain("\x1b[?1049");
    // Each finished line was written once; only the live region repaints.
    expect(count(strip(term.raw()), "alpha says hi")).toBe(1);
    expect(count(strip(term.raw()), "worker-x done")).toBe(1);
    app.quit();
    await running;
  });

  test("a page switch clears the screen and scrollback and reprints that page; so does a resize", async () => {
    const term = fakeTerm(60);
    const orchs = fakeOrchestrators();
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000 });
    const running = app.run("alpha");
    await until(() => !!app.page);
    term.type("one\r");
    await until(() => term.screen().includes("worker-x done"));
    await app.openPage("beta");
    await until(() => term.display.clears === 1);
    expect(term.raw()).toContain(CLEAR);
    await until(() => term.screen().includes("beta · no remote · 2 pages"));
    expect(term.screen()).not.toContain("alpha says hi");
    term.type("two\r");
    await until(() => term.screen().includes("beta says hi"));

    term.type("\x1a"); // Ctrl+Z back to alpha
    await until(() => term.display.clears === 2);
    await until(() => term.screen().includes("> one\n\nalpha says hi\n\nworker-x done\n"));
    expect(term.screen()).not.toContain("beta says hi");
    const before = term.writes.length;
    term.resize(30, 8);
    await until(() => term.display.clears === 3);
    expect(term.writes.slice(before).join("")).toContain(CLEAR);
    await until(() => term.screen().includes("> one\n\nalpha says hi\n"));
    term.type("/close\r");
    await until(() => term.display.clears === 4 && term.screen().includes("> two\n\nbeta says hi"));
    app.quit();
    await running;
  });

  test("a non-active page's output stays in its history, off the screen; its turn shows as busy", async () => {
    const term = fakeTerm(80);
    const orchs = fakeOrchestrators();
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000 });
    const running = app.run("alpha");
    await until(() => !!app.page);
    const alpha = app.page!;
    await app.openPage("beta");
    await until(() => term.screen().includes("beta · no remote · 2 pages"));
    orchs.writers.alpha!("background line\nhalf");
    alpha.busy = true;
    alpha.busySince = Date.now();
    app.draw();
    await until(() => term.screen().includes("2 pages · 1 busy"));
    expect(alpha.lines.map(raw)).toContain("background line");
    expect(alpha.md.pending).toBe("half");
    expect(strip(term.raw())).not.toContain("background line");
    expect(strip(term.raw())).not.toContain("half");
    alpha.busy = false;
    term.type("\x1a");
    await until(() => term.screen().includes("background line\nhalf"));
    app.quit();
    await running;
  });

  test("/agents clears and shows the transcript live; /back reprints the page", async () => {
    const term = fakeTerm(80);
    const orchs = fakeOrchestrators();
    const transcript = paths.transcript("viewed", "worker-v");
    mkdirSync(join(transcript, ".."), { recursive: true });
    const entry = (content: string) => JSON.stringify({ type: "message", message: { role: "assistant", content } }) + "\n";
    await Bun.write(transcript, entry("worker line one"));
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000, agents: async () => [{ name: "worker-v", live: false }] });
    const running = app.run("viewed");
    await until(() => !!app.page);
    term.type("hello\r");
    await until(() => term.screen().includes("worker-x done"));
    term.type("/agents\r");
    await until(() => !!app.menu);
    term.press({ name: "enter" });
    await until(() => term.display.clears === 1 && term.screen().includes("worker line one"));
    expect(term.screen()).not.toContain("viewed says hi");
    expect(term.screen()).toContain("viewed › worker-v");
    const { appendFileSync } = await import("node:fs");
    appendFileSync(transcript, entry("worker line two"));
    await until(() => term.screen().includes("worker line one\n\nworker line two"));
    // An agent's assistant text is markdown too (as Claude Code shows subagent text); a user prompt stays plain.
    appendFileSync(transcript, entry("**bold** reply\n\n| k | v |\n|---|---|\n| a | b |"));
    appendFileSync(transcript, JSON.stringify({ type: "message", message: { role: "user", content: "**raw** prompt" } }) + "\n");
    await until(() => term.screen().includes("worker line two\n\nbold reply\n\n┌───┬───┐\n│ k │ v │"));
    await until(() => term.screen().includes("> **raw** prompt"));
    term.type("/back\r");
    await until(() => term.display.clears === 2 && term.screen().includes("> hello\n\nviewed says hi\n\nworker-x done"));
    expect(term.screen()).not.toContain("worker line");
    app.quit();
    await running;
  });

  test("quit leaves the output and the cursor on a fresh line below it, and never uses the alternate screen", async () => {
    const term = fakeTerm();
    const orchs = fakeOrchestrators();
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000 });
    const running = app.run("alpha");
    await until(() => !!app.page);
    term.type("hi\r");
    await until(() => term.screen().includes("worker-x done"));
    orchs.writers.alpha!("half a line");
    await until(() => term.screen().includes("half a line"));
    term.type("draft");
    app.quit();
    await running;
    expect(term.closed).toBe(true);
    // The live region (status, input) goes; what was printed stays, the streamed half line too.
    expect(term.screen().split("\n").slice(3).join("\n")).toBe("> hi\n\nalpha says hi\n\nworker-x done\nhalf a line");
    expect(term.display.col).toBe(0);
    expect(term.raw()).not.toContain("1049");

    // The real terminal keeps raw mode and bracketed paste, and no alternate screen.
    const out: string[] = [];
    const modes: boolean[] = [];
    const stdin = { isTTY: true, setRawMode: (on: boolean) => { modes.push(on); }, setEncoding() {}, on() {}, off() {}, resume() {}, pause() {} };
    const stdout = { isTTY: true, columns: 80, rows: 24, write: (s: string) => { out.push(s); return true; }, on() {} };
    const real = realTerminal(stdin as never, stdout as never, undefined, NO_REPLY_WINDOW);
    real.open();
    real.close();
    expect(modes).toEqual([true, false]);
    expect(out.join("")).toContain("\x1b[?2004h");
    expect(out.join("")).toContain("\x1b[?2004l");
    expect(out.join("")).not.toContain("1049");
    expect(out.join("")).not.toContain("\x1b[2J");
  });
});

describe("frames, resizes, startup and crashes", () => {
  test("stream chunks coalesce into a few frames instead of one per chunk", async () => {
    const term = fakeTerm(80);
    const orchs = fakeOrchestrators();
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000 });
    const running = app.run("alpha");
    await until(() => term.screen().includes("alpha ·"));
    const before = term.writes.length;
    const started = Date.now();
    for (let i = 0; i < 40; i++) { orchs.writers.alpha!("x"); await Bun.sleep(1); }
    const elapsed = Date.now() - started;
    await until(() => term.screen().includes("x".repeat(40)));
    // One frame per 16ms at most (plus the trailing one), far fewer than 40.
    expect(term.writes.length - before).toBeLessThanOrEqual(Math.ceil(elapsed / 16) + 2);
    app.quit();
    await running;
  });

  test("a burst of resizes reprints once after it settles; shrinking under a tall live region stays clean", async () => {
    const term = fakeTerm(60, 16);
    const orchs = fakeOrchestrators();
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000 });
    const running = app.run("alpha");
    await until(() => !!app.page);
    term.type("hello\r");
    await until(() => term.screen().includes("worker-x done"));
    term.type("one\x1b\rtwo\x1b\rthree\x1b\rfour");
    app.openMenu("pick one", ["a", "b", "c", "d", "e", "f"].map((v) => ({ value: v, label: v })), () => {});
    await until(() => term.screen().includes("  four") && term.screen().includes("pick one"));
    const before = term.writes.length;
    term.resize(50, 12);
    term.resize(40, 9);
    await Bun.sleep(30);
    term.resize(30, 6);
    app.draw(); // a draw mid-resize writes nothing with the stale geometry
    expect(term.writes.length).toBe(before);
    await until(() => term.display.clears === 1);
    const after = term.writes.slice(before).join("");
    expect(after.split("\x1b[3J").length - 1).toBe(1);
    await until(() => term.screen().includes("  four"));
    const shown = term.display.screen();
    expect(shown.length).toBe(6);
    expect(shown).toContain("  four");
    expect(shown.indexOf("  four")).toBeLessThan(shown.findIndex((r) => r.includes("pick one")));
    expect(shown.join("\n")).toContain("agents running");
    expect(term.display.text().includes("> hello\n\nalpha says hi\n\nworker-x done\n")).toBe(true);
    app.quit();
    await running;
  });

  test("the live region shows 'opening…' at once; lines said or logged before the pages open are kept", async () => {
    const term = fakeTerm(80);
    let gate!: () => void;
    const orchs = fakeOrchestrators();
    const openOrchestrator: typeof orchs.openOrchestrator = async (...args) => { await new Promise<void>((r) => (gate = r)); return orchs.openOrchestrator(...args); };
    const app = new App({ term, openOrchestrator, pollMs: 100_000 });
    term.display.write("$ parallels start\r\n");
    const running = app.run("alpha");
    await until(() => term.screen().includes("opening…"));
    app.say("early note");
    console.warn("logged %s", "early");
    await until(() => term.screen().includes("logged early"));
    gate();
    await until(() => term.screen().includes("alpha · no remote"));
    expect(term.screen().split("\n").slice(0, 3)).toEqual(["$ parallels start", "early note", "logged early"]);
    expect(term.display.clears).toBe(0);
    expect(term.screen()).not.toContain("opening…");
    app.quit();
    await running;
  });

  test("console output and the config warning go into the scrollback, not to stderr", async () => {
    const term = fakeTerm(200);
    const orchs = fakeOrchestrators();
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000 });
    const log = console.log;
    const running = app.run("alpha");
    await until(() => !!app.page);
    expect(console.log).not.toBe(log);
    const stderr = spyOn(process.stderr, "write");
    const stdout = spyOn(process.stdout, "write");
    await Bun.write(paths.config, "maxReviewRounds = [broken");
    try {
      await loadConfig();
      console.log("a log line");
      await until(() => term.screen().includes("parallels: ignoring") && term.screen().includes("a log line"));
      expect(stderr).not.toHaveBeenCalled();
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
      stdout.mockRestore();
      rmSync(paths.config, { force: true });
    }
    app.quit();
    await running;
    expect(console.log).toBe(log); // restored
  });

  test("a frame that throws is reported once and the app keeps running", async () => {
    const term = fakeTerm(80);
    const orchs = fakeOrchestrators();
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000 });
    const running = app.run("alpha");
    await until(() => term.screen().includes("alpha ·"));
    let boom = true;
    app.menu = { title: "bad", index: 0, pick: () => {}, get items(): string[] { if (boom) throw new Error("boom"); return ["ok"]; } };
    app.draw();
    await Bun.sleep(60);
    boom = false;
    app.menu = null;
    app.draw();
    await until(() => term.screen().includes("error drawing the screen: boom"));
    expect(app.page!.lines.filter((l) => raw(l).includes("boom")).length).toBe(1);
    term.type("still here\r");
    await until(() => term.screen().includes("worker-x done"));
    app.quit();
    await running;
  });

  test("escapes and controls in streamed output and replies cannot move the cursor", async () => {
    const term = fakeTerm(80);
    const orchs = fakeOrchestrators();
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000 });
    const running = app.run("alpha");
    await until(() => !!app.page);
    orchs.writers.alpha!("tool \x1b[A\x1b[2Kout\r\x07put\nhalf \x1b[3A\x1b[J");
    await until(() => term.screen().includes("half"));
    app.say("said \x1b[H\x1b[2Jline\b");
    await until(() => term.screen().includes("said line"));
    expect(term.screen().split("\n").slice(3).filter(Boolean).slice(0, 3)).toEqual(["tool output", "said line", "half"]);
    app.quit();
    await running;
  });

  test("the real terminal tidies up on a signal or crash: sync off, paste off, cursor on, live region erased, cooked mode", () => {
    const make = () => {
      const out: string[] = [];
      const modes: boolean[] = [];
      const handlers = new Map<string, (...a: unknown[]) => void>();
      const exits: number[] = [];
      const errs: string[] = [];
      const proc = {
        on: (e: string, fn: (...a: unknown[]) => void) => { handlers.set(e, fn); },
        off: (e: string, fn: (...a: unknown[]) => void) => { if (handlers.get(e) === fn) handlers.delete(e); },
        exit: (code?: number) => { exits.push(code ?? 0); },
        stderr: { write: (s: string) => { errs.push(s); } },
      };
      const stdin = { isTTY: true, setRawMode: (on: boolean) => { modes.push(on); }, setEncoding() {}, on() {}, off() {}, resume() {}, pause() {} };
      const stdout = { isTTY: true, columns: 80, rows: 24, write: (s: string) => { out.push(s); return true; }, on() {} };
      const term = realTerminal(stdin as never, stdout as never, proc as never, NO_REPLY_WINDOW);
      return { term, out, modes, handlers, exits, errs };
    };
    for (const [event, code] of [["SIGTERM", 143], ["SIGHUP", 129], ["uncaughtException", 1], ["exit", null]] as const) {
      const t = make();
      t.term.open();
      expect([...t.handlers.keys()].sort()).toEqual(["SIGHUP", "SIGTERM", "exit", "uncaughtException"]);
      t.term.eraseOnExit("\r\x1b[2A\x1b[J");
      t.handlers.get(event)!(new Error("kaboom"));
      expect(t.out.at(-1)).toBe("\x1b[?2026l\x1b[?2004l\x1b[?25h\r\x1b[2A\x1b[J");
      expect(t.modes).toEqual([true, false]);
      expect(t.exits).toEqual(code === null ? [] : [code]);
      expect(t.errs.join("")).toContain(event === "uncaughtException" ? "kaboom" : "");
      expect(t.handlers.size).toBe(0);
      t.term.close(); // already restored: nothing more
      expect(t.modes).toEqual([true, false]);
    }
    const t = make();
    t.term.open();
    t.term.close();
    expect(t.handlers.size).toBe(0);
    expect(t.modes).toEqual([true, false]);
  });
});

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
    expect(term.screen()).not.toContain("┌");
    write("\x1b[2m▸ bash {\"command\":\"**ls**\"}\x1b[0m\n", true); // a tool line ends the table and stays plain
    await until(() => term.screen().includes("┌"));
    expect(term.screen()).toContain('▸ bash {"command":"**ls**"}');
    expect(term.screen()).toContain("│ tui-markdown │ Render markdown in the chat area │");
    expect(app.page!.lines.slice(-3).map((l) => (typeof l === "string" ? "plain" : "md" in l ? l.md : "user" in l ? l.user : l.tool))).toEqual(["Some **bold** and snake_case", TABLE.trimEnd(), "plain"]);
    app.quit();
    await running;
  });

  test("replies render as markdown after their sender, and a resize re-lays out a table from the raw text", async () => {
    const term = fakeTerm(60, 30);
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
    term.resize(34, 30);
    await until(() => term.display.clears === 1);
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
  test("a page opens with its transcript's history under the shell's output, above the input, and again when switched back to", async () => {
    const t = openTranscript(paths.transcript("resumed", "orchestrator"));
    await t.append({ type: "meta", role: "orchestrator", model: "m" });
    await t.append({ type: "message", message: { role: "user", content: "[user] what changed?" } });
    await t.append({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "**Two** things:\n- a\n- b\n", citations: null }, { type: "tool_use", id: "x1", name: "bash", input: { command: "ls" } }] } });
    await t.append({ type: "message", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x1", content: "SECRET-RESULT" }, { type: "text", text: "[worker-feat] all done" }] } });
    await t.append({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Worker done.", citations: null }] } });
    const term = fakeTerm(50, 20);
    term.display.write("shell$ parallels start\r\n");
    const orchs = fakeOrchestrators();
    // The page is built from the transcript its orchestrator loaded.
    const openOrchestrator: typeof orchs.openOrchestrator = async (...args) => ({ ...(await orchs.openOrchestrator(...args)), entries: () => (args[0] === "resumed" ? t.branch() : []) });
    const app = new App({ term, openOrchestrator, pollMs: 100_000 });
    const running = app.run("resumed");
    await until(() => term.screen().includes("Worker done."));
    const restored = ["shell$ parallels start", "> what changed?", "Two things:", "- a", "- b", "⏺ Bash(ls)", "  ⎿  1 line", "From worker-feat: all done", "Worker done."];
    const rows = term.screen().split("\n");
    expect([rows[0], ...rows.slice(4).filter(Boolean).slice(0, restored.length - 1)]).toEqual(restored);
    expect(term.display.buf[term.display.top + term.display.row]!.join("").trimEnd()).toBe(">"); // input before the status
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
    expect(term.screen().split("\n").slice(3).filter(Boolean).slice(0, restored.length - 1)).toEqual(restored.slice(1));
    app.quit();
    await running;
  });

  test("a restored page shows what it showed live: real orchestrator, scripted model", async () => {
    const TABLE_MD = "| a | b |\n|---|---|\n| 1 | 2 |";
    const runner = { async start() { await put("fidelity", "orchestrator", { from: "worker-feat", text: "Report:\n\nall green" }); }, async stop() {}, async running() { return []; } };
    const tools = { spawn: makeSpawn(runner), message };
    const provider = fakeProvider([
      [said(`Plan:\n${TABLE_MD}\nthen *go*`), toolUse("t1", "spawn", { prompt: "do it", branch: "feat" })],
      [said("```ts\nconst x = 1;\n"), toolUse("t2", "message", { to: "user", text: "Started **feat**." })],
      [said("All set.")],
      // A second turn, started by the poll: a message from `parallels msg` and a report, nothing typed here.
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
    const term = fakeTerm(60, 30);
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
      { tool: "Spawn(feat, worker)", summary: "spawned worker-feat", failed: false },
      { tool: "Message(user: Started **feat**.)", summary: "sent to user", failed: false },
      { tool: "Message(user: Second.)", summary: "sent to user", failed: false },
    ]);
    expect(term.screen()).toContain("⏺ Spawn(feat, worker)\n  ⎿  spawned worker-feat");
    expect(live.map(raw).filter((l) => l.endsWith("> go") || l.endsWith("m go"))).toEqual([`${bold(">")} go`]); // typed here: shown once
    expect(live.map(raw)).toContain(`${bold(">")} from the cli`);
    expect(live.map(raw).some((l) => l.includes("From worker-feat: Report:…"))).toBe(true);
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
  const PICK = "↑↓ or 1–9 choose · Enter pick · type to answer · Esc/Tab later";
  const ANSWER = "Enter send · Esc clear · Tab later";
  const GUARD = "send or clear your message to answer";
  const live = (term: ReturnType<typeof fakeTerm>) => term.display.screen().join("\n");
  const ask1 = (project: string, text: string, options?: string[], def?: string) => askQuestions(project, [{ text, ...(options ? { options } : {}), ...(def ? { default: def } : {}) }]);
  const statusOf = async (project: string) => (await allQuestions(project)).map((q) => [q.text, q.status, q.answer ?? null]);
  /** An app on `project` with a fake orchestrator whose inbox callback is kept, no question delay unless given. */
  async function start(project: string, extra: Partial<ConstructorParameters<typeof App>[0]> = {}) {
    const term = fakeTerm(70, 16);
    const orchs = fakeOrchestrators();
    let onInbox: ((msgs: Message[]) => void) | undefined;
    const openOrchestrator = async (p: string, u: string | undefined, w: (t: string, plain?: boolean) => void, inbox?: (msgs: Message[]) => void) => { onInbox = inbox; return orchs.openOrchestrator(p, u, w); };
    const app = new App({ term, openOrchestrator, pollMs: 20, watchdog: async () => {}, merges: async () => {}, questionDelayMs: 0, ...extra });
    const running = app.run(project);
    await until(() => !!app.page);
    if (!extra.questions && (await allQuestions(project)).some((q) => q.status === "open")) await app.questions.command(app.page); // explicit opt-in
    return { term, orchs, app, running, inbox: (msgs: Message[]) => onInbox!(msgs), stop: async () => { app.quit(); await running; } };
  }

  test("Enter on an option answers it; one dim line goes to the scrollback; the inbox message reaches the orchestrator", async () => {
    const [q] = await ask1("qa-opt", "Which db?", ["postgres", "sqlite"], "sqlite");
    const { term, orchs, app, stop } = await start("qa-opt");
    await until(() => live(term).includes("? Which db?") && live(term).includes("❯ 1. postgres"));
    expect(live(term)).toContain("type your own answer");
    expect(live(term)).toContain("skip (use default: sqlite)");
    expect(live(term)).toContain(PICK);
    expect(live(term)).toContain("1 question");
    term.press({ name: "down" });
    await until(() => live(term).includes("❯ 2. sqlite"));
    term.press({ name: "enter" });
    await until(() => term.screen().includes("? Which db? → sqlite"));
    expect(await statusOf("qa-opt")).toEqual([["Which db?", "answered", "sqlite"]]);
    await until(() => !live(term).includes(PICK));
    expect(live(term)).not.toContain("question");
    expect(orchs.said["qa-opt"]).toEqual([]); // not sent as a chat message
    const inbox = await drain("qa-opt", "orchestrator");
    expect(inbox.map((m) => [m.from, m.text])).toEqual([["user", `[${q!.id}] answer to "Which db?": sqlite`]]);
    expect(app.page!.lines.map(raw)).toContain(answeredLine("Which db?", "sqlite"));
    await stop();
  });

  test("digits 1–9 pick an option on an option row; a digit past the options starts a typed answer", async () => {
    await askQuestions("qa-digit", [{ text: "Which db?", options: ["postgres", "sqlite"] }, { text: "Port?", options: ["80"] }]);
    const { term, app, stop } = await start("qa-digit");
    await until(() => live(term).includes("❯ 1. postgres"));
    term.type("2");
    await until(() => term.screen().includes("? Which db? → sqlite"));
    await until(() => live(term).includes("? Port?"));
    term.type("9");
    await until(() => live(term).includes("answer> 9"));
    expect(app.page!.questions.open).toHaveLength(1);
    await stop();
  });

  test("arrival never steals a chat draft; Ctrl+Q opens explicitly and closing preserves it", async () => {
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

  test("Enter, digits and typing do nothing for a moment after a question first shows", async () => {
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

  test("Esc never sends: it clears a typed answer, then puts the queue off; skip is a row", async () => {
    await askQuestions("qa-esc", [{ text: "Port?", options: ["80", "8080"], default: "8080" }, { text: "Host?" }]);
    const { term, app, stop } = await start("qa-esc");
    await until(() => live(term).includes("? Port? (1 of 2)"));
    term.press({ name: "escape" }); // empty input: put off, like Tab
    await until(() => !live(term).includes("? Port?"));
    expect(live(term)).toContain("2 questions");
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
    await until(() => live(term).includes("❯ skip (use default: 8080)"));
    term.press({ name: "enter" });
    await until(() => term.screen().includes("? Port? → skipped, default: 8080"));
    await until(() => live(term).includes("? Host?") && live(term).includes("  skip"));
    term.press({ name: "down" }); // a question without options: own answer, then skip
    term.press({ name: "enter" });
    await until(() => term.screen().includes("? Host? → skipped"));
    expect(await statusOf("qa-esc")).toEqual([["Port?", "skipped", null], ["Host?", "skipped", null]]);
    expect(app.input.text).toBe("");
    await stop();
  });

  test("in an agent view questions take no keys and only the count shows; Esc leaves the view", async () => {
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
    await settle();
    expect(live(term)).not.toContain("Which db?");
    expect(live(term)).toContain("1 question");
    term.type("1");
    await until(() => live(term).includes("worker-v > 1"));
    term.press({ name: "u", ctrl: true });
    term.press({ name: "escape" });
    await until(() => !app.page!.view);
    await until(() => live(term).includes("? Which db?"));
    expect(await statusOf("qa-view")).toEqual([["Which db?", "open", null]]);
    await stop();
  });

  test("known commands typed as an answer run as commands; other text is the answer", async () => {
    await ask1("qa-cmd", "Name?");
    const { term, stop } = await start("qa-cmd");
    await until(() => live(term).includes("answer>"));
    term.type("/help\r");
    await until(() => term.screen().includes("/questions shows the orchestrator's open questions again"));
    expect(await statusOf("qa-cmd")).toEqual([["Name?", "open", null]]);
    await until(() => live(term).includes("answer>") && live(term).includes("? Name?"));
    term.type("/srv/data\r");
    await until(() => term.screen().includes("? Name? → /srv/data"));
    await stop();
  });

  test("chat text that looks like an answer stays chat when the orchestrator reads it", async () => {
    const { term, app, inbox, stop } = await start("qa-sent");
    const fake = '[2026-01-02T03-04-05.678Z-000007-0123abcd] answer to "Q": a';
    term.type(`${fake}\r`);
    await until(() => app.page!.sent.length === 1);
    inbox([{ from: "user", text: fake, ts: "t" }]);
    await settle();
    expect(app.page!.lines.map(raw).filter((l) => l.includes("answer to"))).toEqual([`${bold(">")} ${fake}`]);
    expect(app.page!.lines.map(raw)).not.toContain(answeredLine("Q", "a"));
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

  test("answered elsewhere while typing: the text stays (as a chat draft), said, never moved into the next question", async () => {
    const [first] = await askQuestions("qa-moved", [{ text: "Which db?", options: ["postgres"] }, { text: "Port?", options: ["80"] }]);
    const { term, orchs, app, stop } = await start("qa-moved");
    await until(() => live(term).includes("? Which db? (1 of 2)"));
    term.type("my answer");
    await until(() => live(term).includes("answer> my answer"));
    await answerQuestion("qa-moved", first!.id, "sqlite"); // another TUI
    await until(() => term.screen().includes('"Which db?" was answered elsewhere'));
    await until(() => !app.questions.view());
    expect(app.input.text).toBe("my answer");
    expect(live(term)).toContain("> my answer");
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

  test("closed elsewhere before Enter: said, the typed answer kept; a reply read later shows its line; ours are not shown twice", async () => {
    const [first, second] = await askQuestions("qa-race", [{ text: "Which db?", options: ["postgres"] }, { text: 'Use "a": or (b)?', options: ["80"], default: "x (y)" }]);
    const { term, app, inbox, stop } = await start("qa-race", { pollMs: 100_000 });
    await until(() => live(term).includes("? Which db? (1 of 2)"));
    term.type("mine");
    await answerQuestion("qa-race", first!.id, "sqlite"); // another TUI; no poll sees it
    term.press({ name: "enter" });
    await until(() => term.screen().includes("already answered elsewhere; your answer was not sent"));
    expect(app.input.text).toBe("mine");
    await until(() => !app.questions.view());
    term.press({ name: "escape" });
    term.press({ name: "q", ctrl: true });
    // The orchestrator reads the other TUI's answer: shown as a restored page shows it.
    inbox(await drain("qa-race", "orchestrator"));
    await until(() => term.screen().includes("? Which db? → sqlite"));
    // An option picked here, closed elsewhere first: said too.
    await answerQuestion("qa-race", second!.id, "81");
    await until(() => live(term).includes(PICK));
    term.press({ name: "enter" });
    await until(() => term.screen().split("already answered elsewhere").length === 3);
    inbox(await drain("qa-race", "orchestrator"));
    await until(() => term.screen().includes('? Use "a": or (b)? → 81'));
    // Answered here: not shown twice when read.
    await ask1("qa-race", "Again?", ["yes"]);
    term.type("/questions\r");
    await until(() => live(term).includes("? Again?"));
    term.press({ name: "enter" });
    await until(() => term.screen().includes("? Again? → yes"));
    inbox(await drain("qa-race", "orchestrator"));
    await settle();
    expect(app.page!.lines.map(raw).filter((l) => l === answeredLine("Again?", "yes"))).toHaveLength(1);
    await stop();
  });

  test("an answer while a reply streams waits for its partial line, so the reply is not split", async () => {
    await ask1("qa-stream", "Which db?", ["postgres"]);
    const { term, orchs, app, stop } = await start("qa-stream");
    await until(() => live(term).includes("? Which db?"));
    (orchs.writers["qa-stream"] as (t: string, plain?: boolean) => void)("half a rep");
    await until(() => app.page!.md.pending === "half a rep");
    term.press({ name: "enter" });
    await until(() => (app.page!.held.length as number) === 1);
    expect(app.page!.lines.map(raw)).not.toContain(answeredLine("Which db?", "postgres"));
    (orchs.writers["qa-stream"] as (t: string, plain?: boolean) => void)("ly\n");
    (orchs.writers["qa-stream"] as (t: string, plain?: boolean) => void)("▸ tool\n", true); // ends the markdown
    await until(() => app.page!.lines.map(raw).includes(answeredLine("Which db?", "postgres")));
    const lines = app.page!.lines.map(raw);
    expect(lines.indexOf("half a reply")).toBeLessThan(lines.indexOf(answeredLine("Which db?", "postgres")));
    await stop();
  });

  test("Tab puts the queue off so chat works; a new question or /questions shows it again; /questions lists several", async () => {
    await ask1("qa-tab", "Which db?", ["postgres", "sqlite"]);
    const { term, orchs, stop } = await start("qa-tab");
    await until(() => live(term).includes("? Which db?"));
    term.press({ name: "tab" });
    await until(() => !live(term).includes("? Which db?"));
    expect(live(term)).toContain("1 question"); // still counted
    term.type("hello\r");
    await until(() => orchs.said["qa-tab"]?.length === 1);
    expect(orchs.said["qa-tab"]).toEqual(["hello"]);
    term.press({ name: "up" }); // history, not the question
    await until(() => live(term).includes("> hello"));
    term.press({ name: "u", ctrl: true });

    await ask1("qa-tab", "Port?");
    await until(() => live(term).includes("2 questions")); // arrival only updates the count
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
    await until(() => live(term).includes("qa-bg: 2 questions"));
    expect(live(term)).not.toContain("One?");
    term.type("\x18");
    await until(() => app.page?.project === "qa-bg");
    term.press({ name: "q", ctrl: true });
    await until(() => live(term).includes("? One? (1 of 2)"));
    expect(live(term)).toContain("2 questions");
    expect(live(term)).not.toContain("qa-bg: 2");
    await stop();
  });

  test("modifier chords never pick, put off or clear a question; Ctrl+C still quits", async () => {
    await ask1("qa-chord", "Which db?", ["postgres", "sqlite"], "sqlite");
    const { term, app, running } = await start("qa-chord");
    await until(() => live(term).includes("❯ 1. postgres"));
    for (const k of [{ name: "down", ctrl: true }, { name: "down", alt: true }, { name: "enter", ctrl: true }, { name: "escape", alt: true }, { name: "tab", shift: true }, { name: "j", ctrl: true }, { name: "2", alt: true }]) term.press(k);
    await settle();
    expect(live(term)).toContain("❯ 1. postgres");
    expect(app.page!.questions.open).toHaveLength(1);
    expect(app.page!.questions.hidden).toBeNull();
    expect(await statusOf("qa-chord")).toEqual([["Which db?", "open", null]]);
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
      all: async () => [],
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

  test("a restored page shows an answer the way it showed live: real orchestrator, scripted model", async () => {
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
    expect(shown.map(raw)).toEqual([answeredLine('Use "a": or (b)?', "sqlite"), "Noted, sqlite."]);
    await stop();

    const again = await start("qa-restore", { openOrchestrator: open, pollMs: 100_000 });
    expect(again.app.page!.lines).toEqual(shown);
    await again.stop();
  });
});

describe("command and key tables", () => {
  /** /help as it was written before the command table, line for line. */
  const OLD_HELP = [
    "^N new orchestrator   ^Z ^X switch pages   Esc clear (scroll with your terminal)",
    "^B or /projects: every project; ↑↓ jk move, Enter opens, p pins, d deletes, Esc closes",
    "Shift+Enter or Alt+Enter new line   Alt+←→ / Alt+B F words   Alt+⌫ ^W Alt+D delete words",
    "Home End ^A ^E ^U ^K act on the current line   ↑↓ move between rows, then history",
    "/keys shows what your terminal sends for a chord (Esc ends)",
    "/rename <name>   /new [name] [git-url]   /close closes this page   /quit",
    "/agents   /effort [level|default]   /fast [on|off]   /models [id]   /accounts   /login claude|codex [profile]",
    "/review-rounds [n] review rounds before CI (0 = straight to CI)",
    "/questions shows the orchestrator's open questions again: ↑↓ or 1–9 choose, Enter picks (or skips on the skip row), type to answer, Esc/Tab later",
  ];
  const OLD_HELP_VIEW = "/back (or Esc) leaves the agent view";
  const bare = () => new App({ term: fakeTerm(), openOrchestrator: fakeOrchestrators().openOrchestrator, pollMs: 100_000 });

  test("/help is built from the table: every command but /help is listed, /back only in an agent view, text unchanged", () => {
    const app = bare();
    const help = helpLines(app.commands, false).join("\n");
    const inView = helpLines(app.commands, true).join("\n");
    for (const name of app.commands.keys()) {
      if (name === "/help") continue; // never listed itself, as before
      expect(inView).toContain(name);
      if (name !== "/back") expect(help).toContain(name);
    }
    expect(help).not.toContain("/back");
    expect(helpLines(app.commands, false)).toEqual(OLD_HELP);
    expect(helpLines(app.commands, true)).toEqual([...OLD_HELP, OLD_HELP_VIEW]);
    expect([...app.commands.keys()].sort()).toEqual(["/accounts", "/agents", "/back", "/close", "/effort", "/fast", "/help", "/keys", "/login", "/models", "/new", "/projects", "/questions", "/quit", "/rename", "/review-rounds"]);
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
    for (const [name, c] of commands) if (c.needsPage) expect(name).toBe("/agents"); // /models handles no-page explicitly
  });

  test("unknown commands say 'unknown command /x' (the name only), as before", async () => {
    const term = fakeTerm(80);
    const orchs = fakeOrchestrators();
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000 });
    const running = app.run("alpha");
    await until(() => !!app.page);
    for (const t of ["/nope", "/nope with args", "/quit now", "/help me"]) term.type(`${t}\r`);
    const unknown = () => app.page!.lines.map(raw).filter((l) => l.includes("unknown command"));
    await until(() => unknown().length === 4);
    expect(unknown()).toEqual(["unknown command /nope", "unknown command /nope", "unknown command /quit", "unknown command /help"].map(dim));
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
      await until(() => term.screen().trim() === ">"); // let the close's reprint land first (a reprint with no page drops lines said before it)
      term.type("/help\r"); // needs no page: runs with none
      await until(() => term.screen().includes("/review-rounds [n]"));
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

  test("guard: in an agent view every command runs; plain text is refused", async () => {
    const term = fakeTerm(80);
    const orchs = fakeOrchestrators();
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000 });
    const running = app.run("viewer");
    await until(() => !!app.page);
    const view = { name: "worker-x", lines: [] as string[], leave: () => {}, live: false, calls: new Calls() };
    app.page!.view = view;
    term.type("/keys\r");
    await until(() => app.keyEcho);
    term.press({ name: "escape" });
    term.type("/review-rounds 2\r/nope\rhello\r");
    await until(() => view.lines.join("\n").includes("/back first to talk to the orchestrator"));
    expect(view.lines.join("\n")).toContain("unknown command /nope");
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
    term.type("/login openai\r/keys\r");
    await until(() => app.keyEcho && term.screen().includes("already signing in"));
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
    expect(bare().keyLayers.map((l) => l.name)).toEqual(["keyEcho", "chords", "projects", "menu", "questions", "escape", "enter", "editor"]);
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
    const term = fakeTerm(30, 10);
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
      expect(term.display.buf[row]!.join("").trimEnd()).toBe("> draft");
      expect([bg[row], bg[row + 1]]).toEqual([true, true]); // input, bottom status
      expect(term.display.col).toBe(7);
    };
    check(30);
    term.resize(24, 10);
    await until(() => term.display.clears === 1 && term.screen().includes("> draft"));
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
    await until(() => term.screen().includes("⏺ Bash(git status)"));
    expect(app.page!.lines.some((l) => typeof l !== "string" && "tool" in l)).toBe(false); // live only, not committed
    expect(term.screen()).toContain("working…"); // the status line's word, shimmering too
    const frame = () => app.frame().running!.join("");
    const first = frame();
    expect(frame()).toBe(first); // same instant, same frame
    state.now += 400;
    expect(frame()).not.toBe(first); // the band moved
    expect(state.ticks.length).toBe(1); // the animation timer runs while the turn does
    state.events!.onToolResult({ id: "c1", ok: true, text: "M a.ts\nM b.ts\n" });
    await until(() => term.screen().includes("⏺ Bash(git status)\n  ⎿  2 lines"));
    expect(app.frame().running).toEqual([]);
    state.events!.onTool({ id: "c2", name: "bash", input: { command: "make" } });
    state.events!.onToolResult({ id: "c2", ok: true, text: "x: error 1\n[exit 2]" });
    await until(() => term.screen().includes("⏺ Bash(make)\n  ⎿  exit 2: x: error 1"));
    expect(term.raw()).toContain("\x1b[31m⏺");
    state.finish!();
    await until(() => !app.page!.busy);
    expect(state.ticks.length).toBe(0); // nothing runs: no timer
    app.quit();
    await running;
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
    await until(() => term.screen().includes("checking") && term.screen().includes("⏺ Bash(bun test)"));
    expect(app.page!.view!.lines.some((l) => typeof l !== "string" && "tool" in l)).toBe(false); // still running
    const { appendFileSync } = await import("node:fs");
    appendFileSync(transcript, line("user", [{ type: "tool_result", tool_use_id: "u1", content: "1 pass\n0 fail\n" }]));
    await until(() => term.screen().includes("⏺ Bash(bun test)\n  ⎿  2 lines"));
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
  inbox(["one", "two", "external"].map((text) => ({ from: "user", text, ts: "" })));
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
  await until(() => term.screen().includes("⏺ Bash(wait)\n  ⎿  interrupted"));
  expect(app.page!.calls.size).toBe(0);
  expect(term.raw()).toContain("\x1b[31m⏺");
  term.type("/agents\r");
  await until(() => !!app.menu);
  term.press({ name: "enter" });
  await until(() => term.screen().includes("⏺ Bash(sleep forever)\n  ⎿  interrupted"));
  expect(app.page!.view!.calls.size).toBe(0);
  app.quit();
  await running;
});

test("header caches model and filters subagent counts; unchanged background frames write no bytes", async () => {
  const term = fakeTerm(80, 24);
  const ticks: { fn: () => void; ms: number }[] = [];
  let now = 0;
  const clock: Clock = { now: () => now, every: (fn, ms) => { const tick = { fn, ms }; ticks.push(tick); return () => { ticks.splice(ticks.indexOf(tick), 1); }; } };
  let model = "model-a", reads = 0;
  const app = new App({ term, clock, pollMs: 100_000, projectModel: async () => { reads++; return model; }, agents: async () => [{ name: "orchestrator", live: true }, { name: "worker-a", live: true }, { name: "reviewer-a", live: true }, { name: "worker-old", live: false }], openOrchestrator: fakeOrchestrators().openOrchestrator });
  const running = app.run("header-test");
  await until(() => term.screen().includes("model-a") && term.screen().includes("2 agents running"));
  const readOnce = reads;
  app.frame(); app.frame();
  expect(reads).toBe(readOnce);
  model = "model-b";
  await app.refreshHeader();
  await until(() => term.screen().includes("model-b") && term.display.clears === 1);
  const background = app.page!;
  await app.openPage("foreground-test");
  background.busy = true;
  app.draw();
  await settle();
  expect(ticks.map((t) => t.ms)).toEqual([100]);
  const before = term.writes.length;
  const lastBytes = Buffer.byteLength(term.writes.at(-1)!);
  for (let i = 0; i < 10; i++) { now += 100; ticks[0]!.fn(); await Bun.sleep(20); }
  const bytes = term.writes.slice(before).reduce((n, s) => n + Buffer.byteLength(s), 0);
  expect(bytes).toBe(0);
  await Bun.write("/tmp/tui-background-bandwidth.json", JSON.stringify({ cols: 80, rows: 24, oldBytesPerSecond: lastBytes * (1000 / 33), newBytesPerSecond: bytes }));
  app.page!.busy = true;
  app.draw();
  expect(ticks.map((t) => t.ms)).toEqual([33]);
  app.quit();
  await running;
});
