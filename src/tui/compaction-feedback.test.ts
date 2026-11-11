import { expect, test } from "bun:test";
import { appFixture } from "../test/app-fixture";
import { App, type Clock } from "./app";
import type { OrchestratorActivity } from "../protocol";

const { fakeTerm, fakeOrchestrators, until, raw } = appFixture();

test("compaction uses persistent composer feedback, never fake thinking or conversation history", async () => {
  const term = fakeTerm(80, 25), fake = fakeOrchestrators(), ticks = new Set<() => void>();
  let now = 0, activity: OrchestratorActivity = { working: false, compacting: true };
  const clock: Clock = { now: () => now, every: fn => { ticks.add(fn); return () => { ticks.delete(fn); }; } };
  const app = new App({ term, clock, pollMs: 100000, openOrchestrator: async (...args) => ({
    ...await fake.openOrchestrator(args[0], args[1], args[2], args[3]),
    activity: () => args[0] === "compaction" ? activity : { working: false, compacting: false },
  }) });
  const running = app.run("compaction"), above = () => app.frame().inputArea!.lines.map(Bun.stripANSI).join("\n");
  try {
    await until(() => !!app.page && above().includes("Compacting…"));
    const page = app.page!;
    page.busy = true; app.draw(); // The daemon's maintenance turn is not a foreground request.
    expect(app.frame().activity).toBeUndefined();
    app.note("orchestrator: compaction requested; it runs at the next safe boundary");
    expect(above()).not.toContain("requested");
    const first = above(); now = 120; ticks.forEach(tick => tick()); expect(above()).not.toBe(first);
    term.type("my draft"); expect(above()).toContain("Compacting…"); expect(app.input.text).toBe("my draft");
    app.note("other notice"); expect(above()).toContain("other notice"); expect(above()).toContain("Compacting…");
    term.type("!"); expect(above()).not.toContain("other notice"); expect(above()).toContain("Compacting…");
    activity = { working: true, compacting: true }; app.draw();
    expect(Bun.stripANSI(app.frame().activity!)).toContain("thinking"); // Concurrent foreground work still has its own activity.
    await app.openPage("other"); expect(above()).not.toContain("Compacting…");
    app.active = 0; app.reprint(); expect(above()).toContain("Compacting…");
    activity = { working: false, compacting: false }; page.busy = false;
    app.note("compaction complete: ~302194 → ~65368 history tokens; recent messages unchanged.", page);
    expect(above()).not.toContain("Compacting…"); expect(above()).toContain("Compacted 302k → 65k");
    term.type("x"); app.draw(); expect(above()).not.toContain("Compacted");
    expect(page.lines.map(raw).join("\n")).not.toMatch(/Compacted|Compacting|thinking/);
    expect(ticks.size).toBe(0);
  } finally { app.quit(); await running; }
});
