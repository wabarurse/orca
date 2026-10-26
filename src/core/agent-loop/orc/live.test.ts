import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../../../config/config";
import { liveFile, liveReader, liveWriter } from "./live";
import type { LiveEvent } from "../../../protocol/daemon";

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

test("a header-only turn replaced by the next turn's longer file is noticed by its header, not its size: nothing of the new turn is read under the old key, so a stale follower never shows it twice", async () => {
  const p = "live-replace";
  mkdirSync(paths.orchestrator(p), { recursive: true });
  const w = liveWriter({ project: p, run: "r", head: () => "h" });
  w.begin(1); // a maintenance turn: header only
  await settle();
  const r = liveReader(p);
  expect(kinds(r.read({ run: "r", turn: 1 }))).toEqual(["start"]);
  await w.end();
  w.begin(2);
  w.write("the second turn's text, longer than the first turn's whole file\n");
  w.onTool({ id: "t", name: "bash", input: {} });
  await settle();
  // The follower still expects turn 1 (its status is stale for a look): the file is another turn's, nothing is consumed.
  expect(r.read({ run: "r", turn: 1 })).toEqual([]);
  expect(r.read({ run: "r", turn: 1 })).toEqual([]);
  // Once it expects turn 2 it reads that file from its start, once.
  expect(kinds(r.read({ run: "r", turn: 2 }))).toEqual(["start", "text", "tool_start"]);
  expect(r.read({ run: "r", turn: 2 })).toEqual([]);
  await w.end();
  // The same for a file rewritten in place with the same key but a new header (a daemon whose end() could not remove it): read once from the start.
  writeFileSync(liveFile(p), JSON.stringify({ seq: 0, kind: "start", run: "r", turn: 3, at: "a" }) + "\n" + JSON.stringify({ seq: 1, kind: "text", head: "h", text: "x" }) + "\n");
  expect(kinds(r.read({ run: "r", turn: 3 }))).toEqual(["start", "text"]);
  writeFileSync(liveFile(p), JSON.stringify({ seq: 0, kind: "start", run: "r", turn: 3, at: "b" }) + "\n" + JSON.stringify({ seq: 1, kind: "text", head: "h", text: "y" }) + "\n" + JSON.stringify({ seq: 2, kind: "text", head: "h", text: "z" }) + "\n");
  expect(r.read({ run: "r", turn: 3 })).toMatchObject([{ seq: 0 }, { seq: 1, text: "y" }, { seq: 2, text: "z" }]);
});

test("a multibyte character split across two reads is decoded whole; a re-read event is skipped and a gap is reported once", async () => {
  const p = "live-utf8";
  mkdirSync(paths.orchestrator(p), { recursive: true });
  const notices: string[] = [];
  const r = liveReader(p, t => { notices.push(t); });
  const line = JSON.stringify({ seq: 1, kind: "text", head: "h", text: "déjà ☃ 🐋 vu" }) + "\n";
  const bytes = Buffer.from(line);
  const cut = bytes.indexOf(Buffer.from("🐋")) + 2; // inside the whale's four bytes
  writeFileSync(liveFile(p), JSON.stringify({ seq: 0, kind: "start", run: "r", turn: 1, at: "a" }) + "\n");
  writeFileSync(liveFile(p), bytes.subarray(0, cut), { flag: "a" });
  expect(kinds(r.read({ run: "r", turn: 1 }))).toEqual(["start"]);
  writeFileSync(liveFile(p), bytes.subarray(cut), { flag: "a" });
  expect(r.read({ run: "r", turn: 1 })).toMatchObject([{ seq: 1, text: "déjà ☃ 🐋 vu" }]);
  // Events are read once each even if a line comes back (a duplicate seq is skipped); a jump in seq is reported once.
  writeFileSync(liveFile(p), line + JSON.stringify({ seq: 5, kind: "status", head: "h", text: "late" }) + "\n" + JSON.stringify({ seq: 9, kind: "status", head: "h", text: "later" }) + "\n", { flag: "a" });
  expect(r.read({ run: "r", turn: 1 }).map(e => e.seq)).toEqual([5, 9]);
  expect(notices).toEqual(["orchestrator: live output skipped 3 event(s)"]);
});

test("the cap counts bytes, not characters", async () => {
  const p = "live-bytes";
  mkdirSync(paths.orchestrator(p), { recursive: true });
  const w = liveWriter({ project: p, run: "r", head: () => "h", capBytes: 200 });
  w.begin(1);
  w.write("🐋".repeat(30) + "\n"); // 31 characters, 121 bytes
  w.write("🐋".repeat(30) + "\n"); // over 200 bytes with the first: truncated
  await settle();
  expect(kinds(liveReader(p).read({ run: "r", turn: 1 }))).toEqual(["start", "text", "truncated"]);
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
