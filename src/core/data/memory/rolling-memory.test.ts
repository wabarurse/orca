import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { createAgent, type AgentDeps } from "../../agent-loop/loop/agent";
import { runAgent } from "../../../exec/run";
import { budget, estimate } from "./compaction";
import { paths, saveConfig } from "../../../config/config";
import { put } from "../inbox/inbox";
import { archivePath, purgeProject, queryHistory } from "./archive";
import { createOrchestrator } from "../../agent-loop/orc/orchestrator";
import type { CompleteRequest, Provider } from "../../../providers/provider";
import { RollingCompactor, rollingCut, type RollingOptions } from "./rolling-memory";
import { parseMemory, summarizeOlder } from "./rolling-summary";
import type { RollingMemory } from "../../../protocol/transcript";
import { observeTaskPR, registerTask, setTaskAttention } from "../tasks/tasks";
import { fakeProvider, text, toolUse } from "../../../test/fake-provider";
import { paired } from "./tool-pairs";
import { open } from "../transcripts/transcript";
import { orchestratorTask as task, task as agentTask } from "../../tools/task";

const previous = process.env.ORCA_HOME, dirs: string[] = [], compacters: RollingCompactor[] = [];
afterEach(() => {
  compacters.splice(0).forEach(c => c.reset());
  process.env.ORCA_HOME = previous;
  dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true }));
});
const memory = (patch: Partial<RollingMemory> = {}): RollingMemory => ({ user: ["Prefers concise responses"], project: ["Use Bun"], pending: [], tasks: [], ...patch });
const answer = (value = memory()) => ({ content: [text(JSON.stringify(value))], completion: "completed", stop: "end" as const });
function gated(value = memory()) {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const calls: CompleteRequest[] = [];
  const provider: Provider = { name: "openai", models: async () => [], complete: async request => {
    calls.push(request); entered.resolve(); await release.promise; return answer(value);
  } };
  return { provider, calls, entered: entered.promise, release: release.resolve };
}
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "rolling-memory-")); dirs.push(dir); process.env.ORCA_HOME = dir;
  const project = "p", transcript = open(paths.transcript(project, "orchestrator"));
  mkdirSync(paths.repo(project), { recursive: true }); // the binding the daemon expects; without it the one-shot CLI sees a deleted project
  await saveConfig({ model: "gpt-6-sol" });
  for (const [role, content] of [["user", "Prefers concise responses. Use Bun. " + "old work ".repeat(2500)], ["assistant", "old findings ".repeat(2500)], ["user", "recent question"], ["assistant", "recent answer"]] as const) {
    await transcript.append({ type: "message", message: { role, content } });
  }
  const foreground = fakeProvider([[text("foreground answer")]]);
  const deps: AgentDeps = { model: "gpt-6-sol", provider: foreground, tools: {}, transcript, ctx: { project, role: "orchestrator", cwd: dir }, compaction: {}, write() {} };
  const controller = (provider: Provider, extra = {}) => {
    const result = new RollingCompactor(project, transcript, { triggerTokens: 5000, tailTokens: 200, loadProvider: async () => provider, ...extra });
    compacters.push(result); return result;
  };
  return { dir, project, transcript, foreground, deps, controller };
}
async function settle(controller: RollingCompactor) {
  for (let i = 0; i < 100 && !controller.ready(); i++) await Bun.sleep(1);
  expect(controller.ready()).toBe(true);
}

test("tail splitting retains complete tool exchanges, including an oversized newest batch", () => {
  const messages: MessageParam[] = [
    { role: "user", content: "older work".repeat(1000) },
    { role: "assistant", content: [toolUse("a", "bash", {}), toolUse("b", "bash", {})] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "a".repeat(3000) }, { type: "tool_result", tool_use_id: "b", content: "ok" }] },
  ];
  const cut = rollingCut(messages, 100);
  expect(cut).toBe(1); expect(paired(messages.slice(cut))).toBe(true); expect(paired(messages.slice(0, cut))).toBe(true);
  expect(() => rollingCut(messages.slice(0, -1), 100)).toThrow("grammar");
});

test("foreground proceeds while Luna works; idle publication preserves newer messages and full replay", async () => {
  const { project, transcript } = await fixture(), worker = gated();
  const foreground = fakeProvider([[toolUse("check", "check", {})], [text("continuing without waiting")]]);
  const original = transcript.history!(), before = await transcript.chain();
  const orch = await createOrchestrator({ project, transcript, provider: foreground, write() {},
    tools: { check: { spec: { name: "check", description: "check", input_schema: { type: "object" } }, run: async () => "checked" } },
    rolling: { triggerTokens: 5000, tailTokens: 200, loadProvider: async () => worker.provider } });
  await orch.say("Actually, use detailed explanations for this task.");
  await orch.turn(); await worker.entered;
  expect(foreground.calls).toHaveLength(2); expect(worker.calls).toHaveLength(1);
  expect(worker.calls[0]).toMatchObject({ model: "gpt-6-luna", tools: [], settings: { effort: "low", fast: false }, maxTokens: 4096 });
  expect(transcript.branch()[0]?.type).toBe("message");
  const recent = (await transcript.chain()).slice(2), history = transcript.history!();
  worker.release();
  for (let i = 0; i < 100 && !await orch.pending(); i++) await Bun.sleep(1);
  expect(await orch.pending()).toBe(true);
  await orch.turn();
  expect(foreground.calls).toHaveLength(2); expect(await orch.pending()).toBe(false);
  expect((await transcript.chain()).slice(1)).toEqual(recent);
  expect(transcript.history!()).toEqual(history); expect(history.slice(0, original.length)).toEqual(original);
  expect(estimate(await transcript.chain())).toBeLessThan(estimate(before) / 5);
  expect(await open(transcript.path).chain()).toEqual(await transcript.chain());
  const db = new Database(archivePath(), { readonly: true });
  try {
    // history() also replays model-request diagnostics; only message entries are
    // counted by this query. Verify every original entry's raw archive separately.
    expect(db.query("SELECT count(*) AS n FROM entries WHERE kind='message'").get())
      .toEqual({ n: history.filter(e => e.type === "message").length });
    expect(history.filter(e => e.type === "model-request").map(e => e.stage))
      .toEqual(["preparing", "provider-wait", "completed", "preparing", "provider-wait", "completed"]);
    const archived = db.query("SELECT raw FROM entries WHERE project=? AND agent='orchestrator' AND id=?");
    for (const entry of history) {
      const row = archived.get(project, entry.uuid) as { raw: string } | null;
      expect(row).not.toBeNull();
      expect(JSON.parse(row!.raw)).toEqual(entry);
    }
  }
  finally { db.close(); }
});

test("merge during summary drops task notes; cancelled and closed-unmerged tasks remain explicit", async () => {
  const { project, transcript, deps, controller } = await fixture();
  const finished = await registerTask(project, { name: "Ship feature", summary: "Feature", branch: "feat/ship", authorized: true });
  const cancelled = await registerTask(project, { name: "Paused feature", summary: "Pause", branch: "feat/pause", authorized: true });
  await setTaskAttention(project, cancelled.id, { kind: "cancelled", reason: "User said stop" });
  const closed = await registerTask(project, { name: "Closed feature", summary: "Closed", branch: "feat/closed", authorized: true });
  await setTaskAttention(project, closed.id, { kind: "closed", reason: "Closed without merge" });
  const worker = gated(memory({ tasks: [{ id: finished.id, notes: "old next step" }, { id: cancelled.id, notes: "Do not restart" }] }));
  const rolling = controller(worker.provider);
  await rolling.boundary(deps); await worker.entered;
  await observeTaskPR(project, finished.id, { branch: finished.branch, state: "MERGED", ready: false, checks: "not_configured", mergedAt: new Date().toISOString(),
    pr: { repository: "o/r", number: 1, url: "https://github.com/o/r/pull/1", head: "a".repeat(40) } });
  worker.release(); await settle(rolling); await rolling.boundary(deps);
  const summary = transcript.branch()[0];
  expect(summary?.type).toBe("summary");
  if (summary?.type !== "summary") return;
  expect(summary.text).not.toContain(finished.id);
  expect(summary.text).toContain(cancelled.id); expect(summary.text).toContain('"kind":"cancelled"');
  expect(summary.text).toContain(closed.id); expect(summary.text).toContain('"kind":"closed"');
});

test("hard-limit boundary waits for one worker and never sends an oversized foreground request", async () => {
  const { deps, controller, foreground } = await fixture(), worker = gated(), rolling = controller(worker.provider);
  deps.compaction = { contextLimit: 20000, outputReserve: 2000 };
  deps.compactBoundary = (d, manual) => rolling.boundary(d, manual);
  const run = createAgent(deps).run(); await worker.entered;
  expect(foreground.calls).toHaveLength(0);
  worker.release(); await run;
  expect(foreground.calls).toHaveLength(1); expect(worker.calls).toHaveLength(1);
  expect(estimate(foreground.calls[0]!.messages)).toBeLessThan(5000);
});

test("default trigger is 40% of the model window, capped by safe input; explicit triggerTokens wins", async () => {
  const { deps, transcript } = await fixture();
  let calls = 0;
  const provider: Provider = { name: "openai", models: async () => [], complete: async () => { calls++; return answer(); } };
  const probe = async (model: string, compaction: NonNullable<AgentDeps["compaction"]>, input: number, options: RollingOptions = {}) => {
    const rolling = new RollingCompactor("p", transcript, { tailTokens: 200, loadProvider: async () => provider, ...options }); compacters.push(rolling);
    const probed = { ...deps, model, compaction: { ...compaction } };
    const estimated = budget(probed, await transcript.chain());
    probed.compaction.measured = { model, input, estimated };
    const before = calls;
    await rolling.boundary(probed);
    for (let i = 0; i < 100 && rolling.ready() !== (calls > before); i++) await Bun.sleep(1);
    rolling.reset();
    return calls > before;
  };
  // 1M window: 400k by default, well above the old fixed 100k.
  expect(await probe("claude-opus-5-5", {}, 150000)).toBe(false);
  expect(await probe("claude-opus-5-5", {}, 399000)).toBe(false);
  expect(await probe("claude-opus-5-5", {}, 401000)).toBe(true);
  // Small usable context: .8 * (.8 * 100k - 40k) = 32k caps the 40k default.
  expect(await probe("gpt-6-sol", { contextLimit: 100000, outputReserve: 40000 }, 31000)).toBe(false);
  expect(await probe("gpt-6-sol", { contextLimit: 100000, outputReserve: 40000 }, 33000)).toBe(true);
  // An explicit absolute trigger replaces the percentage in both directions.
  expect(await probe("claude-opus-5-5", {}, 150000, { triggerTokens: 100000 })).toBe(true);
  expect(await probe("claude-opus-5-5", {}, 450000, { triggerTokens: 600000 })).toBe(false);
});

test("default trigger retains about 20k verbatim through repeated cycles and restart", async () => {
  const { project, deps } = await fixture();
  deps.transcript = open(paths.transcript(project, "long-orchestrator"));
  deps.compaction = { contextLimit: 250000 }; // 40% default trigger = 100k input tokens
  let calls = 0;
  const provider: Provider = { name: "openai", models: async () => [], complete: async () => { calls++; return answer(); } };
  for (let cycle = 0; cycle < 3; cycle++) {
    const rolling = new RollingCompactor(project, deps.transcript, { loadProvider: async () => provider }); compacters.push(rolling);
    for (let i = 0; i < 80; i++) await deps.transcript.append({ type: "message", message: { role: i % 2 ? "assistant" : "user", content: `Cycle ${cycle} item ${i}: ` + "x".repeat(4000) } });
    const before = await deps.transcript.chain(), cut = rollingCut(before, 20000), originals = deps.transcript.history!();
    expect(estimate(before)).toBeGreaterThan(100000);
    await rolling.boundary(deps); await settle(rolling); await rolling.boundary(deps);
    const after = await deps.transcript.chain();
    expect(after.slice(1)).toEqual(before.slice(cut));
    expect(estimate(after)).toBeLessThan(22000); expect(estimate(after.slice(1))).toBeGreaterThan(17000);
    expect(deps.transcript.history!()).toEqual(originals);
    deps.transcript = open(deps.transcript.path);
    expect(await deps.transcript.chain()).toEqual(after);
  }
  expect(calls).toBe(6); // Two bounded source requests each cycle; no full transcript resubmission.
});

test("disabled automatic compaction does no archive or inference work; manual still works", async () => {
  const { project, deps, transcript, controller } = await fixture();
  const provider = fakeProvider([[text(JSON.stringify(memory()))]]), rolling = controller(provider);
  deps.compaction = { enabled: false };
  await rolling.boundary(deps);
  expect(provider.calls).toHaveLength(0); expect(await Bun.file(archivePath()).exists()).toBe(false);
  await rolling.boundary(deps, true);
  expect(provider.calls).toHaveLength(1); expect(transcript.branch()[0]?.type).toBe("summary");
});

test("a failed summary at the hard limit never calls the foreground model", async () => {
  const { deps, foreground, transcript, controller } = await fixture();
  const rolling = controller(fakeProvider([[text("invalid memory")]]));
  deps.compaction = { contextLimit: 20000, outputReserve: 2000 };
  deps.compactBoundary = (d, m) => rolling.boundary(d, m);
  const before = await Bun.file(transcript.path).text();
  await expect(createAgent(deps).run()).rejects.toThrow("context blocked");
  expect(foreground.calls).toHaveLength(0); expect(await Bun.file(transcript.path).text()).toBe(before);
});

for (const mode of ["malformed", "incomplete", "timeout", "credentials"] as const) test(`${mode} summary keeps originals and does not hot-loop`, async () => {
  const { transcript, deps, controller } = await fixture();
  let calls = 0;
  const provider: Provider = { name: "openai", models: async () => [], complete: async () => {
    calls++;
    if (mode === "timeout") return new Promise(() => {});
    if (mode === "credentials") throw new Error("Login required");
    return { ...answer(), content: mode === "malformed" ? [text("not json")] : answer().content, completion: mode === "incomplete" ? "length" : "completed" };
  } };
  const rolling = controller(provider, { timeoutMs: 10 }), before = await Bun.file(transcript.path).text();
  await rolling.boundary(deps, true);
  await rolling.boundary(deps);
  expect(calls).toBe(1); expect(await Bun.file(transcript.path).text()).toBe(before); expect(rolling.ready()).toBe(false);
});

test("archive failure prevents replacement but a fitting foreground request can continue", async () => {
  const { project, transcript, foreground, deps, controller } = await fixture(), worker = gated(), rolling = controller(worker.provider);
  mkdirSync(archivePath());
  deps.compactBoundary = (d, m) => rolling.boundary(d, m);
  await createAgent(deps).run();
  expect(foreground.calls).toHaveLength(1); expect(worker.calls).toHaveLength(0);
  expect(transcript.branch()[0]?.type).toBe("message");
});

test("cancel and clear discard an in-flight result, including a provider ignoring abort", async () => {
  const { project, transcript } = await fixture(), worker = gated();
  const orch = await createOrchestrator({ project, transcript, provider: fakeProvider([[text("done")]]), tools: {}, write() {},
    rolling: { triggerTokens: 5000, tailTokens: 200, loadProvider: async () => worker.provider } });
  await orch.say("go"); await orch.turn(); await worker.entered;
  orch.cancel!(); expect(worker.calls[0]!.signal!.aborted).toBe(true);
  await orch.clear!(); worker.release(); await Bun.sleep(1);
  expect(await orch.pending()).toBe(false); expect(await transcript.chain()).toEqual([]);
  expect(JSON.parse(await queryHistory(project, { action: "search_history", query: "old work" })).entries).toEqual([]);
  expect(transcript.history!().filter(e => e.type === "message").length).toBeGreaterThan(4);
});

test("closing an orchestrator session aborts its worker and cannot start another", async () => {
  const { deps, transcript, controller } = await fixture(), worker = gated(), rolling = controller(worker.provider);
  await rolling.boundary(deps); await worker.entered;
  const before = await Bun.file(transcript.path).text();
  rolling.dispose(); expect(worker.calls[0]!.signal!.aborted).toBe(true);
  worker.release(); await Bun.sleep(1);
  await rolling.boundary(deps, true);
  expect(rolling.ready()).toBe(false); expect(worker.calls).toHaveLength(1);
  expect(await Bun.file(transcript.path).text()).toBe(before);
});

test("the one-shot orchestrator CLI also uses Luna and joins its worker before exiting", async () => {
  const { project, transcript, foreground } = await fixture(), worker = gated();
  let ended = false;
  await put(project, "orchestrator", { from: "user", text: "continue", inputId: "cli" });
  const run = runAgent({ project, role: "orchestrator", exitWhenIdle: true, loadProvider: async () => foreground,
    rolling: { triggerTokens: 5000, tailTokens: 200, loadProvider: async () => worker.provider } }).then(code => { ended = true; return code; });
  await worker.entered;
  for (let i = 0; i < 100 && !foreground.calls.length; i++) await Bun.sleep(1);
  expect(foreground.calls).toHaveLength(1); expect(ended).toBe(false);
  worker.release(); expect(await run).toBe(0);
  expect(open(transcript.path).branch()[0]?.type).toBe("summary");
  expect(worker.calls[0]!.model).toBe("gpt-6-luna");
});

test("a late worker cannot publish into a deleted/recreated project, add archive rows, or leave rows behind", async () => {
  const { project, transcript, deps, controller } = await fixture(), worker = gated(), rolling = controller(worker.provider);
  await rolling.boundary(deps); await worker.entered;
  const state = () => {
    const db = new Database(archivePath(), { readonly: true });
    try {
      return db.query(`SELECT (SELECT count(*) FROM entries WHERE project=?1) AS n, (SELECT max(rowid) FROM entries WHERE project=?1) AS top,
        (SELECT indexed_at FROM sources WHERE project=?1) AS at`).get(project) as { n: number; top: number; at: string };
    } finally { db.close(); }
  };
  const before = state();
  expect(before.n).toBeGreaterThan(0);
  rmSync(paths.project(project), { recursive: true }); mkdirSync(paths.project(project));
  worker.release(); await settle(rolling); await rolling.boundary(deps);
  expect(await Bun.file(transcript.path).exists()).toBe(false);
  expect(transcript.branch().some(e => e.type === "summary")).toBe(false);
  expect(state()).toEqual(before); // the late worker neither re-indexed nor changed the old rows
  purgeProject(project);
  expect(state()).toEqual({ n: 0, top: null, at: null } as unknown as ReturnType<typeof state>);
  const db = new Database(archivePath(), { readonly: true });
  try { expect(db.query("SELECT count(*) AS n FROM entry_search WHERE entry_search MATCH 'old'").get()).toEqual({ n: 0 }); } finally { db.close(); }
});

test("repeated rolling checkpoints carry user memory forward and never duplicate the tail", async () => {
  const { transcript, deps, controller } = await fixture();
  const calls: CompleteRequest[] = [];
  const rolling = controller({ name: "openai", models: async () => [], complete: async req => { calls.push(req); return answer(); } });
  await rolling.boundary(deps, true);
  await transcript.append({ type: "message", message: { role: "user", content: "next work ".repeat(2500) } });
  await transcript.append({ type: "message", message: { role: "assistant", content: "latest answer" } });
  const history = transcript.history!();
  await rolling.boundary(deps, true);
  expect(calls).toHaveLength(2); expect(JSON.stringify(calls[1]!.messages)).toContain("Prefers concise responses");
  expect(transcript.history!()).toEqual(history);
  expect((await open(transcript.path).chain()).at(-1)?.content).toBe("latest answer");
});

test("oversized source is summarized in bounded parts with previous memory and without reasoning", async () => {
  const calls: CompleteRequest[] = [];
  const provider: Provider = { name: "openai", models: async () => [], complete: async req => { calls.push(req); return answer(); } };
  const source: MessageParam[] = [{ role: "assistant", content: [{ type: "thinking", thinking: "DO_NOT_SEND_REASONING", signature: "signature" }, text("🙂".repeat(60000))] }];
  await summarizeOlder(source, [], new AbortController().signal, async () => provider);
  expect(calls).toHaveLength(2);
  expect(JSON.stringify(calls)).not.toContain("DO_NOT_SEND_REASONING");
  expect(JSON.stringify(calls)).not.toContain("�");
  expect(JSON.stringify(calls[1]!.messages)).toContain("Prefers concise responses");
  for (const call of calls) expect(estimate(call.messages)).toBeLessThan(70000);
});

test("structured summaries reject unknown tasks, invalid fields and oversized output", () => {
  expect(() => parseMemory(JSON.stringify(memory({ tasks: [{ id: "invented", notes: "do it" }] })), [])).toThrow("unknown task");
  expect(() => parseMemory(JSON.stringify({ user: "invalid" }), [])).toThrow();
  expect(() => parseMemory(JSON.stringify(memory({ user: ["x".repeat(1100)] })), [])).toThrow("invalid memory");
  expect(() => parseMemory("x".repeat(12000), [])).toThrow("budget");
});

test("summary task allowlist keeps active notes and removes verified merged notes", async () => {
  const { project } = await fixture();
  const active = await registerTask(project, { name: "Active", summary: "Work", branch: "active", authorized: true });
  const merged = await registerTask(project, { name: "Merged", summary: "Done", branch: "merged", authorized: true });
  const archived = { ...merged, archive: { reason: "merged" as const, mergedAt: merged.createdAt, archivedAt: merged.createdAt, pr: { repository: "o/r", number: 1, url: "https://github.com/o/r/pull/1", head: "a".repeat(40) } } };
  const result = memory({ tasks: [{ id: active.id, notes: "next" }, { id: merged.id, notes: "done" }] });
  const calls: CompleteRequest[] = [];
  const provider: Provider = { name: "openai", models: async () => [], complete: async req => { calls.push(req); return answer(result); } };
  const parsed = await summarizeOlder([{ role: "user", content: `Completed ${merged.id}` }], [active, archived], new AbortController().signal, async () => provider);
  expect(parsed.tasks).toEqual([{ id: active.id, notes: "next" }]);
  const input = JSON.parse(calls[0]!.messages[0]!.content as string);
  expect(input.taskIds).toEqual([active.id]);
  expect(input.registry.map((t: { id: string }) => t.id)).toEqual([active.id, merged.id]);
});

test("out-of-snapshot summary references fail closed with safe source diagnostics", async () => {
  const { project, transcript, deps, controller } = await fixture();
  const outside = "unverified-private-reference";
  // A historical reference is not evidence of registration in this project/snapshot.
  await transcript.append({ type: "message", message: { role: "user", content: outside + " old context ".repeat(3000) } });
  await transcript.append({ type: "message", message: { role: "assistant", content: "recent tail" } });
  const before = await transcript.chain(), head = transcript.head();
  const notices: string[] = [];
  deps.write = text => { notices.push(text); };
  const worker = gated(memory({ tasks: [{ id: outside, notes: "private notes" }] }));
  const rolling = controller(worker.provider);
  await rolling.boundary(deps); await worker.entered;
  // New registration while inference is in flight must not authorize an unknown output.
  await registerTask(project, { name: "New arrival", summary: "New work", branch: "new-arrival", authorized: true });
  worker.release(); await settle(rolling); await rolling.boundary(deps, false, true);
  expect(await transcript.chain()).toEqual(before);
  expect(transcript.head()).toBe(head);
  const notice = notices.find(n => n.includes("unknown task in memory"))!;
  expect(notice).toContain("original history kept");
  expect(notice).toContain("reference occurs in source");
  expect(notice).toContain("0 tasks");
  expect(notice).not.toContain(outside);
  expect(notice).not.toContain("private notes");
  expect(() => parseMemory(JSON.stringify(memory({ tasks: [{ id: outside, notes: "private notes" }] })), [], "unrelated source"))
    .toThrow("reference absent from source");
});

test("SQLite retrieval finds merged tasks and exact original pages; rebuild is idempotent and scoped", async () => {
  const { project, transcript, deps } = await fixture();
  const t = await registerTask(project, { name: "Search migration", summary: "Replace search", branch: "feat/search", authorized: true });
  const body = `Task ${t.id} search migration evidence ` + "🙂".repeat(3000);
  const entry = await transcript.append({ type: "message", message: { role: "user", content: body } });
  await observeTaskPR(project, t.id, { branch: t.branch, state: "MERGED", ready: false, checks: "not_configured", mergedAt: new Date().toISOString(),
    pr: { repository: "o/r", number: 2, url: "https://github.com/o/r/pull/2", head: "b".repeat(40) } });
  const query = { action: "search_history", query: "search migration", status: "merged", limit: 1 };
  const result = JSON.parse(await task.run(query, deps.ctx));
  expect(result.tasks[0]).toMatchObject({ id: t.id, status: "merged" });
  expect(result.entries).toHaveLength(1); expect(result.entries[0].entryId).toBe(entry.uuid);
  expect(result.entries[0].excerpt.length).toBeLessThanOrEqual(400);
  const first = JSON.parse(await queryHistory(project, { action: "read_history", entryId: entry.uuid }));
  const second = JSON.parse(await queryHistory(project, { action: "read_history", entryId: entry.uuid, offset: first.nextOffset }));
  expect(first.nextOffset).toBe(2048); expect(second.offset).toBe(2048);
  expect(first.text + second.text).toBe([...`[user] ${body}`].slice(0, 4096).join(""));
  rmSync(archivePath());
  expect(JSON.parse(await queryHistory(project, query))).toEqual(result);
  const db = new Database(archivePath(), { readonly: true });
  try { expect(JSON.parse((db.query("SELECT raw FROM entries WHERE id=?").get(entry.uuid) as { raw: string }).raw)).toEqual(entry); }
  finally { db.close(); }
  expect(await task.run(query, { ...deps.ctx, role: "worker" })).toContain("only the orchestrator");
  expect(JSON.stringify(agentTask.spec)).not.toContain("search_history");
  expect(await task.run({ ...query, limit: 500 }, deps.ctx)).toContain("refused");
  expect(JSON.parse(await queryHistory(project, { action: "search_history", query: "\" OR 1=1; --" })).entries).toEqual([]);
  await transcript.append({ type: "context-boundary" });
  expect(JSON.parse(await queryHistory(project, query)).tasks).toEqual([]);
  await expect(queryHistory(project, { action: "read_history", entryId: entry.uuid })).rejects.toThrow("current context");
});
