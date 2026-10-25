import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "./config";
import { drain, format, parseFormatted, pending, put } from "./inbox";

const home = mkdtempSync(join(tmpdir(), "orca-inbox-"));
process.env.ORCA_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));

test("an empty or missing inbox drains to nothing", async () => {
  expect(await pending("p1", "orchestrator")).toBe(false);
  expect(await drain("p1", "orchestrator")).toEqual([]);
});

test("put then drain returns messages oldest first and empties the queue", async () => {
  await put("p2", "orchestrator", { from: "worker-a", text: "first" });
  await put("p2", "orchestrator", { from: "user", text: "second" });
  expect(await pending("p2", "orchestrator")).toBe(true);
  const msgs = await drain("p2", "orchestrator");
  expect(msgs.map((m) => m.text)).toEqual(["first", "second"]);
  expect(msgs[0]?.from).toBe("worker-a");
  expect(msgs[0]?.ts).toMatch(/^\d{4}-/);
  expect(await drain("p2", "orchestrator")).toEqual([]);
  expect(await pending("p2", "orchestrator")).toBe(false);
});

test("each agent has its own queue", async () => {
  await put("p3", "worker-a", { from: "orchestrator", text: "for a" });
  await put("p3", "user", { from: "orchestrator", text: "for you" });
  expect(await drain("p3", "orchestrator")).toEqual([]);
  expect((await drain("p3", "worker-a")).map((m) => m.text)).toEqual(["for a"]);
  expect((await drain("p3", "user")).map((m) => m.text)).toEqual(["for you"]);
});

test("many puts in the same millisecond still drain in order", async () => {
  const n = 200;
  for (let i = 0; i < n; i++) await put("p4", "x", { from: "y", text: String(i) });
  expect((await drain("p4", "x")).map((m) => m.text)).toEqual(Array.from({ length: n }, (_, i) => String(i)));
});

test("concurrent puts from one process land in send order: once one resolves, every earlier one is there", async () => {
  const n = 50;
  const seen: number[] = [];
  const count = () => readdirSync(join(paths.inbox("p6"), "x")).filter((f) => f.endsWith(".json")).length;
  await Promise.all(Array.from({ length: n }, (_, i) => put("p6", "x", { from: "y", text: String(i) }).then(() => { seen[i] = count(); })));
  expect(seen.every((c, i) => c >= i + 1)).toBe(true);
  expect((await drain("p6", "x")).map((m) => m.text)).toEqual(Array.from({ length: n }, (_, i) => String(i)));
});

test("writes are atomic: no temp files left, a bad file is dropped", async () => {
  await put("p5", "x", { from: "y", text: "ok" });
  await Bun.write(join(paths.inbox("p5"), "x", "0000-bad.json"), '{"from":');
  expect(readdirSync(join(paths.inbox("p5"), "x")).some((f) => f.endsWith(".tmp"))).toBe(false);
  expect((await drain("p5", "x")).map((m) => m.text)).toEqual(["ok"]);
});

test("format tags each sender", () => {
  expect(format([{ from: "a", text: "x", ts: "" }, { from: "b", text: "y", ts: "" }])).toBe("[a] x\n\n[b] y");
});

test("parseFormatted reads back what format wrote", () => {
  const msgs = [{ from: "user", text: "hi\nthere", ts: "" }, { from: "worker-feat-x", text: "done\n\nall green", ts: "" }];
  expect(parseFormatted(format(msgs))).toEqual(msgs.map(({ from, text }) => ({ from, text })));
  expect(parseFormatted("no tag here")).toEqual([{ from: "", text: "no tag here" }]);
});

test("parseFormatted only takes real sender ids as tags", () => {
  const msgs = [
    { from: "worker-feat.x_1", text: "Report:\n\n[x] done\n\n[1] item", ts: "" },
    { from: "user", text: "please\n\n[x] done\n\n[1] item", ts: "" },
    { from: "reviewer", text: "ok", ts: "" },
    { from: "orchestrator", text: "note", ts: "" },
  ];
  expect(parseFormatted(format(msgs))).toEqual(msgs.map(({ from, text }) => ({ from, text })));
  expect(parseFormatted("[x] done\n\n[user] hi")).toEqual([{ from: "", text: "[x] done\n\n[user] hi" }]);
  expect(parseFormatted("[workerx] hi")).toEqual([{ from: "", text: "[workerx] hi" }]);
});
