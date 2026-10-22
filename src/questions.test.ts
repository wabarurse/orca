import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "./config";
import { drain } from "./inbox";
import { all, answer, ask, cleanQuestions, list, skip } from "./questions";
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
  expect(msgs.map((m) => m.text)).toEqual([
    `[${a!.id}] answer to "Which DB?": postgres`,
    `[${b!.id}] skipped "Dark mode?"; use your default (no)`,
  ]);
});

test("a double answer or skip is refused and sends nothing", async () => {
  const [q] = await ask("q3", [{ text: "Ship it?", default: "yes" }]);
  await answer("q3", q!.id, "yes");
  await drain("q3", "orchestrator");
  await expect(answer("q3", q!.id, "no")).rejects.toThrow("already answered");
  await expect(skip("q3", q!.id)).rejects.toThrow("already answered");
  await expect(answer("q3", "nope", "x")).rejects.toThrow("no question");
  await expect(answer("q3", "../../x", "x")).rejects.toThrow("bad question id");
  await expect(skip("q3", "..")).rejects.toThrow("bad question id");
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

test("concurrent answers: exactly one wins and one message is sent", async () => {
  const [q] = await ask("q5", [{ text: "Race?", default: "no" }]);
  const results = await Promise.allSettled([answer("q5", q!.id, "a"), answer("q5", q!.id, "b"), skip("q5", q!.id)]);
  expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
  expect((await drain("q5", "orchestrator")).length).toBe(1);
  expect(await list("q5")).toEqual([]);
});

test("a skip without a default says to decide", async () => {
  const [q] = await ask("q6", [{ text: "Name?" }]);
  await skip("q6", q!.id);
  expect((await drain("q6", "orchestrator")).map((m) => m.text)).toEqual([`[${q!.id}] skipped "Name?" (no default given); decide yourself`]);
});

test("input is cleaned and capped", async () => {
  expect(cleanQuestions([{ text: "a\nb\tc", options: ["x", "x", { y: 1 }, 3, " y "], default: "x" }])).toEqual([
    { text: "a b c", options: ["x", "y"], default: "x" },
  ]);
  expect(() => cleanQuestions([{ text: "bad\u0007" }])).toThrow("control or bidi characters");
  expect(() => cleanQuestions([{ text: "c1\u0085" }])).toThrow("control or bidi characters");
  for (const ch of ["\u202e", "\u2066", "\u2069", "\u2028", "\u2029"]) expect(() => cleanQuestions([{ text: `a${ch}b` }])).toThrow("bidi");
  expect(() => cleanQuestions([{ text: "x".repeat(501) }])).toThrow("over 500");
  expect(() => cleanQuestions([{ text: "q", options: ["o".repeat(101)] }])).toThrow("over 100");
  expect(() => cleanQuestions([{ text: "q", default: "d".repeat(101) }])).toThrow("over 100");
  expect(() => cleanQuestions([{ text: "q", options: Array.from({ length: 9 }, (_, i) => String(i)) }])).toThrow("over 8 options");
  expect(() => cleanQuestions(Array.from({ length: 11 }, () => ({ text: "q" })))).toThrow("over 10 questions");
  const ctx = { project: "q7", cwd: "/", role: "orchestrator" as const };
  expect(await askTool.run({ questions: Array.from({ length: 11 }, () => ({ text: "q" })) }, ctx)).toBe("refused: over 10 questions in one call");
  const [q] = await ask("q7", [{ text: "Why?", default: "x" }]);
  await expect(answer("q7", q!.id, "bad\u0000")).rejects.toThrow("control or bidi characters");
  await answer("q7", q!.id, "line\nbreak");
  expect((await drain("q7", "orchestrator"))[0]?.text).toEndWith(": line break");
});

test("a failed inbox send leaves the question open and answerable", async () => {
  const [q] = await ask("q8", [{ text: "Retry?", default: "yes" }]);
  const box = join(paths.inbox("q8"), "orchestrator");
  mkdirSync(paths.inbox("q8"), { recursive: true });
  writeFileSync(box, "not a directory");
  await expect(answer("q8", q!.id, "first")).rejects.toThrow();
  expect((await list("q8")).map((x) => [x.id, x.status, x.answer])).toEqual([[q!.id, "open", undefined]]);
  rmSync(box);
  await answer("q8", q!.id, "second");
  expect((await drain("q8", "orchestrator")).map((m) => m.text)).toEqual([`[${q!.id}] answer to "Retry?": second`]);
  expect(await list("q8")).toEqual([]);
});

test("unreadable or malformed question stores fail visibly instead of fabricating an empty unanswered queue", async () => {
  expect(await list("missing-store")).toEqual([]);
  mkdirSync(paths.project("bad-store"), { recursive: true });
  writeFileSync(paths.questions("bad-store"), "not a directory");
  await expect(list("bad-store")).rejects.toThrow();
  mkdirSync(paths.questions("broken-question"), { recursive: true });
  const file = join(paths.questions("broken-question"), "q.json");
  writeFileSync(file, "{"); await expect(list("broken-question")).rejects.toThrow();
  writeFileSync(file, JSON.stringify({ id: "q", status: "mystery" }));
  await expect(list("broken-question")).rejects.toThrow("invalid question record");
  expect(await Bun.file(file).json()).toEqual({ id: "q", status: "mystery" }); // no reset/migration
  writeFileSync(file, JSON.stringify({ id: "q", text: "Q?", ts: "t", status: "answered", answer: 123 }));
  await expect(list("broken-question")).rejects.toThrow("invalid question record");
});
