import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "./config";
import { liveFile, liveReader, liveWriter, type LiveEvent } from "./orchestrator-live";

const home = mkdtempSync(join(tmpdir(), "orca-live-"));
process.env.ORCA_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));

const settle = () => Bun.sleep(30);
const kinds = (events: LiveEvent[]) => events.map(e => e.kind);

test("writer and reader round trip: ordered, head-tagged events for the expected turn only; the file is replaced at begin and gone after end", async () => {
  const p = "live-rt";
  mkdirSync(paths.orchestrator(p), { recursive: true });
  let head: string | null = "h0";
  const logs: string[] = [];
  const w = liveWriter({ project: p, run: "run-a", head: () => head, log: t => { logs.push(t); } });
  w.write("dropped before a turn");
  w.begin(1);
  w.write("Hel"); w.write("lo\n");
  w.onTool({ id: "t1", name: "bash", input: { command: "ls" } });
  head = "h1";
  w.onToolResult({ id: "t1", ok: true, text: "a\nb" });
  w.write("memory: indexed\n", true);
  await settle();

  const r = liveReader(p);
  expect(r.read({ run: "run-a", turn: 2 })).toEqual([]); // another turn: nothing consumed
  expect(r.read({ run: "run-b", turn: 1 })).toEqual([]); // another daemon: nothing consumed
  const events = r.read({ run: "run-a", turn: 1 });
  expect(kinds(events)).toEqual(["start", "text", "text", "tool_start", "tool_end", "status"]);
  expect(events.map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
  expect(events[1]).toMatchObject({ kind: "text", head: "h0", text: "Hel" });
  expect(events[3]).toMatchObject({ kind: "tool_start", head: "h0", call: { id: "t1", name: "bash" } });
  expect(events[4]).toMatchObject({ kind: "tool_end", head: "h1", outcome: { id: "t1", ok: true, text: "a\nb" } });
  expect(events[5]).toMatchObject({ kind: "status", head: "h1", text: "memory: indexed\n" });
  expect(r.read({ run: "run-a", turn: 1 })).toEqual([]); // nothing new
  w.write("more\n");
  await settle();
  expect(r.read({ run: "run-a", turn: 1 })).toMatchObject([{ seq: 6, kind: "text", text: "more\n" }]);

  await w.end();
  expect(existsSync(liveFile(p))).toBe(false);
  w.write("after the turn"); // not a turn: dropped
  await settle();
  expect(existsSync(liveFile(p))).toBe(false);
  expect(r.read({ run: "run-a", turn: 1 })).toEqual([]);

  // The next turn replaces the file from its header; the same reader follows it from the start.
  w.begin(2);
  w.write("second\n");
  await settle();
  const second = r.read({ run: "run-a", turn: 2 });
  expect(second).toMatchObject([{ seq: 0, kind: "start", run: "run-a", turn: 2 }, { seq: 1, kind: "text", text: "second\n" }]);
  await w.end();
  expect(logs).toEqual([]);
});

test("a line still being written waits for its newline; a leftover file from a dead daemon is not read until the live turn's header replaces it", async () => {
  const p = "live-partial";
  mkdirSync(paths.orchestrator(p), { recursive: true });
  const header = JSON.stringify({ seq: 0, kind: "start", run: "old-run", turn: 7, at: "t" }) + "\n";
  writeFileSync(liveFile(p), header + JSON.stringify({ seq: 1, kind: "text", head: null, text: "stale" }) + "\n" + "{\"seq\":2,\"kind\":\"text\",\"head\":null,\"te");
  const r = liveReader(p);
  expect(r.read({ run: "new-run", turn: 1 })).toEqual([]);
  expect(r.read({ run: "new-run", turn: 1 })).toEqual([]);
  // The live daemon's turn begins: a shorter file with a matching header.
  const w = liveWriter({ project: p, run: "new-run", head: () => "h" });
  w.begin(1);
  await settle();
  expect(kinds(r.read({ run: "new-run", turn: 1 }))).toEqual(["start"]);
  // A partial line is held until complete; what follows a damaged line is still read.
  writeFileSync(liveFile(p), "{\"seq\":1,\"kind\":\"text\",\"head\":\"h\",\"te", { flag: "a" });
  expect(r.read({ run: "new-run", turn: 1 })).toEqual([]);
  writeFileSync(liveFile(p), "xt\":\"done\"}\nnot json\n" + JSON.stringify({ seq: 2, kind: "status", head: "h", text: "ok\n" }) + "\n", { flag: "a" });
  expect(r.read({ run: "new-run", turn: 1 })).toMatchObject([{ seq: 1, kind: "text", text: "done" }, { seq: 2, kind: "status" }]);
  await w.end();
});

test("the cap replaces further text by one truncated event while tool events are still logged", async () => {
  const p = "live-cap";
  mkdirSync(paths.orchestrator(p), { recursive: true });
  const w = liveWriter({ project: p, run: "r", head: () => "h", capBytes: 300 });
  w.begin(1);
  w.write("x".repeat(120) + "\n");
  w.write("y".repeat(120) + "\n");
  w.write("z".repeat(120) + "\n"); // over the cap
  w.write("after\n");
  w.write("status too\n", true);
  w.onTool({ id: "t", name: "bash", input: {} });
  w.onToolResult({ id: "t", ok: true, text: "" });
  await settle();
  const events = liveReader(p).read({ run: "r", turn: 1 });
  expect(kinds(events)).toEqual(["start", "text", "text", "truncated", "tool_start", "tool_end"]);
  expect(readFileSync(liveFile(p), "utf8").length).toBeLessThan(1000);
  await w.end();
  // The next turn starts with a fresh budget.
  w.begin(2);
  w.write("fresh\n");
  await settle();
  expect(kinds(liveReader(p).read({ run: "r", turn: 2 }))).toEqual(["start", "text"]);
  await w.end();
});

test("an unwritable live file never throws into the turn and is logged once", async () => {
  const p = "live-fail";
  mkdirSync(paths.project(p), { recursive: true });
  writeFileSync(paths.orchestrator(p), "a file where the directory should be");
  const logs: string[] = [];
  const w = liveWriter({ project: p, run: "r", head: () => null, log: t => { logs.push(t); } });
  w.begin(1);
  w.write("hello\n");
  w.onTool({ id: "t", name: "bash", input: {} });
  await w.end();
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain("live output stopped");
  expect(liveReader(p).read({ run: "r", turn: 1 })).toEqual([]);
});
