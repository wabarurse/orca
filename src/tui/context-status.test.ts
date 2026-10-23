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
  expect(reviewStatus([task, task])).toBe("Reviews 0r:0 1r:2 2+r:0 ?:0 CI:2");
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

test("multi-task review distribution is explicit, bounded and switches to the viewed task", () => {
  const tasks = [0, 1, 4].map((rounds, i) => ({ branch: `feat/${i}`, review: { rounds, unknown: false, ci: i === 2 } }) as TaskRow);
  tasks.push({ branch: "legacy" } as TaskRow);
  expect(reviewStatus(tasks)).toBe("Reviews 0r:1 1r:1 2+r:1 ?:1 CI:1");
  expect(reviewStatus(tasks, "reviewer-feat-0")).toBe("Review 0");
  expect(reviewStatus(tasks, "reviewer-feat-2")).toBe("Review 4 · CI");
  expect(reviewStatus(tasks, "worker-legacy")).toBe("Review ?");
  expect(reviewStatus(tasks, "reviewer-absent")).toBe("Review —");
});

test("common terminal sizes expose useful context/model/reviews and agent identity", () => {
  const c = { tabs: [{ name: "project" }], active: 0, model: "gpt-5.5 · effort high · fast on", directory: "/repo", remote: "host/repo", context: "Ctx ~12k/272k", review: "Review 1 · CI" };
  for (const cols of [40, 80, 120]) {
    const rows = chapterRows(c, cols, 8).map(Bun.stripANSI).join("\n");
    for (const text of ["project", "Ctx ~12k/272k", "Review 1 · CI", "gpt-5.5", "effort high", "fast on", "/repo", "host/repo"]) expect(rows).toContain(text);
    const aggregate = chapterRows({ ...c, review: "Reviews 0r:1 1r:1 2+r:1 ?:1 CI:1", agent: "reviewer-feat-x" }, cols, 8).map(Bun.stripANSI).join("\n");
    for (const text of ["Ctx ~12k/272k", "gpt-5.5", "0r:1", "1r:1", "2+r:1", "?:1", "CI:1", "view reviewer-feat-x"]) expect(aggregate).toContain(text);
  }
  const short = chapterRows({ ...c, review: "Reviews 0r:1 1r:1 2+r:1 ?:1 CI:1" }, 40, 4).map(Bun.stripANSI).join("\n");
  expect(short).toContain("Ctx ~12k/272k"); expect(short).toContain("gpt-5.5");
});
