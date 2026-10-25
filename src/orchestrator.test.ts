// End to end over the real transcript, tasks, inbox and tools, with a scripted
// model and a fake runner so nothing hits the API, git or tmux.

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, paths, saveConfig } from "./config";
import { put } from "./inbox";
import { createOrchestrator, ensureProject } from "./orchestrator";
import { DYNAMIC_DISPATCH } from "./prompts";
import type { Runner, StartOptions } from "./runner";
import { fakeProvider, text, toolUse } from "./test/fake-provider";
import { message } from "./tools/message";
import { startTaskRun, stopTaskRun } from "./tasks";
import { task } from "./tools/task";
import { makeSpawn } from "./tools/spawn";
import { open } from "./transcript";

const home = mkdtempSync(join(tmpdir(), "orca-e2e-"));
process.env.ORCA_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));

const started: StartOptions[] = [];
const runner: Runner = {
  async start(o) {
    await startTaskRun(o.project, o.run!);
    await stopTaskRun(o.project, o.run!, "waiting", "Fake agent reported");
    started.push({ project: o.project, role: o.role, branch: o.branch });
  },
  async stop() {},
  async running() { return []; },
};
const tools = { task, spawn: makeSpawn(runner), message };
const project = "demo";
const taskId = crypto.randomUUID();

test("user asks for a feature: orchestrator spawns a worker and replies", async () => {
  const provider = fakeProvider([
    [toolUse("register", "task", { action: "register", taskId, name: "Login", summary: "Add login page", branch: "feat/login", authorized: true })],
    [text("Splitting that into one task."), toolUse("tu1", "spawn", { taskId, prompt: "Add a login page", branch: "feat/login" })],
    [toolUse("tu2", "message", { to: "user", text: "Started a worker on feat/login." })],
    [text("done")],
  ]);
  const orch = await createOrchestrator({ project, provider, tools, write: () => {} });
  await orch.say("build me a login page");
  expect(await orch.pending()).toBe(true);

  const replies = await orch.turn();
  expect(replies.map((r) => r.text)).toEqual(["Started a worker on feat/login."]);
  expect(started).toEqual([{ project, role: "worker", branch: "feat/login" }]);
  expect(await orch.pending()).toBe(false);

  // The inbox message reached the model as one user message with the sender tagged.
  expect(provider.calls[0]!.messages.at(-1)?.content).toBe("[user] build me a login page");
});

test("worker reports back: orchestrator spawns a reviewer on the same branch", async () => {
  const provider = fakeProvider([
    [toolUse("tu3", "spawn", { taskId, prompt: "Review PR #12", branch: "feat/login", role: "reviewer", reviewMode: "review" }), toolUse("tu4", "message", { to: "user", text: "feat/login is in review." })],
    [text("ok")],
  ]);
  const orch = await createOrchestrator({ project, provider, tools, write: () => {} });
  await put(project, "orchestrator", { from: "worker-feat-login", text: "Done, PR #12" });

  const replies = await orch.turn();
  expect(replies[0]?.text).toBe("feat/login is in review.");
  expect(started.at(-1)).toEqual({ project, role: "reviewer", branch: "feat/login" });
});

test("the orchestrator transcript persists across restarts", async () => {
  const t = open(paths.transcript(project, "orchestrator"));
  const chain = await t.chain();
  expect(chain[0]?.content).toBe("[user] build me a login page");
  expect(chain.some((m) => typeof m.content === "string" && m.content.includes("[worker-feat-login] Done, PR #12"))).toBe(true);
});

test("a turn with an empty inbox does nothing", async () => {
  const provider = fakeProvider([]);
  const orch = await createOrchestrator({ project, provider, tools, write: () => {} });
  expect(await orch.turn()).toEqual([]);
  expect(provider.calls).toHaveLength(0);
});

test("spawn seeded the worker and reviewer transcripts with their prompts", async () => {
  const worker = await open(paths.transcript(project, "worker-feat-login")).chain();
  expect(worker[0]?.content).toBe("Branch: feat/login\n\nAdd a login page");
  const reviewer = await open(paths.transcript(project, "reviewer-feat-login")).chain();
  expect(reviewer[0]?.content).toBe("Branch: feat/login\n\nReview PR #12");
});

test("ensureProject binds an existing main checkout without creating a clone", async () => {
  const source = join(home, "..", `orca-source-${crypto.randomUUID()}`);
  await Bun.$`git init -q -b main ${source}`.quiet();
  try {
    await ensureProject("fresh", source);
    const head = Bun.file(paths.repo("fresh") + "/.git/HEAD");
    expect(await head.exists()).toBe(true);
    await ensureProject("fresh"); // idempotent
    expect(await head.exists()).toBe(true);
    expect(await Bun.file(join(paths.project("fresh"), "repo", ".git", "HEAD")).exists()).toBe(false);
  } finally { rmSync(source, { recursive: true, force: true }); }
});

test("onInbox gets each batch as it is read, and the turn's replies are kept in the transcript", async () => {
  const provider = fakeProvider([
    [toolUse("tu9", "message", { to: "user", text: "On it." })],
    [text("ok")],
  ]);
  const seen: string[][] = [];
  const orch = await createOrchestrator({ project: "inboxes", provider, tools, write: () => {}, onInbox: (msgs) => seen.push(msgs.map((m) => `${m.from}: ${m.text}`)) });
  await put("inboxes", "orchestrator", { from: "user", text: "hi" });
  await put("inboxes", "orchestrator", { from: "worker-a", text: "done" });
  expect((await orch.turn()).map((r) => r.text)).toEqual(["On it."]);
  expect(seen).toEqual([["user: hi", "worker-a: done"]]);
  const branch = orch.entries!();
  expect(branch.at(-1)).toMatchObject({ type: "replies", messages: [{ from: "orchestrator", text: "On it." }] });
  expect(open(paths.transcript("inboxes", "orchestrator")).branch().map((e) => e.type)).toEqual(branch.map((e) => e.type));
  // The replies entry is not sent to the model.
  expect((await open(paths.transcript("inboxes", "orchestrator")).chain()).length).toBe(branch.filter((e) => e.type === "message").length);
});

test("cancelling a turn aborts the provider, pauses inbox polling, and next message resumes saved history", async () => {
  const project = "cancel-orch";
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const seen: import("./providers").CompleteRequest[] = [];
  let aborted = false;
  const provider: import("./providers").Provider = { name: "anthropic", async models() { return []; }, async complete(req) {
    seen.push(req);
    if (seen.length > 1) return { stop: "end", content: [text("resumed")] };
    started();
    return new Promise((_resolve, reject) => req.signal!.addEventListener("abort", () => { aborted = true; reject(req.signal!.reason); }, { once: true }));
  } };
  const orch = await createOrchestrator({ project, provider, tools: {}, write() {} });
  await orch.say("remember original");
  const turn = orch.turn();
  await ready;
  orch.cancel!();
  await turn;
  expect(aborted).toBe(true);
  await put(project, "orchestrator", { from: "worker-other", text: "background report" });
  expect(await orch.pending()).toBe(false);
  await orch.turn();
  expect(seen).toHaveLength(1);
  await orch.say("continue now");
  expect(await orch.pending()).toBe(true);
  await orch.turn();
  expect(seen).toHaveLength(2);
  expect(JSON.stringify(seen[1]!.messages)).toContain("remember original");
  expect(JSON.stringify(seen[1]!.messages)).toContain("background report");
  expect(JSON.stringify(seen[1]!.messages)).toContain("continue now");
  expect(seen[1]!.signal!.aborted).toBe(false);
});

test("a new external user message (including a question answer) resumes a paused orchestrator", async () => {
  const project = "external-resume";
  const provider = fakeProvider([[text("answer received")]]);
  const orch = await createOrchestrator({ project, provider, tools: {}, write() {} });
  await put(project, "orchestrator", { from: "user", text: "already queued" });
  orch.cancel!();
  expect(await orch.pending()).toBe(false);
  await Bun.sleep(2);
  await put(project, "orchestrator", { from: "worker-other", text: "still running" });
  expect(await orch.pending()).toBe(false);
  await put(project, "orchestrator", { from: "user", text: "new answer" });
  expect(await orch.pending()).toBe(true);
  await orch.turn();
  expect(provider.calls).toHaveLength(1);
  expect(JSON.stringify(provider.calls[0]!.messages)).toContain("new answer");
});

test("say submitted before cancellation cannot resume when its persistence finishes afterward", async () => {
  const project = "delayed-say";
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let defer = true;
  const provider = fakeProvider([[text("resumed with both messages")]]);
  const orch = await createOrchestrator({ project, provider, tools: {}, write() {},
    put: async (...args) => { if (defer) await gate; return put(...args); },
  });
  const earlier = orch.say("submitted before cancel");
  orch.cancel!();
  defer = false;
  release();
  await earlier;
  expect(await orch.pending()).toBe(false);
  await orch.turn();
  expect(provider.calls).toHaveLength(0);
  await orch.say("authorized later");
  await orch.turn();
  expect(provider.calls[0]!.messages.at(-1)?.content).toBe("[user] submitted before cancel\n\n[user] authorized later");
});

test("external sends and repeated cancellations are ordered even at one timestamp, with no queued input lost", async () => {
  const { spyOn } = await import("bun:test");
  const time = spyOn(Date.prototype, "toISOString").mockReturnValue("2026-01-01T00:00:00.000Z");
  const project = "equal-time";
  const provider = fakeProvider([[text("all received")]]);
  const orch = await createOrchestrator({ project, provider, tools: {}, write() {} });
  try {
    const old = put(project, "orchestrator", { from: "user", text: "before first cancel" });
    orch.cancel!();
    await old;
    expect(await orch.pending()).toBe(false);
    const between = put(project, "orchestrator", { from: "user", text: "between cancels" });
    orch.cancel!();
    await between;
    expect(await orch.pending()).toBe(false);
    await put(project, "orchestrator", { from: "worker-other", text: "background" });
    expect(await orch.pending()).toBe(false);
    await put(project, "orchestrator", { from: "user", text: "after second cancel" });
    expect(await orch.pending()).toBe(true);
    await orch.turn();
    expect(provider.calls[0]!.messages.at(-1)?.content).toBe("[user] before first cancel\n\n[user] between cancels\n\n[worker-other] background\n\n[user] after second cancel");
  } finally { time.mockRestore(); }
});

test("question answers capture authorization at submission, not after asynchronous question writes", async () => {
  const { answer, ask } = await import("./questions");
  const project = "question-order";
  const provider = fakeProvider([[text("question received")]]);
  const orch = await createOrchestrator({ project, provider, tools: {}, write() {} });
  const [first, second] = await ask(project, [{ text: "First?" }, { text: "Second?" }]);
  const preCancel = answer(project, first!.id, "old answer");
  orch.cancel!();
  await preCancel;
  expect(await orch.pending()).toBe(false);
  await answer(project, second!.id, "new answer");
  expect(await orch.pending()).toBe(true);
  await orch.turn();
  const input = JSON.stringify(provider.calls[0]!.messages);
  expect(input).toContain("old answer");
  expect(input).toContain("new answer");
});

test("the real CLI send resumes a cancelled orchestrator across processes", async () => {
  const project = "cli-resume";
  const provider = fakeProvider([[text("cli received")]]);
  const orch = await createOrchestrator({ project, provider, tools: {}, write() {} });
  orch.cancel!();
  const proc = Bun.spawn(["bun", `${import.meta.dir}/cli.ts`, "msg", project, "external continuation"], {
    env: { ...process.env, ORCA_HOME: home }, stdout: "pipe", stderr: "pipe",
  });
  expect(await proc.exited).toBe(0);
  expect(await orch.pending()).toBe(true);
  await orch.turn();
  expect(JSON.stringify(provider.calls[0]!.messages)).toContain("external continuation");
});


test("local prompt identities survive persistence unchanged and are reported only at consumption", async () => {
  const project = "input-identity", seen: import("./inbox").Message[] = [];
  const provider = fakeProvider([[text("received")]]);
  const orch = await createOrchestrator({ project, provider, tools: {}, onInbox: messages => seen.push(...messages) });
  await orch.say("identical", undefined, "local-first");
  await put(project, "orchestrator", { from: "user", text: "identical" });
  await orch.say("identical", undefined, "local-last");
  expect(seen).toEqual([]);
  await orch.turn();
  expect(seen.map(message => message.inputId)).toEqual(["local-first", undefined, "local-last"]);
  expect(provider.calls[0]!.messages.at(-1)?.content).toBe("[user] identical\n\n[user] identical\n\n[user] identical");
  await orch.turn();
  expect(seen).toHaveLength(3);
});

test("header context follows the current chain, invalidates model switches, and isolates sessions", async () => {
  const { effectiveModel } = await import("./project-model");
  const p = "context-header";
  const provider = fakeProvider([[text("a response")]]);
  const orch = await createOrchestrator({ project: p, provider, tools: {}, write: () => {} });
  const model = await effectiveModel(p);
  expect(orch.contextUsage?.(model)).toBeUndefined();
  await orch.say("hello");
  await orch.turn();
  const baseline = orch.contextUsage!(model)!;
  expect(baseline).toBeGreaterThan(0);
  expect(orch.contextUsage!("another-model")).toBeUndefined();
  const t = open(paths.transcript(p, "orchestrator"));
  await t.append({ type: "message", message: { role: "user", content: "x".repeat(15000) } });
  await orch.refresh!();
  expect(orch.contextUsage!(model)!).toBeGreaterThan(baseline + 4000);
  await t.append({ type: "context-boundary" });
  await orch.refresh!();
  expect(orch.contextUsage!(model)!).toBeLessThan(baseline);
  const other = await createOrchestrator({ project: "other-context-header", provider, tools: {}, write: () => {} });
  expect(other.contextUsage!(model)).toBeUndefined();
});

test("header context limit is the one the session's compaction uses", async () => {
  const { saveConfig } = await import("./config");
  const { contextLimit } = await import("./compaction");
  await saveConfig({ contextLimitFallback: 64000 });
  try {
    const p = "context-header-limit";
    const orch = await createOrchestrator({ project: p, provider: fakeProvider([[text("ok")]]), tools: {}, write: () => {} });
    expect(orch.contextWindow!("unlisted-model")).toEqual({ limit: 64000, estimated: true }); // before any turn: configured fallback
    await orch.say("hello");
    await orch.turn();
    expect(orch.contextWindow!("unlisted-model")).toEqual({ limit: 64000, estimated: true });
    expect(contextLimit({ fallback: 64000 }, "unlisted-model")).toBe(64000);
    expect(orch.contextWindow!("claude-opus-5-5")).toEqual({ limit: 1000000, estimated: false });
  } finally { await saveConfig({ contextLimitFallback: 128000 }); }
});

test("context cache is constant-work on unchanged draws and tracks summary retained tails", async () => {
  const { effectiveModel } = await import("./project-model");
  const p = "context-checkpoint", transcript = open(paths.transcript(p, "orchestrator"));
  let branches = 0;
  const branch = transcript.branch;
  transcript.branch = () => { branches++; return branch(); };
  const provider = fakeProvider([[text("first")], [text("second")]]);
  const orch = await createOrchestrator({ project: p, transcript, provider, tools: {}, write: () => {} });
  const model = await effectiveModel(p);
  await orch.say("old context ".repeat(2000));
  await orch.turn();
  const large = orch.contextUsage!(model)!;
  const before = branches;
  for (let i = 0; i < 1000; i++) expect(orch.contextUsage!(model)).toBe(large);
  expect(branches).toBe(before); // no transcript traversal/serialization/estimation
  const retained = [{ role: "user" as const, content: "retained tail ".repeat(100) }];
  await transcript.append({ type: "summary", text: "Compacted checkpoint", retained });
  const compacted = orch.contextUsage!(model)!;
  expect(compacted).toBeLessThan(large);
  expect(branches).toBe(before + 1);
  expect(await transcript.chain()).toEqual([{ role: "user", content: "Compacted checkpoint" }, ...retained]);
  // Same summary text but different retained payload must invalidate the cache.
  await transcript.append({ type: "summary", text: "Compacted checkpoint", retained: [{ role: "user", content: "retained tail ".repeat(300) }] });
  const moreTail = orch.contextUsage!(model)!;
  expect(moreTail).toBeGreaterThan(compacted + 800);
  expect(branches).toBe(before + 2);
  await transcript.append({ type: "summary", text: "Compacted checkpoint" });
  expect(orch.contextUsage!(model)!).toBeLessThan(compacted);
  // A new request captures a new system/tool configuration even with the same
  // model. Warming that snapshot still leaves subsequent draws constant-work.
  await orch.say("continue"); await orch.turn();
  const next = orch.contextUsage!(model), warmed = branches;
  for (let i = 0; i < 100; i++) expect(orch.contextUsage!(model)).toBe(next);
  expect(branches).toBe(warmed);
});

test("/dynamic-dispatch is read per turn: toggling between turns changes the next system prompt", async () => {
  const p = "dispatch-per-turn", systems: (string | undefined)[] = [];
  const base = fakeProvider([[text("one")], [text("two")], [text("three")]]);
  const provider = { ...base, complete: (req: Parameters<typeof base.complete>[0]) => { systems.push(req.system); return base.complete(req); } };
  const orch = await createOrchestrator({ project: p, provider, tools: {}, write: () => {} });
  expect((await loadConfig()).dynamicDispatch).toBe(false);
  try {
    for (const on of [false, true, false]) {
      await saveConfig({ dynamicDispatch: on });
      await orch.say(`turn ${systems.length}`);
      await orch.turn();
    }
  } finally { await saveConfig({ dynamicDispatch: false }); }
  expect(systems.length).toBe(3);
  expect(systems[0]).not.toContain(DYNAMIC_DISPATCH);
  expect(systems[1]).toBe(`${systems[0]}\n\n${DYNAMIC_DISPATCH}`);
  expect(systems[2]).toBe(systems[0]);
});
