import { expect, test } from "bun:test";
import { contextStatus, reviewStatus } from "./context-status";
import { reviewProgress, type TaskRun, type TaskRow } from "../tasks";
import { chapterRows } from "./chrome";
import { visibleLength } from "./render";

test("context uses k units, honest estimates and unknown limits/counts", () => {
  expect(contextStatus("gpt-5.5", 12345)).toBe("Ctx ~12.3k/272k");
  expect(contextStatus("gpt-daybreak-red-latest", 0)).toBe("Ctx ~0k/372k");
  expect(contextStatus("unknown", 1500)).toBe("Ctx ~1.5k/?");
  for (const value of [undefined, NaN, Infinity, -1]) expect(contextStatus("gpt-5.5", value)).toBe("Ctx ?/272k");
});
const run = (mode?: "review" | "watch-ci", started = true): TaskRun => ({ id: crypto.randomUUID(), agent: "reviewer-feat-x", role: "reviewer", state: started ? "started" : "prepared", preparedAt: "now", ...(started ? { startedAt: "now" } : {}), reviewMode: mode });
test("review progress counts confirmed code reviews, not CI or prepared/legacy runs", () => {
  expect(reviewProgress([run("review"), run("watch-ci"), run("review", false)])).toEqual({ rounds: 1, unknown: false, ci: true });
  expect(reviewProgress([run()]).unknown).toBe(true);
  const task = { branch: "feat/x", review: reviewProgress([run("review"), run("watch-ci")]) } as TaskRow;
  expect(reviewStatus([task])).toBe("Review 1 · CI");
  expect(reviewStatus([task], "reviewer-feat-x")).toBe("Review 1 · CI");
  expect(reviewStatus([task, task])).toBe("Review · 2 tasks");
  expect(reviewStatus([])).toBe("Review —");
  expect(reviewStatus(undefined)).toBe("Review ?");
});
test("telemetry and existing identities remain bounded at narrow widths and height budgets", () => {
  for (const cols of [1, 4, 12, 25, 80, 160]) for (const budget of [0, 1, 2, 4, 8]) {
    const rows = chapterRows({ tabs: [{ name: "project" }], active: 0, model: "gpt-5.5", directory: "/repo", remote: "remote", context: contextStatus("gpt-5.5", 12000), review: "Review 1 · CI" }, cols, budget);
    expect(rows.length).toBeLessThanOrEqual(budget);
    for (const row of rows) expect(visibleLength(row)).toBeLessThanOrEqual(cols);
  }
});
