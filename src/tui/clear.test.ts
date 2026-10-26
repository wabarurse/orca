import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, type AppDeps } from "./app";
import type { Terminal } from "./components/term";
import { FakeScreen } from "./components/testing";
import { Calls } from "./conversation/tools";
import { open } from "../core/data/transcripts/transcript";
import { createOrchestrator } from "../core/agent-loop/orc/orchestrator";
import { paths, saveConfig } from "../config/config";
import { put, drain } from "../core/data/inbox/inbox";
import { ask, all } from "../core/data/inbox/questions";
import { fakeProvider } from "../test/fake-provider";
import { withProjectStateLock } from "../core/data/projects/state";

const previous = process.env.ORCA_HOME;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); process.env.ORCA_HOME = previous; });
async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
}
async function setup(extra: Partial<AppDeps> = {}) {
  const home = mkdtempSync(join(tmpdir(), "clear-ui-"));
  process.env.ORCA_HOME = home;
  await saveConfig({ model: "unknown", compact: false });
  const project = "p";
  const t = open(paths.transcript(project, "orchestrator"));
  await t.append({ type: "message", message: { role: "user", content: "original UI history" } });
  const provider = fakeProvider([]);
  let resize = () => {};
  let exit = "", closed = false;
  const screen = new FakeScreen(100, 24);
  const term: Terminal = { cols: 100, rows: 24, write: s => { screen.write(s); if (closed) exit += s; }, onKey() {}, onResize(cb) { resize = cb; }, open() {}, close() { closed = true; }, eraseOnExit() {} };
  const app = new App({ term, pollMs: 100000, agents: async () => [], watchdog: async () => {}, merges: async () => {}, questionDelayMs: 0,
    openOrchestrator: async (project, _url, write, onInbox) => createOrchestrator({ project, provider, tools: {}, write, onInbox }), ...extra });
  const running = app.run(project);
  await until(() => !!app.page);
  cleanups.push(async () => { app.quit(); await running; rmSync(home, { recursive: true, force: true }); });
  const command = () => app.commands.get("/clear")!.run("", app.page);
  const context = () => open(t.path).chain();
  return { app, project, t, term, screen, provider, command, context, running, exit: () => exit,
    resize(cols: number, rows: number) { term.cols = cols; term.rows = rows; screen.resize(cols, rows); resize(); },
    confirm: async () => { await app.onKey({ name: "down" }); await app.onKey({ name: "enter" }); } };
}
const uiText = (app: App) => JSON.stringify(app.page?.lines);

test("bare /clear is local, cancel-default and excluded from recall; esc preserves drafts/history; explicit confirmation keeps exit transcript", async () => {
  const ui = await setup(), { app } = ui;
  const before = await Bun.file(ui.t.path).text();
  app.input = { text: "/clear", cursor: 6 };
  await app.onKey({ name: "enter" });
  expect(app.menu?.index).toBe(0);
  expect(app.menu?.items).toEqual(["cancel", "clear context"]);
  expect(app.page!.inputHistory).not.toContain("/clear");
  await app.onKey({ name: "enter" });
  expect(app.menu).toBeNull();
  expect(await Bun.file(ui.t.path).text()).toBe(before);
  app.input = { text: "draft 界", cursor: 5 };
  const lines = [...app.page!.lines];
  await ui.command();
  await until(() => ui.screen.text().includes("clear context"));
  const visible = ui.screen.screen().map(Bun.stripANSI);
  expect(visible.findIndex(row => row.includes("clear context"))).toBeGreaterThan(visible.findIndex(row => row.includes("0 messages queued")));
  for (const key of [{ name: "paste", text: "danger\n/quit" }, { name: "char", text: "y" }, { name: "q", ctrl: true }, { name: "g", ctrl: true }, { name: "enter", alt: true }]) await app.onKey(key);
  expect(app.input).toEqual({ text: "draft 界", cursor: 5 });
  await app.onKey({ name: "escape" });
  expect(app.input).toEqual({ text: "draft 界", cursor: 5 });
  expect(app.page!.lines).toEqual(lines);
  expect(await Bun.file(ui.t.path).text()).toBe(before);
  await ui.command(); await ui.confirm();
  expect(await ui.context()).toEqual([]);
  expect(uiText(app)).toContain("original UI history");
  expect(uiText(app)).toContain("model context cleared");
  expect(ui.provider.calls).toHaveLength(0);
  expect(open(ui.t.path).history!().map(e => e.type)).toEqual(["message", "context-boundary"]);
  expect(app.input).toEqual({ text: "draft 界", cursor: 5 });
  app.quit(); await ui.running;
  expect(ui.exit()).toContain("original UI history");
});

test("no arguments, no page creation, and worker/reviewer transcript views refuse", async () => {
  const ui = await setup(), { app } = ui;
  app.input = { text: "/clear yes", cursor: 10 };
  await app.onKey({ name: "enter" });
  expect(app.menu).toBeNull();
  expect(uiText(app)).toContain("unknown command /clear");
  expect(app.page!.inputHistory).not.toContain("/clear yes");
  for (const name of ["worker-a", "reviewer-a"]) {
    app.page!.view = { name, lines: [], leave() {}, live: false, calls: new Calls() };
    await ui.command();
    expect(app.menu).toBeNull();
    expect(JSON.stringify(app.page!.view.lines)).toContain("/back first");
  }
  app.page!.view = null;
  app.closePage();
  await ui.command();
  expect(app.pages).toHaveLength(0);
  expect(await ui.context()).toHaveLength(1);
});

test("busy, durable cancelled input, queued previews, and pending question answers all refuse", async () => {
  const ui = await setup(), { app } = ui, page = app.page!;
  page.busy = true; await ui.command(); expect(app.menu).toBeNull(); page.busy = false;
  page.sent.push({ inputId: "in-flight", text: "not durable yet" });
  await ui.command(); expect(app.menu).toBeNull();
  expect(app.frame().queued?.texts).toEqual(["not durable yet"]);
  page.sent.pop();
  for (const action of ["answer", "skip"] as const) {
    page.questions.closing = action; await ui.command(); expect(app.menu).toBeNull();
  }
  page.questions.closing = false;
  page.orch.cancel!();
  await put(ui.project, "orchestrator", { from: "worker-a", text: "paused report" });
  expect(await page.orch.pending()).toBe(false);
  await ui.command(); expect(app.menu).toBeNull();
  expect((await drain(ui.project, "orchestrator"))[0]?.text).toBe("paused report");
  expect(await ui.context()).toHaveLength(1);
  expect(ui.provider.calls).toHaveLength(0);
});

for (const change of ["busy", "sent", "inbox", "compact", "view", "recreated"]) test(`confirmation rechecks ${change} without clearing`, async () => {
  const ui = await setup(), { app } = ui, page = app.page!;
  await ui.command();
  expect(app.menu).not.toBeNull();
  if (change === "busy") page.busy = true;
  if (change === "sent") page.sent.push({ inputId: "new", text: "new queued" });
  if (change === "inbox") await put(ui.project, "orchestrator", { from: "user", text: "new durable" });
  if (change === "compact") await page.orch.compact!();
  if (change === "view") page.view = { name: "worker-a", lines: [], leave() {}, live: false, calls: new Calls() };
  if (change === "recreated") {
    rmSync(paths.project(ui.project), { recursive: true }); mkdirSync(paths.project(ui.project));
    await Bun.write(ui.t.path, "replacement must not change\n");
  }
  await ui.confirm();
  expect(app.menu).toBeNull();
  if (change === "recreated") expect(await Bun.file(ui.t.path).text()).toBe("replacement must not change\n");
  else expect(await ui.context()).toHaveLength(1);
  if (change === "inbox") expect((await drain(ui.project, "orchestrator"))[0]?.text).toBe("new durable");
  if (change === "sent") expect(app.frame().queued?.texts).toEqual(["new queued"]);
  page.busy = false;
  expect(ui.provider.calls).toHaveLength(0);
});

test("switching, closing/reopening the same project, and resize invalidate confirmation and its captured callback", async () => {
  const ui = await setup(), { app } = ui, first = app.page!;
  app.input = { text: "p draft", cursor: 2 };
  await app.openPage("other");
  app.input = { text: "other draft", cursor: 3 };
  app.switchPage(-1);
  expect(app.input.text).toBe("p draft");
  await ui.command(); const stale = app.menu!;
  await app.onKey({ name: "x", ctrl: true });
  expect(app.menu).toBeNull();
  expect(app.input.text).toBe("other draft");
  await stale.pick(1);
  expect(await ui.context()).toHaveLength(1);
  app.switchPage(-1);
  await ui.command(); const closed = app.menu!;
  app.closePage(); await app.openPage("p");
  expect(app.page).not.toBe(first);
  await closed.pick(1);
  expect(await ui.context()).toHaveLength(1);
  app.input = { text: "resize draft", cursor: 4 };
  await ui.command(); await app.onKey({ name: "down" });
  ui.resize(10, 3);
  expect(app.menu).toBeNull();
  expect(app.input).toEqual({ text: "resize draft", cursor: 4 });
  expect(await ui.context()).toHaveLength(1);
});

test("tiny hidden confirmation still owns typing and Escape, preserving chat and question drafts across clear", async () => {
  const ui = await setup(), { app } = ui, page = app.page!;
  app.input = { text: "chat draft", cursor: 4 };
  await ask(ui.project, [{ text: "Question?" }]);
  await app.questions.command(page);
  app.input = { text: "answer draft", cursor: 5 };
  ui.resize(8, 3);
  await ui.command();
  expect(app.menu).not.toBeNull();
  await app.onKey({ name: "paste", text: "wrong" });
  await app.onKey({ name: "escape" });
  expect(app.input).toEqual({ text: "answer draft", cursor: 5 });
  await ui.command(); await ui.confirm();
  expect(app.input).toEqual({ text: "answer draft", cursor: 5 });
  await app.onKey({ name: "escape" });
  expect(app.input).toEqual({ text: "chat draft", cursor: 4 });
  expect((await all(ui.project))[0]?.status).toBe("open");
  expect(await ui.context()).toEqual([]);
});

test("sign-in-held text and its delayed persistence remain visible and block clear", async () => {
  const login = Promise.withResolvers<string>(), persisted = Promise.withResolvers<void>();
  const ui = await setup({ login: async () => login.promise }), { app } = ui, page = app.page!;
  const signingIn = app.commands.get("/login")!.run("codex", page);
  app.input = { text: "held prompt", cursor: 11 }; await app.onKey({ name: "enter" });
  await ui.command(); expect(app.menu).toBeNull();
  expect(app.frame().queued?.texts).toEqual(["held prompt"]);
  const original = page.orch.say;
  page.orch.say = async (...args) => { await persisted.promise; return original(...args); };
  login.resolve("signed in");
  await until(() => page.sent.length === 1);
  await ui.command(); expect(app.menu).toBeNull();
  expect(app.frame().queued?.texts).toContain("held prompt");
  page.orch.cancel!(); // Preserve the queued message without running the fake provider.
  persisted.resolve(); await signingIn;
  expect((await drain(ui.project, "orchestrator"))[0]?.text).toBe("held prompt");
  expect(await ui.context()).toHaveLength(1);
  expect(ui.provider.calls).toHaveLength(0);
});

test("navigation cancels an authorized clear waiting on persistence, never retargeting another page", async () => {
  const ui = await setup(), { app } = ui;
  await app.openPage("other"); app.switchPage(-1);
  await ui.command();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const blocker = withProjectStateLock("p", async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  await app.onKey({ name: "down" });
  const saving = app.onKey({ name: "enter" });
  await app.onKey({ name: "x", ctrl: true });
  release.resolve(); await blocker; await saving;
  expect(app.page!.project).toBe("other");
  expect(await ui.context()).toHaveLength(1);
  expect(await open(paths.transcript("other", "orchestrator")).chain()).toEqual([]);
});

test("late eligibility results cannot open a confirmation after a page change; ctrl+c only cancels the local modal", async () => {
  const ui = await setup(), { app } = ui, page = app.page!;
  await app.openPage("other"); app.switchPage(-1);
  const release = Promise.withResolvers<void>();
  const check = page.orch.checkClear!;
  page.orch.checkClear = async () => { await release.promise; return check(); };
  const opening = ui.command();
  await app.onKey({ name: "x", ctrl: true });
  release.resolve(); await opening;
  expect(app.menu).toBeNull();
  expect(app.page!.project).toBe("other");
  app.switchPage(-1);
  app.input = { text: "keep draft", cursor: 4 };
  const submission = page.orch.submission!();
  await ui.command();
  await app.onKey({ name: "c", ctrl: true });
  expect(app.menu).toBeNull();
  expect(page.orch.submission!()).toBe(submission); // not global turn cancellation/pause
  expect(app.input).toEqual({ text: "keep draft", cursor: 4 });
  expect(await ui.context()).toHaveLength(1);
});
