import { afterEach, expect, test } from "bun:test";
import { App } from "../app";
import type { TaskRow } from "../../protocol/task";
import { appFixture } from "../../test/app-fixture";
import { TaskCounts } from "./task-count";

const { fakeTerm, fakeOrchestrators, until } = appFixture();
const row = (id: string, archived = false): TaskRow => ({ id, name: id, summary: "s", branch: `feat/${id}`, status: "working", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  ...(archived ? { archive: { reason: "merged", mergedAt: "2026-01-02T00:00:00Z", archivedAt: "2026-01-02T00:00:00Z", pr: { repository: "o/r", number: 1, url: "https://github.com/o/r/pull/1" } } } : {}) } as TaskRow);
const deferred = <T>() => { let resolve!: (v: T) => void, reject!: (e: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });

test("unknown until read, counts unarchived rows, single-flight, failure is ? not 0, closed pages ignored, redraw only on change", async () => {
  const page = {}, reads: ReturnType<typeof deferred<TaskRow[]>>[] = [];
  let open = true, draws = 0;
  const counts = new TaskCounts<object>(() => { const d = deferred<TaskRow[]>(); reads.push(d); return d.promise; }, () => open, () => { draws++; });
  expect(counts.label(page)).toBe("? tasks");
  const first = counts.refresh(page); void counts.refresh(page);
  await Bun.sleep(0); expect(reads).toHaveLength(1);
  reads[0]!.resolve([row("a"), row("b", true)]); await first;
  expect(counts.label(page)).toBe("1 task"); expect(draws).toBe(1);
  const again = counts.refresh(page); await Bun.sleep(0);
  reads[1]!.resolve([row("a"), row("c")]); await again;
  expect(counts.label(page)).toBe("2 tasks");
  const same = counts.refresh(page); await Bun.sleep(0);
  reads[2]!.resolve([row("a"), row("c")]); await same;
  expect(draws).toBe(2); // an unchanged label does not redraw
  const failing = counts.refresh(page); await Bun.sleep(0);
  reads[3]!.reject(new Error("corrupt registry")); await failing;
  expect(counts.label(page)).toBe("? tasks");
  // A shared read (the Tasks panel's) sets the count and passes its rows/error through.
  expect(await counts.observe(page, Promise.resolve([]))).toEqual([]);
  expect(counts.label(page)).toBe("0 tasks");
  open = false;
  await counts.observe(page, Promise.resolve([row("late")]));
  expect(counts.label(page)).toBe("0 tasks");
  await expect(counts.observe(page, Promise.reject(new Error("x")))).rejects.toThrow("x");
});

test("the status bar shows the page's task count instead of queued messages; read on open/switch/poll, never per frame", async () => {
  const term = fakeTerm(100, 24);
  const rows = new Map<string, TaskRow[]>([["count-a", [row("one"), row("two"), row("merged", true)]], ["count-b", [row("solo")]]]);
  let reads = 0, fail = false;
  const app = new App({ term, pollMs: 100_000, openOrchestrator: fakeOrchestrators().openOrchestrator,
    tasks: async project => { reads++; if (fail) throw new Error("registry unreadable"); return rows.get(project) ?? []; } });
  const running = app.run("count-a");
  cleanups.push(async () => { app.quit(); await running; });
  await until(() => term.screen().includes("0 agents running │ 2 tasks │ inbox"));
  app.page!.sent.push({ inputId: "held", text: "queued prompt" });
  expect(app.status(app.page!)).not.toMatch(/queued/); expect(app.frame().queued?.texts).toEqual(["queued prompt"]);
  const settled = reads;
  for (let i = 0; i < 5; i++) { app.frame(); app.draw(); }
  expect(reads).toBe(settled);
  await app.openPage("count-b");
  await until(() => app.status(app.page!).includes("1 task │"));
  rows.set("count-a", [row("one")]);
  app.switchPage(-1);
  await until(() => app.status(app.page!).includes("1 task │"));
  fail = true;
  (app as unknown as { watchPages(): void }).watchPages(); // the existing poll's task-inbox refresh
  await until(() => app.status(app.page!).includes("? tasks"));
  await until(() => term.screen().includes(">[count-a]") && term.screen().includes("0 agents running │ ? tasks │"));
});
