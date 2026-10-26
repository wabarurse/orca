import { expect, test } from "bun:test";
import { contextStatus, dispatchStatus, reviewStatus } from "./context-status";
import { reviewProgress, type TaskRun } from "../../core/data/tasks/tasks";
import { chapterRows } from "./chrome";
import { visibleLength } from "../components/text";

test("context uses k units, honest estimates and unknown limits/counts", () => {
  expect(contextStatus("gpt-5.5", 12345)).toBe("ctx ~12.3k/272k");
  expect(contextStatus("gpt-daybreak-red-latest", 0)).toBe("ctx ~0k/372k");
  expect(contextStatus("claude-opus-5-5", 45000)).toBe("ctx ~45k/1M");
  expect(contextStatus("claude-opus-5-5", 999949)).toBe("ctx ~999.9k/1M");
  expect(contextStatus("claude-opus-5-5", 999990)).toBe("ctx ~1M/1M");
  expect(contextStatus("claude-opus-5-5", 1000000)).toBe("ctx ~1M/1M");
  expect(contextStatus("unknown", 1520000, { limit: 1500000, estimated: true })).toBe("ctx ~1.5M/1.5M?");
  expect(contextStatus("claude-opus-4-6", 45000)).toBe("ctx ~45k/200k");
  // Unlisted: the limit compaction uses, marked as an estimate rather than a bare ?.
  expect(contextStatus("unknown", 1500)).toBe("ctx ~1.5k/128k?");
  expect(contextStatus("unknown", 45000, { limit: 64000, estimated: true })).toBe("ctx ~45k/64k?");
  expect(contextStatus("unknown", 45000, { limit: 6789, estimated: false })).toBe("ctx ~45k/6.8k");
  expect(contextStatus(undefined, 45000, { limit: 64000, estimated: true })).toBe("ctx ~45k/?");
  expect(contextStatus(undefined)).toBe("ctx ?/?");
  for (const value of [undefined, NaN, Infinity, -1]) expect(contextStatus("gpt-5.5", value)).toBe("ctx ?/272k");
});
const run = (mode?: "review" | "watch-ci", started = true): TaskRun => ({ id: crypto.randomUUID(), agent: "reviewer-feat-x", role: "reviewer", state: started ? "started" : "prepared", preparedAt: "now", ...(started ? { startedAt: "now" } : {}), reviewMode: mode });
test("task progress still counts confirmed code reviews, not CI or prepared/legacy runs", () => {
  expect(reviewProgress([run("review"), run("watch-ci"), run("review", false)])).toEqual({ rounds: 1, unknown: false, ci: true });
  expect(reviewProgress([run()]).unknown).toBe(true);
});
test("review label accepts only the configured count, including both limits", () => {
  for (const n of [0, 1, 7, 100]) expect(reviewStatus(n)).toBe(`review rounds: ${n}`);
  for (const n of [undefined, NaN, Infinity, -1, 1.5, 101]) expect(reviewStatus(n)).toBe("review rounds: ?");
});
test("dispatch label shows the saved switch, or unknown", () => {
  expect(dispatchStatus(true)).toBe("dispatch: on");
  expect(dispatchStatus(false)).toBe("dispatch: off");
  expect(dispatchStatus(undefined)).toBe("dispatch: ?");
});
test("dispatch sits next to review rounds and stays bounded at every width", () => {
  const c = { tabs: [{ name: "Project" }], active: 0, model: "Model-ID", directory: "/Repo", remote: "Host/Repo", context: "ctx ~12k/272k", review: reviewStatus(100), dispatch: dispatchStatus(false) };
  expect(chapterRows(c, 120, 8).map(Bun.stripANSI).join("\n")).toContain("review rounds: 100 · dispatch: off");
  for (const cols of [40, 80]) expect(chapterRows(c, cols, 8).map(Bun.stripANSI).join("\n")).toContain("dispatch: off");
  for (const cols of [1, 4, 12, 25, 40, 80, 160]) for (const budget of [0, 1, 2, 4, 8]) {
    const rows = chapterRows({ ...c, agent: "reviewer-Task" }, cols, budget);
    expect(rows.length).toBeLessThanOrEqual(budget);
    for (const row of rows) expect(visibleLength(row)).toBeLessThanOrEqual(cols);
  }
});
test("telemetry and identities remain bounded at narrow widths and height budgets", () => {
  for (const cols of [1, 4, 12, 25, 40, 80, 160]) for (const budget of [0, 1, 2, 4, 8]) {
    const rows = chapterRows({ tabs: [{ name: "Project" }], active: 0, model: "Model-ID", directory: "/Repo", remote: "Remote", context: contextStatus("gpt-5.5", 12000), review: reviewStatus(100), agent: "reviewer-Task" }, cols, budget);
    expect(rows.length).toBeLessThanOrEqual(budget);
    for (const row of rows) expect(visibleLength(row)).toBeLessThanOrEqual(cols);
  }
});
test("common terminal sizes expose the saved review limit even in an agent view", () => {
  const c = { tabs: [{ name: "Project" }], active: 0, model: "Model-ID · effort high · fast on", directory: "/Repo", remote: "Host/Repo", context: "ctx ~12k/272k", review: reviewStatus(100) };
  for (const cols of [40, 80, 120]) {
    const rows = chapterRows(c, cols, 8).map(Bun.stripANSI).join("\n");
    for (const text of ["Project", c.context, c.review, "Model-ID", "effort high", "fast on", "/Repo", "Host/Repo"]) expect(rows).toContain(text);
    const agent = chapterRows({ ...c, context: "ctx ?/?", agent: "reviewer-Task" }, cols, 8).map(Bun.stripANSI).join("\n");
    for (const text of ["ctx ?/?", c.review, "view reviewer-Task"]) expect(agent).toContain(text);
  }
  const short = chapterRows(c, 25, 4).map(Bun.stripANSI).join("\n");
  expect(short).toContain(c.context); expect(short).toContain("Model-ID");
});

test("lowercase telemetry snapshot preserves project, model, path, remote and agent identity", () => {
  const chapter = { tabs: [{ name: "MyProject" }], active: 0, model: "Provider-Model-ID · effort default · fast off", directory: "/Users/Ada/Repo", remote: "Host/Owner/Repo", context: contextStatus(undefined), review: reviewStatus(100), agent: "reviewer-MyTask" };
  for (const cols of [40, 100]) {
    const rendered = chapterRows(chapter, cols, 9).map(Bun.stripANSI).join("\n");
    expect(rendered).toMatchSnapshot();
    for (const value of ["MyProject", "Provider-Model-ID", chapter.directory, chapter.remote, chapter.agent, "review rounds: 100", "ctx ?/?"]) expect(rendered).toContain(value);
  }
});
