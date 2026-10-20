import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "./config";
import { drain, put } from "./inbox";

const home = mkdtempSync(join(tmpdir(), "parallels-inbox-"));
process.env.PARALLELS_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));

test("drain on an empty inbox returns nothing", async () => {
  expect(await drain("p1")).toEqual([]);
});

test("put then drain returns messages oldest first and empties the box", async () => {
  await put("p2", { from: "worker-t1", text: "first" });
  await put("p2", { from: "user", text: "second" });
  const msgs = await drain("p2");
  expect(msgs.map((m) => m.text)).toEqual(["first", "second"]);
  expect(msgs[0]?.from).toBe("worker-t1");
  expect(msgs[0]?.ts).toMatch(/^\d{4}-/);
  expect(await drain("p2")).toEqual([]);
});

test("inbox and outbox are separate", async () => {
  await put("p3", { from: "orchestrator", text: "reply" }, "outbox");
  expect(await drain("p3")).toEqual([]);
  expect((await drain("p3", "outbox")).map((m) => m.text)).toEqual(["reply"]);
});

test("many puts in the same millisecond still drain in order", async () => {
  const n = 200;
  for (let i = 0; i < n; i++) await put("p5", { from: i % 2 ? "a" : "b", text: String(i) });
  const texts = (await drain("p5")).map((m) => m.text);
  expect(texts).toEqual(Array.from({ length: n }, (_, i) => String(i)));
});

test("a partial file is dropped, not fatal", async () => {
  await Bun.write(join(paths.inbox("p4"), "0000-bad.json"), '{"from":');
  await put("p4", { from: "user", text: "ok" });
  expect((await drain("p4")).map((m) => m.text)).toEqual(["ok"]);
});
