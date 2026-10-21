import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, type AppDeps } from "./app";
import { parseKeys, type Key } from "./keys";
import type { Terminal } from "./term";
import { effectiveModel } from "../project-model";
import { paths, saveConfig } from "../config";

const home = mkdtempSync(join(tmpdir(), "model-ui-"));
process.env.PARALLELS_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));
async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
}
async function setup(agents: { name: string; live: boolean }[], choices?: AppDeps["modelChoices"]) {
  await saveConfig({ model: "gpt-6-astra" });
  const project = `p-${crypto.randomUUID()}`;
  let key: (k: Key) => void = () => {};
  const term: Terminal = {
    cols: 160, rows: 40, write() {}, open() {}, close() {}, eraseOnExit() {}, onResize() {}, onKey(cb) { key = cb; },
  };
  const app = new App({ term, pollMs: 100000, agents: async () => agents, modelChoices: choices,
    watchdog: async () => {}, merges: async () => {},
    openOrchestrator: async (id) => {
      mkdirSync(paths.project(id), { recursive: true });
      return { say: async () => {}, pending: async () => false, turn: async () => [] };
    },
  });
  const running = app.run(project);
  await until(() => !!app.page);
  return { app, project, type(s: string) { for (const k of parseKeys(s)) key(k); }, key, async close() { app.quit(); await running; } };
}

test("direct switch counts only live subagents; Cancel and Escape never persist; Switch all saves project only", async () => {
  const ui = await setup([{ name: "worker-a", live: true }, { name: "worker-b", live: false }, { name: "reviewer-a", live: true }]);
  try {
    await ui.app.commands.get("/models")!.run("claude-test", ui.app.page);
    expect(ui.app.menu!.title).toContain("1 workers and 1 reviewers");
    expect(await effectiveModel(ui.project)).toBe("gpt-6-astra");
    ui.type("\r"); // safe default Cancel
    await until(() => !ui.app.menu);
    expect(await effectiveModel(ui.project)).toBe("gpt-6-astra");
    await ui.app.commands.get("/models")!.run("claude-test", ui.app.page);
    ui.key({ name: "escape" });
    await until(() => !ui.app.menu);
    expect(await effectiveModel(ui.project)).toBe("gpt-6-astra");
    await ui.app.commands.get("/models")!.run("claude-test", ui.app.page);
    ui.key({ name: "down" }); ui.type("\r");
    await until(() => ui.app.page!.lines.some((line) => typeof line === "string" && line.includes("next model request")));
    expect(await effectiveModel(ui.project)).toBe("claude-test");
    expect(await effectiveModel("other-project")).toBe("gpt-6-astra");
  } finally { await ui.close(); }
});

test("picker uses the same immediate path when no subagents run", async () => {
  const ui = await setup([{ name: "worker-old", live: false }], async () => ({ choices: [{ value: "claude-test", label: "Claude" }], errors: [], current: "gpt-6-astra" }));
  try {
    await ui.app.commands.get("/models")!.run("", ui.app.page);
    ui.type("\r");
    await until(() => ui.app.page!.lines.some((line) => typeof line === "string" && line.includes("next model request")));
    expect(await effectiveModel(ui.project)).toBe("claude-test");
    expect(ui.app.menu).toBeNull();
  } finally { await ui.close(); }
});

test("async picker and stale confirmation cannot switch a different selected page", async () => {
  let release!: (value: Awaited<ReturnType<NonNullable<AppDeps["modelChoices"]>>>) => void;
  const ui = await setup([{ name: "worker-a", live: true }], () => new Promise((r) => { release = r; }));
  try {
    const original = ui.app.page!;
    const fetching = ui.app.commands.get("/models")!.run("", original);
    ui.app.pages.push({ ...original, project: "other" }); ui.app.active = 1;
    release({ choices: [{ value: "claude-test", label: "Claude" }], errors: [], current: "gpt-6-astra" });
    await fetching;
    expect(ui.app.menu).toBeNull();
    ui.app.active = 0;
    await ui.app.commands.get("/models")!.run("claude-test", original);
    ui.app.active = 1;
    ui.key({ name: "down" }); ui.type("\r");
    await until(() => !ui.app.menu);
    expect(await effectiveModel(ui.project)).toBe("gpt-6-astra");
    expect(await effectiveModel("other")).toBe("gpt-6-astra");
  } finally { await ui.close(); }
});
