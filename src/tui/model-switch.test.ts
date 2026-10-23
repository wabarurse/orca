import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, type AppDeps } from "./app";
import { parseKeys, type Key } from "./keys";
import type { Terminal } from "./term";
import { tmux } from "../runner";
import { setModel } from "../commands";
import { withProjectStateLock } from "../project-state";
import { effectiveModel } from "../project-model";
import { paths, saveConfig } from "../config";

const home = mkdtempSync(join(tmpdir(), "model-ui-"));
process.env.PARALLELS_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));
async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
}
async function setup(agents: { name: string; live: boolean }[], choices?: AppDeps["modelChoices"], extra: Partial<AppDeps> = {}) {
  await saveConfig({ model: "gpt-6-astra" });
  const project = `p-${crypto.randomUUID()}`;
  let key: (k: Key) => void = () => {};
  const writes: string[] = [];
  const opened: string[] = [];
  const term: Terminal = {
    cols: 160, rows: 40, write(s) { writes.push(s); }, open() {}, close() {}, eraseOnExit() {}, onResize() {}, onKey(cb) { key = cb; },
  };
  const app = new App({ term, pollMs: 100000, modelAgents: async () => agents.filter((a) => a.live).map((a) => a.name), modelChoices: choices,
    watchdog: async () => {}, merges: async () => {},
    openOrchestrator: async (id) => {
      opened.push(id);
      mkdirSync(paths.project(id), { recursive: true });
      return { say: async () => {}, pending: async () => false, turn: async () => [] };
    }, ...extra,
  });
  const running = app.run(project);
  await until(() => !!app.page);
  return { app, project, writes, opened, type(s: string) { for (const k of parseKeys(s)) key(k); }, key, async close() { app.quit(); await running; } };
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


function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const catalog = (id: string) => ({ choices: [{ value: id, label: id }], errors: [], current: "gpt-6-astra" });
const modelCommand = (ui: Awaited<ReturnType<typeof setup>>, id = "") => ui.app.commands.get("/models")!.run(id, ui.app.page);

for (const result of [null, "throw", [], ["shell", "worker-no-transcript", "reviewer-no-transcript"]] as const) {
  test(`production liveness boundary ${JSON.stringify(result)} ignores unreadable transcripts`, async () => {
    const windows = spyOn(tmux, "windows").mockImplementation(async () => {
      if (result === "throw") throw new Error("tmux unavailable");
      return result && [...result];
    });
    const ui = await setup([], undefined, { modelAgents: undefined });
    try {
      // ENOTDIR is an unreadable transcript directory, regardless of uid.
      await Bun.write(join(paths.project(ui.project), "transcripts"), "not a directory");
      ui.type("/models claude-test\r");
      if (result === null || result === "throw") {
        await until(() => ui.app.page!.lines.join("").includes("could not determine running agents; try again"));
        expect(await effectiveModel(ui.project)).toBe("gpt-6-astra");
      } else if (result.length) {
        await until(() => !!ui.app.menu);
        expect(ui.app.menu!.title).toContain("1 workers and 1 reviewers");
        expect(await effectiveModel(ui.project)).toBe("gpt-6-astra");
      } else {
        await until(() => ui.app.page!.lines.join("").includes("next model request"));
        expect(await effectiveModel(ui.project)).toBe("claude-test");
      }
    } finally { await ui.close(); windows.mockRestore(); }
  });
}

test("no-page /models real dispatch refuses without creating project/global write; survives reprint", async () => {
  const ui = await setup([]);
  try {
    ui.app.closePage();
    for (const command of ["/models", "/models claude-test"]) {
      ui.type(command + "\r");
      await until(() => ui.writes.join("").includes("open a project before changing its model"));
      expect(ui.app.pages).toHaveLength(0);
      expect(ui.opened).toHaveLength(1);
      expect(await effectiveModel("other")).toBe("gpt-6-astra");
      ui.app.reprint();
      await Bun.sleep(30);
      // An unchanged screen needs no repaint, and the notice stays available.
      expect(ui.writes.join("")).toContain("open a project before changing its model");
    }
  } finally { await ui.close(); }
});

for (const cancel of ["newer", "escape", "other-menu", "away-back", "close"] as const) {
  test(`deferred catalog is invalidated by ${cancel}`, async () => {
    const old = deferred<ReturnType<typeof catalog>>();
    let calls = 0;
    const ui = await setup([], () => ++calls === 1 ? old.promise : Promise.resolve(catalog("newer")));
    try {
      const pending = modelCommand(ui);
      if (cancel === "newer") await modelCommand(ui);
      if (cancel === "escape") ui.key({ name: "escape" });
      if (cancel === "other-menu") ui.app.openMenu("other menu", [{ value: 1, label: "other" }], () => {});
      if (cancel === "away-back") { await ui.app.openPage("another"); ui.app.switchPage(-1); }
      if (cancel === "close") ui.app.closePage();
      old.resolve(catalog("stale")); await pending;
      expect(ui.app.menu?.items.join("") ?? "").not.toContain("stale");
      if (cancel === "newer") expect(ui.app.menu!.items.join("")).toContain("newer");
      if (cancel === "other-menu") expect(ui.app.menu!.title).toContain("other menu");
      expect(await effectiveModel(ui.project)).toBe("gpt-6-astra");
    } finally { await ui.close(); }
  });
}

test("out-of-order liveness cannot save an older operation", async () => {
  const old = deferred<string[] | null>();
  let calls = 0;
  const ui = await setup([], undefined, { modelAgents: () => ++calls === 1 ? old.promise : Promise.resolve([]) });
  try {
    const pending = modelCommand(ui, "claude-old");
    await modelCommand(ui, "gpt-new");
    old.resolve([]); await pending;
    expect(await effectiveModel(ui.project)).toBe("gpt-new");
  } finally { await ui.close(); }
});

test("confirmed save belongs to captured project after close, and queued commits preserve invocation order", async () => {
  const ui = await setup([]);
  const gate = deferred<void>();
  const entered = deferred<void>();
  const lock = withProjectStateLock(ui.project, async () => { entered.resolve(); await gate.promise; });
  try {
    await entered.promise;
    const commits: string[] = [];
    // The injectable boundary records invocation, but production setModel owns the queue.
    const deps = (ui.app as unknown as { deps: AppDeps }).deps;
    deps.saveModel = (id, project, identity) => { commits.push(id); return setModel(id, project, identity); };
    const first = modelCommand(ui, "claude-first");
    await until(() => commits.length === 1);
    const second = modelCommand(ui, "gpt-last");
    await until(() => commits.length === 2);
    ui.app.closePage();
    gate.resolve(); await lock; await first; await second;
    expect(await effectiveModel(ui.project)).toBe("gpt-last");
    expect(ui.app.pages).toHaveLength(0);
  } finally { gate.resolve(); await ui.close(); }
});

test("effort/fast real command dispatch query, set, refuse and no-page feedback", async () => {
  const ui = await setup([]);
  const lines = () => ui.app.page!.lines.join("");
  try {
    ui.type("/effort\r"); await until(() => lines().includes("supported: default, low, medium, high, xhigh, max"));
    ui.type("/effort high\r"); await until(() => lines().includes("effort for gpt-6-astra: high"));
    await until(() => ui.writes.some(s => s.includes("effort high · fast off")));
    ui.type("/fast\r"); await until(() => lines().includes("fast for gpt-6-astra: off"));
    ui.type("/fast on\r"); await until(() => lines().includes("fast for gpt-6-astra: on"));
    await until(() => ui.writes.some(s => s.includes("effort high · fast on")));
    ui.type("/effort ultra\r"); await until(() => lines().includes("effort ultra is unsupported"));
    ui.type("/fast yes\r"); await until(() => lines().includes("usage: /fast"));
    ui.app.closePage();
    for (const cmd of ["/effort", "/fast on"]) {
      ui.type(cmd + "\r");
      await until(() => ui.writes.join("").includes("open a project before changing its model settings"));
      expect(ui.app.pages).toHaveLength(0);
      expect(ui.opened).toHaveLength(1);
    }
  } finally { await ui.close(); }
});

test("stopped turn UI explains explicit resume, model change does not rerun it", async () => {
  let queued = false;
  let turns = 0;
  const ui = await setup([], undefined, { openOrchestrator: async (project) => {
    mkdirSync(paths.project(project), { recursive: true });
    return { say: async () => { queued = true; }, pending: async () => queued, turn: async () => { queued = false; turns++; throw new Error("429 rate limit"); } };
  } });
  try {
    ui.type("task\r");
    await until(() => ui.app.page!.lines.join("").includes("send another message to resume with retained history"));
    await modelCommand(ui, "claude-test");
    expect(turns).toBe(1);
    expect(ui.app.page!.lines.join("")).toContain("failed/stopped turns need another message to resume");
  } finally { await ui.close(); }
});

test("confirmed UI save queued behind directory replacement refuses the new project", async () => {
  let saving!: () => void;
  const started = new Promise<void>((r) => { saving = r; });
  const ui = await setup([], undefined, { saveModel: (id, project, identity) => { saving(); return setModel(id, project, identity); } });
  const entered = deferred<void>();
  const release = deferred<void>();
  const replacement = withProjectStateLock(ui.project, async () => {
    entered.resolve(); await release.promise;
    rmSync(paths.project(ui.project), { recursive: true });
    mkdirSync(paths.project(ui.project));
  });
  try {
    await entered.promise;
    ui.type("/models claude-stale\r"); await started;
    release.resolve(); await replacement;
    await until(() => ui.app.page!.lines.join("").includes("project changed while switching model"));
    expect(await effectiveModel(ui.project)).toBe("gpt-6-astra");
  } finally { release.resolve(); await ui.close(); }
});

test("header uses the project's startup override and global fallback through the same accessor", async () => {
  let opened = 0;
  const ui = await setup([], undefined, { openOrchestrator: async (project) => {
    mkdirSync(paths.project(project), { recursive: true });
    if (!opened++) await Bun.write(join(paths.project(project), "model"), "claude-startup\n");
    return { async say() {}, async pending() { return false; }, async turn() { return []; } };
  } });
  try {
    expect(ui.app.page!.model).toBe("claude-startup");
    await until(() => ui.writes.some((s) => s.includes("claude-startup")));
    await ui.app.openPage("header-global-fallback");
    expect(ui.app.page!.model).toBe("gpt-6-astra");
    await until(() => ui.writes.some((s) => s.includes("model gpt-6-astra")));
  } finally { await ui.close(); }
});

for (const picker of [false, true]) test(`header changes only after confirmed ${picker ? "picker" : "direct"} save`, async () => {
  const ui = await setup([{ name: "worker-a", live: true }], async () => catalog("claude-header"));
  async function request() {
    await modelCommand(ui, picker ? "" : "claude-header");
    if (picker) { ui.type("\r"); await until(() => !!ui.app.menu?.title.includes("switch this project")); }
  }
  try {
    await request();
    expect(ui.app.page!.model).toBe("gpt-6-astra");
    ui.type("\r"); // Cancel default
    await until(() => !ui.app.menu);
    expect(ui.app.page!.model).toBe("gpt-6-astra");
    await request();
    ui.key({ name: "down" }); ui.type("\r");
    await until(() => ui.app.page!.model === "claude-header");
    await until(() => ui.writes.some((s) => s.includes(`model claude-header`)));
  } finally { await ui.close(); }
});

test("confirmed save refreshes captured page, not the selection changed while persistence awaited", async () => {
  const release = deferred<void>(), entered = deferred<void>();
  const ui = await setup([{ name: "worker-a", live: true }], undefined, { saveModel: async (id, project, identity) => {
    entered.resolve(); await release.promise;
    return setModel(id, project, identity);
  } });
  try {
    const captured = ui.app.page!;
    await modelCommand(ui, "claude-captured");
    ui.key({ name: "down" }); ui.type("\r");
    await entered.promise;
    const other = await ui.app.openPage("header-other-selection");
    release.resolve();
    await until(() => captured.model === "claude-captured");
    expect(ui.app.page).toBe(other);
    expect(other.model).toBe("gpt-6-astra");
    expect(await effectiveModel(captured.project)).toBe("claude-captured");
    expect(await effectiveModel(other.project)).toBe("gpt-6-astra");
    ui.app.switchPage(-1);
    await until(() => ui.writes.some((s) => s.includes(`model claude-captured`)));
  } finally { release.resolve(); await ui.close(); }
});
