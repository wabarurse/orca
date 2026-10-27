import { png } from "../test/image-fixture";
import { pendingImageInputs } from "../core/data/images/images";
import type { ImageRef } from "../protocol/images";
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Orchestrator } from "../core/agent-loop/orc/orchestrator";
import { displayName, newProjectName, setDisplayName } from "../core/data/projects/registry";
import { loadConfig, paths } from "../config/config";
import { effectiveFlow } from "../core/data/projects/flow";
import { AGENTS_TICK_MS, App, helpLines, parseCommand, type Clock, type Line, type ToolEvents } from "./app";
import { createOrchestrator } from "../core/agent-loop/orc/orchestrator";
import { drain, put } from "../core/data/inbox/inbox";
import type { Message } from "../protocol/inbox";
import { all as allQuestions, answer as answerQuestion, ask as askQuestions } from "../core/data/inbox/questions";
import { answeredNote, fileStore, queuedAnswer, type QuestionStore } from "./footer/questions";
import { MAX_RESTORED_ROWS, userLines } from "./conversation/restore";
import { historyRows, lineRows } from "./conversation/lines";
import { fakeProvider, text as said, toolUse } from "../test/fake-provider";
import { message } from "../core/tools/message";
import { registerTask } from "../core/data/tasks/tasks";
import { makeSpawn } from "../core/tools/spawn";
import { open as openTranscript } from "../core/data/transcripts/transcript";
import { ESC_DELAY_MS, parseKeys, type Key } from "./components/keys";
import { realTerminal, type Terminal } from "./components/term";
import { FakeScreen } from "./components/testing";
import { bold, dim } from "./components/text";
import { live as renderLive } from "./footer/render";
import { setUserFill } from "./components/style";
import { Calls } from "./conversation/tools";

const home = mkdtempSync(join(tmpdir(), "orca-tui-"));
process.env.ORCA_HOME = home;
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
function fakeTerm(cols = 40, rows = 24) {
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
    open() { this.opened = true; this.write("\x1b[?1049h"); },
    close() { this.write("\x1b[?1049l"); this.closed = true; },
    press: (k) => { for (const h of handlers) h(k); },
    type: (s) => { for (const k of parseKeys(s)) for (const h of handlers) h(k); },
    screen: () => display.text(),
    raw: () => writes.join(""),
  };
  return term;
}

/** The chapter's closing rule separates pinned metadata from the body. */
const bodyStart = (term: ReturnType<typeof fakeTerm>) => term.display.screen().findIndex(row => /^─+$/.test(row)) + 1;
const bodyRows = (term: ReturnType<typeof fakeTerm>) => term.display.screen().slice(bodyStart(term));

/** Click the screen row showing `text` (one press and release on the same cell). */
async function clickRow(app: App, term: ReturnType<typeof fakeTerm>, text: string): Promise<void> {
  const y = term.display.screen().findIndex(row => row.includes(text)) + 1;
  expect(y).toBeGreaterThan(0);
  await app.onKey({ name: "mousedown", x: 3, y });
  await app.onKey({ name: "mouseup", x: 3, y });
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
    const ids: (string | undefined)[] = [];
    return {
      async say(text, _submission, inputId) { said[project]!.push(text); ids.push(inputId); queued++; },
      async pending() { return queued > 0; },
      async turn() {
        queued = 0;
        onInbox?.(said[project]!.slice(consumed).map((text, i) => ({ from: "user", text, inputId: ids[consumed + i], ts: "" })));
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
    expect(await Bun.file(join(home, "projects", "named", "name")).text()).toBe("login page\n");
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
    await until(() => !!app.frame().help);
    expect(app.frame().help!.lines.join("\n")).toContain("/back");
    expect(view.lines).toEqual([]);
    term.press({ name: "escape" });
    term.type("hello\r");
    await until(() => view.lines.join("\n").includes("/back first"));
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
    await Bun.write(paths.repository("bound"), JSON.stringify({ version: 1, directory: source, branch: "main", worktreeId: crypto.randomUUID() }));
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
    expect([note(app).includes("Which db?"), app.frame().queued?.texts]).toEqual([false, ["? Which db? → sqlite"]]); // the note waits under the open panel, like the images row
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
    expect(term.screen()).not.toContain("? Port? →"); // no line, and the note waits under the open panel
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
    expect(app.page!.lines.map(raw).join(" ")).toContain("unsent answer: mine");
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
    await until(() => term.screen().split("already closed elsewhere").length === 3);
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
    expect([shown.map(raw), note(app).includes(answeredNote('Use "a": or (b)?', "sqlite"))]).toEqual([["Noted, sqlite."], true]);
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
    expect([...app.commands.keys()].sort()).toEqual(["/accounts", "/agents", "/back", "/clear", "/close", "/compact", "/dynamic-dispatch", "/effort", "/fast", "/help", "/inbox", "/keys", "/login", "/model", "/new", "/projects", "/questions", "/quit", "/refresh", "/rename", "/retry-images", "/review-rounds"]);
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
    for (const [name, c] of commands) if (c.needsPage) expect(["/agents", "/compact"]).toContain(name);
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
    term.type("/review-rounds 2\r/nope\r");
    await until(() => app.frame().inputArea!.lines[0] === dim("unknown command /nope")); term.type("hello\r"); // a note, shown over the view too
    await until(() => view.lines.join("\n").includes("/back first to talk to the orchestrator"));
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

test("saved history beyond the preview budget remains reachable before exit, including before compaction", async () => {
  const project = "full-scroll", t = openTranscript(paths.transcript(project, "orchestrator"));
  await t.append({ type: "meta", role: "orchestrator", model: "m" });
  await t.append({ type: "message", message: { role: "user", content: "ORIGINAL-BEFORE-COMPACTION" } });
  for (let i = 0; i < 140; i++) await t.append({ type: "message", message: { role: "assistant", content: `saved record ${i}: ` + "wrapping words ".repeat(6) } });
  await t.append({ type: "summary", text: "MODEL-ONLY-SUMMARY", retained: [], boundary: t.head() });
  await t.append({ type: "message", message: { role: "assistant", content: "AFTER-COMPACTION" } });
  const term = fakeTerm(100, 24), orchs = fakeOrchestrators();
  for (let i = 0; i < 40; i++) term.write(`PRELAUNCH-SHELL-${i}\r\n`);
  const app = new App({ term, pollMs: 100_000, watchdog: async () => {}, merges: async () => {},
    openOrchestrator: async (p, url, write, inbox) => ({ ...await orchs.openOrchestrator(p, url, write, inbox), entries: () => p === project ? t.history!() : [] }),
  });
  const running = app.run(project);
  try {
    await until(() => term.screen().includes("AFTER-COMPACTION"));
    const rows = historyRows(app.page!.lines, term.cols).length;
    expect(rows).toBeGreaterThan(MAX_RESTORED_ROWS * 2);
    expect(app.page!.lines.map(raw).join("\n")).not.toMatch(/MODEL-ONLY-SUMMARY|earlier messages/);
    term.type("\x1b[200~draft 界é👩‍💻\nsecond line\x1b[201~");
    await until(() => term.screen().includes("second line"));
    const draft = { ...app.input }, top = bodyStart(term);
    const header = term.display.screen().slice(0, top), footer = term.display.screen().slice(-5);
    // Injected reports exercise the application path, NOT physical Apple Terminal gestures.
    const scrollToStart = async () => {
      term.type("\x1b[<64;10;8M".repeat(Math.ceil(rows / 3) + 10));
      await until(() => term.screen().includes("ORIGINAL-BEFORE-COMPACTION"));
    };
    await scrollToStart();
    expect(term.display.screen()[top]).toBe("> ORIGINAL-BEFORE-COMPACTION");
    const body = term.display.screen().slice(top, -5);
    term.type("\x1b[<64;10;8M".repeat(20)); // clamp at the original first message
    app.say("LIVE-WHILE-READING");
    await Bun.sleep(40);
    expect(term.display.screen().slice(top, -5)).toEqual(body);
    expect(term.display.screen().slice(0, top)).toEqual(header);
    expect(term.display.screen().slice(-5)).toEqual(footer);
    expect(term.screen()).not.toContain("PRELAUNCH-SHELL");
    expect(term.display.modes.get(1049)).toBe(true);
    for (const cols of [23, 100]) {
      term.resize(cols, 24);
      await Bun.sleep(170);
      expect(bodyRows(term)[0]).toStartWith("> ORIGINAL-BEFORE");
      expect(app.input).toEqual(draft);
    }
    // Tail-following resumes at the bottom; switching projects never drops the original history.
    term.type("\x1b[<65;10;8M".repeat(rows));
    await until(() => term.screen().includes("LIVE-WHILE-READING"));
    await app.openPage("other-scroll");
    term.type("\x1a");
    await until(() => term.screen().includes("LIVE-WHILE-READING"));
    await scrollToStart();
    expect(app.input).toEqual(draft);
    expect(term.raw()).not.toContain("\x1b[?1049l");
    expect(term.raw()).not.toContain("\x1b[3J");
  } finally { app.quit(); await running; }
  const exit = term.screen();
  expect(exit).toContain("PRELAUNCH-SHELL-0");
  for (const text of ["ORIGINAL-BEFORE-COMPACTION", "AFTER-COMPACTION", "LIVE-WHILE-READING"]) expect(exit.split(text).length - 1).toBe(1);
  expect(exit.indexOf("ORIGINAL-BEFORE-COMPACTION")).toBeLessThan(exit.indexOf("saved record 0:"));
  expect(exit.indexOf("saved record 139:")).toBeLessThan(exit.indexOf("AFTER-COMPACTION"));
  expect(exit).not.toContain("MODEL-ONLY-SUMMARY");
  expect(term.display.modes.get(1049)).toBe(false);
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
  await until(() => term.screen().includes("model-b"));
  const background = app.page!;
  await app.openPage("foreground-test");
  background.busy = true;
  app.draw();
  await settle();
  expect(ticks.map((t) => t.ms)).toEqual([100]);
  const before = term.writes.length;
  const frame = app.frame();
  const shown = renderLive(frame).shown;
  const lastBytes = Buffer.byteLength(`\x1b[?2026h${renderLive(frame, shown).text}\x1b[?2026l`);
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

test("external question closure preserves both original chat and orphan answer, expanded or collapsed", async () => {
  for (const collapsed of [false, true]) {
    const project = `orphan-drafts-${collapsed}`;
    const term = fakeTerm(100, 18);
    const app = new App({ term, openOrchestrator: fakeOrchestrators().openOrchestrator, questionDelayMs: 0, pollMs: 10, watchdog: async () => {}, merges: async () => {} });
    const running = app.run(project);
    await until(() => !!app.page);
    term.type("original chat draft");
    const [first, next] = await askQuestions(project, [{ text: "First?" }, { text: "Next?" }]);
    await app.questions.command(app.page);
    term.type("orphan answer");
    expect(app.input.text).toBe("orphan answer");
    if (collapsed) term.press({ name: "q", ctrl: true });
    await answerQuestion(project, first!.id, "someone else's answer");
    await until(() => app.page!.questions.open[0]?.id === next!.id);
    expect(app.input.text).toBe("original chat draft");
    expect(app.page!.lines.map(raw).join(" ")).toContain("unsent answer: orphan answer");
    expect(app.questions.view()).toBeNull();
    await app.questions.command(app.page);
    expect(app.input.text).toBe(""); // orphan never becomes the next question's answer
    term.press({ name: "escape" });
    expect(app.input.text).toBe("original chat draft");
    app.quit(); await running;
  }
});

test("header refresh generations reject reverse completion and closed/reopened pages", async () => {
  const reads: ((model: string) => void)[] = [];
  let defer = false;
  const term = fakeTerm(80, 12);
  const app = new App({ term, pollMs: 100_000, projectModel: async () => defer ? new Promise<string>((r) => reads.push(r)) : "initial", openOrchestrator: fakeOrchestrators().openOrchestrator });
  const running = app.run("refresh-a");
  await until(() => !!app.page);
  const a = app.page!;
  defer = true;
  const first = app.refreshHeader(a), second = app.refreshHeader(a);
  reads[1]!("newest"); await second;
  reads[0]!("old"); await first;
  expect(a.model).toBe("newest");
  const offscreen = app.refreshHeader(a);
  defer = false;
  await app.openPage("refresh-b");
  reads[2]!("offscreen-a"); await offscreen;
  expect(app.page!.model).toBe("initial");
  expect(a.model).toBe("offscreen-a");
  defer = true;
  const stale = app.refreshHeader(a);
  app.closePage(app.pages.indexOf(a));
  defer = false;
  const reopened = await app.openPage("refresh-a");
  reads[3]!("stale-closed"); await stale;
  expect(reopened).not.toBe(a);
  expect(reopened.model).toBe("initial");
  expect(a.model).toBe("offscreen-a");
  app.quit(); await running;
});

test("sign-in queue attempts every owned message after failures across pages without duplicating consumed successes", async () => {
  for (const failed of ["one", "two"]) {
    const attempted: string[] = [];
    let finish!: () => void;
    const term = fakeTerm(100, 18);
    const app = new App({ term, pollMs: 100_000, login: async () => { await new Promise<void>((r) => { finish = r; }); return "signed in"; }, openOrchestrator: async (_p, _u, _w, inbox) => ({
      async say(text, _submission, inputId) { attempted.push(text); if (text === failed) throw new Error("send failed"); inbox?.([{ from: "user", text, inputId, ts: "" }]); },
      async pending() { return false; }, async turn() { return []; },
    }) });
    const running = app.run(`login-drain-${failed}`);
    await until(() => !!app.page);
    const firstPage = app.page!;
    term.type("/login claude\r");
    await until(() => !!finish);
    term.type("one\rtwo\r");
    await until(() => app.status(firstPage).includes("2 messages queued"));
    expect(app.frame().queued?.texts).toEqual(["one", "two"]);
    await app.openPage(`login-other-${failed}`);
    const secondPage = app.page!;
    term.type("three\r");
    await until(() => app.status(secondPage).includes("1 message queued"));
    expect(app.frame().queued?.texts).toEqual(["three"]);
    finish();
    await until(() => attempted.length === 3 && app.status(secondPage).includes("0 messages queued"));
    expect(attempted).toEqual(["one", "two", "three"]);
    const displayed = [...firstPage.lines, ...secondPage.lines].map(raw).map(strip);
    for (const text of ["one", "two", "three"]) expect(displayed.filter((l) => l === `> ${text}`).length).toBe(text === failed ? 0 : 1);
    expect(displayed).toContain(`not sent: ${failed}`);
    expect(firstPage.sent).toEqual([]);
    expect(secondPage.sent).toEqual([]);
    expect(app.frame().queued?.texts).toEqual([]);
    app.switchPage(-1);
    expect(app.frame().queued?.texts).toEqual([]);
    app.quit(); await running;
  }
});

describe("ctrl+c cancellation", () => {
  test("first cancels only selected page, preserves draft, expires after 2s; second exits", async () => {
    const term = fakeTerm(100, 20);
    const cancelled: string[] = [];
    const fakes = fakeOrchestrators();
    let now = 100;
    const app = new App({ term, pollMs: 100_000, clock: { now: () => now, every: () => () => {} },
      async openOrchestrator(...args) { return { ...await fakes.openOrchestrator(args[0], args[1], args[2], args[3]), cancel: () => { cancelled.push(args[0]); } }; },
    });
    const running = app.run("cancel-a");
    await until(() => !!app.page);
    term.type("/new cancel-b\r");
    await until(() => app.page?.project === "cancel-b");
    app.input = { text: "unsent draft", cursor: 12 };
    app.keyEcho = true; // diagnostic/menu layers must not swallow the interrupt
    await app.onKey({ name: "c", ctrl: true });
    expect(cancelled).toEqual(["cancel-b"]);
    expect(app.input.text).toBe("unsent draft");
    expect(term.closed).toBe(false);
    await until(() => term.screen().includes("within 2 seconds to exit"));
    now += 2001;
    await app.onKey({ name: "c", ctrl: true });
    expect(cancelled).toEqual(["cancel-b", "cancel-b"]);
    expect(term.closed).toBe(false);
    now += 1999;
    await app.onKey({ name: "c", ctrl: true });
    await running;
    expect(term.closed).toBe(true);
  });

  test("agent view cancels only selected session, leaving orchestrator and other roles alone", async () => {
    const term = fakeTerm(100, 20);
    const cancelled: string[] = [];
    const fakes = fakeOrchestrators();
    const app = new App({ term, pollMs: 100_000,
      async openOrchestrator(...args) { return { ...await fakes.openOrchestrator(args[0], args[1], args[2], args[3]), cancel: () => { cancelled.push("orchestrator"); } }; },
      async cancelAgent(project, id) { cancelled.push(`${project}/${id}`); },
    });
    const running = app.run("selected-agent");
    await until(() => !!app.page);
    app.page!.view = { name: "reviewer-x", lines: [], live: true, calls: new Calls(), leave() {} };
    await app.onKey({ name: "c", ctrl: true });
    expect(cancelled).toEqual(["selected-agent/reviewer-x"]);
    expect(app.page!.view!.name).toBe("reviewer-x");
    expect(term.closed).toBe(false);
    await until(() => term.screen().includes("stopping selected agent"));
    app.quit();
    await running;
  });
});

test("real App login-held pre-cancel input stays paused, retains FIFO, and does not block other pages", async () => {
  const term = fakeTerm(90, 20);
  const providers = new Map<string, ReturnType<typeof fakeProvider>>();
  let finish!: () => void;
  const app = new App({ term, pollMs: 100_000,
    login: async () => { await new Promise<void>(resolve => { finish = resolve; }); return "signed in"; },
    openOrchestrator: async (project, _url, write, onInbox, events) => {
      const provider = fakeProvider([[said("received")]]);
      providers.set(project, provider);
      return createOrchestrator({ project, provider, tools: {}, write, onInbox, ...events });
    },
  });
  const running = app.run("login-cancel-real");
  try {
    await until(() => !!app.page);
    const cancelled = app.page!;
    term.type("/login claude\r");
    await until(() => app.loggingIn);
    term.type("held one\rheld two\r");
    await until(() => cancelled.lines.filter(l => raw(l).includes("queued; runs after sign-in")).length === 2);
    term.type("\x03");
    await until(() => strip(app.frame().inputArea!.lines[0]!).startsWith("turn cancelled.") && !cancelled.lines.some(l => raw(l).includes("turn cancelled"))); // a note, not a line
    await app.openPage("login-cancel-other");
    term.type("unrelated input\r");
    await until(() => app.page!.lines.some(l => raw(l).includes("queued; runs after sign-in")));
    finish();
    await until(() => providers.get("login-cancel-other")!.calls.length === 1);
    expect(providers.get("login-cancel-real")!.calls).toHaveLength(0);
    expect(await cancelled.orch.pending()).toBe(false);
    term.type("\x1a"); // selected cancelled page
    expect(app.page).toBe(cancelled);
    term.type("continue now\r");
    await until(() => providers.get("login-cancel-real")!.calls.length === 1);
    const messages = providers.get("login-cancel-real")!.calls[0]!.messages;
    expect(messages.at(-1)?.content).toBe("[user] held one\n\n[user] held two\n\n[user] continue now");
  } finally { app.quit(); await running; }
});

test("current-view resize anchoring ignores unrelated sessions, and tail activity never enters restored or exit history", async () => {
  const term = fakeTerm(80, 24);
  const orchs = fakeOrchestrators();
  const clock: Clock = { now: () => 5000, every: () => () => {} };
  const app = new App({ term, openOrchestrator: orchs.openOrchestrator, clock, pollMs: 100_000 });
  const running = app.run("anchored-e");
  try {
    await until(() => !!app.page);
    const page = app.page!;
    await app.openPage("unrelated-e");
    app.page!.busy = true;
    app.switchPage(-1);
    const records: Line[] = Array.from({ length: 50 }, (_, i) => {
      const text = `record ${i}: ` + "words ".repeat(25);
      return i % 2 ? userLines(text)[0]! : { md: text };
    });
    page.lines.push(...records);
    expect(historyRows(page.lines, 80).length).toBeGreaterThan(records.length);
    expect(historyRows(page.lines, 23).length).toBeGreaterThan(historyRows(page.lines, 80).length);
    app.reprint();
    term.type("reading draft");
    page.busy = true;
    page.busySince = 0;
    app.draw();
    await until(() => term.screen().includes("thinking… 5s"));
    for (let i = 0; i < 30; i++) term.press({ name: "pageup" });
    await until(() => bodyRows(term)[0]!.startsWith("record 0:"));
    const top = historyRows(records, 80).findIndex(row => Bun.stripANSI(row).startsWith("> record 21:"));
    expect(top % 3).toBe(0);
    for (let i = 0; i < top / 3; i++) term.press({ name: "wheeldown" });
    await until(() => bodyRows(term)[0]!.startsWith("> record 21:"));
    const reading = "> record 21:";
    const visible = bodyRows(term);
    orchs.writers[page.project]!("appended structured paragraph " + "new words ".repeat(30) + "\n");
    orchs.writers["unrelated-e"]!("background owner paragraph " + "elsewhere ".repeat(20) + "\n");
    await Bun.sleep(30);
    expect(bodyRows(term)).toEqual(visible);
    expect(app.input.text).toBe("reading draft");
    const durable = JSON.stringify(page.lines);
    for (const cols of [23, 80, 10, 53, 23, 80]) {
      term.resize(cols, 24);
      await Bun.sleep(170);
      expect(bodyRows(term)[0]).toBe(Bun.stripANSI(lineRows(records[21]!, cols)[0]!).trimEnd());
      expect(term.screen()).not.toContain("thinking…");
      expect(app.input.text).toBe("reading draft");
      expect(term.display.col).toBe(app.frame().inputArea!.col);
      expect(JSON.stringify(page.lines)).toBe(durable);
    }
    app.switchPage(1);
    await until(() => term.screen().includes("working…"));
    expect(term.screen()).not.toContain("record ");
    app.switchPage(-1);
    await until(() => term.screen().includes("working… 5s"));
    // A different conversation owns a different viewport: switching back follows its tail.
    expect(term.screen()).not.toContain(reading);
    page.busy = false;
    app.draw();
    await until(() => !term.screen().includes("working…"));
    expect(app.frame().activity).toBeUndefined(); // background session remains busy
    expect(JSON.stringify(page.lines)).toBe(durable);
  } finally { app.quit(); await running; }
  expect(term.screen()).not.toMatch(/thinking|working|opening|agents running|messages queued/);
});

test("boxed input and question vertical editing share rendered geometry across resize, retaining the chat draft", async () => {
  const { inputGeometry } = await import("./footer/render");
  const { vertical } = await import("./footer/editor");
  const term = fakeTerm(40, 24);
  const orchs = fakeOrchestrators();
  const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 20, questionDelayMs: 0, watchdog: async () => {}, merges: async () => {} });
  const running = app.run("boxed-question-e");
  const width = () => inputGeometry(app.frame().input.prompt, term.cols, Math.max(1, term.rows - bodyStart(term) - 1)).width;
  try {
    await until(() => term.screen().includes(">[boxed-question-e]"));
    term.type("界".repeat(40) + "é👩‍💻");
    const draft = app.input.text;
    const expected = vertical(app.input, width(), -1)!;
    term.press({ name: "up" });
    expect(app.input).toEqual(expected);
    await askQuestions("boxed-question-e", [{ text: "Destination?" }]);
    await until(() => app.page!.questions.open.length === 1);
    expect(app.input.text).toBe(draft);
    term.press({ name: "q", ctrl: true });
    await until(() => app.questions.answering());
    term.type("界".repeat(40) + " answer");
    const answer = app.input.text;
    const before = vertical(app.input, width(), -1)!;
    term.press({ name: "up" });
    expect(app.input).toEqual(before);
    term.resize(17, 18);
    await Bun.sleep(160);
    const after = vertical(app.input, width(), -1)!;
    term.press({ name: "up" });
    expect(app.input).toEqual(after);
    expect(term.display.col).toBeLessThan(term.cols);
    term.press({ name: "escape" });
    expect(app.input.text).toBe(draft);
    term.press({ name: "q", ctrl: true });
    await until(() => app.questions.answering());
    expect(app.input.text).toBe(answer);
    expect(app.page!.sent).toEqual([]);
  } finally { app.quit(); await running; }
});

test("App retains an interior source offset across widening/narrowing and resets it on new wheel intent", async () => {
  const term = fakeTerm(23, 24);
  const orchs = fakeOrchestrators();
  const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000 });
  const running = app.run("source-anchor-e");
  try {
    await until(() => !!app.page);
    const code = "code-" + "0123456789".repeat(40);
    const lines: Line[] = [
      { md: ["long first line ".repeat(30), "short", "```ts", "tiny", code, "last", "```"].join("\n") },
      ...Array.from({ length: 30 }, (_, i) => ({ md: `later ${i} ` + "wrapped content ".repeat(20) })),
    ];
    const codeStart = () => historyRows(lines, 23).findIndex(row => Bun.stripANSI(row).startsWith("│ code-"));
    while ((codeStart() + 3) % 3) lines.unshift("fixed preface");
    const top = codeStart() + 3; // offset 63 within this source line
    const reading = "│ " + code.slice(63, 84);
    expect(Bun.stripANSI(historyRows(lines, 23)[top]!)).toBe(reading);
    app.page!.lines.push(...lines);
    app.reprint();
    await until(() => term.screen().includes("wrapped content"));
    for (let i = 0; i < 300; i++) term.press({ name: "pageup" });
    await until(() => bodyRows(term)[0] === Bun.stripANSI(historyRows(lines, 23)[0]!));
    for (let i = 0; i < top / 3; i++) term.press({ name: "wheeldown" });
    await until(() => bodyRows(term)[0] === reading);
    for (const cols of [80, 40, 23, 10, 80, 23]) {
      term.resize(cols, 24);
      await Bun.sleep(170);
      const offset = Math.floor(63 / (cols - 2)) * (cols - 2);
      expect(bodyRows(term)[0]).toBe("│ " + code.slice(offset, offset + cols - 2));
      const visible = bodyRows(term);
      orchs.writers[app.page!.project]!("new structured background output " + "words ".repeat(20) + "\n");
      await Bun.sleep(25);
      expect(bodyRows(term)).toEqual(visible);
    }
    term.press({ name: "wheeldown" }); // a new reading intent: offset 126, not 63
    await until(() => bodyRows(term)[0] === "│ " + code.slice(126, 147));
    for (const cols of [80, 23]) {
      term.resize(cols, 24);
      await Bun.sleep(170);
      const offset = Math.floor(126 / (cols - 2)) * (cols - 2);
      expect(bodyRows(term)[0]).toBe("│ " + code.slice(offset, offset + cols - 2));
    }
  } finally { app.quit(); await running; }
});

test("combined E viewport cancels actual tools, keeps full pre-checkpoint live/exit history and no revived activity", async () => {
  const project = "combined-cancel-e", path = paths.transcript(project, "orchestrator");
  mkdirSync(paths.repo(project), { recursive: true });
  const t = openTranscript(path);
  await t.append({ type: "meta", role: "orchestrator", model: "m" });
  await t.append({ type: "message", message: { role: "user", content: "FULL-HISTORY-SENTINEL" } });
  for (let i = 0; i < 105; i++) await t.append({ type: "message", message: { role: "assistant", content: `durable record ${i}: ` + "wrapping words ".repeat(5) } });
  await t.append({ type: "summary", text: "compressed model-only summary", retained: [], boundary: t.head() });
  const marker = join(home, "combined-bash-ready");
  const provider = fakeProvider([
    [toolUse("cancel-real", "bash", { command: `echo started > '${marker}'; sleep 60` }), toolUse("never", "bash", { command: "echo NEVER-EXECUTED" })],
    [said("authorized continuation")],
  ]);
  const { bash } = await import("../core/tools/bash/bash");
  const { paired } = await import("../core/data/memory/tool-pairs");
  const term = fakeTerm(100, 24);
  // The header's fin cruises on App's clock while the page is busy and parks (tick 0) once idle; the header rows compared
  // below span its body, so freeze the clock at 0 to put the cruising fin where the parked one sits. Timers stay real.
  const clock: Clock = { now: () => 0, every: (fn, ms) => { const t = setInterval(fn, ms); return () => clearInterval(t); } };
  const app = new App({ term, clock, pollMs: 100_000, watchdog: async () => {}, merges: async () => {},
    openOrchestrator: async (project, _url, write, onInbox, events) => createOrchestrator({ project, transcript: t, provider, tools: { bash }, write, onInbox, ...events }),
  });
  const running = app.run(project);
  try {
    await until(() => !!app.page);
    expect(app.page!.lines.map(raw).join("\n")).toContain("FULL-HISTORY-SENTINEL"); // live history is complete, not just exit output
    // Page data can precede the throttled first frame; never capture "opening…" as the header.
    await until(() => term.display.screen()[0]!.includes(">[combined-cancel-e]"));
    term.type("start cancellable tool\r");
    await until(() => existsSync(marker));
    expect(app.page!.calls.size).toBe(1);
    term.type("draft 界é👩‍💻");
    const draft = { ...app.input };
    const header = term.display.buf.slice(term.display.top, term.display.top + 4).map(row => row.join(""));
    term.press({ name: "pageup" });
    term.resize(23, 24);
    await Bun.sleep(160);
    term.resize(100, 24);
    await Bun.sleep(160);
    expect(app.input).toEqual(draft);
    term.type("\x03");
    await until(() => !app.page!.busy);
    expect(app.page!.calls.size).toBe(0);
    expect(app.frame().activity).toBeUndefined();
    expect(app.frame().running).toEqual([]);
    expect(app.input).toEqual(draft);
    expect(paired(await t.chain())).toBe(true);
    expect(provider.calls).toHaveLength(1);
    expect(await app.page!.orch.pending()).toBe(false);
    // Context/review telemetry can change during the cancelled turn; identity stays pinned.
    expect(term.display.buf.slice(term.display.top, term.display.top + 4).map(row => row.join("")).filter((_, i) => i !== 1)).toEqual(header.filter((_, i) => i !== 1));
    term.press({ name: "escape" }); // only intentional draft clearing for this continuation
    term.type("resume saved turn\r");
    await until(() => provider.calls.length === 2 && !app.page!.busy);
    expect(JSON.stringify(provider.calls[1]!.messages)).toContain("cancelled by user");
    expect(JSON.stringify(provider.calls[1]!.messages)).toContain("resume saved turn");
    expect(app.page!.calls.size).toBe(0);
  } finally { app.quit(); await running; }
  const exit = term.screen();
  expect(exit).toContain("FULL-HISTORY-SENTINEL");
  expect(exit).toContain("durable record 104");
  expect(exit).toContain("authorized continuation");
  expect(exit).not.toContain("compressed model-only summary");
  expect(exit).not.toMatch(/thinking…|working…|messages queued|agents running/);
  expect(term.display.modes.get(1049)).toBe(false);
});

test("ctrl+c through pinned question/modal layers preserves owners and drafts without resuming the cancelled request", async () => {
  const project = "cancel-question-e";
  let requested = false, aborted = false;
  const provider: import("../providers").Provider = { name: "anthropic", async models() { return []; }, async complete(req) {
    requested = true;
    return new Promise((_resolve, reject) => req.signal!.addEventListener("abort", () => { aborted = true; reject(req.signal!.reason); }, { once: true }));
  } };
  const term = fakeTerm(80, 24);
  const app = new App({ term, pollMs: 20, questionDelayMs: 0, watchdog: async () => {}, merges: async () => {},
    openOrchestrator: async (project, _url, write, onInbox, events) => createOrchestrator({ project, provider, tools: {}, write, onInbox, ...events }),
  });
  const running = app.run(project);
  try {
    await until(() => !!app.page);
    const owner = app.page!;
    term.type("start request\r");
    await until(() => requested);
    term.type("chat draft 界");
    const chat = { ...app.input };
    await askQuestions(project, [{ text: "Keep this question?" }]);
    await until(() => owner.questions.open.length === 1);
    term.press({ name: "q", ctrl: true });
    await until(() => app.questions.answering());
    term.type("answer draft 👩‍💻");
    const answer = { ...app.input };
    term.press({ name: "c", ctrl: true });
    await until(() => aborted && !owner.busy);
    expect(app.page).toBe(owner);
    expect(app.questions.answering()).toBe(true);
    expect(app.input).toEqual(answer);
    expect(owner.questions.open).toHaveLength(1);
    expect(await owner.orch.pending()).toBe(false);
    term.press({ name: "escape" });
    expect(app.input).toEqual(chat);
    term.press({ name: "q", ctrl: true });
    await until(() => app.questions.answering());
    expect(app.input).toEqual(answer);
    // A project modal hides, but must not steal, the question's answer buffer.
    term.press({ name: "b", ctrl: true });
    await until(() => !!app.projectList);
    expect(app.input).toEqual(answer);
    term.press({ name: "escape" });
    expect(app.input).toEqual(answer);
    expect(app.questions.answering()).toBe(true);
    expect(app.frame().activity).toBeUndefined();
  } finally { app.quit(); await running; }
});

describe("explicit footer help", () => {
  test("modal keys preserve draft/cursor/history, navigation reaches diagnostics, and esc never leaves an agent view", async () => {
    const term = fakeTerm(80, 24);
    const orchs = fakeOrchestrators();
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000 });
    const running = app.run("help-draft");
    try {
      await until(() => !!app.page);
      const page = app.page!;
      const draft = { text: "kept\nchat 界 draft", cursor: 6 };
      app.input = { ...draft };
      const history = [...page.inputHistory];
      let left = 0;
      page.view = { name: "worker-help", lines: [], leave: () => { left++; }, live: true, calls: new Calls() };
      await app.commands.get("/help")!.run("", page);
      await until(() => term.screen().includes("help"));
      expect(app.frame().help!.lines.join("\n")).toContain("/back");
      for (const key of [{ name: "enter" }, { name: "char", text: "1" }, { name: "paste", text: "not inserted" }, { name: "backspace" }, { name: "tab" }]) await app.onKey(key);
      expect(app.input).toEqual(draft);
      expect(page.inputHistory).toEqual(history);
      expect(orchs.said[page.project]).toEqual([]);
      await app.onKey({ name: "pagedown" });
      expect(app.frame().help!.top).toBeGreaterThan(0);
      await app.onKey({ name: "end" });
      await until(() => term.screen().includes("/review-rounds"));
      await app.onKey({ name: "home" });
      expect(app.frame().help!.top).toBe(0);
      await app.onKey({ name: "wheeldown" });
      expect(app.frame().help!.top).toBe(3);
      await app.onKey({ name: "wheelup" });
      expect(app.frame().help!.top).toBe(0);
      await app.onKey({ name: "escape" });
      expect(app.frame().help).toBeNull();
      expect(left).toBe(0);
      expect(app.input).toEqual(draft);
      expect(page.view.lines).toEqual([]);
      await app.commands.get("/help")!.run("", page);
      await app.commands.get("/help")!.run("", page);
      expect(app.frame().help).toBeNull();
      expect(app.input).toEqual(draft);
      await app.onKey({ name: "escape" });
      expect(left).toBe(1);
    } finally { app.quit(); await running; }
  });

  test("/help submission, help scrolling and resize retain the conversation's interior source anchor amid live output", async () => {
    const term = fakeTerm(23, 24);
    const orchs = fakeOrchestrators();
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000 });
    const running = app.run("help-anchor");
    try {
      await until(() => !!app.page);
      const code = "code-" + "0123456789".repeat(40);
      const lines: Line[] = [{ md: "```ts\n" + code + "\n```" }, ...Array.from({ length: 100 }, (_, i) => `later ${i}`)];
      const codeStart = () => historyRows(lines, 23).findIndex(row => Bun.stripANSI(row).startsWith("│ code-"));
      while ((codeStart() + 3) % 3) lines.unshift("preface");
      app.page!.lines.push(...lines);
      app.reprint();
      await until(() => term.screen().includes("later 99"));
      for (let i = 0; i < 100; i++) term.press({ name: "pageup" });
      for (let i = 0; i < (codeStart() + 3) / 3; i++) term.press({ name: "wheeldown" });
      const reading = "│ " + code.slice(63, 84);
      await until(() => bodyRows(term)[0] === reading);
      term.type("/help\r"); // Must not use Enter's normal jump-to-tail path.
      await until(() => term.screen().includes("help"));
      expect(bodyRows(term)[0]).toBe(reading);
      term.press({ name: "wheeldown" });
      term.press({ name: "pagedown" });
      for (const cols of [80, 40, 23, 10, 80, 23]) {
        term.resize(cols, 24);
        await Bun.sleep(170);
        const offset = Math.floor(63 / (cols - 2)) * (cols - 2);
        expect(bodyRows(term)[0]).toBe("│ " + code.slice(offset, offset + cols - 2));
        orchs.writers[app.page!.project]!("live output while reading help\n");
        await Bun.sleep(25);
        expect(bodyRows(term)[0]).toBe("│ " + code.slice(offset, offset + cols - 2));
        expect(app.frame().help).not.toBeNull();
      }
      term.press({ name: "escape" });
      await until(() => !app.frame().help);
      expect(bodyRows(term)[0]).toBe(reading);
      expect(app.page!.lines.map(raw).join("\n")).not.toContain("/help");
    } finally { app.quit(); await running; }
  });

  test("page/menu/project transitions close help, and a hidden tiny-terminal panel still owns keys", async () => {
    const term = fakeTerm(80, 24);
    const app = new App({ term, openOrchestrator: fakeOrchestrators().openOrchestrator, pollMs: 100_000 });
    const running = app.run("help-transition-a");
    const help = () => app.commands.get("/help")!.run("", app.page);
    try {
      await until(() => !!app.page);
      await app.openPage("help-transition-b");
      const draft = { text: "draft unchanged", cursor: 3 };
      app.input = { ...draft };
      await help();
      await app.onKey({ name: "z", ctrl: true });
      expect(app.frame().help).toBeNull();
      expect(app.input).toEqual({ text: "", cursor: 0 }); // the other project's own draft
      await app.onKey({ name: "x", ctrl: true });
      expect(app.input).toEqual(draft);
      await help();
      app.openMenu("example menu", [{ value: "one", label: "one" }], () => {});
      expect(app.frame().help).toBeNull();
      await app.onKey({ name: "escape" });
      await help();
      await app.onKey({ name: "b", ctrl: true });
      expect(app.projectList).not.toBeNull();
      expect(app.frame().help).toBeNull();
      await app.onKey({ name: "escape" });
      await help();
      term.resize(1, 1);
      await Bun.sleep(170);
      expect(app.frame().help).not.toBeNull();
      await app.onKey({ name: "enter" });
      await app.onKey({ name: "char", text: "x" });
      await app.onKey({ name: "pagedown" });
      expect(app.input).toEqual(draft);
      await app.onKey({ name: "escape" });
      expect(app.frame().help).toBeNull();
      expect(app.input).toEqual(draft);
      term.resize(80, 24);
      await Bun.sleep(170);
      expect(app.frame().help).toBeNull();
      await help();
      app.closePage();
      expect(app.frame().help).toBeNull();
    } finally { app.quit(); await running; }
  });

  test("question arrivals stay opt-in; help never answers/skips and preserves original chat and answer through external close", async () => {
    const project = "help-questions";
    const term = fakeTerm(80, 24);
    let cancelled = 0;
    const orchs = fakeOrchestrators();
    const app = new App({ term, pollMs: 20, watchdog: async () => {}, merges: async () => {}, questionDelayMs: 0,
      openOrchestrator: async (p, url, write, inbox) => ({ ...await orchs.openOrchestrator(p, url, write, inbox), cancel: () => { cancelled++; } }),
    });
    const running = app.run(project);
    const help = () => app.commands.get("/help")!.run("", app.page);
    try {
      await until(() => !!app.page);
      const chat = { text: "original chat", cursor: 4 };
      app.input = { ...chat };
      await help();
      const [q] = await askQuestions(project, [{ text: "Question one?" }]);
      await until(() => app.page!.questions.open.length === 1);
      expect(app.frame().question).toBeNull();
      expect(app.input).toEqual(chat);
      expect(app.frame().help).not.toBeNull();
      await app.onKey({ name: "enter" });
      await app.onKey({ name: "escape" });
      expect(app.frame().question).toBeNull();
      expect(app.input).toEqual(chat);
      await help();
      await app.onKey({ name: "q", ctrl: true }); // Explicit opening replaces help.
      expect(app.frame().help).toBeNull();
      expect(app.questions.answering()).toBe(true);
      const answer = { text: "answer draft", cursor: 5 };
      app.input = { ...answer };
      await help();
      await app.onKey({ name: "enter" });
      await app.onKey({ name: "char", text: "1" });
      await app.onKey({ name: "c", ctrl: true }); // Cancellation still goes to the owner, not help.
      expect(cancelled).toBe(1);
      expect(app.frame().help).not.toBeNull();
      expect(app.input).toEqual(answer);
      expect((await allQuestions(project))[0]!.status).toBe("open");
      await app.onKey({ name: "escape" }); // Only help closes; answer is untouched.
      expect(app.questions.answering()).toBe(true);
      expect(app.input).toEqual(answer);
      await help();
      await askQuestions(project, [{ text: "Question two?" }]);
      await answerQuestion(project, q!.id, "answered elsewhere");
      await until(() => app.page!.questions.open.length === 1 && app.page!.questions.open[0]!.text === "Question two?");
      expect(app.input).toEqual(chat);
      expect(app.frame().help).not.toBeNull();
      expect(app.frame().question).toBeNull();
      expect(app.page!.lines.map(raw).join("\n")).toContain("answer draft");
      await app.onKey({ name: "escape" });
      await app.onKey({ name: "q", ctrl: true });
      expect(app.input.text).toBe(""); // Orphan answer never attaches to the next question.
      await app.onKey({ name: "escape" });
      expect(app.input).toEqual(chat);
    } finally { app.quit(); await running; }
  });

  test("help works before a page exists, never enters durable/exit history, and does not reopen after restart", async () => {
    const project = "help-durable";
    const path = paths.transcript(project, "orchestrator");
    mkdirSync(paths.repo(project), { recursive: true });
    const transcript = openTranscript(path);
    await transcript.append({ type: "meta", role: "orchestrator", model: "m" });
    await transcript.append({ type: "message", message: { role: "user", content: "DURABLE-HELP-SENTINEL" } });
    for (let i = 0; i < 80; i++) await transcript.append({ type: "message", message: { role: "assistant", content: `record ${i} ` + "old history ".repeat(10) } });
    await transcript.append({ type: "summary", text: "model-only summary", retained: [], boundary: transcript.head() });
    const saved = await Bun.file(path).text();
    let ready!: () => void;
    const waiting = new Promise<void>(resolve => { ready = resolve; });
    const orchs = fakeOrchestrators();
    const open: ConstructorParameters<typeof App>[0]["openOrchestrator"] = async (p, url, write, inbox) => { await waiting; return { ...await orchs.openOrchestrator(p, url, write, inbox), entries: () => transcript.history!() }; };
    const term = fakeTerm(80, 24);
    const app = new App({ term, openOrchestrator: open, pollMs: 100_000 });
    const running = app.run(project);
    try {
      term.type("/help\r");
      await until(() => term.screen().includes("help"));
      expect(app.pages).toHaveLength(0);
      expect(app.frame().help).not.toBeNull();
      term.press({ name: "escape" });
      ready();
      await until(() => !!app.page);
      expect(app.frame().help).toBeNull();
      const before = [...app.page!.lines];
      term.type("/help\r");
      await until(() => term.screen().includes("help"));
      expect(app.page!.lines).toEqual(before);
      expect(app.page!.inputHistory).toEqual(["/help"]);
      await app.page!.savingHistory;
    } finally { ready(); app.quit(); await running; }
    expect(term.screen()).toContain("DURABLE-HELP-SENTINEL");
    expect(term.screen()).not.toContain("advanced & diagnostics");
    // A visible repository path may contain /help-durable; the command itself
    // must never be printed as a conversation entry.
    expect(term.screen()).not.toMatch(/^\s*>?\s*\/help\s*$/m);
    expect(await Bun.file(path).text()).toBe(saved);
    const again = new App({ term: fakeTerm(80, 24), openOrchestrator: open, pollMs: 100_000 });
    const restarted = again.run(project);
    try {
      await until(() => !!again.page);
      expect(again.frame().help).toBeNull();
      expect(again.page!.lines.map(raw).join("\n")).not.toContain("/help");
      await again.onKey({ name: "up" });
      expect(again.input.text).toBe("/help");
    } finally { again.quit(); await restarted; }
  });
});

describe("queued input footer", () => {
  test("several submissions stay above input until each consumption, never inserting drafts or double-echoing identical prompts", async () => {
    const term = fakeTerm(100, 24);
    let inbox!: (msgs: Message[]) => void, finish!: () => void;
    const app = new App({ term, pollMs: 100_000, openOrchestrator: async (_p, _u, _w, read) => {
      inbox = read!;
      return { async say() {}, async pending() { return false; }, turn: () => new Promise(resolve => { finish = () => resolve([]); }) };
    } });
    const running = app.run("queued-order");
    try {
      await until(() => !!app.page);
      term.type("first\r");
      await until(() => !!finish);
      term.type("\x1b[200~second\nline 界é👩‍💻\x1b[201~\rfirst\r");
      const texts = ["first", "second\nline 界é👩‍💻", "first"];
      await until(() => app.frame().queued?.texts.length === 3);
      term.type("\x1b[200~unsent\ndraft\x1b[201~");
      term.press({ name: "left" });
      const draft = { ...app.input };
      await until(() => term.screen().includes("queued 3/3"));
      const rows = term.display.screen();
      const heading = rows.findIndex(row => row.startsWith("queued"));
      expect(rows[heading - 1]).toBe("");
      expect(term.display.backgrounds()[heading - 1]!.some(Boolean)).toBe(false);
      expect(rows.slice(heading, heading + 5)).toEqual([
        "queued 3/3 · orchestrator · queued-order", "  1. first", "  2. second ↵ line 界é👩‍💻", "  3. first", "┌" + "─".repeat(98) + "┐",
      ]);
      expect(app.page!.lines).toEqual([]);
      expect(app.frame().queued?.texts).toEqual(texts);
      for (let i = 0; i < texts.length; i++) {
        inbox([{ from: "user", ...app.page!.sent[0]!, ts: "synthetic" }]);
        expect(app.page!.busy).toBe(true); // not turn completion, a real consumption boundary
        expect(app.frame().queued?.texts).toEqual(texts.slice(i + 1));
        expect(app.page!.lines).toEqual(texts.slice(0, i + 1).flatMap(userLines));
        expect(app.input).toEqual(draft);
      }
      inbox([{ from: "user", text: "external user", ts: "synthetic" }]);
      expect(app.page!.lines).toEqual([...texts, "external user"].flatMap(userLines));
      finish();
      await until(() => !/queued \d+\/\d+/.test(term.screen()));
      expect(app.input).toEqual(draft);
    } finally { finish?.(); app.quit(); await running; }
    expect(term.screen()).not.toMatch(/queued \d+\/\d+/); // no footer previews in exit transcript
    expect(term.screen().split("> first")).toHaveLength(3);
  });

  test("project, answer and agent-view drafts stay independent from pending orchestrator previews through switches and resizes", async () => {
    const term = fakeTerm(90, 24), reads = new Map<string, (msgs: Message[]) => void>();
    const app = new App({ term, pollMs: 100_000, questionDelayMs: 0, openOrchestrator: async (project, _u, _w, inbox) => {
      reads.set(project, inbox!);
      return { async say() {}, async pending() { return false; }, async turn() { return []; } };
    } });
    const running = app.run("queued-project-a");
    try {
      await until(() => !!app.page);
      term.type("pending A\r");
      await until(() => app.frame().queued?.texts.length === 1);
      const a = app.page!, chat = { text: "chat A\n界 draft", cursor: 8 };
      app.input = { ...chat }; app.draw();
      await askQuestions(a.project, [{ text: "Synthetic question?" }]);
      await app.onKey({ name: "q", ctrl: true });
      app.input = { text: "answer draft 👩‍💻", cursor: 7 }; app.draw();
      const answer = { ...app.input };
      expect(app.questions.answering()).toBe(true);
      expect(app.frame().queued?.texts).toEqual(["pending A"]);
      await app.onKey({ name: "b", ctrl: true });
      expect(app.projectList).not.toBeNull();
      await app.onKey({ name: "escape" });
      expect(app.input).toEqual(answer);
      await app.openPage("queued-project-b");
      term.type("pending B\r");
      await until(() => app.frame().queued?.texts.length === 1);
      const b = app.page!, chatB = { text: "draft B", cursor: 3 };
      app.input = { ...chatB }; app.draw();
      expect(app.frame().queued?.texts).toEqual(["pending B"]);
      app.switchPage(-1);
      expect(app.page).toBe(a);
      expect(app.input).toEqual(chat); // project switches close Inbox, not its drafts
      await app.onKey({ name: "q", ctrl: true });
      expect(app.input).toEqual(answer);
      for (const [cols, rows] of [[12, 8], [23, 16], [90, 24]]) {
        term.resize(cols!, rows!);
        await Bun.sleep(160);
        expect(app.input).toEqual(answer);
        expect(app.frame().queued?.texts).toEqual(["pending A"]);
      }
      await app.onKey({ name: "q", ctrl: true });
      expect(app.input).toEqual(chat);
      a.view = { name: "worker-synthetic", lines: [], live: true, calls: new Calls(), leave() {} };
      a.name = "Renamed display"; // identity remains the original project id
      app.draw();
      await until(() => term.screen().includes("queued 1/1 · orchestrator · Renamed display"));
      expect(app.frame().queued?.texts).toEqual(["pending A"]);
      reads.get(a.project)!([{ from: "user", ...a.sent[0]!, ts: "synthetic" }]);
      expect(a.view.lines).toEqual([]);
      expect(a.lines).toEqual(userLines("pending A"));
      expect(app.input).toEqual(chat);
      expect(a.project).toBe("queued-project-a");
      app.switchPage(1);
      expect(app.page).toBe(b);
      expect(app.input).toEqual(chatB);
      expect(app.frame().queued?.texts).toEqual(["pending B"]);
    } finally { app.quit(); await running; }
  });

  test("real inbox consumption during a tool turn removes only consumed previews and inserts each user exactly once", async () => {
    const term = fakeTerm(90, 24), project = "queued-real-turn";
    let release!: () => void, started = false, response!: () => void;
    let afterExternal: readonly string[] | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const responseGate = new Promise<void>(resolve => { response = resolve; });
    const scripted = fakeProvider([[toolUse("wait-1", "wait", {})], [said("finished")]]);
    let requests = 0;
    const provider = { ...scripted, async complete(req: Parameters<typeof scripted.complete>[0]) {
      if (++requests === 2) await responseGate;
      return scripted.complete(req);
    } };
    const app = new App({ term, pollMs: 100_000, openOrchestrator: async (project, _url, write, onInbox, events) => createOrchestrator({ project, provider, write, ...events,
      onInbox: messages => {
        for (const msg of messages) {
          onInbox?.([msg]);
          if (msg.text === "next one" && !msg.inputId) afterExternal = app.frame().queued?.texts;
        }
      },
      tools: { wait: { spec: { name: "wait", description: "Synthetic gate", input_schema: { type: "object" } }, async run() { started = true; await gate; return "ok"; } } },
    }) });
    const running = app.run(project);
    try {
      await until(() => !!app.page);
      term.type("start\r");
      await until(() => started);
      await put(project, "orchestrator", { from: "user", text: "next one" }); // external, identical to a local prompt
      // Preview visibility means submitted, not persisted. Await both sends before
      // releasing the tool so this boundary is guaranteed to consume both inputs.
      for (const key of parseKeys("next one\rnext two\r")) await app.onKey(key);
      await until(() => app.frame().queued?.texts.length === 2);
      await until(() => term.screen().includes("  2. next two"));
      expect(app.page!.lines.filter((line): boolean => typeof line === "object" && "user" in line)).toEqual(userLines("start"));
      release();
      await until(() => requests === 2);
      expect(app.page!.busy).toBe(true);
      expect(app.frame().queued?.texts).toEqual([]);
      expect(afterExternal).toEqual(["next one", "next two"]); // external consumption must not acknowledge identical local text
      expect(app.page!.lines.filter((line): boolean => typeof line === "object" && "user" in line)).toEqual(["start", "next one", "next one", "next two"].flatMap(userLines));
      response();
      await until(() => !app.page!.busy);
      const transcript = await openTranscript(paths.transcript(project, "orchestrator")).chain();
      for (const text of ["start", "next one", "next two"]) expect(JSON.stringify(transcript).split(`[user] ${text}`)).toHaveLength(text === "next one" ? 3 : 2);
    } finally { release(); response(); app.quit(); await running; }
  });

  test("login transfer retains previews and FIFO even for submissions made during a delayed send", async () => {
    const term = fakeTerm(100, 24), attempted: string[] = [];
    let signedIn!: () => void, persisted!: () => void, read!: (msgs: Message[]) => void;
    const loginGate = new Promise<void>(resolve => { signedIn = resolve; });
    const writeGate = new Promise<void>(resolve => { persisted = resolve; });
    const app = new App({ term, pollMs: 100_000, login: async () => { await loginGate; return "signed in"; }, openOrchestrator: async (_p, _u, _w, inbox) => {
      read = inbox!;
      return { async say(text) { attempted.push(text); if (text === "one") await writeGate; }, async pending() { return false; }, async turn() { return []; } };
    } });
    const running = app.run("queued-login-transfer");
    try {
      await until(() => !!app.page);
      term.type("/login claude\r");
      await until(() => app.loggingIn);
      term.type("one\rtwo\r");
      await until(() => app.frame().queued?.texts.length === 2);
      expect(app.frame().queued?.texts).toEqual(["one", "two"]);
      signedIn();
      await until(() => attempted.length === 1);
      expect(app.loggingIn).toBe(false);
      expect(app.frame().queued?.texts).toEqual(["one", "two"]);
      term.type("three\r");
      await until(() => app.frame().queued?.texts.length === 3);
      expect(attempted).toEqual(["one"]);
      expect(app.frame().queued?.texts).toEqual(["one", "two", "three"]);
      persisted();
      await until(() => attempted.length === 3);
      expect(attempted).toEqual(["one", "two", "three"]);
      expect(app.frame().queued?.texts).toEqual(attempted); // successful persistence alone is not consumption
      read(app.page!.sent.map(item => ({ from: "user", ...item, ts: "synthetic" })));
      expect(app.frame().queued?.texts).toEqual([]);
      expect(app.page!.lines.filter((line): boolean => typeof line === "object" && "user" in line)).toEqual(attempted.flatMap(userLines));
    } finally { signedIn(); persisted(); app.quit(); await running; }
  });
});

for (const boundary of ["cancel", "error"] as const) test(`queued footer survives a real ${boundary} boundary without acknowledging pending input`, async () => {
  const term = fakeTerm(100, 24), project = `queued-boundary-${boundary}`;
  let reject!: (error: Error) => void, calls = 0;
  const scripted = fakeProvider([[said("resumed")]]);
  const provider = { ...scripted, async complete(req: Parameters<typeof scripted.complete>[0]) {
    if (++calls !== 1) return scripted.complete(req);
    return new Promise<Awaited<ReturnType<typeof scripted.complete>>>((_resolve, fail) => {
      reject = fail;
      req.signal!.addEventListener("abort", () => fail(req.signal!.reason), { once: true });
    });
  } };
  const app = new App({ term, pollMs: 100_000, openOrchestrator: async (project, _u, write, onInbox) => createOrchestrator({ project, provider, tools: {}, write, onInbox }) });
  const running = app.run(project);
  try {
    await until(() => !!app.page);
    term.type("consumed before boundary\r");
    await until(() => !!reject);
    term.type("still pending");
    await app.onKey({ name: "enter" }); // wait for persistence before failing the active request
    await until(() => app.frame().queued?.texts.length === 1);
    term.type("draft stays");
    const draft = { ...app.input };
    if (boundary === "cancel") await app.onKey({ name: "c", ctrl: true });
    else reject(new Error("synthetic request failure"));
    await until(() => !app.page!.busy && term.screen().includes("  1. still pending"));
    expect(calls).toBe(1);
    expect(app.frame().queued?.texts).toEqual(["still pending"]);
    expect(app.input).toEqual(draft);
    expect(app.page!.lines.filter((line): boolean => typeof line === "object" && "user" in line)).toEqual(userLines("consumed before boundary"));
    await app.onKey({ name: "escape" }); // explicit clearing of this fixture's draft only
    term.type("resume now\r");
    await until(() => calls === 2 && !app.page!.busy);
    expect(app.frame().queued?.texts).toEqual([]);
    expect(app.page!.lines.filter((line): boolean => typeof line === "object" && "user" in line)).toEqual(["consumed before boundary", "still pending", "resume now"].flatMap(userLines));
    const transcript = JSON.stringify(await openTranscript(paths.transcript(project, "orchestrator")).chain());
    for (const text of ["consumed before boundary", "still pending", "resume now"]) expect(transcript.split(`[user] ${text}`)).toHaveLength(2);
  } finally { reject?.(new Error("test cleanup")); app.quit(); await running; }
});

test("queued footer removal preserves a scrolled source anchor and enter still follows the tail, without changing terminal input modes", async () => {
  const term = fakeTerm(100, 24);
  let read!: (msgs: Message[]) => void;
  const app = new App({ term, pollMs: 100_000, openOrchestrator: async (_p, _u, _w, inbox) => {
    read = inbox!;
    return { async say() {}, async pending() { return false; }, async turn() { return []; } };
  } });
  const running = app.run("queued-scroll");
  const conversation = () => {
    const rows = term.display.screen();
    const at = rows.findIndex(row => row.startsWith("queued") || row.startsWith("┌"));
    expect(at).toBeGreaterThan(bodyStart(term));
    expect(rows[at - 1]).toBe("");
    expect(term.display.backgrounds()[term.display.top + at - 1]!.some(Boolean)).toBe(false);
    return rows.slice(bodyStart(term), at - 1);
  };
  try {
    await until(() => !!app.page);
    for (let i = 0; i < 80; i++) app.say(`history ${i}`);
    await until(() => term.screen().includes("history 79"));
    const bodyHeight = conversation().length;
    const saved = historyRows(app.page!.lines, term.cols).map(row => Bun.stripANSI(row).trimEnd());
    expect(conversation()).toEqual(saved.slice(-bodyHeight));
    term.press({ name: "pageup" });
    await until(() => !term.screen().includes("history 79"));
    // Page Up overlaps exactly one CONTENT row; the fixed gap is not scrollable.
    const start = saved.length - bodyHeight - (bodyHeight - 1);
    expect(conversation()).toEqual(saved.slice(start, start + bodyHeight));
    const top = bodyStart(term), before = term.writes.length;
    term.type("queue one\rqueue two\r");
    await until(() => term.screen().includes("queued 2/2"));
    expect(conversation().at(-1)).toBe("history 79"); // existing Enter contract: follow the tail
    term.press({ name: "pageup" });
    await until(() => !term.screen().includes("history 79"));
    const anchor = term.display.screen()[top];
    term.type("kept draft");
    const draft = { ...app.input };
    read([{ from: "user", ...app.page!.sent[0]!, ts: "synthetic" }]);
    await until(() => term.screen().includes("queued 1/1"));
    expect(term.display.screen()[top]).toBe(anchor);
    conversation(); // Shrinking the queue keeps the gap above the entire footer.
    term.type("\x1b[<65;10;8M".repeat(100)); // injected SGR, not a physical gesture
    await until(() => term.screen().includes("> queue one"));
    read([{ from: "user", ...app.page!.sent[0]!, ts: "synthetic" }]);
    await until(() => term.screen().includes("> queue two") && !/queued \d+\/\d+/.test(term.screen()));
    expect(conversation().at(-1)).toBe("> queue two");
    expect(app.input).toEqual(draft);
    expect(term.display.top).toBe(0);
    expect(term.writes.slice(before).join("")).not.toMatch(/\x1b\[\?(1049|1000|1006|2004)[hl]/);
  } finally { app.quit(); await running; }
});


test("a failed write removes that submission, not a later identical pending prompt", async () => {
  const term = fakeTerm(100, 24);
  let fail!: (error: Error) => void, attempts = 0;
  const app = new App({ term, pollMs: 100_000, openOrchestrator: async () => ({
    async say() { if (++attempts === 1) await new Promise<void>((_resolve, reject) => { fail = reject; }); },
    async pending() { return false; }, async turn() { return []; },
  }) });
  const running = app.run("queued-identical-failure");
  try {
    await until(() => !!app.page);
    term.type("same\rmiddle\rsame\r");
    await until(() => attempts === 3);
    const original = [...app.page!.sent];
    expect(new Set(original.map(item => item.inputId)).size).toBe(3);
    fail(new Error("synthetic write failure"));
    await until(() => app.page!.sent.length === 2);
    expect(app.page!.sent).toEqual(original.slice(1));
    expect(app.frame().queued?.texts).toEqual(["middle", "same"]);
    expect(app.page!.lines.map(raw).map(strip)).toContain("not sent: same");
    expect(app.page!.lines.some(line => typeof line === "object" && "user" in line)).toBe(false);
  } finally { fail?.(new Error("cleanup")); app.quit(); await running; }
});

test("raw SGR/X10 input through realTerminal only scrolls the body: draft, queue and pinned bars survive", async () => {
  const display = new FakeScreen(80, 24), writes: string[] = [];
  let input: ((chunk: Uint8Array) => void) | undefined;
  const stdin = { isTTY: true, setRawMode() {}, on(_e: string, fn: typeof input) { input = fn; }, off() { input = undefined; }, resume() {}, pause() {} };
  const stdout = { isTTY: true, columns: 80, rows: 24, on() {}, write(s: string) { writes.push(s); display.write(s); return true; } };
  const proc = { on() {}, off() {}, exit() {}, stderr: { write() {} } };
  const term = realTerminal(stdin as never, stdout as never, proc, NO_REPLY_WINDOW);
  const app = new App({ term, pollMs: 100_000, watchdog: async () => {}, merges: async () => {}, projectModel: async () => "synthetic",
    openOrchestrator: async () => ({ async say() { throw new Error("input must not submit"); }, async pending() { return false; }, async turn() { return []; } }),
  });
  const running = app.run("raw-wheel");
  try {
    await until(() => !!app.page);
    const page = app.page!;
    page.lines.push(...Array.from({ length: 100 }, (_, i) => `RAW-RECORD-${i}`));
    page.sent.push({ inputId: "synthetic-1", text: "queued first" }, { inputId: "synthetic-2", text: "queued second\nline" });
    app.reprint();
    const text = Buffer.from("\x1b[200~draft 界é👩‍💻\nsecond line\x1b[201~\x1b[D");
    for (const byte of text) input!(Uint8Array.of(byte));
    const draft = { ...app.input }, queue = JSON.stringify(page.sent);
    expect(draft.text).toBe("draft 界é👩‍💻\nsecond line");
    await until(() => display.text().includes("queued 2/2"));
    const initial = display.screen(), start = initial.findIndex(row => /^─+$/.test(row)) + 1;
    const footerAt = initial.findIndex(row => row.startsWith("queued"));
    const pinned = () => {
      expect(display.screen().slice(0, start)).toEqual(initial.slice(0, start));
      expect(display.screen().slice(footerAt)).toEqual(initial.slice(footerAt));
      expect(app.input).toEqual(draft);
      expect(JSON.stringify(page.sent)).toBe(queue);
    };
    const up = Buffer.from("\x1b[<64;10;10M"), down = Buffer.from([27, 91, 77, 97, 194, 160]);
    // Every split traverses realTerminal -> keyReader -> App, not just parseKeys.
    for (const packet of [up, down]) for (let cut = 1; cut < packet.length; cut++) {
      input!(packet.subarray(0, cut)); input!(packet.subarray(cut));
      expect(app.input).toEqual(draft);
    }
    input!(Buffer.from("\x1b[<64;10;10M".repeat(100)));
    await until(() => display.screen()[start] === "RAW-RECORD-0");
    pinned();
    input!(Buffer.from("\x1b[<64;10;10M".repeat(20)));
    await Bun.sleep(25);
    expect(display.screen()[start]).toBe("RAW-RECORD-0"); pinned();
    const top = display.screen();
    input!(Buffer.from("\x1b[<66;10;10M\x1b[<67;10;10M\x1b[<65;10;10m\x1b[<65M\x1b[M !!"));
    await Bun.sleep(25);
    expect(display.screen()).toEqual(top); pinned();
    input!(Buffer.concat(Array.from({ length: 100 }, () => down)));
    await until(() => display.screen().includes("RAW-RECORD-99")); pinned();
    const bottom = display.screen();
    input!(down); await Bun.sleep(25);
    expect(display.screen()).toEqual(bottom); pinned();
    expect(app.frame().queued?.texts).toEqual(["queued first", "queued second\nline"]);
    const output = writes.join("");
    for (const mode of [1000, 1002, 1006]) {
      expect(output).toContain(`\x1b[?${mode}h`);
      expect(output).not.toContain(`\x1b[?${mode}l`);
    }
    for (const mode of [1049, 2004]) {
      expect(output.split(`\x1b[?${mode}h`)).toHaveLength(2);
      expect(output).not.toContain(`\x1b[?${mode}l`);
    }
    expect(output).not.toContain("\x1b[3J");
    // Draft-safe /keys entry uses a real control byte, not a direct command call.
    input!(Buffer.from("\x07"));
    expect(app.keyEcho).toBe(true);
    input!(up); input!(down);
    expect(page.lines.map(raw).join("\n")).toContain('{"name":"wheelup"}');
    expect(page.lines.map(raw).join("\n")).toContain('{"name":"wheeldown"}');
    input!(Buffer.from("\x1b"));
    await until(() => !app.keyEcho);
    expect(app.input).toEqual(draft);
    expect(JSON.stringify(page.sent)).toBe(queue);
  } finally { app.quit(); await running; }
});

test("Option+Backspace and a drag arriving as separate writes through realTerminal: the word goes, the drag auto-copies, even when the Esc timer fires first", async () => {
  const display = new FakeScreen(60, 24), copied: string[] = [];
  let input: ((chunk: Uint8Array) => void) | undefined;
  const stdin = { isTTY: true, setRawMode() {}, on(_e: string, fn: typeof input) { input = fn; }, off() { input = undefined; }, resume() {}, pause() {} };
  const stdout = { isTTY: true, columns: 60, rows: 24, on() {}, write(s: string) { display.write(s); return true; } };
  const proc = { on() {}, off() {}, exit() {}, stderr: { write() {} } };
  const term = realTerminal(stdin as never, stdout as never, proc, NO_REPLY_WINDOW);
  const app = new App({ term, pollMs: 100_000, watchdog: async () => {}, merges: async () => {}, projectModel: async () => "synthetic", clipboardText: async text => { copied.push(text); },
    openOrchestrator: async () => ({ async say() { throw new Error("input must not submit"); }, async pending() { return false; }, async turn() { return []; } }),
  });
  const running = app.run("split-writes");
  // The terminal's writes reach stdin as real reads: a child process writes `prefix`, then `rest`
  // 5ms later on its own clock (as Terminal.app writes the Option prefix and the key, and each
  // mouse report, separately). With `stall`, the read that delivered the prefix keeps the loop
  // busy past the Esc window while the rest lands in the pipe, so the expired Esc timer runs
  // before the read that is already waiting, as under a slow frame.
  const write = async (prefix: string, rest = "", stall = 0) => {
    const source = Bun.spawn(["/bin/sh", "-c", 'printf "%s" "$1"; if [ -n "$2" ]; then sleep 0.005; printf "%s" "$2"; fi', "writes", prefix, rest], { stdin: "ignore", stdout: "pipe" });
    const chunks: string[] = [];
    for await (const chunk of source.stdout) {
      chunks.push(Buffer.from(chunk).toString("latin1"));
      input!(chunk);
      if (chunks.length === 1 && stall) { const end = performance.now() + stall; while (performance.now() < end) { /* busy */ } }
    }
    await source.exited;
    expect(chunks.join("")).toBe(prefix + rest);
    if (rest) expect(chunks[0]).toBe(prefix); // the race did happen: the prefix was read on its own
  };
  const split = (prefix: string, rest: string) => write(prefix, rest, ESC_DELAY_MS + 10);
  try {
    await until(() => !!app.page);
    app.page!.lines.push("SELECT-ME please", ...Array.from({ length: 30 }, (_, i) => `row-${i}`));
    app.reprint();
    await until(() => display.screen().some(row => row.includes("row-29")));
    await write("hello big wide world");
    await write("\x1b", "\x7f"); // Terminal.app: ESC, then DEL, two writes
    expect(app.input).toEqual({ text: "hello big wide ", cursor: 15 });
    await split("\x1b", "\x7f"); // the Esc timer ran before the DEL read: still one chord, never Escape (which clears the draft)
    expect(app.input).toEqual({ text: "hello big ", cursor: 10 });
    await split("\x1b", "\b");
    expect(app.input).toEqual({ text: "hello ", cursor: 6 });
    await split("\x1b", "d"); // any Alt chord
    expect(app.input).toEqual({ text: "hello ", cursor: 6 });
    await write("\x1b"); await Bun.sleep(ESC_DELAY_MS * 3); // a real lone Escape still clears, after the bounded wait
    expect(app.input.text).toBe("");
    for (let i = 0; i < 3; i++) { await write("\x1b[5~"); await Bun.sleep(25); }
    await until(() => display.screen().some(row => row.includes("SELECT-ME")));
    const y = display.screen().findIndex(row => row.includes("SELECT-ME")) + 1;
    // Every report its own write; the ESC of each read before its rest with the timer racing it; the release last.
    for (const report of [`\x1b[<0;1;${y}M`, `\x1b[<32;5;${y}M`, `\x1b[<32;9;${y}M`, `\x1b[<0;9;${y}m`]) await split(report.slice(0, 1), report.slice(1));
    await until(() => copied.length === 1);
    expect(copied).toEqual(["SELECT-ME"]);
    expect(app.input.text).toBe(""); // no report text typed into the draft
  } finally { app.quit(); await running; }
});

test("extended Kitty Option Delete edits Unicode at the cursor through realTerminal, not on release", async () => {
  let input: ((chunk: Uint8Array) => void) | undefined;
  const stdin = { isTTY: true, setRawMode() {}, on(_e: string, fn: typeof input) { input = fn; }, off() {}, resume() {}, pause() {} };
  const stdout = { isTTY: true, columns: 60, rows: 24, on() {}, write() { return true; } };
  const proc = { on() {}, off() {}, exit() {}, stderr: { write() {} } };
  const term = realTerminal(stdin as never, stdout as never, proc, NO_REPLY_WINDOW);
  const orchs = fakeOrchestrators();
  const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000 });
  const running = app.run("kitty-option-delete");
  try {
    await until(() => !!app.page);
    app.input = { text: "keep café 世界 tail", cursor: "keep café 世界".length };
    // Documented protocol bytes, not a capture from the user's terminal.
    // Split inside the modifier/event field, the part previously coerced to NaN.
    input!(Buffer.from("\x1b[127;3:"));
    input!(Buffer.from("1u"));
    expect(app.input).toEqual({ text: "keep café  tail", cursor: "keep café ".length });
    input!(Buffer.from("\x1b[127;3:2u"));
    expect(app.input).toEqual({ text: "keep  tail", cursor: 5 });
    input!(Buffer.from("\x1b[127;3:3u"));
    expect(app.input).toEqual({ text: "keep  tail", cursor: 5 });
    expect(orchs.said["kitty-option-delete"]).toEqual([]);
  } finally { app.quit(); await running; }
});

test("ctrl+g enters /keys without replacing chat, answer, or no-page drafts and input history", async () => {
  const term = fakeTerm(100, 24), orchs = fakeOrchestrators();
  const app = new App({ term, pollMs: 100_000, questionDelayMs: 0, openOrchestrator: orchs.openOrchestrator });
  const running = app.run("keys-drafts");
  const check = async () => {
    const draft = { ...app.input }, history = [...(app.page?.inputHistory ?? [])];
    term.type("\x07");
    expect(app.keyEcho).toBe(true);
    term.type("\x1b[<64;1;1M\x1b[<65;1;1M\x1b[200~ignored\x1b[201~\r");
    term.press({ name: "escape" });
    expect(app.keyEcho).toBe(false);
    expect(app.input).toEqual(draft);
    expect(app.page?.inputHistory ?? []).toEqual(history);
  };
  try {
    await until(() => !!app.page);
    app.input = { text: "chat\n界 draft", cursor: 6 };
    await check();
    await askQuestions("keys-drafts", [{ text: "Answer?" }]);
    await app.questions.command(app.page);
    app.input = { text: "answer 👩‍💻", cursor: 4 };
    await check();
    expect(app.questions.answering()).toBe(true);
    await app.onKey({ name: "q", ctrl: true });
    expect(app.input).toEqual({ text: "chat\n界 draft", cursor: 6 });
    expect(orchs.said["keys-drafts"]).toEqual([]);
    await app.closePage();
    app.input = { text: "no-page draft", cursor: 2 };
    await check();
  } finally { app.quit(); await running; }
});

describe("clipboard image drafts and immutable queue ownership (isolated fixtures only)", () => {
  async function fixture(clipboardImage: () => Promise<{ bytes: Uint8Array; mime: string }> = async () => ({ bytes: png(), mime: "image/png" }), extra: Partial<ConstructorParameters<typeof App>[0]> = {}) {
    const project = `images-${crypto.randomUUID()}`;
    mkdirSync(paths.project(project), { recursive: true });
    const term = fakeTerm(100, 28);
    const sent: { text: string; inputId?: string; attachments?: ImageRef[] }[] = [];
    const receipts = new Set<string>();
    let inbox!: (msgs: Message[]) => void;
    const app = new App({ term, pollMs: 100_000, clipboardImage, watchdog: async () => {}, merges: async () => {}, agents: async () => [],
      openOrchestrator: async (_p, _url, _write, onInbox) => {
        inbox = onInbox!;
        return { say: async (text, _submission, inputId, attachments) => { sent.push({ text, inputId, attachments }); },
          pending: async () => false, turn: async () => [], consumed: () => receipts };
      }, ...extra });
    const running = app.run(project);
    await until(() => !!app.page && !term.screen().includes("opening…"));
    return { app, term, project, sent, receipts, inbox: (msgs: Message[]) => inbox(msgs), stop: async () => { app.quit(); await running; } };
  }
  const v: Key = { name: "v", ctrl: true }, y: Key = { name: "y", ctrl: true };
  test("no startup/paste polling; removable visible images, ordinary text paste, image-only sends and exact receipts", async () => {
    let reads = 0;
    const f = await fixture(async () => { reads++; return { bytes: png(), mime: "image/png" }; });
    try {
      expect(reads).toBe(0);
      await f.app.onKey({ name: "paste", text: "ordinary\ntext" });
      expect(reads).toBe(0); expect(f.app.input.text).toBe("ordinary\ntext");
      await f.app.onKey(v); await f.app.onKey(v);
      expect(f.app.frame().inputArea!.lines.join("\n")).toContain("[image 1] [image 2]");
      await f.app.onKey(y); expect(f.app.frame().inputArea!.lines.join("\n")).not.toContain("[image 2]");
      await f.app.onKey({ name: "enter" });
      expect(f.sent[0]!.text).toBe("ordinary\ntext"); expect(f.sent[0]!.attachments).toHaveLength(1);
      expect(f.app.page!.sent).toHaveLength(1);
      expect(f.app.frame().queued!.texts[0]).toContain("[image 1]");
      await f.app.onKey(v); await f.app.onKey({ name: "enter" });
      expect(f.sent[1]!.text).toBe(""); expect(f.sent[1]!.attachments).toHaveLength(1);
      expect(f.sent[1]!.inputId).not.toBe(f.sent[0]!.inputId);
      expect(await pendingImageInputs(f.project)).toHaveLength(2);
      f.inbox([{ from: "user", text: f.sent[0]!.text, ts: "", inputId: "not-the-same" }]);
      expect(f.app.page!.sent).toHaveLength(2);
      f.receipts.add(f.sent[0]!.inputId!);
      f.inbox([{ from: "user", ...f.sent[0]!, ts: "" }]);
      expect(f.app.page!.sent).toHaveLength(1);
      expect(f.term.raw()).not.toContain(png().toString("base64"));
    } finally { await f.stop(); }
  });
  test("slash commands preserve images and draft; esc clears; projects have separate removable attachments", async () => {
    const f = await fixture();
    try {
      await f.app.onKey(v);
      await f.app.onKey({ name: "char", text: "/clear" }); await f.app.onKey({ name: "enter" });
      expect(f.app.input.text).toBe("/clear"); expect(f.sent).toHaveLength(0);
      expect(f.app.frame().inputArea!.lines.join("\n")).toContain("image 1");
      const first = f.app.page!;
      const second = `images-${crypto.randomUUID()}`; mkdirSync(paths.project(second), { recursive: true });
      await f.app.openPage(second);
      expect(f.app.frame().inputArea!.lines.join("\n")).not.toContain("image 1");
      f.app.switchPage(-1); expect(f.app.page).toBe(first);
      expect(f.app.frame().inputArea!.lines.join("\n")).toContain("image 1");
      await f.app.onKey({ name: "escape" });
      expect(f.app.frame().inputArea!.lines.join("\n")).not.toContain("image 1");
      expect(f.app.input.text).toBe("");
    } finally { await f.stop(); }
  });
  test.each(["send", "escape", "refresh", "project", "menu", "question", "delete", "close", "cancel", "history"])("late clipboard completion cannot attach to newer draft/page/modal after %s", async action => {
    let finish!: (image: { bytes: Uint8Array; mime: string }) => void, reads = 0;
    const f = await fixture(async () => { reads++; return new Promise(r => { finish = r; }); });
    try {
      const reading = f.app.onKey(v);
      await f.app.onKey(v); expect(reads).toBe(1);
      if (action === "send") { await f.app.onKey({ name: "char", text: "old prompt" }); await f.app.onKey({ name: "enter" }); }
      if (action === "escape") await f.app.onKey({ name: "escape" });
      if (action === "refresh") await f.app.refreshSessions();
      if (action === "project") { const p = `images-${crypto.randomUUID()}`; mkdirSync(paths.project(p), { recursive: true }); await f.app.openPage(p); f.app.switchPage(-1); }
      if (action === "menu") { f.app.openMenu("fixture", [{ value: "x", label: "x" }], () => {}); await f.app.onKey({ name: "escape" }); }
      if (action === "question") { await f.app.onKey({ name: "q", ctrl: true }); await f.app.onKey({ name: "escape" }); }
      if (action === "delete") f.app.page!.deleting = true;
      if (action === "close") { f.app.closePage(); await f.app.openPage(f.project); }
      if (action === "cancel") await f.app.onKey({ name: "c", ctrl: true });
      if (action === "history") await f.app.onKey({ name: "up" });
      await f.app.onKey({ name: "char", text: "new draft" });
      finish({ bytes: png(), mime: "image/png" }); await reading;
      expect(f.app.frame().inputArea!.lines.join("\n")).not.toContain("image 1");
      expect(f.app.input.text).toContain("new draft");
      expect(f.sent.every(m => !m.attachments?.length)).toBe(true);
    } finally { finish?.({ bytes: png(), mime: "image/png" }); await f.stop(); }
  });
  test("clipboard errors and size/count limits retain text/images; modal ctrl+v never reads clipboard", async () => {
    let fail = false, reads = 0;
    const f = await fixture(async () => { reads++; if (fail) throw new Error("fixture clipboard unavailable"); return { bytes: png(), mime: "image/png" }; });
    try {
      await f.app.onKey({ name: "char", text: "retained" }); await f.app.onKey(v);
      fail = true; await f.app.onKey(v);
      expect(f.app.input.text).toBe("retained"); expect(f.app.frame().inputArea!.lines.join("\n")).toContain("image 1");
      expect(f.app.page!.lines.map(raw).join("\n")).toContain("fixture clipboard unavailable");
      fail = false; for (let n = 0; n < 4; n++) await f.app.onKey(v);
      expect(reads).toBe(5); expect(f.app.frame().inputArea!.lines.join("\n")).toContain("image 4");
      f.app.openMenu("fixture", [{ value: "x", label: "x" }], () => {});
      await f.app.onKey(v); expect(reads).toBe(5);
    } finally { await f.stop(); }
  });
  test("failed image writes preserve original IDs/bytes, /refresh and explicit retry never infer missing-inbox consumption", async () => {
    let fails = true; const attempts: string[] = [];
    const f = await fixture(undefined, { openOrchestrator: async () => ({
      say: async (_text, _epoch, id) => { attempts.push(id!); if (fails) throw new Error("fixture write error"); },
      pending: async () => false, turn: async () => [], consumed: () => new Set(),
    }) });
    try {
      await f.app.onKey(v);
      await expect(f.app.onKey({ name: "enter" })).rejects.toThrow("write error");
      const inputId = f.app.page!.sent[0]!.inputId;
      expect(f.app.page!.sent[0]!.retry).toBe(true);
      await f.app.refreshSessions(); expect(f.app.page!.sent[0]!.inputId).toBe(inputId);
      f.app.closePage(); await f.app.openPage(f.project);
      expect(f.app.page!.sent[0]!.inputId).toBe(inputId);
      expect(attempts).toHaveLength(1); // reopen NEVER auto-resends
      fails = false;
      await f.app.onKey({ name: "char", text: "/retry-images" }); await f.app.onKey({ name: "enter" });
      expect(attempts).toEqual([inputId, inputId]); expect(f.app.page!.sent).toHaveLength(1);
    } finally { await f.stop(); }
  });
  test("login failure journals image prompts, reopen restores them without sending, explicit retry retains exact IDs", async () => {
    let reject!: (error: Error) => void;
    const f = await fixture(undefined, { login: async () => new Promise((_resolve, r) => { reject = r; }) });
    try {
      await f.app.onKey({ name: "char", text: "/login claude" });
      const signing = f.app.onKey({ name: "enter" });
      await until(() => f.app.loggingIn);
      await f.app.onKey(v); await f.app.onKey({ name: "enter" });
      const [saved] = await pendingImageInputs(f.project);
      expect(saved!.text).toBe(""); expect(f.sent).toHaveLength(0);
      reject(new Error("fixture login failure")); await signing;
      expect(f.app.page!.sent[0]!.inputId).toBe(saved!.inputId);
      f.app.closePage(); await f.app.openPage(f.project);
      expect(f.sent).toHaveLength(0);
      expect(f.app.page!.sent[0]!.inputId).toBe(saved!.inputId);
      expect(f.app.frame().queued!.texts[0]).toContain("/retry-images");
      await f.app.onKey({ name: "char", text: "/retry-images" }); await f.app.onKey({ name: "enter" });
      expect(f.sent).toHaveLength(1); expect(f.sent[0]!.inputId).toBe(saved!.inputId);
      expect(f.sent[0]!.attachments).toEqual(saved!.attachments);
    } finally { await f.stop(); }
  });

});

test('conversation drag highlights only history, auto-copies on release; ctrl+o re-copies and esc/resize/context clear', async () => {
  const term = fakeTerm(60, 24), orchs = fakeOrchestrators();
  const copied: string[] = [];
  const app = new App({ term, openOrchestrator: orchs.openOrchestrator, clipboardText: async text => { copied.push(text); }, pollMs: 100_000 });
  const running = app.run('selection-probe');
  try {
    await until(() => !!app.page);
    app.page!.lines.push('SELECT-ME 界é', ...Array.from({ length: 40 }, (_, i) => `row-${i}`));
    app.reprint();
    await until(() => term.display.screen().some(row => row.includes('row-39')));
    term.press({ name: 'pageup' }); term.press({ name: 'pageup' }); term.press({ name: 'pageup' });
    await until(() => term.display.screen().some(row => row.includes('SELECT-ME')));
    const y = term.display.screen().findIndex(row => row.includes('SELECT-ME')) + 1;
    expect(y).toBeGreaterThan(0);
    term.type(`\x1b[<0;1;${y}M\x1b[<32;9;${y}M\x1b[<0;9;${y}m`);
    await settle();
    expect(term.raw()).toContain('\x1b[7mSELECT-ME\x1b[0m');
    expect(copied).toEqual(['SELECT-ME']);
    term.press({ name: 'wheeldown' }); await settle();
    await app.onKey({ name: 'o', ctrl: true });
    expect(copied).toEqual(['SELECT-ME', 'SELECT-ME']);
    term.type('draft'); await app.onKey({ name: 'escape' });
    expect(app.input.text).toBe('draft');
    await app.onKey({ name: 'o', ctrl: true }); expect(copied).toHaveLength(2);
    // Header/footer cannot create a selection, and the removed command stays absent.
    term.type('\x1b[<0;1;1M\x1b[<32;9;1M\x1b[<0;9;1m');
    await app.onKey({ name: 'o', ctrl: true }); expect(copied).toHaveLength(2);
    expect(app.commands.has('/mouse')).toBe(false);
    term.press({ name: 'pageup' }); await settle();
    term.type(`\x1b[<0;1;${y}M\x1b[<32;9;${y}M\x1b[<0;9;${y}m`);
    term.resize(40, 20); await Bun.sleep(160);
    await app.onKey({ name: 'o', ctrl: true }); expect(copied).toHaveLength(3);
    for (let i = 0; i < 4; i++) { await app.onKey({ name: 'pageup' }); await Bun.sleep(25); }
    await until(() => term.display.screen().some(row => row.includes('SELECT-ME')));
    const currentY = term.display.screen().findIndex(row => row.includes('SELECT-ME')) + 1;
    expect(currentY).toBeGreaterThan(0);
    term.type(`\x1b[<0;1;${currentY}M\x1b[<32;9;${currentY}M\x1b[<0;9;${currentY}m`);
    await settle();
    await app.openPage('selection-other'); await settle();
    await app.onKey({ name: 'o', ctrl: true }); expect(copied).toHaveLength(4);

  } finally { app.quit(); await running; }
});

for (const scroll of ['wheeldown', 'pagedown', 'wheelup']) test(`drag ${scroll} motion/release in one input burst preserves queued scroll and painted coordinates`, async () => {
  const term = fakeTerm(60, 24), orchs = fakeOrchestrators(), copied: string[] = [];
  const app = new App({ term, openOrchestrator: orchs.openOrchestrator, clipboardText: async text => { copied.push(text); }, pollMs: 100_000 });
  const running = app.run(`selection-burst-${scroll}`);
  try {
    await until(() => !!app.page);
    const records = Array.from({ length: 60 }, (_, i) => `ROW-${String(i).padStart(2, '0')}`);
    app.page!.lines = records;
    app.reprint();
    await until(() => term.display.screen().includes('ROW-59'));
    if (scroll !== 'wheelup') {
      for (let i = 0; i < 10; i++) term.press({ name: 'pageup' });
      await until(() => term.display.screen().includes('ROW-00'));
    }
    const painted = term.display.screen();
    const y = painted.findIndex(row => row.startsWith('ROW-')) + 1;
    const first = Number(painted[y - 1]!.slice(4));
    const count = painted.filter(row => row.startsWith('ROW-')).length;
    const target = first + (scroll === 'wheelup' ? -3 : scroll === 'wheeldown' ? 3 : count - 1);
    // No yields/settles: events queue behind the same throttled frame. Motion
    // still refers to the old painted rows, not the requested scroll target.
    term.press({ name: 'mousedown', x: 1, y });
    term.press({ name: scroll });
    term.press({ name: 'mousemove', x: 6, y: y + 1 });
    term.press({ name: 'mouseup', x: 6, y: y + 1 });
    expect(copied).toEqual([`${records[first]}\n${records[first + 1]}`]);
    await app.onKey({ name: 'o', ctrl: true }); // flush pending frame + explicit copy
    expect(term.display.screen()[y - 1]).toBe(records[target]!);
    expect(copied).toEqual(Array(2).fill(`${records[first]}\n${records[first + 1]}`));
  } finally { app.quit(); await running; }
});

test('automatic copy errors stay visible, highlight supports explicit retry; motion and canceled release do not copy', async () => {
  const term = fakeTerm(60, 24), orchs = fakeOrchestrators(), copied: string[] = [];
  const app = new App({ term, openOrchestrator: orchs.openOrchestrator, clipboardText: async text => {
    copied.push(text); throw new Error('fixture desktop unavailable');
  }, pollMs: 100_000 });
  const running = app.run('selection-error');
  try {
    await until(() => !!app.page);
    app.page!.lines = ['COPY-ME']; app.reprint(); await settle();
    const y = term.display.screen().findIndex(row => row.includes('COPY-ME')) + 1;
    const down = () => app.onKey({ name: 'mousedown', x: 1, y });
    const up = () => app.onKey({ name: 'mouseup', x: 7, y });
    await down(); await app.onKey({ name: 'mousemove', x: 7, y });
    expect(copied).toEqual([]);
    await app.onKey({ name: 'escape' }); await up();
    expect(copied).toEqual([]);
    await down(); await up(); await up();
    expect(copied).toEqual(['COPY-ME']);
    expect(app.page!.lines.map(raw).join('\n')).toContain('copy failed: fixture desktop unavailable');
    await app.onKey({ name: 'o', ctrl: true });
    expect(copied).toEqual(['COPY-ME', 'COPY-ME']);
  } finally { app.quit(); await running; }
});

test("unchanged telemetry polls avoid redraw; task progress is independent of the saved limit and agent switches render honestly", async () => {
  const term = fakeTerm(80, 24);
  const tasks = [{ id: "one", branch: "feat/one", review: { rounds: 1, unknown: false, ci: false } }] as import("../protocol/tasks").TaskRow[];
  const fake = fakeOrchestrators();
  let limit = 7;
  const app = new App({ term, pollMs: 100_000, projectModel: async () => "gpt-5.5", tasks: async () => tasks, flowSettings: async () => ({ maxReviewRounds: limit, dynamicDispatch: false }),
    agents: async () => [], openOrchestrator: async (...args) => ({ ...await fake.openOrchestrator(args[0], args[1], args[2], args[3]), contextUsage: () => 12500 }) });
  const running = app.run("header-poll-telemetry");
  try {
    await until(() => !!app.page);
    await app.refreshHeader();
    await until(() => term.screen().includes("ctx ~12.5k/272k") && term.screen().includes("review rounds: 7"));
    await settle();
    const draws = spyOn(app, "draw"), bytesBefore = term.writes.length;
    for (let i = 0; i < 20; i++) await app.refreshHeader();
    expect(draws).not.toHaveBeenCalled();
    expect(term.writes.length).toBe(bytesBefore);
    limit = 0;
    await app.refreshSessions();
    await app.refreshHeader();
    expect(draws).toHaveBeenCalled();
    await until(() => term.screen().includes("review rounds: 0"));
    draws.mockRestore();
    // These views have no usage accessor of their own: never borrow the main
    // session's estimate or current project model limit for another agent.
    app.page!.view = { name: "reviewer-feat-two", lines: [], leave() {}, live: false, calls: new Calls() };
    app.draw();
    await until(() => term.screen().includes("review rounds: 0") && term.screen().includes("view reviewer-feat-two"));
    expect(term.screen()).toContain("ctx ?/?");
    app.page!.view = { ...app.page!.view!, name: "worker-feat-one" };
    app.draw();
    await until(() => term.screen().includes("view worker-feat-one") && term.screen().includes("review rounds: 0"));
    app.page!.view = null; app.draw();
    await until(() => term.screen().includes("ctx ~12.5k/272k") && term.screen().includes("review rounds: 0"));
  } finally { app.quit(); await running; }
});

test("header denominator: verified claude window, unlisted model shows the session's compaction estimate", async () => {
  const term = fakeTerm(80, 24);
  const fake = fakeOrchestrators();
  let model = "claude-opus-5-5";
  const app = new App({ term, pollMs: 100_000, projectModel: async () => model, tasks: async () => [], flowSettings: async () => ({ maxReviewRounds: 7, dynamicDispatch: false }), agents: async () => [],
    openOrchestrator: async (...args) => ({ ...await fake.openOrchestrator(args[0], args[1], args[2], args[3]), contextUsage: () => 45000,
      contextWindow: (m: string) => (m === "claude-opus-5-5" ? { limit: 1000000, estimated: false } : { limit: 64000, estimated: true }) }) });
  const running = app.run("header-denominator");
  try {
    await until(() => !!app.page);
    await app.refreshHeader();
    await until(() => term.screen().includes("ctx ~45k/1M"));
    model = "unlisted-model";
    await app.refreshHeader();
    await until(() => term.screen().includes("ctx ~45k/64k?"));
    app.page!.view = { name: "reviewer-feat-two", lines: [], leave() {}, live: false, calls: new Calls() };
    app.draw();
    await until(() => term.screen().includes("view reviewer-feat-two"));
    expect(term.screen()).toContain("ctx ?/?");
  } finally { app.quit(); await running; }
});

describe("/agents clocks", () => {
  const T0 = Date.parse("2024-05-01T10:00:00.000Z");
  const iso = (ms: number) => new Date(T0 + ms).toISOString();
  const row = (term: ReturnType<typeof fakeTerm>, name: string) => term.screen().split("\n").find((l) => l.includes(name))?.trim();

  /** An app whose clock and timers the test drives; `agents` is what the list returns now. */
  async function setup(agents: () => Promise<{ name: string; live: boolean; startedAt?: string; endedAt?: string; approximateEnd?: boolean }[]>) {
    const term = fakeTerm(80, 24);
    const state = { now: T0 + 192_000 };
    const timers: { fn: () => void; ms: number }[] = [];
    const clock: Clock = { now: () => state.now, every: (fn, ms) => { const t = { fn, ms }; timers.push(t); return () => { timers.splice(timers.indexOf(t), 1); }; } };
    const menuTimers = () => timers.filter((t) => t.ms === AGENTS_TICK_MS);
    const app = new App({ term, clock, pollMs: 100_000, agents, watchdog: async () => {}, merges: async () => {}, openOrchestrator: fakeOrchestrators().openOrchestrator });
    const running = app.run("clocks");
    await until(() => !!app.page);
    return { term, state, timers, menuTimers, app, running, stop: async () => { app.quit(); await running; },
      tick: async (ms: number) => { state.now += ms; for (const t of menuTimers()) t.fn(); await Bun.sleep(30); } };
  }

  test("a live agent's clock ticks once a second from its start; a finished agent's time is final", async () => {
    const t = await setup(async () => [
      { name: "worker-foo", live: true, startedAt: iso(0) },
      { name: "worker-old", live: false, startedAt: iso(0), endedAt: iso(14 * 60_000 + 2000) },
      { name: "worker-kill", live: false, startedAt: iso(0), endedAt: iso(61_000), approximateEnd: true },
      { name: "worker-none", live: false },
    ]);
    try {
      expect(t.menuTimers().length).toBe(0);
      t.term.type("/agents\r");
      await until(() => !!t.app.menu);
      await until(() => row(t.term, "worker-foo") === "❯ worker-foo  live 3m 12s");
      expect(row(t.term, "worker-old")).toBe("worker-old  finished 14m 02s");
      expect(row(t.term, "worker-kill")).toBe("worker-kill  finished ~1m 01s");
      expect(row(t.term, "worker-none")).toBe("worker-none  finished");
      expect(t.menuTimers().map((x) => x.ms)).toEqual([1000]);
      await t.tick(1000);
      await until(() => row(t.term, "worker-foo") === "❯ worker-foo  live 3m 13s");
      await t.tick(5000);
      await until(() => row(t.term, "worker-foo") === "❯ worker-foo  live 3m 18s");
      expect(row(t.term, "worker-old")).toBe("worker-old  finished 14m 02s");
    } finally { await t.stop(); }
  });

  test("an agent that exits while the menu is open flips to finished and freezes at its end", async () => {
    let list = [{ name: "worker-foo", live: true, startedAt: iso(0) } as { name: string; live: boolean; startedAt?: string; endedAt?: string }];
    let reads = 0;
    const t = await setup(async () => { reads++; return list; });
    try {
      t.term.type("/agents\r");
      await until(() => row(t.term, "worker-foo") === "❯ worker-foo  live 3m 12s");
      const opened = reads;
      await t.tick(1000);
      expect(reads).toBe(opened); // not due yet: the list is read every other second
      list = [{ name: "worker-foo", live: false, startedAt: iso(0), endedAt: iso(193_000) }];
      await t.tick(1000); // now 3m 14s: the list is re-read and shows the end at 3m 13s
      await until(() => row(t.term, "worker-foo") === "❯ worker-foo  finished 3m 13s");
      expect(reads).toBe(opened + 1);
      await t.tick(60_000);
      await t.tick(60_000);
      expect(row(t.term, "worker-foo")).toBe("❯ worker-foo  finished 3m 13s");
    } finally { await t.stop(); }
  });

  test("list reads never overlap, and a failed read leaves the menu as it was", async () => {
    let reads = 0, release!: () => void, mode: "ok" | "hold" | "fail" = "ok";
    const t = await setup(async () => {
      reads++;
      if (mode === "hold") await new Promise<void>((r) => (release = r));
      if (mode === "fail") throw new Error("tmux gone");
      return [{ name: "worker-foo", live: true, startedAt: iso(0) }];
    });
    try {
      t.term.type("/agents\r");
      await until(() => !!t.app.menu);
      const opened = reads;
      mode = "hold";
      await t.tick(2000);
      await t.tick(1000);
      await t.tick(1000);
      expect(reads).toBe(opened + 1); // the first re-read is still pending
      release();
      mode = "fail";
      await Bun.sleep(30);
      await t.tick(2000);
      await until(() => reads === opened + 2);
      await Bun.sleep(30);
      expect(row(t.term, "worker-foo")).toContain("live 3m");
      mode = "ok";
      await t.tick(2000);
      await until(() => reads === opened + 3);
    } finally { await t.stop(); }
  });

  test("the selection follows its agent by name when the list reorders or grows, and Enter attaches that agent", async () => {
    const mk = (...names: string[]) => names.map((name) => ({ name, live: false }));
    let list = mk("worker-a", "worker-b", "worker-c");
    const t = await setup(async () => list);
    try {
      t.term.type("/agents\r");
      await until(() => !!t.app.menu);
      t.term.press({ name: "down" });
      await until(() => t.app.menu!.index === 1);
      list = mk("worker-c", "worker-x", "worker-b", "worker-a");
      await t.tick(2000);
      await until(() => t.app.menu!.index === 2);
      expect(row(t.term, "worker-b")).toBe("❯ worker-b  finished");
      list = mk("worker-c", "worker-a"); // the selected agent vanished: same position, in range
      await t.tick(2000);
      await until(() => t.app.menu!.index === 1);
      list = mk("worker-a", "worker-c", "worker-b");
      await t.tick(2000);
      await until(() => t.app.menu!.index === 0);
      t.term.press({ name: "enter" });
      await until(() => t.app.page!.view?.name === "worker-a");
      expect(t.menuTimers().length).toBe(0);
    } finally { await t.stop(); }
  });

  test("no menu timer runs before the menu opens, after esc, in another overlay, or after quitting", async () => {
    const t = await setup(async () => [{ name: "worker-foo", live: true, startedAt: iso(0) }]);
    try {
      expect(t.menuTimers().length).toBe(0);
      t.term.type("/agents\r");
      await until(() => t.menuTimers().length === 1);
      t.term.press({ name: "escape" });
      await until(() => !t.app.menu);
      expect(t.menuTimers().length).toBe(0);

      t.term.type("/agents\r");
      await until(() => t.menuTimers().length === 1);
      await t.app.openProjects(); // another overlay replaces the menu
      expect(t.menuTimers().length).toBe(0);
      await t.app.closeProjects();

      t.term.type("/agents\r");
      await until(() => t.menuTimers().length === 1);
      t.term.type("");
      t.app.quit();
      await t.running;
      expect(t.timers.length).toBe(0);
    } finally { await t.stop(); }
  });

  test("a tick after the menu closed starts no list read, and a read that finds the view moved on closes the menu", async () => {
    let reads = 0;
    const t = await setup(async () => { reads++; return [{ name: "worker-foo", live: true, startedAt: iso(0) }]; });
    try {
      t.term.type("/agents\r");
      await until(() => t.menuTimers().length === 1);
      const tick = t.menuTimers()[0]!.fn;
      const opened = reads;
      t.app.menu = null; // closed, but the draw that syncs the timer off has not run yet (Enter while attach runs)
      t.state.now += 5000;
      tick();
      await Bun.sleep(30);
      expect(reads).toBe(opened);
      expect(t.menuTimers().length).toBe(0);

      t.term.type("/agents\r");
      await until(() => t.menuTimers().length === 1);
      (t.app as unknown as { modelGeneration: number }).modelGeneration++; // another operation superseded the menu
      await t.tick(2000);
      await until(() => !t.app.menu && t.menuTimers().length === 0);
    } finally { await t.stop(); }
  });

  test("ticks only redraw through the frame throttle", async () => {
    const t = await setup(async () => [{ name: "worker-foo", live: true, startedAt: iso(0) }]);
    try {
      t.term.type("/agents\r");
      await until(() => row(t.term, "worker-foo") === "❯ worker-foo  live 3m 12s");
      await settle();
      const before = t.term.writes.length;
      t.state.now += 1000;
      for (let i = 0; i < 20; i++) t.menuTimers()[0]!.fn();
      await Bun.sleep(40);
      expect(t.term.writes.length - before).toBeLessThanOrEqual(2);
      expect(row(t.term, "worker-foo")).toBe("❯ worker-foo  live 3m 13s");
    } finally { await t.stop(); }
  });
});
