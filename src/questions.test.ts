import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "./config";
import { drain } from "./inbox";
import { all, answer, ask, list, skip } from "./questions";
import { ask as askTool } from "./tools/ask";
import { registry, toolsFor } from "./tools/index";

const home = mkdtempSync(join(tmpdir(), "parallels-questions-"));
process.env.PARALLELS_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));

test("questions list in ask order, a file each, no temp files", async () => {
  const n = 50;
  await ask("q1", Array.from({ length: n }, (_, i) => ({ text: String(i), default: "x" })));
  expect((await list("q1")).map((q) => q.text)).toEqual(Array.from({ length: n }, (_, i) => String(i)));
  const files = readdirSync(paths.questions("q1"));
  expect(files.length).toBe(n);
  expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
});

test("answer and skip close the question and message the orchestrator", async () => {
  const [a, b] = await ask("q2", [
    { text: "Which DB?", options: ["sqlite", "postgres"], default: "sqlite" },
    { text: "Dark mode?", default: "no" },
  ]);
  await answer("q2", a!.id, "postgres");
  await skip("q2", b!.id);
  expect(await list("q2")).toEqual([]);
  expect((await all("q2")).map((q) => [q.status, q.answer])).toEqual([["answered", "postgres"], ["skipped", undefined]]);
  const msgs = await drain("q2", "orchestrator");
  expect(msgs.map((m) => m.from)).toEqual(["user", "user"]);
  expect(msgs.map((m) => m.text)).toEqual(['answer to "Which DB?": postgres', 'skipped "Dark mode?"; use your default (no)']);
});

test("a double answer or skip is refused and sends nothing", async () => {
  const [q] = await ask("q3", [{ text: "Ship it?", default: "yes" }]);
  await answer("q3", q!.id, "yes");
  await drain("q3", "orchestrator");
  expect(answer("q3", q!.id, "no")).rejects.toThrow("already answered");
  expect(skip("q3", q!.id)).rejects.toThrow("already answered");
  expect(answer("q3", "nope", "x")).rejects.toThrow("no question");
  expect(await drain("q3", "orchestrator")).toEqual([]);
});

test("the ask tool queues and returns ids at once; only the orchestrator has it", async () => {
  const ctx = { project: "q4", cwd: "/" };
  const out = await askTool.run({ questions: [{ text: "A?", default: "a" }, { text: "B?", options: ["x", "y"] }] }, { ...ctx, role: "orchestrator" });
  const qs = await list("q4");
  expect(out).toBe(`queued 2: ${qs.map((q) => q.id).join(", ")}`);
  expect(qs[1]?.options).toEqual(["x", "y"]);
  expect(await askTool.run({ questions: [] }, { ...ctx, role: "orchestrator" })).toStartWith("refused");
  expect(await askTool.run({ questions: [{ text: "C?" }] }, { ...ctx, role: "worker", branch: "b" })).toStartWith("refused");
  expect(toolsFor.orchestrator).toContain("ask");
  expect(toolsFor.worker).not.toContain("ask");
  expect(toolsFor.reviewer).not.toContain("ask");
  expect(registry.ask).toBe(askTool);
});
