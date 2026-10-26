import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, type AppDeps } from "./app";
import { FakeScreen } from "./testing";
import type { Terminal } from "./term";
import type { Orchestrator } from "../orchestrator";
import { paths, saveConfig } from "../config";

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

async function setup(extra: Partial<AppDeps> = {}) {
  const home = mkdtempSync(join(tmpdir(), "tui-daemon-"));
  process.env.ORCA_HOME = home;
  await saveConfig({ model: "fake-model" });
  const screen = new FakeScreen(90, 28);
  const term: Terminal = { cols: 90, rows: 28, open() {}, close() {}, eraseOnExit() {}, onKey() {}, onResize() {}, write(s) { screen.write(s); } };
  const calls: string[] = [];
  const app = new App({ term, pollMs: 30, projectModel: async () => "fake-model", agents: async () => [], questionDelayMs: 0,
    projects: { live: async () => [], kill: async () => {} },
    openOrchestrator: async (project) => { mkdirSync(paths.repo(project), { recursive: true }); return clientStub(calls); }, ...extra });
  const running = app.run("a");
  await until(() => !!app.page);
  cleanups.push(async () => { app.quit(); await running; rmSync(home, { recursive: true, force: true }); });
  return { app, calls };
}

test("opening a page starts ensuring its daemon without blocking the page, shows what the keeper did, and every poll keeps it alive", async () => {
  const ensured: string[] = [];
  let line: string | undefined = "orchestrator started";
  const { app, calls } = await setup({ ensureDaemon: async project => { ensured.push(project); const l = line; line = undefined; return l; } });
  expect(ensured[0]).toBe("a");
  await until(() => text(app).includes("orchestrator started"));
  await until(() => ensured.length >= 3); // the poll
  expect(text(app).match(/orchestrator started/g)).toHaveLength(1);
  await app.openPage("b");
  expect(ensured).toContain("b");
  expect(calls.filter(c => c === "turn")).toEqual([]); // nothing ran in-process
  // Quitting the TUI leaves the daemon alone: no cancel, only dispose (checked by the cleanup below).
});

test("a keeper failure is reported on the page and retried on later polls; quitting never cancels the daemon's turn", async () => {
  let fail = true;
  const attempts: number[] = [];
  const { app, calls } = await setup({ ensureDaemon: async () => { attempts.push(Date.now()); if (fail) throw new Error("tmux not found"); return undefined; } });
  await until(() => text(app).includes("orchestrator is not running: tmux not found"));
  await until(() => attempts.length > 3);
  expect(text(app).match(/tmux not found/g)).toHaveLength(1); // the same failure is not repeated every poll
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
  const { app, calls } = await setup({ saveModel: async id => `model set to ${id}` });
  await app.commands.get("/models")!.run("claude-opus-5-5", app.page);
  await until(() => calls.includes("model claude-opus-5-5"));
  await until(() => text(app).includes("orchestrator: model claude-opus-5-5 applies"));
});
