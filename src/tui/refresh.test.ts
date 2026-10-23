import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, type AppDeps } from "./app";
import { FakeScreen } from "./testing";
import type { Terminal } from "./term";
import { createOrchestrator } from "../orchestrator";
import { loadConfig, paths, saveConfig } from "../config";
import { open } from "../transcript";
import { drain, pending, put } from "../inbox";
import { fakeProvider, text, toolUse } from "../test/fake-provider";
import { ask, skip, answer, all } from "../questions";
import { registerTask, setTaskAttention } from "../tasks";
import { setDisplayName, togglePin } from "../commands";
import { inputEpoch } from "../user-input";
import { tryStorageLock } from "../storage-lock";
import { projectTurnLock } from "../project-state";
import { saveProjectSettings } from "../project-settings";
import { Calls } from "./tools";

const previous = process.env.PARALLELS_HOME;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  if (previous === undefined) delete process.env.PARALLELS_HOME; else process.env.PARALLELS_HOME = previous;
});
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function until(check: () => boolean) {
  for (let i = 0; i < 300 && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
}
const raw = (app: App) => JSON.stringify(app.page?.lines);
async function setup(extra: Partial<AppDeps> = {}) {
  const home = mkdtempSync(join(tmpdir(), "tui-refresh-"));
  process.env.PARALLELS_HOME = home;
  await saveConfig({ model: "fake-model" });
  const screen = new FakeScreen(90, 28);
  const term: Terminal = { cols: 90, rows: 28, open() {}, close() {}, eraseOnExit() {}, onKey() {}, onResize() {}, write(s) { screen.write(s); } };
  const provider = fakeProvider([]);
  const app = new App({ term, pollMs: 100_000, projectModel: async () => "fake-model", agents: async () => [],
    watchdog: async () => {}, merges: async () => {}, questionDelayMs: 0,
    projects: { live: async () => [], kill: async () => {} },
    openOrchestrator: async (project, _url, write, onInbox, tools) => {
      mkdirSync(paths.repo(project), { recursive: true });
      const orch = await createOrchestrator({ project, provider, tools: {}, write, onInbox, ...tools });
      // This window submits/views but the tests explicitly choose the consumer.
      return { ...orch, turn: async () => [], pending: async () => false };
    }, ...extra });
  const running = app.run("a");
  await until(() => !!app.page);
  cleanups.push(async () => {
    await app.refreshSessions(); app.quit(); await running;
    for (const page of app.pages) await page.savingHistory;
    rmSync(home, { recursive: true, force: true });
  });
  const submit = async (text: string) => { app.input = { text, cursor: text.length }; await app.onKey({ name: "enter" }); };
  return { home, app, screen, provider, submit };
}

test("automatic refresh requests do not delay publication; cross-window exact-ID receipts clear only consumed previews and preserve drafts", async () => {
  const { app, submit, provider } = await setup();
  const page = app.page!, original = page.orch.refresh!;
  const held = deferred(), entered = deferred();
  let refreshCalls = 0;
  page.orch.refresh = async () => { refreshCalls++; entered.resolve(); await held.promise; return original(); };
  await submit("identical"); await entered.promise;
  const first = page.sent[0]!.inputId;
  await submit("identical");
  const second = page.sent[1]!.inputId;
  expect(second).not.toBe(first);
  const durable = await drain("a", "orchestrator");
  expect(durable.map(m => m.inputId)).toEqual([first, second]);
  // Re-publish ONLY the first message to simulate a consumer's snapshot boundary.
  await put("a", "orchestrator", durable[0]!);
  const remoteProvider = fakeProvider([[text("other window reply")]]);
  const remote = await createOrchestrator({ project: "a", provider: remoteProvider, tools: {}, write() {} });
  await remote.turn();
  app.input = { text: "new draft 界\nkeep cursor", cursor: 6 };
  held.resolve(); await app.refreshSessions();
  expect(refreshCalls).toBeGreaterThanOrEqual(1);
  expect(page.sent.map(m => m.inputId)).toEqual([second]); // missing file is NOT consumption
  expect(app.input).toEqual({ text: "new draft 界\nkeep cursor", cursor: 6 });
  expect(raw(app)).toContain("other window reply");
  expect(provider.calls).toHaveLength(0);
  expect(page.inputHistory).toContain("identical");
  expect(app.frame().queued?.texts).toEqual(["identical"]);
  await app.refreshSessions();
  expect(page.sent.map(m => m.inputId)).toEqual([second]);
  expect(raw(app).match(/other window reply/g)).toHaveLength(1);
});

test("manual refresh reconciles projects/pins, settings, tasks and closed questions without scheduling work or changing page/panels/drafts", async () => {
  let watchdogs = 0, live = false;
  const { app, submit, provider, screen } = await setup({ projectModel: undefined, watchdog: async () => { watchdogs++; }, agents: async () => live ? [{ name: "worker-existing", live: true }] : [] });
  const page = app.page!;
  const [q1, q2] = await ask("a", [{ text: "closed elsewhere" }, { text: "answered elsewhere" }]);
  await app.refreshSessions();
  expect(page.questions.open).toHaveLength(2); expect(page.questions.expanded).toBe(false);
  const task = await registerTask("a", { name: "Visible task", summary: "Persisted summary", branch: "feat/task", authorized: true });
  await app.commands.get("/inbox")!.run("", page);
  await setTaskAttention("a", task.id, { kind: "cancelled", reason: "must not resume" });
  await skip("a", q1!.id); await answer("a", q2!.id, "answer");
  await setDisplayName("a", "Shared display"); await togglePin("a");
  mkdirSync(paths.repo("b"), { recursive: true });
  await setDisplayName("b", "Second project");
  await saveConfig({ model: "gpt-5.5" });
  await saveProjectSettings("a", "gpt-5.5", { effort: "high" });
  live = true;
  app.input = { text: "retained task-panel draft", cursor: 4 };
  const epoch = inputEpoch("a");
  await app.commands.get("/refresh")!.run("", page);
  expect(app.page).toBe(page); expect(page.name).toBe("Shared display");
  expect(page.model).toBe("gpt-5.5"); expect(page.settings?.effort).toBe("high");
  expect(page.questions.open).toHaveLength(0);
  expect(page.questions.expanded).toBe(false);
  expect(app.frame().inbox?.section).toBe("tasks");
  expect(app.frame().inbox?.lines.join("\n")).toContain("cancelled");
  expect(app.input).toEqual({ text: "retained task-panel draft", cursor: 4 });
  expect(inputEpoch("a")).toBe(epoch);
  expect(await pending("a", "orchestrator")).toBe(true); // answer remains unconsumed
  expect(provider.calls).toHaveLength(0); expect(watchdogs).toBe(0);
  expect((await all("a")).map(q => q.status)).toEqual(["skipped", "answered"]);
  await app.onKey({ name: "escape" });
  await app.commands.get("/projects")!.run("", page);
  await app.refreshSessions();
  expect(app.frame().projects?.items.map(p => p.label)).toContain("Shared display");
  expect(app.frame().projects?.items[0]?.pinned).toBe(true);
  expect(app.frame().projects?.items.map(p => p.label)).toContain("Second project");
  await until(() => page.agentCount === 1);
  await Bun.sleep(25);
  expect(screen.screen().join("\n")).toContain("Shared display");
  // Running the literal command consumes only its command buffer, not a new draft typed during refresh.
  await app.onKey({ name: "escape" });
  await submit("/refresh");
  expect(provider.calls).toHaveLength(0);
});

test("refresh while a local tool is active is deferred, queued submissions remain ordered, then idle reconciliation is read-only", async () => {
  const started = deferred(), release = deferred();
  const provider = fakeProvider([[toolUse("tool", "wait", {})], [text("finished safely")]]);
  const { app, submit } = await setup({ openOrchestrator: async (project, _url, write, onInbox, events) => {
    mkdirSync(paths.repo(project), { recursive: true });
    return createOrchestrator({ project, provider, write, onInbox, ...events, tools: {
      wait: { spec: { name: "wait", input_schema: { type: "object" } }, async run() { started.resolve(); await release.promise; return "ok"; } },
    } });
  } });
  await submit("start"); await started.promise;
  const page = app.page!, calls = page.calls, lines = [...page.lines];
  await app.commands.get("/refresh")!.run("", page);
  expect(page.busy).toBe(true); expect(page.calls).toBe(calls); expect(page.lines).toEqual(lines);
  await submit("queued 1"); await submit("queued 2");
  expect(page.sent.map(m => m.text)).toEqual(["queued 1", "queued 2"]);
  app.input = { text: "draft while busy\nsecond line", cursor: 5 };
  release.resolve();
  await until(() => !page.busy);
  await app.refreshSessions();
  expect(page.sent).toHaveLength(0);
  expect(provider.calls).toHaveLength(2);
  expect(raw(app)).toContain("finished safely");
  expect(app.input).toEqual({ text: "draft while busy\nsecond line", cursor: 5 });
  expect(JSON.stringify(provider.calls[1]!.messages)).toContain("queued 1\\n\\n[user] queued 2");
});

test("failed refresh cannot fail an already published prompt, and a failed send cannot clear another identical input", async () => {
  const { app, submit, provider } = await setup();
  const page = app.page!, original = page.orch.say;
  page.orch.refresh = async () => { throw Error("refresh read failed"); };
  await submit("same");
  const id = page.sent[0]!.inputId;
  await app.refreshSessions();
  expect(await pending("a", "orchestrator")).toBe(true);
  expect(page.sent.map(m => m.inputId)).toEqual([id]);
  expect(raw(app)).toContain("refresh read failed");
  page.orch.say = async () => { throw Error("write failed"); };
  await expect(submit("same")).rejects.toThrow("write failed");
  expect(page.sent.map(m => m.inputId)).toEqual([id]);
  expect((await drain("a", "orchestrator")).map(m => m.inputId)).toEqual([id]);
  expect(provider.calls).toHaveLength(0);
  page.orch.say = original;
});

test("automatic polling clears consumption in another window, then processes new pending input after busy-to-idle", async () => {
  const { app, submit } = await setup({ pollMs: 15 });
  await submit("cross window");
  const remoteProvider = fakeProvider([[text("received elsewhere")]]);
  const remote = await createOrchestrator({ project: "a", provider: remoteProvider, tools: {}, write() {} });
  await remote.turn();
  // Input consumption may be observed before the remote reply is appended;
  // wait for both independent publications to reach the local view.
  await until(() => app.page!.sent.length === 0 && raw(app).includes("received elsewhere"));
  expect(raw(app)).toContain("received elsewhere");
  const provider = fakeProvider([[text("poll processed")]]);
  const real = await createOrchestrator({ project: "a", provider, tools: {}, write() {} });
  app.page!.orch = real;
  app.page!.busy = true;
  await put("a", "orchestrator", { from: "user", text: "new pending", inputId: "new" });
  await Bun.sleep(30);
  expect(provider.calls).toHaveLength(0);
  app.page!.busy = false;
  await until(() => provider.calls.length === 1 && !app.page!.busy);
  expect(real.consumed!().has("new")).toBe(true);
  await app.refreshSessions();
  expect(provider.calls).toHaveLength(1);
});

test("refresh restores full external history before the next local model turn and leaves active project drafts independent", async () => {
  const provider = fakeProvider([[text("local result")]]);
  const { app, submit } = await setup({ openOrchestrator: async (project, _url, write, onInbox, events) => {
    mkdirSync(paths.repo(project), { recursive: true });
    return createOrchestrator({ project, provider, tools: {}, write, onInbox, ...events });
  } });
  const a = app.page!;
  app.input = { text: "draft a", cursor: 2 };
  const b = await app.openPage("b"); app.input = { text: "draft b", cursor: 3 };
  const external = open(paths.transcript("a", "orchestrator"));
  for (let i = 0; i < 80; i++) await external.append({ type: "message", message: { role: "assistant", content: `external history ${i}` } });
  await app.refreshSessions();
  expect(app.page).toBe(b); expect(app.input).toEqual({ text: "draft b", cursor: 3 });
  expect(JSON.stringify(a.lines)).toContain("external history 0");
  app.switchPage(-1);
  expect(app.input).toEqual({ text: "draft a", cursor: 2 });
  await external.append({ type: "message", message: { role: "assistant", content: "newest external context" } });
  await submit("next turn"); await until(() => !a.busy);
  expect(JSON.stringify(provider.calls[0]!.messages)).toContain("newest external context");
  expect(raw(app)).toContain("newest external context"); expect(raw(app)).toContain("external history 0");
});


test("login-held submissions refresh immediately and retain original epochs, IDs and FIFO through release", async () => {
  const gate = deferred();
  const { app, submit, provider } = await setup({ login: async () => { await gate.promise; return "signed in"; } });
  const page = app.page!, refresh = page.orch.refresh!;
  let reads = 0;
  page.orch.refresh = async () => { reads++; return refresh(); };
  const signingIn = app.commands.get("/login")!.run("codex", page);
  try {
    await until(() => app.loggingIn);
    const originalEpoch = page.orch.submission!();
    await submit("held before cancel");
    await until(() => reads > 0);
    expect(await pending("a", "orchestrator")).toBe(false);
    page.orch.cancel!();
    const newEpoch = page.orch.submission!(), before = reads;
    await submit("held after cancel");
    await until(() => reads > before);
    expect(app.frame().queued?.texts).toEqual(["held before cancel", "held after cancel"]);
    app.input = { text: "new draft during sign-in", cursor: 4 };
    gate.resolve(); await signingIn;
    const messages = await drain("a", "orchestrator");
    expect(messages.map(m => m.text)).toEqual(["held before cancel", "held after cancel"]);
    expect(messages.map(m => m.userEpoch)).toEqual([originalEpoch, newEpoch]);
    expect(messages.map(m => m.inputId)).toEqual(page.sent.map(m => m.inputId));
    expect(new Set(messages.map(m => m.inputId)).size).toBe(2);
    expect(app.input).toEqual({ text: "new draft during sign-in", cursor: 4 });
    expect(provider.calls).toHaveLength(0);
  } finally { gate.resolve(); await signingIn; }
});

test("manual refresh preserves a scrolled history anchor, composer cursor and pinned header when external history grows", async () => {
  const { app, screen } = await setup();
  const external = open(paths.transcript("a", "orchestrator"));
  for (let i = 0; i < 50; i++) await external.append({ type: "message", message: { role: "assistant", content: `external row ${i}` } });
  await app.refreshSessions(); await Bun.sleep(30);
  await app.onKey({ name: "pageup" }); await Bun.sleep(30);
  const first = screen.screen().find(row => row.includes("external row"));
  expect(first).toBeDefined();
  app.input = { text: "scroll draft\nsecond line", cursor: 7 };
  for (let i = 50; i < 60; i++) await external.append({ type: "message", message: { role: "assistant", content: `external row ${i}` } });
  await app.commands.get("/refresh")!.run("", app.page); await Bun.sleep(30);
  expect(screen.screen().find(row => row.includes("external row"))).toBe(first);
  expect(app.input).toEqual({ text: "scroll draft\nsecond line", cursor: 7 });
  expect(screen.screen().slice(0, 3).join("\n")).toContain("fake-model");
  expect(raw(app)).toContain("external row 0"); expect(raw(app)).toContain("external row 59");
});


test("a turn that loses shared ownership cannot mark an unrendered snapshot as displayed", async () => {
  const provider = fakeProvider([]);
  const { app, submit } = await setup({ openOrchestrator: async (project, _url, write, onInbox, events) => {
    mkdirSync(paths.repo(project), { recursive: true });
    return createOrchestrator({ project, provider, tools: {}, write, onInbox, ...events });
  } });
  const page = app.page!, refresh = page.orch.refresh!;
  await open(paths.transcript("a", "orchestrator")).append({ type: "message", message: { role: "assistant", content: "external snapshot not yet rendered" } });
  // pending() can load this snapshot independently of the presentation refresh.
  await refresh();
  const release = await tryStorageLock(projectTurnLock("a"));
  expect(release).toBeDefined();
  const gate = deferred();
  page.orch.refresh = async () => { await gate.promise; return refresh(); };
  try {
    await submit("waiting for the other owner");
    await until(() => !page.busy);
    app.input = { text: "keep this draft", cursor: 4 };
    gate.resolve();
    await app.refreshSessions();
    expect(raw(app)).toContain("external snapshot not yet rendered");
    expect(page.sent.map(m => m.text)).toEqual(["waiting for the other owner"]);
    expect(app.input).toEqual({ text: "keep this draft", cursor: 4 });
    expect(provider.calls).toHaveLength(0);
  } finally {
    gate.resolve();
    page.orch.refresh = refresh;
    await release?.();
  }
});

const header = (screen: FakeScreen) => screen.screen().slice(0, 7).join("\n");

test("saved review limit starts at the default, commands keep all pages and agent views in sync", async () => {
  const { app, screen, submit } = await setup();
  await until(() => header(screen).includes("review rounds: 1"));
  await submit("/review-rounds");
  expect(raw(app)).toContain("review rounds: 1");
  await app.openPage("b");
  for (const n of [0, 100, 7]) {
    await submit(`/review-rounds ${n}`);
    expect((await loadConfig()).maxReviewRounds).toBe(n);
    await until(() => header(screen).includes(`review rounds: ${n}`));
    await app.openPage("a");
    await until(() => header(screen).includes(`review rounds: ${n}`));
    app.page!.view = { name: "reviewer-MixedCase", lines: [], calls: new Calls(), live: false, leave() {} };
    app.draw();
    await until(() => header(screen).includes("view reviewer-MixedCase"));
    expect(header(screen)).toContain(`review rounds: ${n}`);
    expect(header(screen)).toContain("ctx ?/?");
    app.page!.view = null;
    await app.openPage("b");
  }
  for (const arg of ["-1", "101", "1.5", "bad", "0100"]) {
    await submit(`/review-rounds ${arg}`);
    expect(raw(app)).toContain("usage: /review-rounds");
    expect((await loadConfig()).maxReviewRounds).toBe(7);
    expect(header(screen)).toContain("review rounds: 7");
  }
});

test("manual and passive refresh observe external saved review limits with existing config fallback rules", async () => {
  const { app, screen, submit } = await setup({ pollMs: 20 });
  await until(() => header(screen).includes("review rounds: 1"));
  await saveConfig({ maxReviewRounds: 0 });
  await until(() => header(screen).includes("review rounds: 0")); // real timer, no explicit refresh
  await saveConfig({ maxReviewRounds: 100 });
  await submit("/refresh");
  await until(() => header(screen).includes("review rounds: 100"));
  // Invalid persisted settings use loadConfig's existing default, also used by the command.
  await Bun.write(paths.config, 'model = "fake-model"\nmaxReviewRounds = 101\n');
  await app.refreshSessions(false);
  await until(() => header(screen).includes("review rounds: 1"));
  await submit("/review-rounds");
  expect(raw(app)).toContain("review rounds: 1");
});

test("review config is read once per refresh, never during paint or once per page", async () => {
  let reads = 0;
  const { app, screen } = await setup({ reviewLimit: async () => { reads++; return 8; } });
  await app.openPage("b");
  await until(() => header(screen).includes("review rounds: 8"));
  const before = reads;
  for (let i = 0; i < 100; i++) { app.frame(); app.draw(); }
  await Bun.sleep(30);
  expect(reads).toBe(before);
  await app.refreshSessions(false);
  expect(reads).toBe(before + 1);
});

test("unavailable or invalid review snapshots show unknown rather than an invented count, then recover", async () => {
  let state: number | Error = new Error("Fixture Read FAILED");
  const { app, screen } = await setup({ reviewLimit: async () => { if (state instanceof Error) throw state; return state; } });
  await until(() => header(screen).includes("review rounds: ?"));
  expect(raw(app)).toContain("review rounds refresh failed: Error: Fixture Read FAILED");
  for (const value of [9, NaN, 101, -1, 1.5, 0]) {
    state = value;
    await app.refreshSessions();
    const label = value === 9 || value === 0 ? String(value) : "?";
    await until(() => header(screen).includes(`review rounds: ${label}`));
  }
  state = new Error("Later Read FAILED");
  await app.refreshSessions();
  await until(() => header(screen).includes("review rounds: ?"));
  state = 1; // cleanup's refresh can succeed
});

for (const fail of [false, true]) test(`a stale pre-command review ${fail ? "failure" : "snapshot"} cannot replace a newer saved value`, async () => {
  let delayed: Promise<number> | undefined;
  const entered = deferred();
  const { app, screen, submit } = await setup({ reviewLimit: () => {
    if (delayed) entered.resolve();
    return delayed ?? loadConfig().then(c => c.maxReviewRounds);
  } });
  let release!: () => void;
  delayed = new Promise<number>((resolve, reject) => { release = () => fail ? reject(new Error("Old read FAILED")) : resolve(1); });
  // The getter captures the deferred read before the command starts saving.
  const refreshing = app.refreshSessions(false);
  try {
    await entered.promise;
    delayed = undefined;
    await submit("/review-rounds 0");
    await until(() => header(screen).includes("review rounds: 0"));
    release(); await refreshing;
    expect(header(screen)).toContain("review rounds: 0");
    expect((await loadConfig()).maxReviewRounds).toBe(0);
  } finally { delayed = undefined; release(); await refreshing; }
});

test("a failed review-rounds save never paints the requested value", async () => {
  const { app, screen, submit } = await setup();
  await submit("/review-rounds 7");
  await until(() => header(screen).includes("review rounds: 7"));
  rmSync(paths.config);
  mkdirSync(paths.config); // deterministic write failure, even when run as a privileged test user
  try {
    await expect(submit("/review-rounds 100")).rejects.toThrow();
    expect(header(screen)).toContain("review rounds: 7");
    expect(header(screen)).not.toContain("review rounds: 100");
    expect(raw(app)).not.toContain("review rounds set to 100");
  } finally {
    rmSync(paths.config, { recursive: true });
    await saveConfig({ model: "fake-model", maxReviewRounds: 7 });
  }
});
