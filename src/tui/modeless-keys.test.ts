import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { appFixture } from "../test/app-fixture";
import { paths } from "../config";
import { open } from "../core/data/transcripts";
import { App } from "./app";

const { fakeTerm, until } = appFixture();

function start(project: string, extra: Partial<ConstructorParameters<typeof App>[0]> = {}) {
  mkdirSync(paths.project(project), { recursive: true });
  const record = open(paths.transcript(project, "orchestrator"));
  const term = fakeTerm();
  const app = new App({ term, ...extra,
    openOrchestrator: async () => ({ say: async () => {}, pending: async () => false, turn: async () => [], entries: () => record.history!() }) });
  return { app, term, running: app.run(project) };
}

test("letters always type into the composer: no Normal or Insert mode and no /vim", async () => {
  const { app, term, running } = start("modeless-type");
  try {
    await until(() => !!app.page);
    term.type("jkHLq"); await until(() => term.screen().includes("> jkHLq"));
    expect(term.screen()).not.toMatch(/\[NORMAL\]|\[INSERT\]/);
    term.type("\x15/vim\r"); await until(() => term.screen().includes("unknown command"));
  } finally { app.quit(); await running; }
});

test("a menu moves with j/k and leaves the composer typing when it closes", async () => {
  const { app, term, running } = start("modeless-menu", {
    effortChoices: async () => ({ model: "claude-opus-5-5", current: "default", note: undefined, choices: [{ value: "default", label: "default", current: true }, { value: "high", label: "high" }] }),
  });
  try {
    await until(() => !!app.page);
    term.type("/effort\r"); await until(() => !!app.menu);
    term.type("j"); await until(() => app.menu?.index === 1);
    term.type("q"); await until(() => !app.menu);
    term.type("x"); await until(() => term.screen().includes("> x"));
  } finally { app.quit(); await running; }
});

test("Ctrl chords open each tab of the work page; q closes it", async () => {
  const { app, term, running } = start("modeless-chords");
  try {
    await until(() => !!app.page);
    for (const [chord, kind] of [["\x01", "agents"], ["\x14", "tasks"], ["\x11", "questions"], ["\x07", "images"], ["\x10", "processes"], ["\x02", "projects"]] as const) {
      term.type(chord); await until(() => app.work.state?.kind === kind);
      term.type("q"); await until(() => !app.work.open);
    }
    // On the page h/l move between tabs and q closes it.
    term.type("\x01l"); await until(() => app.work.state?.kind === "tasks");
    term.type("h"); await until(() => app.work.state?.kind === "agents");
    term.type("q"); await until(() => !app.work.open);
  } finally { app.quit(); await running; }
});

test("typing a letter while help is open closes help and types it", async () => {
  const { app, term, running } = start("modeless-help");
  try {
    await until(() => !!app.page);
    term.type("/help\r"); await until(() => app.frame().help !== null);
    term.type("j"); expect(app.frame().help).not.toBeNull(); // j/k scroll help
    term.type("w"); await until(() => app.frame().help === null && app.input.text === "w");
  } finally { app.quit(); await running; }
});
