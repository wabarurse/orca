import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Orchestrator } from "../orchestrator";
import { displayName, newProjectName, setDisplayName } from "../commands";
import { loadConfig } from "../config";
import { App, type Clock } from "./app";
import { parseKeys, type Key } from "./keys";
import type { Terminal } from "./term";

const home = mkdtempSync(join(tmpdir(), "parallels-tui-"));
process.env.PARALLELS_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));

const strip = (s: string) => s.replace(/\x1b\[[0-9;?<>]*[A-Za-z]/g, "");

function fakeTerm(cols = 40, rows = 8) {
  const handlers: ((k: Key) => void)[] = [];
  let screen = "";
  const term: Terminal & { type(s: string): void; press(k: Key): void; screen(): string; opened: boolean; closed: boolean } = {
    cols, rows, opened: false, closed: false,
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
    expect(term.screen()).toContain("login page  ·  "); // header
    expect(app.frame().tabs[0]!.title).toBe("login page");
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
    const view = { name: "worker-x", lines: [] as string[], leave: () => { left++; }, live: false };
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
    const view = { name: "worker-x", lines: [] as string[], leave: () => {}, live: false };
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
    await until(() => app.page!.lines.filter((l) => l.includes("queued; runs after sign-in")).length === 2);
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
    const term = fakeTerm();
    let writesAfterClose = 0;
    const termWrite = term.write;
    term.write = (s) => { if (term.closed) writesAfterClose++; termWrite(s); };
    const app = new App({ term, openOrchestrator, pollMs: 100_000, clock, agents });
    const running = app.run("alpha");
    await until(() => !!app.page);
    expect(started).toBe(0); // idle: no timer
    term.type("go\r");
    await until(() => started === 1 && term.screen().includes("⠋ thinking… 0s"));
    expect(term.screen()).toContain(" alpha ⠋ ");
    now = 2_150;
    ticks[0]!();
    await until(() => term.screen().includes("⠙ thinking… 2s"));
    write("partial text");
    await until(() => term.screen().includes("working… 2s"));
    finish();
    await until(() => stopped === 1);
    expect(ticks.length).toBe(0);
    expect(term.screen()).not.toContain("working…");

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
    expect(page.lines.map(strip)).toContain(">   first");
    expect(page.lines.map(strip)).toContain("  second");
    expect(page.lines.some((l) => l.includes("\n"))).toBe(false);
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
    const lines = app.page!.lines.map(strip);
    expect(lines).toContain("> line one");
    expect(lines).toContain("  line two");
    expect(app.page!.lines.some((l) => l.includes("\n"))).toBe(false);
    finish();
    await until(() => orchs.said.queuer?.length === 1);
    expect(orchs.said.queuer).toEqual(["line one\nline two"]);
    app.quit();
    await running;
  });
});
