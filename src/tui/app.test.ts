import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Orchestrator } from "../orchestrator";
import { App } from "./app";
import { parseKeys, type Key } from "./keys";
import type { Terminal } from "./term";

const home = mkdtempSync(join(tmpdir(), "parallels-tui-"));
process.env.PARALLELS_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));

const strip = (s: string) => s.replace(/\x1b\[[0-9;?<>]*[A-Za-z]/g, "");

function fakeTerm() {
  const handlers: ((k: Key) => void)[] = [];
  let screen = "";
  const term: Terminal & { type(s: string): void; press(k: Key): void; screen(): string; opened: boolean; closed: boolean } = {
    cols: 40, rows: 8, opened: false, closed: false,
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
    await settle();
    expect(orchs.opened[1]!.project).toMatch(/^orch-[a-z0-9]{4}$/);
    expect(orchs.opened[1]!.url).toBeUndefined();
    expect(app.pages.length).toBe(2);
    expect(app.page!.project).toBe(orchs.opened[1]!.project);
    expect(term.screen()).toContain("/rename <name> to rename");

    term.type("\x1a"); // Ctrl+Z
    expect(app.page!.project).toBe("alpha");
    term.type("\x18"); // Ctrl+X
    expect(app.page!.project).toBe(orchs.opened[1]!.project);
    term.type("\x18"); // wraps around
    expect(app.page!.project).toBe("alpha");
    term.type("\x1b[1;5C"); // Ctrl+Right, the arrow fallback
    expect(app.page!.project).toBe(orchs.opened[1]!.project);
    term.type("\x1b[1;3D"); // Alt+Left
    expect(app.page!.project).toBe("alpha");

    term.type("/new beta git@example.com:b.git\r");
    await settle();
    expect(orchs.opened[2]).toEqual({ project: "beta", url: "git@example.com:b.git" });
    term.type("/close\r");
    await settle();
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
    await settle();
    expect(app.page!.project).toBe("login-page");
    expect(orchs.opened.map((o) => o.project)).toEqual(["orch-old", "login-page"]);
    expect(existsSync(join(home, "projects", "login-page", "repo"))).toBe(true);
    expect(existsSync(join(home, "projects", "orch-old"))).toBe(false);
    expect(term.screen()).toContain("orch-old → login-page");
    term.type("/rename bad name\r");
    await settle();
    expect(term.screen()).toContain("error: names are letters");
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
    await settle();
    expect(app.pages.map((p) => p.project)).toEqual(expect.arrayContaining(["p1", "p2"]));
    app.quit();
    await running;
  });

  test("a report that lands while idle is picked up by the poll", async () => {
    const term = fakeTerm();
    const orchs = fakeOrchestrators();
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 20 });
    const running = app.run("alpha");
    await settle();
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
});
