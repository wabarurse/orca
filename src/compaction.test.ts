import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { budget, compact, contextLimit, splitHistory } from "./compaction";
import { createAgent, type AgentDeps } from "./agent";
import { createOrchestrator } from "./orchestrator";
import { open } from "./transcript";
import { restore } from "./tui/restore";
import { put, pending } from "./inbox";
import { fakeProvider, text, toolUse } from "./test/fake-provider";

const dirs: string[] = [];
const oldHome = process.env.PARALLELS_HOME;
afterEach(() => { process.env.PARALLELS_HOME = oldHome; for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "compact-")); dirs.push(dir);
  const transcript = open(join(dir, "t.jsonl"));
  for (const content of ["original requirements " + "a".repeat(3000), "old answer" + "z".repeat(33000), "recent task", "recent answer"]) {
    await transcript.append({ type: "message", message: { role: content.includes("answer") ? "assistant" : "user", content } });
  }
  const provider = fakeProvider([[text("Goal: original requirements. Progress: old answer. Next: recent task.")]]);
  const deps: AgentDeps = { transcript, provider, model: "unknown", tools: {}, ctx: { project: "p", role: "worker", cwd: dir }, compaction: { fallback: 20000 } };
  return { deps, provider, transcript, dir };
}
test("threshold includes system/tools/reserve; unknown uses configured fallback", async () => {
  const { deps, provider } = await fixture();
  expect(contextLimit({ fallback: 12345 })).toBe(12345);
  expect(contextLimit({ fallback: 12345 }, "gpt-6-astra")).toBe(272000);
  expect(contextLimit({ fallback: 12345, contextLimit: 6789 })).toBe(6789);
  deps.compaction!.fallback = 100000;
  expect(await compact(deps)).toBeNull(); expect(provider.calls).toHaveLength(0);
  deps.tools = { example: { spec: { name: "example", description: "d".repeat(3000), input_schema: { type: "object" } }, run: async () => "" } };
  expect(budget(deps, [])).toBeGreaterThan(2000);
  deps.system = "s".repeat(300000);
  expect(budget(deps, [])).toBeGreaterThan(100000);
  await expect(compact(deps)).rejects.toThrow("Context blocked");
});
test("atomic checkpoint, repeated compactions and restart keep original UI history without duplicated tail", async () => {
  const { deps, transcript } = await fixture();
  const before = await Bun.file(transcript.path).text();
  const history = transcript.history!();
  expect(await compact(deps, true)).toBe(true);
  expect((await Bun.file(transcript.path).text()).startsWith(before)).toBe(true);
  expect(open(transcript.path).history!()).toEqual(history);
  expect(restore(open(transcript.path).history!(), 100)).toEqual(restore(history, 100));
  expect(await open(transcript.path).chain()).toEqual(await transcript.chain());
  await transcript.append({ type: "message", message: { role: "user", content: "b".repeat(20000) } });
  await transcript.append({ type: "message", message: { role: "assistant", content: "done" } });
  await transcript.append({ type: "message", message: { role: "user", content: "new task" } });
  deps.provider = fakeProvider([[text("Goal: requirements. Progress: done. Next: new task.")]]);
  expect(await compact(deps, true)).toBe(true);
  expect(open(transcript.path).history!()).toHaveLength(7);
  expect((await transcript.chain()).at(-1)?.content).toBe("new task");
});
test("complete tool/thinking turn stays together", () => {
  const messages: any[] = [{ role: "user", content: "old" }, { role: "assistant", content: "done" }, { role: "user", content: "task" }, { role: "assistant", content: [{ type: "thinking", thinking: "x", signature: "s" }, { type: "tool_use", id: "a", name: "bash", input: {} }, { type: "tool_use", id: "b", name: "bash", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "a" }, { type: "tool_result", tool_use_id: "b", content: "b" }] }];
  expect(splitHistory(messages)).toBe(2);
  expect(splitHistory(messages, 1)).toBe(0);
});
for (const failure of ["", "x".repeat(30000), new Error("offline")]) test(`failed summary leaves bytes/head/context unchanged: ${String(failure).slice(0, 20)}`, async () => {
  const { deps, transcript } = await fixture();
  deps.provider = { ...deps.provider!, complete: async () => { if (failure instanceof Error) throw failure; return { content: [text(failure)], completion: "end_turn", stop: "end" }; } };
  const before = await Bun.file(transcript.path).text(), head = transcript.head(), chain = await transcript.chain();
  expect(await compact(deps, true)).toBe(false);
  expect(transcript.head()).toBe(head); expect(await transcript.chain()).toEqual(chain);
  expect(await Bun.file(transcript.path).text()).toBe(before);
});
test("model change to smaller context rechecks and compact off can be overridden manually", async () => {
  const { deps } = await fixture();
  deps.compaction = { contextLimit: 100000 }; expect(await compact(deps)).toBeNull();
  deps.model = "smaller"; deps.compaction.contextLimit = 10000;
  deps.compaction.enabled = false; expect(await compact(deps)).toBeNull();
  deps.compaction.contextLimit = 100000;
  expect(await compact(deps, true)).toBe(true);
});
test("manual idle queues without user messages; busy request and arriving inbox use safe boundaries", async () => {
  const { deps, transcript, dir } = await fixture(); process.env.PARALLELS_HOME = dir;
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>(r => started = r);
  const gate = new Promise<void>(r => release = r);
  let calls = 0;
  const provider = { ...deps.provider!, complete: async () => { calls++; started(); await gate; return { content: [text("short summary")], completion: "end_turn", stop: "end" as const }; } };
  const orch = await createOrchestrator({ project: "p", provider, transcript, tools: {} });
  await orch.compact!(); expect(await orch.pending()).toBe(true);
  const turn = orch.turn(); await entered;
  await put("p", "orchestrator", { from: "user", text: "arrived during summary" });
  await orch.compact!(); expect(await orch.turn()).toEqual([]);
  release(); await turn;
  expect(calls).toBe(1); expect(await pending("p", "orchestrator")).toBe(true);
  expect(await orch.pending()).toBe(true);
  expect(orch.entries!()).toHaveLength(4);
});
for (const role of ["worker", "reviewer"] as const) test(`${role} uses shared pre-request path`, async () => {
  const { deps, provider, dir } = await fixture(); process.env.PARALLELS_HOME = dir;
  deps.ctx.role = role;
  deps.provider = fakeProvider([[text("Goal: constraints. Progress: done. Next: task.")], [text("final")]]);
  await createAgent(deps).run();
  expect(deps.transcript.branch()[0]?.type).toBe("summary");
  expect(provider.calls).toHaveLength(0);
});
test("non-reducing small summary and orphaned tool batches are rejected", async () => {
  const { deps, dir } = await fixture();
  deps.transcript = open(join(dir, "small.jsonl"));
  for (const content of ["first", "second"]) await deps.transcript.append({ type: "message", message: { role: "user", content } });
  const head = deps.transcript.head();
  expect(await compact(deps, true)).toBe(false);
  expect(deps.transcript.head()).toBe(head);
  await deps.transcript.append({ type: "message", message: { role: "assistant", content: "a".repeat(20000) } });
  await deps.transcript.append({ type: "message", message: { role: "user", content: "new" } });
  await deps.transcript.append({ type: "message", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "missing", content: "orphan" }] } });
  deps.provider = fakeProvider([[text("summary")]]);
  const before = deps.transcript.head();
  expect(await compact(deps, true)).toBe(false);
  expect(deps.transcript.head()).toBe(before);
});
test("resolver is consulted before compaction and summarizer uses newly selected provider", async () => {
  const { deps, dir } = await fixture(); process.env.PARALLELS_HOME = dir;
  deps.model = "gpt-6-astra";
  deps.compaction = { fallback: 20000 };
  const selected = fakeProvider([[text("Goal and progress summary")], [text("done")]]);
  deps.resolveModel = async () => ({ model: "smaller-unknown", provider: selected });
  await createAgent(deps).run();
  expect(selected.calls).toHaveLength(2);
  expect(selected.calls).toHaveLength(2);
  expect(selected.calls[0]?.tools).toEqual([]);
});
test("restart ignores truncated checkpoint and subsequent append remains readable", async () => {
  const { transcript } = await fixture();
  const { appendFile } = await import("node:fs/promises");
  const before = await transcript.chain();
  await appendFile(transcript.path, '{"type":"summary","text":"truncated');
  const restarted = open(transcript.path);
  expect(await restarted.chain()).toEqual(before);
  await restarted.append({ type: "message", message: { role: "user", content: "after crash" } });
  expect(await open(transcript.path).chain()).toEqual([...before, { role: "user", content: "after crash" }]);
});


test("scheduled compaction retains full UI replay and forwards subsequent tool events", async () => {
  const { transcript, dir } = await fixture();
  process.env.PARALLELS_HOME = dir;
  const originals = transcript.history!();
  const provider = fakeProvider([
    [text("Goal: original requirements. Progress: old answer. Next: recent task.")],
    [text("Running a check."), toolUse("check-1", "check", {})],
    [text("Finished.")],
  ]);
  const events: string[] = [];
  const plain: string[] = [];
  const orch = await createOrchestrator({
    project: "compaction-ui", transcript, provider,
    tools: { check: { spec: { name: "check", description: "Check", input_schema: { type: "object" } }, run: async () => "checked" } },
    write: (value, isPlain) => { if (isPlain) plain.push(value); },
    onInbox: messages => { events.push(...messages.map(m => `inbox:${m.text}`)); },
    onTool: call => { events.push(`start:${call.id}`); },
    onToolResult: result => { events.push(`end:${result.id}:${result.ok}`); },
  });
  await orch.compact!();
  await orch.turn();
  expect(orch.entries!()).toEqual(originals);
  expect(restore(orch.entries!(), 100)).toEqual(restore(originals, 100));
  expect(plain.some(line => line.includes("compaction complete"))).toBe(true);
  await orch.say("check now");
  expect(events).toEqual([]);
  await orch.turn();
  expect(events).toEqual(["inbox:check now", "start:check-1", "end:check-1:true"]);
  expect(plain.some(line => line.includes("⏺"))).toBe(false);
  expect(orch.entries!()).toEqual(open(transcript.path).history!());
  expect(restore(orch.entries!(), 100)).toEqual(restore(open(transcript.path).history!(), 100));
});
