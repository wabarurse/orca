import { appFixture } from "../test/app-fixture";
import { readProjectState, writeProjectState } from "../config";
import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Orchestrator } from "../core/agent-loop/orc/orchestrator";
import { displayName, newProjectName, setDisplayName } from "../core/data/projects/registry";
import { loadConfig, paths } from "../config/config";
import { effectiveFlow } from "../core/data/projects/flow";
import { AGENTS_TICK_MS, App, type Clock, type ToolEvents } from "./app";
import { historyRows } from "./conversation/lines";
import { text as said } from "../test/fake-provider";
import { message } from "../core/tools/message";
import { realTerminal } from "./components/term";
import { dim } from "./components/text";
import { Calls } from "./conversation/tools";

const { home, screenErrors, USER_BG, strip, raw, fakeTerm, bodyStart, bodyRows, clickRow, fakeOrchestrators, settle, NO_REPLY_WINDOW, until } = appFixture();

describe("tui app", () => {
  test("orca welcome stays static until submission, then only the header fin animates", async () => {
    const term = fakeTerm(100, 40), fake = fakeOrchestrators();
    let now = 0, publish!: () => void, finish!: () => void;
    const publishing = new Promise<void>(resolve => { publish = resolve; });
    const finishing = new Promise<void>(resolve => { finish = resolve; });
    const ticks = new Set<() => void>();
    const clock: Clock = { now: () => now, every: fn => { ticks.add(fn); return () => { ticks.delete(fn); }; } };
    const app = new App({ term, clock, pollMs: 100_000, agents: async () => [], watchdog: async () => {}, merges: async () => {},
      openOrchestrator: async (...args) => {
        const orch = await fake.openOrchestrator(args[0], args[1], args[2], args[3]);
        return { ...orch, say: async (...input) => { await publishing; await orch.say(...input); }, turn: async () => { await orch.turn(); await finishing; return []; } };
      },
    });
    const running = app.run("orca-welcome");
    const header = () => term.display.screen().slice(0, bodyStart(term)).join("\n");
    try {
      await until(() => app.frame().welcome === true && term.screen().includes("########"));
      expect(header()).not.toContain("#");
      expect(app.page!.lines).toEqual([]);
      expect(ticks.size).toBe(0);
      const art = bodyRows(term).filter(row => /#/.test(row));
      term.type("first prompt"); now = 1200; app.draw();
      await settle();
      expect(bodyRows(term).filter(row => /#/.test(row))).toEqual(art);
      term.type("\r");
      await until(() => app.page!.sent.length === 1 && header().includes("~"));
      expect(app.frame().welcome).toBe(false);
      expect(bodyRows(term).join("\n")).not.toContain("#");
      expect(app.page!.lines).toEqual([]); // still waiting for inbox publication
      publish();
      await until(() => app.page!.busy && app.page!.lines.length > 0);
      await settle();
      const before = header(); now = 2400; ticks.forEach(tick => tick());
      await until(() => header() !== before);
      expect(bodyRows(term).join("\n")).not.toContain("#");
      finish();
      await until(() => !app.page!.busy && ticks.size === 0);
      await app.openPage("orca-fresh");
      await until(() => app.frame().welcome === true);
      app.active = 0; app.reprint();
      await until(() => app.frame().welcome === false && header().includes("~"));
      expect(app.page!.lines.map(raw).join("\n")).not.toContain("#");
    } finally { publish(); finish(); app.quit(); await running; }
    expect(term.display.screen().join("\n")).not.toContain("#"); // no decoration in exit replay
  });

  test("closing pages and quitting dispose idle background memory without cancelling idle projects", async () => {
    const term = fakeTerm(), fake = fakeOrchestrators(), disposed: string[] = [], cancelled: string[] = [];
    const app = new App({ term, pollMs: 100_000, openOrchestrator: async (...args) => ({
      ...await fake.openOrchestrator(args[0], args[1], args[2], args[3]), dispose: () => { disposed.push(args[0]); }, cancel: () => { cancelled.push(args[0]); },
    }) });
    const running = app.run("memory-first");
    try {
      await until(() => !!app.page);
      await app.openPage("memory-second");
      app.closePage();
      expect(disposed).toEqual(["memory-second"]);
    } finally { app.quit(); await running; }
    expect(disposed).toEqual(["memory-second", "memory-first"]);
    expect(cancelled).toEqual([]);
  });

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

  test("ctrl+n starts orch-xxxx at once; ctrl+z and ctrl+x switch pages", async () => {
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
    expect(app.page!.lines).toEqual([]); // a transient note above the composer, not conversation

    term.type("\x1a"); // Ctrl+Z
    expect(app.page!.project).toBe("alpha");
    expect(strip(app.frame().inputArea!.lines.join("\n"))).not.toContain("/rename");
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
    expect(term.closed).toBe(false);
    term.press({ name: "c", ctrl: true });
    await running;
  });

  test("model lifecycle daemon notices do not split live App tool groups", async () => {
    const term = fakeTerm(180), fake = fakeOrchestrators();
    let events!: ToolEvents;
    const app = new App({ term, pollMs: 100_000, openOrchestrator: async (p, url, write, inbox, tools) => {
      events = tools!;
      return fake.openOrchestrator(p, url, write, inbox);
    } });
    const running = app.run("lifecycle-notices");
    const diagnostic = (stage: string) => `[model request] openai/gpt-6-astra ${stage}; started 2026-10-27T00:00:00Z; updated 2026-10-27T00:00:08Z`;
    const finish = (id: string) => {
      events.onTool({ id, name: "bash", input: { command: `echo ${id}` } });
      events.onToolResult({ id, ok: true, text: "ok" });
    };
    try {
      await until(() => !!app.page);
      finish("one");
      for (const stage of ["preparing", "provider-wait", "completed"]) {
        events.notice!(diagnostic(stage));
        expect(strip(app.frame().inputArea!.lines.join("\n"))).toContain(diagnostic(stage));
        expect(app.page!.lines).toHaveLength(1);
      }
      finish("two");
      await until(() => term.screen().includes("▸ 2 tool calls · bash ×2"));
      expect(app.page!.lines).toHaveLength(2);
      for (const notice of [diagnostic("error"), diagnostic("aborted"),
        "model request failed (timeout); retrying: attempt 2, nextRetryAt tomorrow",
        "background compaction failed; original history kept: unknown task in memory"]) {
        events.notice!(notice);
        expect(strip(historyRows(app.page!.lines, 180).join("\n"))).toContain(notice);
      }
    } finally { app.quit(); await running; }
  });

  test("status notes are one transient row above the composer: replaced by the next, cleared by the next key but not scrolling or the mouse, per page, never conversation", async () => {
    const term = fakeTerm(40);
    const orchs = fakeOrchestrators();
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000 });
    const running = app.run("notes");
    await until(() => !!app.page);
    const page = app.page!;
    const above = () => app.frame().inputArea!.lines;
    app.note("first note");
    expect(above()[0]).toBe(dim("first note"));
    expect(page.lines).toEqual([]);
    await until(() => term.screen().includes("first note"));
    app.note(`long ${"x".repeat(60)}\nsecond row`);
    expect(above().filter(row => strip(row).includes("long"))).toHaveLength(1); // one row, cut with an ellipsis
    expect(Bun.stringWidth(above()[0]!)).toBe(40);
    expect(strip(above()[0]!)).toEndWith("…");
    expect(strip(above().join("\n"))).not.toContain("first note");
    term.press({ name: "wheelup" }); term.press({ name: "pagedown" }); term.press({ name: "mousedown", x: 1, y: 1 }); term.press({ name: "mouseup", x: 1, y: 1 });
    expect(strip(above()[0]!)).toContain("long xxx");
    term.type("a");
    expect(strip(above().join("\n"))).not.toContain("long xxx");
    expect(app.input.text).toBe("a");
    await settle();
    expect(term.screen()).not.toContain("long xxx");
    expect(page.lines).toEqual([]);
    // A background page's note waits for that page, and the active page's keys leave it alone.
    term.press({ name: "n", ctrl: true });
    await until(() => app.pages.length === 2 && strip(above().join("\n")).includes("/rename <name> to rename"));
    app.note("for notes", page);
    term.type("b");
    expect(strip(above().join("\n"))).not.toContain("/rename");
    term.type("\x1a"); // Ctrl+Z back to the first page
    expect(app.page).toBe(page);
    expect(above()[0]).toBe(dim("for notes"));
    await app.commands.get("/refresh")!.run("", page); // a re-sync neither keeps nor clears a note: it is not a page notice
    expect(above()[0]).toBe(dim("for notes"));
    expect(app.pages.flatMap(p => p.lines)).toEqual([]);
    app.quit();
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
    expect(page.lines.map(raw).join("\n")).not.toContain("named → login page"); // a transient note, not conversation
    expect(page.project).toBe("named");
    expect(page.name).toBe("login page");
    expect(page.orch).toBe(orch); // not reopened
    expect(orchs.opened.map((o) => o.project)).toEqual(["named"]);
    expect(existsSync(join(home, "projects", "named", "repo"))).toBe(true);
    expect(readProjectState("named", "name")).toBe("login page");
    await until(() => term.screen().includes(">[login page]")); // the selected tab
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

  test("commands work while viewing an agent; plain text is addressed to that agent", async () => {
    const term = fakeTerm();
    const orchs = fakeOrchestrators();
    const feedback: string[] = [];
    const app = new App({ term, feedback: async (project, agent, text) => { feedback.push(`${project}/${agent}: ${text}`); return `delivered to ${agent}`; }, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000 });
    const running = app.run("viewer");
    await until(() => !!app.page);
    const page = app.page!;
    let left = 0;
    const view = { name: "worker-x", lines: [] as string[], leave: () => { left++; }, live: false, calls: new Calls() };
    page.view = view;
    term.type("/help\r");
    await until(() => !!app.frame().help);
    expect(app.frame().help!.lines.join("\n")).toContain("/back");
    expect(view.lines).toEqual([]);
    term.press({ name: "escape" });
    term.type("hello\r");
    await until(() => feedback.length === 1);
    expect(feedback).toEqual(["viewer/worker-x: hello"]);
    expect(orchs.said.viewer).toEqual([]);
    term.type("/rename viewed\r");
    await until(() => page.name === "viewed");
    term.type("/new beta\r");
    await until(() => app.page?.project === "beta");
    term.type("/help\r");
    await until(() => !!app.frame().help);
    expect(app.frame().help!.lines.join("\n")).not.toContain("/back");
    term.press({ name: "escape" });
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
    await until(() => !!app.frame().help);
    term.press({ name: "escape" });
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
    mkdirSync(paths.project("rounds"), { recursive: true }); // the setting lives in the project's directory
    const running = app.run("rounds");
    await until(() => !!app.page);
    const page = app.page!;
    const view = { name: "worker-x", lines: [] as string[], leave: () => {}, live: false, calls: new Calls() };
    page.view = view;
    const note = () => strip(app.frame().inputArea!.lines.join("\n"));
    term.type("/review-rounds 3\r");
    await until(() => note().includes("review rounds set to 3")); // a transient note (cut to the width), even in an agent view
    expect(view.lines.join("\n")).not.toContain("review rounds set to 3");
    expect((await effectiveFlow("rounds")).maxReviewRounds).toBe(3);
    expect((await loadConfig()).maxReviewRounds).toBe(1); // the project's setting, not config.toml's
    page.view = null;
    term.type("/login claude\r");
    await until(() => app.loggingIn);
    term.type("/review-rounds 0\r");
    await until(() => note().includes("review rounds set to 0"));
    expect((await effectiveFlow("rounds")).maxReviewRounds).toBe(0);
    term.type("/review-rounds\r");
    await until(() => note().includes("review rounds: 0"));
    expect(page.lines.join("\n")).not.toContain("queued");
    expect(page.lines.join("\n")).not.toContain("review rounds");
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

  test("/new and ctrl+n ids never match another project's display name", async () => {
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

  test("/keys echoes parsed keys until esc", async () => {
    const term = fakeTerm();
    const orchs = fakeOrchestrators();
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000 });
    const running = app.run("alpha");
    await until(() => !!app.page);
    term.type("/keys\r");
    await until(() => app.keyEcho && term.screen().includes("press keys; esc ends"));
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
    expect(term.screen()).not.toContain("/model");
    term.type("/help\r");
    await until(() => !!app.frame().help);
    const help = app.frame().help!.lines.join("\n");
    expect(app.page!.lines).toEqual([]);
    for (const cmd of ["/keys", "/rename <name>", "/new [name] [directory]", "/close", "/quit", "/agents", "/model [id]", "/accounts", "/login claude|codex", "/review-rounds [n]", "/dynamic-dispatch [on|off]"]) expect(help).toContain(cmd);
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

  test("startup and ctrl+n use the original directory; later startup reuses its bound project", async () => {
    const term = fakeTerm(200);
    const orchs = fakeOrchestrators();
    const repo = join(home, "original");
    await Bun.$`git init -q -b main ${repo}`.quiet();
    const source = realpathSync(repo);
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
    term.type("/new other\r"); // an explicit name still uses the launch checkout
    await until(() => app.page?.project === "other");
    expect(orchs.opened.at(-1)).toEqual({ project: "other", url: source });
    term.type("/new spaces /a/local checkout\r");
    await until(() => app.page?.project === "spaces");
    expect(orchs.opened.at(-1)).toEqual({ project: "spaces", url: "/a/local checkout" });
    app.quit();
    await running;

    // Persist the binding as the real openOrchestrator does.
    mkdirSync(paths.project("bound"), { recursive: true });
    writeProjectState("bound", "repository", { version: 1, directory: source, branch: "main", worktreeId: crypto.randomUUID() });
    const again = new App({ term: fakeTerm(), openOrchestrator: fakeOrchestrators().openOrchestrator, pollMs: 100_000, source });
    const running2 = again.run();
    await until(() => again.page?.project === "bound");
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

  test("menus move with arrows and pick with enter; esc cancels", async () => {
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

  test("a busy selected conversation animates its transient tail; finished agent views borrow no activity", async () => {
    let now = 0;
    const ticks: (() => void)[] = [];
    let started = 0, stopped = 0;
    const clock: Clock = {
      now: () => now,
      // The open /agents menu's own 1s clock is covered by the "/agents clocks" tests; this one counts the animation timer.
      every: (fn, ms) => { if (ms === AGENTS_TICK_MS) return () => {}; started++; ticks.push(fn); return () => { stopped++; ticks.splice(ticks.indexOf(fn), 1); }; },
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
    expect(term.screen()).toContain("⠋ thinking… 0s");
    expect(app.frame().status).not.toContain("thinking");
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
    await until(() => app.page!.view?.name === "worker-x" && started === 2 && term.screen().includes("working…"));
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
    await until(() => !term.screen().includes("working…") && ticks.length === 0);

    // Busy while viewing a finished agent: unrelated orchestrator activity is hidden.
    term.press({ name: "escape" }); // leave the view
    await until(() => !app.page!.view);
    term.type("again\r");
    await until(() => app.page!.busy);
    term.type("/agents\r");
    await until(() => !!app.menu);
    term.press({ name: "enter" });
    await until(() => app.page!.view?.live === false && !term.screen().includes("thinking… "));

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
    expect(writesAfterClose).toBe(1); // Final transcript is printed after restoring the primary screen.
  });

  test("multi-line input: Shift+enter, paste, rows before history, word deletion", async () => {
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

  test("ctrl+b and /projects open a list of every project: move, open, pin", async () => {
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
    await setDisplayName("sb-orch1", "Shiny app");
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

describe("sticky screen", () => {
  const count = (hay: string, needle: string) => hay.split(needle).length - 1;
  const CLEAR = "\x1b[2J\x1b[3J\x1b[H";

  test("typing and sending updates the conversation without repainting unchanged rows", async () => {
    const term = fakeTerm();
    const orchs = fakeOrchestrators();
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000 });
    term.display.write("$ orca start\r\n"); // the shell's output stays above
    const running = app.run("alpha");
    await until(() => !!app.page && term.screen().includes(">"));
    term.type("build it");
    await until(() => term.screen().includes("> build it"));
    term.type("\r");
    await until(() => term.screen().includes("worker-x done"));
    const lines = term.screen().split("\n");
    expect(lines[0]).toContain(">[alpha]");
    expect(bodyRows(term).filter(Boolean).slice(0, 3)).toEqual(["> build it", "alpha says hi", "worker-x done"]);
    expect(lines.filter((l) => l === "> build it").length).toBe(1);
    expect(term.display.clears).toBe(0);
    expect(term.raw()).not.toContain("\x1b[2J");
    expect(term.raw()).toContain("\x1b[?1049h");
    // Each finished line was written once; only the live region repaints.
    expect(count(strip(term.raw()), "alpha says hi")).toBe(1);
    expect(count(strip(term.raw()), "worker-x done")).toBe(1);
    app.quit();
    await running;
  });

  test("page switching and resize refresh the viewport without clearing shell scrollback", async () => {
    const term = fakeTerm(60);
    const orchs = fakeOrchestrators();
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000 });
    const running = app.run("alpha");
    await until(() => !!app.page);
    term.type("one\r");
    await until(() => term.screen().includes("worker-x done"));
    await app.openPage("beta");
    await until(() => !!term.display.screen()[0]?.includes("[beta]"));
    expect(term.raw()).not.toContain(CLEAR);
    await until(() => term.screen().includes(">[beta]"));
    expect(term.screen()).not.toContain("alpha says hi");
    term.type("two\r");
    await until(() => term.screen().includes("beta says hi"));

    term.type("\x1a"); // Ctrl+Z back to alpha
    await until(() => !!term.display.screen()[0]?.includes("[alpha]"));
    await until(() => term.screen().includes("> one\n\nalpha says hi\n\nworker-x done\n"));
    expect(term.screen()).not.toContain("beta says hi");
    const before = term.writes.length;
    term.resize(30, 16);
    await until(() => term.writes.length > before);
    expect(term.writes.slice(before).join("")).not.toContain(CLEAR);
    await until(() => term.screen().includes("> one\n\nalpha says hi\n"));
    term.type("/close\r");
    await until(() => term.screen().includes("> two\n\nbeta says hi"));
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
    await until(() => term.screen().includes(">[beta]"));
    orchs.writers.alpha!("background line\nhalf");
    alpha.busy = true;
    alpha.busySince = Date.now();
    app.draw();
    await until(() => term.screen().includes("[alpha] •"));
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
    await until(() => term.screen().includes("worker line one"));
    expect(term.screen()).not.toContain("viewed says hi");
    expect(term.screen()).toContain("view worker-v");
    const { appendFileSync } = await import("node:fs");
    appendFileSync(transcript, entry("worker line two"));
    await until(() => term.screen().includes("worker line one\n\nworker line two"));
    // An agent's assistant text is markdown too (as Claude Code shows subagent text); a user prompt stays plain.
    appendFileSync(transcript, entry("**bold** reply\n\n| k | v |\n|---|---|\n| a | b |"));
    appendFileSync(transcript, JSON.stringify({ type: "message", message: { role: "user", content: "**raw** prompt" } }) + "\n");
    await until(() => term.screen().includes("worker line two\n\nbold reply\n\n┌───┬───┐\n│ k │ v │"));
    await until(() => term.screen().includes("> **raw** prompt"));
    term.type("/back\r");
    await until(() => term.screen().includes("> hello\n\nviewed says hi\n\nworker-x done"));
    expect(term.screen()).not.toContain("worker line");
    app.quit();
    await running;
  });

  test("quit restores the primary screen and prints the transcript with the cursor on a fresh line", async () => {
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
    expect(term.screen()).toContain("> hi\n\nalpha says hi\n\nworker-x done\nhalf a line");
    expect(term.screen()).not.toContain("draft");
    expect(term.display.col).toBe(0);
    expect(term.raw()).toContain("\x1b[?1049l");

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
    expect(out.join("")).toContain("\x1b[?1049h");
    expect(out.join("")).toContain("\x1b[?1049l");
    expect(out.join("")).not.toContain("\x1b[2J");
  });
});

describe("frames, resizes, startup and crashes", () => {
  test("stream chunks coalesce into a few frames instead of one per chunk", async () => {
    const term = fakeTerm(80);
    const orchs = fakeOrchestrators();
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000 });
    const running = app.run("alpha");
    await until(() => term.screen().includes(">[alpha]"));
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
    await until(() => term.writes.length > before);
    const after = term.writes.slice(before).join("");
    expect(after).not.toContain("\x1b[3J");
    await until(() => term.screen().includes("  four"));
    const shown = term.display.screen();
    expect(shown.length).toBe(6);
    expect(shown).toContain("  four");
    expect(app.menu?.title).toContain("pick one"); // Too short to show the panel, but it still owns keys.
    term.press({ name: "escape" });
    expect(app.menu).toBeNull();
    expect(shown.join("\n")).toContain("agents running");
    expect(app.page!.lines.map(raw).join("\n")).toContain("alpha says hi");
    app.quit();
    await running;
  });

  test("the live region shows 'opening…' at once; lines said or logged before the pages open are kept", async () => {
    const term = fakeTerm(80);
    let gate!: () => void;
    const orchs = fakeOrchestrators();
    const openOrchestrator: typeof orchs.openOrchestrator = async (...args) => { await new Promise<void>((r) => (gate = r)); return orchs.openOrchestrator(...args); };
    const app = new App({ term, openOrchestrator, pollMs: 100_000 });
    term.display.write("$ orca start\r\n");
    const running = app.run("alpha");
    await until(() => term.screen().includes("opening…"));
    app.say("early note");
    console.warn("logged %s", "early");
    await until(() => term.screen().includes("logged early"));
    gate();
    await until(() => term.screen().includes(">[alpha]") && term.screen().includes("no remote"));
    expect(bodyRows(term).slice(0, 2)).toEqual(["early note", "logged early"]);
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
      await until(() => term.screen().includes("orca: ignoring") && term.screen().includes("a log line"));
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
    await until(() => term.screen().includes(">[alpha]"));
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
    expect(bodyRows(term).filter(Boolean).slice(0, 3)).toEqual(["tool output", "said line", "half"]);
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
      expect(t.out.at(-1)).toContain("\x1b[?1049l");
      expect(t.out.at(-1)).toContain("\x1b[?1000l");
      expect(t.out.at(-1)).toContain("\r\x1b[2A\x1b[J");
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
