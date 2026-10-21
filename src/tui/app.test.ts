import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Orchestrator } from "../orchestrator";
import { App, type Clock } from "./app";
import { parseKeys, type Key } from "./keys";
import type { Terminal } from "./term";

const home = mkdtempSync(join(tmpdir(), "parallels-tui-"));
process.env.PARALLELS_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));

const strip = (s: string) => s.replace(/\x1b\[[0-9;?<>]*[A-Za-z]/g, "");

function fakeTerm(cols = 40) {
  const handlers: ((k: Key) => void)[] = [];
  let screen = "";
  const term: Terminal & { type(s: string): void; press(k: Key): void; screen(): string; opened: boolean; closed: boolean } = {
    cols, rows: 8, opened: false, closed: false,
    write: (s) => { screen = s; },
    onKey: (cb) => { handlers.push(cb); },
    onResize: () => {},
    open() { this.opened = true; },
    close() { this.closed = true; },
    press: (k) => { for (const h of handlers) h(k); },
    type: (s) => { for (const k of parseKeys(s)) for (const h of handlers) h(k); },
    screen: () => strip(screen),
  };
  return term;
}

function fakeOrchestrators() {
  const opened: { project: string; url?: string }[] = [];
  const said: Record<string, string[]> = {};
  const writers: Record<string, (t: string) => void> = {};
  const openOrchestrator = async (project: string, url: string | undefined, write: (t: string) => void): Promise<Orchestrator> => {
    opened.push({ project, url });
    said[project] = [];
    writers[project] = write;
    let queued = 0;
    return {
      async say(text) { said[project]!.push(text); queued++; },
      async pending() { return queued > 0; },
      async turn() {
        queued = 0;
        write(`${project} says hi\n`);
        return [{ from: "worker-x", text: "done", ts: "t" }];
      },
    };
  };
  return { opened, said, writers, openOrchestrator };
}

const settle = () => Bun.sleep(15);
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
    await settle();
    expect(term.opened).toBe(true);
    expect(orchs.opened).toEqual([{ project: "alpha", url: undefined }]);
    term.type("build it\r");
    await settle();
    expect(orchs.said.alpha).toEqual(["build it"]);
    const screen = term.screen();
    expect(screen).toContain("> build it");
    expect(screen).toContain("alpha says hi");
    expect(screen).toContain("worker-x done");
    term.type("/quit\r");
    await running;
    expect(term.closed).toBe(true);
  });

  test("Ctrl+N starts orch-xxxx at once; Ctrl+Z and Ctrl+X switch pages", async () => {
    const term = fakeTerm();
    const orchs = fakeOrchestrators();
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000 });
    const running = app.run("alpha");
    await settle();
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

  test("/rename moves the project directory and reopens the orchestrator", async () => {
    mkdirSync(join(home, "projects", "orch-old", "repo"), { recursive: true });
    const term = fakeTerm();
    const orchs = fakeOrchestrators();
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000 });
    const running = app.run("orch-old");
    await settle();
    term.type("/rename login-page\r");
    await until(() => term.screen().includes("orch-old → login-page"));
    expect(app.page!.project).toBe("login-page");
    expect(orchs.opened.map((o) => o.project)).toEqual(["orch-old", "login-page"]);
    expect(existsSync(join(home, "projects", "login-page", "repo"))).toBe(true);
    expect(existsSync(join(home, "projects", "orch-old"))).toBe(false);
    term.type("/rename bad name\r");
    await until(() => term.screen().includes("error: names are letters"));
    app.quit();
    await running;
  });

  test("/keys echoes parsed keys until Esc", async () => {
    const term = fakeTerm();
    const orchs = fakeOrchestrators();
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000 });
    const running = app.run("alpha");
    await settle();
    term.type("/keys\r");
    await settle();
    term.type("\x1b[44;5u");
    term.press({ name: "escape" });
    await settle();
    expect(term.screen()).toContain('{"name":",","ctrl":true}');
    expect(app.keyEcho).toBe(false);
    expect(app.pages.length).toBe(1); // the chord was echoed, not acted on
    app.quit();
    await running;
  });

  test("the screen is bare until /help", async () => {
    const term = fakeTerm();
    const orchs = fakeOrchestrators();
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000 });
    const running = app.run("alpha");
    await settle();
    expect(term.screen()).not.toContain("/models");
    term.type("/help\r");
    await settle();
    expect(term.screen()).toContain("/rename <name>");
    expect(term.screen()).toContain("/models [id]");
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
    await until(() => term.screen().includes("/projects/other/repo")); // the header shows the clone path
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
    await Bun.sleep(60);
    expect(term.screen()).toContain("worker-x done");
    app.quit();
    await running;
  });

  test("menus move with arrows and pick with Enter; Esc cancels", async () => {
    const term = fakeTerm();
    const orchs = fakeOrchestrators();
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000 });
    const running = app.run("alpha");
    await settle();
    let picked = "";
    app.openMenu("pick one", [{ value: "x", label: "x" }, { value: "y", label: "y" }], (v) => { picked = v; });
    term.press({ name: "down" });
    term.press({ name: "enter" });
    await settle();
    expect(picked).toBe("y");
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
    await settle();
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
    await settle();
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
    const term = fakeTerm();
    let writesAfterClose = 0;
    const termWrite = term.write;
    term.write = (s) => { if (term.closed) writesAfterClose++; termWrite(s); };
    const app = new App({ term, openOrchestrator, pollMs: 100_000, clock, agents });
    const running = app.run("alpha");
    await settle();
    expect(started).toBe(0); // idle: no timer
    term.type("go\r");
    await settle();
    expect(started).toBe(1);
    expect(term.screen()).toContain("⠋ thinking… 0s");
    expect(term.screen()).toContain(" alpha ⠋ ");
    now = 2_150;
    ticks[0]!();
    await settle();
    expect(term.screen()).toContain("⠙ thinking… 2s");
    write("partial text");
    await settle();
    expect(term.screen()).toContain("working… 2s");
    finish();
    await settle();
    expect(stopped).toBe(1);
    expect(ticks.length).toBe(0);
    expect(term.screen()).not.toContain("working…");

    // Viewing a live agent through /agents shows the line until it finishes.
    term.type("/agents\r");
    await until(() => !!app.menu);
    term.press({ name: "enter" });
    await settle();
    expect(app.page!.view?.name).toBe("worker-x");
    expect(started).toBe(2);
    expect(term.screen()).toContain("following worker-x");
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
    await settle();
    expect(term.screen()).not.toContain("following");
    expect(ticks.length).toBe(0);

    // Busy while viewing a finished agent: the page's own turn shows.
    term.press({ name: "escape" }); // leave the view
    await until(() => !app.page!.view);
    term.type("again\r");
    await settle();
    term.type("/agents\r");
    await until(() => !!app.menu);
    term.press({ name: "enter" });
    await settle();
    expect(app.page!.view?.live).toBe(false);
    expect(term.screen()).toContain("thinking… ");

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
});
