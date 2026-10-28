import { expect, test } from "bun:test";
import { App, type ToolEvents } from "./app";
import type { Entry } from "../protocol";
import { appFixture } from "../test/app-fixture";

const { fakeTerm, fakeOrchestrators, until } = appFixture();
const request = (uuid: string): Entry => ({ uuid, parentUuid: null, ts: "", type: "model-request",
  requestId: uuid, provider: "anthropic", model: "m", stage: "completed", startedAt: "x", updatedAt: "y" });
const note = (app: App) => Bun.stripANSI(app.frame().inputArea!.lines.join("\n"));

test("saved diagnostics never become notifications on startup, refresh, clear, or reopening; live feedback displays once", async () => {
  const term = fakeTerm(100), orchs = fakeOrchestrators();
  const entries: Entry[] = [request("old")];
  let events: ToolEvents;
  const app = new App({ term, pollMs: 100_000, openOrchestrator: async (project, url, write, inbox, tools) => {
    events = tools!;
    return { ...await orchs.openOrchestrator(project, url, write, inbox), entries: () => [...entries], refresh: async () => true };
  } });
  const running = app.run("status");
  try {
    await until(() => !!app.page);
    expect(note(app)).not.toContain("model request");
    expect(app.page!.lines).toEqual([]);
    events!.notice!("[model request] anthropic/m completed; started x; updated y");
    await until(() => term.screen().includes("model request"));
    term.type("a");
    expect(note(app)).not.toContain("model request");
    // The live event's saved record can arrive after the user dismissed it.
    entries.push(request("just-displayed"));
    events!.onRefresh!();
    await app.refreshSessions();
    expect(note(app)).not.toContain("model request");
    entries.push({ uuid: "reply", parentUuid: null, ts: "", type: "message", message: { role: "assistant", content: "actual answer" } });
    await app.refreshSessions();
    expect(JSON.stringify(app.page!.lines)).toContain("actual answer");
    expect(note(app)).not.toContain("model request");
    app.closePage(); await app.openPage("status");
    expect(note(app)).not.toContain("model request");
    events!.notice!("new live feedback");
    expect(note(app)).toContain("new live feedback");
    term.type("b");
    entries.push({ uuid: "clear", parentUuid: null, ts: "", type: "context-boundary" }, request("after-clear"));
    await app.refreshSessions();
    expect(app.page!.lines).toEqual([]);
    expect(note(app)).not.toContain("model request");
    expect(note(app)).not.toContain("new live feedback");
  } finally { app.quit(); await running; }
});

test("typing before the next frame dismisses feedback without requiring it to be rendered first", async () => {
  const term = fakeTerm(100), orchs = fakeOrchestrators();
  const app = new App({ term, pollMs: 100_000, openOrchestrator: orchs.openOrchestrator });
  const running = app.run("status-input");
  try {
    await until(() => !!app.page);
    app.note("queued frame notice");
    term.type("x"); // No frame() read or timer yield between the event and input.
    expect(note(app)).not.toContain("queued frame notice");
    expect(app.input.text).toBe("x");
    await Bun.sleep(40);
    expect(term.screen()).not.toContain("queued frame notice");
  } finally { app.quit(); await running; }
});
