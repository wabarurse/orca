import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, type AppDeps } from "./app";
import { FakeScreen } from "./components/testing";
import type { Terminal } from "./components/term";
import { createOrchestrator, type Orchestrator } from "../core/agent-loop/orc/orchestrator";
import { paths, saveConfig } from "../config/config";
import type { CompleteRequest } from "../providers/provider";
import { publishLaunch } from "../core/tmux/cancellation";
import { createClientOrchestrator } from "../core/agent-loop/orc/client";
import { readStatus, request } from "../core/agent-loop/orc/channel";
import { runDaemon, windowHooks } from "../core/agent-loop/orc/daemon";
import { liveWriter } from "../core/agent-loop/orc/live";
import { tryStorageLock } from "../core/data/storage-lock";
import { fakeProvider, text as textBlock, toolUse } from "../test/fake-provider";
import type { Tool } from "../core/tools/registry";
import { open } from "../core/data/transcripts/transcript";

// The TUI as a client: it keeps each open project's orchestrator daemon alive
// through the injected keeper, and never runs a turn itself.

const previous = process.env.ORCA_HOME;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  if (previous === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = previous;
});
async function until(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
}
const strip = (s: string) => s.replace(/\x1b\[[0-9;?<>]*[A-Za-z]/g, "");
const text = (app: App) => (app.page?.lines ?? []).map(l => typeof l === "string" ? strip(l) : JSON.stringify(l)).join("\n");
/** The transient status note above the composer, if any. */
const note = (app: App) => strip(app.frame().inputArea!.lines.join("\n"));

/** An orchestrator that records what the TUI asks of it; `turn` here stands for following, never a model call. */
function clientStub(calls: string[]): Orchestrator {
  return {
    async say(t) { calls.push(`say ${t}`); },
    async pending() { return false; },
    async turn() { calls.push("turn"); return []; },
    cancel() { calls.push("cancel"); },
    async compact() { calls.push("compact"); },
    async observeModel(model) { calls.push(`model ${model}`); return `model ${model} applies from the orchestrator's next request`; },
    dispose() { calls.push("dispose"); },
  };
}

/** An App on the current home; quitting it is queued for the test's cleanup. */
async function openApp(extra: Partial<AppDeps> = {}) {
  const screen = new FakeScreen(90, 28);
  const term: Terminal = { cols: 90, rows: 28, open() {}, close() {}, eraseOnExit() {}, onKey() {}, onResize() {}, write(s) { screen.write(s); } };
  const calls: string[] = [];
  const app = new App({ term, pollMs: 30, projectModel: async () => "fake-model", agents: async () => [], questionDelayMs: 0,
    projects: { live: async () => [], kill: async () => {} },
    openOrchestrator: async (project) => { mkdirSync(paths.repo(project), { recursive: true }); return clientStub(calls); }, ...extra });
  const running = app.run("a");
  await until(() => !!app.page);
  cleanups.push(async () => { app.quit(); await running; });
  return { app, calls };
}
async function setup(extra: Partial<AppDeps> = {}) {
  const home = mkdtempSync(join(tmpdir(), "tui-daemon-"));
  process.env.ORCA_HOME = home;
  await saveConfig({ model: "fake-model" });
  cleanups.push(async () => { rmSync(home, { recursive: true, force: true }); });
  return openApp(extra);
}

test("opening a page starts ensuring its daemon without blocking the page, shows what the keeper did, and every poll keeps it alive", async () => {
  const ensured: string[] = [];
  let line: string | undefined = "orchestrator was not running; restarted"; // the keeper's first start is silent: only a restart is noted
  const { app, calls } = await setup({ ensureDaemon: async project => { ensured.push(project); const l = line; line = undefined; return l; } });
  expect(ensured[0]).toBe("a");
  await until(() => note(app).includes("orchestrator was not running; restarted")); // a transient note, not conversation
  await until(() => ensured.length >= 3); // the poll
  expect(text(app)).not.toContain("restarted");
  // Every restart is noted, even one that repeats the last outcome after a key cleared it (the keeper rate-limits restarts).
  for (let i = 0; i < 2; i++) {
    await app.onKey({ name: "char", text: "x" });
    expect(note(app)).not.toContain("orchestrator");
    line = "orchestrator was not running; restarted";
    await until(() => note(app).includes("orchestrator was not running; restarted"));
  }
  expect(text(app)).not.toContain("restarted");
  await app.openPage("b");
  expect(ensured).toContain("b");
  expect(calls.filter(c => c === "turn")).toEqual([]); // nothing ran in-process
  // Quitting the TUI leaves the daemon alone: no cancel, only dispose (checked by the cleanup below).
});

test("a keeper failure is reported on the page and retried on later polls; quitting never cancels the daemon's turn", async () => {
  let fail = true;
  const attempts: number[] = [];
  const { app, calls } = await setup({ ensureDaemon: async () => { attempts.push(Date.now()); if (fail) throw new Error("tmux not found"); return undefined; } });
  await until(() => note(app).includes("orchestrator unavailable: tmux not found"));
  await until(() => attempts.length > 3);
  expect(note(app).match(/tmux not found/g)).toHaveLength(1); // the same failure is not repeated every poll
  fail = false;
  const before = attempts.length;
  await until(() => attempts.length > before + 1);
  app.page!.busy = true; // a turn being followed
  app.quit();
  await Bun.sleep(20);
  expect(calls).not.toContain("cancel");
  expect(calls).toContain("dispose");
});

test("without a keeper (tests, legacy), pages open and the model acknowledgement still goes through the client", async () => {
  const { app, calls } = await setup({ saveModel: async id => `model set to ${id}`, modelAgents: async () => [],
    modelChoices: async () => ({ choices: [{ value: "claude-opus-5-5", label: "claude-opus-5-5" }], errors: [], current: "" }) });
  await app.commands.get("/model")!.run("all", app.page); // all agents skips the scope step; there is no id argument
  await app.onKey({ name: "enter" });
  await until(() => calls.includes("model claude-opus-5-5"));
  await until(() => note(app).includes("orchestrator: model claude-opus-5-5 applies"));
  expect(text(app)).not.toContain("model claude-opus-5-5");
});

test("the daemon's cancel acknowledgement and compaction progress are transient notes (the ack replaces ctrl+c's hint); failures use the same row; a second ctrl+c still exits", async () => {
  let notice!: (text: string) => void;
  let closed = false;
  const calls: string[] = [];
  const screen = new FakeScreen(90, 28);
  const term: Terminal = { cols: 90, rows: 28, open() {}, close() { closed = true; }, eraseOnExit() {}, onKey() {}, onResize() {}, write(s) { screen.write(s); } };
  let now = 1000;
  const { app } = await setup({ term, clock: { now: () => now, every: () => () => {} }, openOrchestrator: async (project, _url, _write, _inbox, tools) => {
    mkdirSync(paths.repo(project), { recursive: true });
    notice = tools!.notice!;
    const stub = clientStub(calls);
    // As the client does: the request goes out at once, the daemon's answer comes later.
    return { ...stub, cancel() { stub.cancel!(); setTimeout(() => notice("orchestrator: turn cancelled; the orchestrator stays paused until you send a message"), 10); } };
  } });
  const page = app.page!;
  await app.onKey({ name: "c", ctrl: true });
  expect(calls).toContain("cancel");
  expect(note(app)).toContain("turn cancelled. send a message to resume; press ctrl+c again within 2 seconds to exit.");
  await until(() => note(app).includes("orchestrator: turn cancelled; the orchestrator stays paused until you send a message"));
  expect(note(app)).not.toContain("press ctrl+c again"); // replaced, one row
  expect(page.lines).toEqual([]);
  for (const line of ["compacting…", "compacting older conversation in the background…", "compaction complete: ~9000 → ~2000 history tokens; recent messages unchanged.", "background summary did not reduce context; original history kept.", "orchestrator: compaction requested; it runs at the next safe boundary"]) {
    notice(line);
    expect(note(app)).toContain(line);
    expect(page.lines).toEqual([]);
  }
  await app.onKey({ name: "char", text: "x" }); // the next key clears the note
  expect(note(app)).not.toContain("compaction");
  for (const line of ["compaction failed: summary exceeds output budget", "background compaction failed; original history kept: rolling summary timed out", "orchestrator: turn failed: boom; send another message to resume with retained history", "cancel not acknowledged: daemon gone"]) {
    notice(line);
    expect(note(app)).toContain(line.slice(0, 70));
    expect(text(app)).toBe("");
  }
  await app.commands.get("/refresh")!.run("", page);
  expect(text(app)).toBe("");
  await app.onKey({ name: "char", text: "y" });
  expect(note(app)).not.toContain("daemon gone");
  expect(closed).toBe(false);
  now += 5000;
  await app.onKey({ name: "c", ctrl: true }); // long after the last press: the first press again
  expect(note(app)).toContain("press ctrl+c again");
  expect(closed).toBe(false);
  now += 1999;
  await app.onKey({ name: "c", ctrl: true });
  await until(() => closed);
  expect(calls.filter(c => c === "cancel")).toHaveLength(2);
});

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
const occurrences = (s: string, needle: string) => s.split(needle).length - 1;

test("a page following a daemon turn shows its streamed text, running and finished tools as the in-process turn did, and each durable entry replaces what the live events showed, never doubling it", async () => {
  const gates = { look: deferred(), ing: deferred(), tool: deferred(), done: deferred() };
  const echo: Tool = { spec: { name: "echo", description: "echo", input_schema: { type: "object", properties: {} } }, run: async () => { await gates.tool.promise; return "one\ntwo\nthree"; } };
  const provider = fakeProvider([]);
  provider.complete = async (req: CompleteRequest) => {
    provider.calls.push({ messages: req.messages, tools: [] });
    if (provider.calls.length === 1) {
      req.onText("Look"); await gates.look.promise; req.onText("ing closely"); await gates.ing.promise;
      return { completion: "end_turn", content: [textBlock("Looking closely"), toolUse("t1", "echo", { what: "it" })], stop: "tool_use" as const };
    }
    req.onText("All done"); await gates.done.promise;
    return { completion: "end_turn", content: [textBlock("All done")], stop: "end" as const };
  };
  let daemon: Promise<unknown> | undefined, release: (() => Promise<void>) | undefined, session: Orchestrator | undefined;
  // What `orca start` does: the page's orchestrator is a client of the project's daemon (run here, in-process).
  const asClient: AppDeps["openOrchestrator"] = (project, _url, write, _onInbox, tools) =>
    createClientOrchestrator({ project, followMs: 10, graceMs: 2000, onRefresh: tools?.onRefresh, notice: tools?.notice, write, onTool: tools?.onTool, onToolResult: tools?.onToolResult });
  const { app } = await setup({ openOrchestrator: async (project, ...rest) => {
    mkdirSync(paths.repo(project), { recursive: true });
    const transcript = open(paths.transcript(project, "orchestrator"));
    const live = liveWriter({ project, run: "run-t", head: () => transcript.head(), log() {} });
    session = await createOrchestrator({ project, provider, tools: { echo }, transcript, ...windowHooks(live, () => {}) });
    release = (await tryStorageLock(paths.daemonLock(project), project))!;
    publishLaunch(project, "orchestrator", "run-t");
    daemon = runDaemon({ project, run: "run-t", session, live, log() {}, watchers: { watchdog: async () => {}, merges: async () => {} }, sleep: () => Bun.sleep(20) });
    return asClient(project, ...rest);
  } });
  cleanups.push(async () => { for (const g of Object.values(gates)) g.resolve(); await request("a", { kind: "stop" }); await daemon; await release?.(); session?.dispose?.(); });
  await until(() => readStatus("a")?.state === "idle");
  const page = app.page!;
  app.input = { text: "hello", cursor: 5 };
  await app.onKey({ name: "enter" });
  // The partial reply streams into the live region, after the user's line landed from the transcript.
  await until(() => app.frame().partial === "Look");
  expect(text(app)).toContain("hello");
  expect(page.busy).toBe(true);
  gates.look.resolve();
  await until(() => app.frame().partial === "Looking closely");
  expect(occurrences(text(app), "Looking closely")).toBe(0);
  gates.ing.resolve();
  // The reply is durable and the call runs: the text moved from the live region into history once; the call's row shimmers below,
  // and the record's call without a result is not drawn as interrupted above it.
  await until(() => page.calls.size === 1);
  expect(app.frame().partial).toBe("");
  expect(occurrences(text(app), "Looking closely")).toBe(1);
  const midTool = (a: App) => {
    expect(strip((a.frame().running ?? []).join("\n"))).toContain("echo(it)");
    expect(occurrences(text(a), "echo(")).toBe(0);
    expect(text(a)).not.toContain("interrupted");
  };
  midTool(app);
  // A second TUI opens on the project now: it restores the durable record (the reply, the call left out as running), then replays the live file (the running call) and tails it.
  const { app: again } = await openApp({ openOrchestrator: asClient });
  const reopened = again.page!;
  expect(text(again)).not.toContain("interrupted"); // from the first paint: the daemon's turn is running
  await until(() => reopened.busy && reopened.calls.size === 1);
  expect(occurrences(text(again), "Looking closely")).toBe(1);
  expect(text(again)).toContain("hello");
  expect(again.frame().partial).toBe("");
  midTool(again);
  gates.tool.resolve();
  // The finished call's line and summary appear once, whether the live event or the durable result drew them.
  await until(() => app.frame().partial === "All done" && again.frame().partial === "All done");
  expect(page.calls.size).toBe(0);
  expect(occurrences(text(again), "echo(")).toBe(1);
  expect(occurrences(text(app), "echo(")).toBe(1);
  expect(occurrences(text(app), '"summary":"one"')).toBe(1);
  expect(occurrences(text(app), "Looking closely")).toBe(1);
  gates.done.resolve();
  await until(() => !page.busy && !reopened.busy);
  for (const a of [app, again]) {
    expect(a.frame().partial).toBe("");
    expect(occurrences(text(a), "All done")).toBe(1);
    expect(occurrences(text(a), "Looking closely")).toBe(1);
    expect(occurrences(text(a), "echo(")).toBe(1);
    expect(text(a)).not.toContain("interrupted");
  }
  expect(text(app)).toBe(text(again)); // both pages show the same conversation
  expect(provider.calls).toHaveLength(2);
});
