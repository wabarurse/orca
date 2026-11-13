import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { appFixture } from "../test/app-fixture";
import { paths } from "../config";
import { open } from "../core/data/transcripts";
import { App } from "./app";

const { fakeTerm, until } = appFixture();

test("the saved vim setting starts the TUI in Vim mode, and /vim saves each toggle", async () => {
  const project = "vim-setting"; mkdirSync(paths.project(project), { recursive: true });
  const record = open(paths.transcript(project, "orchestrator")), saved: boolean[] = [];
  const term = fakeTerm();
  const app = new App({ term, vim: true, saveVim: async on => { saved.push(on); },
    openOrchestrator: async () => ({ say: async () => {}, pending: async () => false, turn: async () => [], entries: () => record.history!() }) });
  const running = app.run(project);
  try {
    await until(() => term.screen().includes("[NORMAL]"));
    term.type("i/vim\r"); await until(() => saved.length === 1 && !term.screen().includes("[INSERT]"));
    term.type("/vim\r"); await until(() => saved.length === 2 && term.screen().includes("[NORMAL]"));
    expect(saved).toEqual([false, true]);
  } finally { app.quit(); await running; }
});
