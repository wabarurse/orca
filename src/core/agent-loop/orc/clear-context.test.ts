import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrchestrator } from "./orchestrator";
import { open } from "../../data/transcripts/transcript";
import { disk, type Storage } from "../../data/transcripts/transcript-storage";
import { compact } from "../../data/memory/compaction";
import { drain, pendingInput, put } from "../../data/inbox/inbox";
import { paths, saveConfig } from "../../../config/config";
import { projectIdentity, withProjectStateLock } from "../../data/projects/state";
import { fakeProvider, text } from "../../../test/fake-provider";
import { restore } from "../../../tui/conversation/restore";

const previous = process.env.ORCA_HOME;
const dirs: string[] = [];
afterEach(() => { process.env.ORCA_HOME = previous; dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
async function fixture(io: Storage = disk) {
  const dir = mkdtempSync(join(tmpdir(), "clear-context-")); dirs.push(dir);
  process.env.ORCA_HOME = dir;
  await saveConfig({ model: "unknown", compact: false });
  const project = "p", transcript = open(paths.transcript(project, "orchestrator"), io);
  await transcript.append({ type: "message", message: { role: "user", content: "OLD_SECRET_TASK" } });
  await transcript.append({ type: "message", message: { role: "assistant", content: "OLD_SECRET_ANSWER" } });
  return { dir, project, transcript };
}

test("explicit append-only boundary resets model branch/chain, not originals, UI, settings, files or worker sessions", async () => {
  const { project, transcript } = await fixture();
  const provider = fakeProvider([]);
  const orch = await createOrchestrator({ project, transcript, provider, tools: {}, write: () => {} });
  const before = await Bun.file(transcript.path).text(), history = orch.entries!(), ui = restore(history, 100, Infinity);
  const identity = projectIdentity(project), config = await Bun.file(paths.config).text();
  const retained = [paths.transcript(project, "worker-a"), join(paths.project(project), "repo/file"), join(paths.project(project), "questions/q.json"), join(paths.project(project), "tasks/task.json"), join(paths.worktree(project, "a"), "file"), join(paths.project(project), "model"), join(paths.project(project), "model-settings.json"), join(paths.runs(project), "worker-a.json")];
  for (const path of retained) await Bun.write(path, "keep me");
  await put(project, "user", { from: "worker-a", text: "user reply is NOT input" });
  await orch.checkClear!(); await orch.clear!();
  expect(provider.calls).toHaveLength(0);
  expect(projectIdentity(project)).toBe(identity);
  expect(await Bun.file(paths.config).text()).toBe(config);
  expect(await orch.pending()).toBe(false);
  expect(await orch.turn()).toEqual([]);
  expect(transcript.branch()).toEqual([]);
  expect(await transcript.chain()).toEqual([]);
  expect(await open(transcript.path).chain()).toEqual([]);
  const boundary = transcript.history!().at(-1)!;
  expect(boundary.type).toBe("context-boundary");
  expect(boundary.parentUuid).toBe(history.at(-1)!.uuid);
  expect((await Bun.file(transcript.path).text()).startsWith(before)).toBe(true);
  expect(orch.entries!().slice(0, -1)).toEqual(history);
  expect(restore(orch.entries!(), 100, Infinity)).toEqual(ui);
  for (const path of retained) expect(await Bun.file(path).text()).toBe("keep me");
  expect((await drain(project, "user"))[0]?.text).toContain("NOT input");
});

test("clear -> fresh request -> repeated compaction -> reload never pins or summarizes pre-clear task; complete UI survives", async () => {
  const { project, transcript } = await fixture();
  let system: string | undefined;
  const fake = fakeProvider([[text("new answer " + "z".repeat(30000))]]);
  const provider = { ...fake, complete: async (request: Parameters<typeof fake.complete>[0]) => { system = request.system; return fake.complete(request); } };
  const tools = { example: { spec: { name: "example", description: "tool instructions stay", input_schema: { type: "object" as const } }, run: async () => "unused" } };
  const orch = await createOrchestrator({ project, transcript, provider, tools, write: () => {} });
  await orch.clear!();
  await orch.say("FRESH_TASK"); await orch.turn();
  expect(JSON.stringify(fake.calls)).not.toContain("OLD_SECRET");
  expect(fake.calls[0]!.messages[0]!.content).toBe("[user] FRESH_TASK");
  expect(system).toBeTruthy();
  expect(fake.calls[0]!.tools).toEqual(["example"]);
  for (let i = 0; i < 2; i++) {
    await transcript.append({ type: "message", message: { role: "user", content: "next task " + i } });
    const summary = fakeProvider([[text("Fresh progress only.")]]);
    expect(await compact({ transcript, provider: summary, model: "unknown", tools: {}, compaction: { fallback: 30000 } }, true)).toBe(true);
    expect(JSON.stringify(summary.calls)).not.toContain("OLD_SECRET");
    const loaded = open(transcript.path);
    expect(JSON.stringify(await loaded.chain())).not.toContain("OLD_SECRET");
    expect(JSON.stringify(await loaded.chain())).toContain("FRESH_TASK");
    expect(JSON.stringify(restore(loaded.history!(), 100, Infinity))).toContain("OLD_SECRET_TASK");
    expect(JSON.stringify(restore(loaded.history!(), 100, Infinity))).toContain("OLD_SECRET_ANSWER");
    if (!i) await transcript.append({ type: "message", message: { role: "assistant", content: "another answer " + "y".repeat(30000) } });
  }
  // The latest of multiple clears wins, even across summaries.
  await orch.clear!();
  expect(await open(transcript.path).chain()).toEqual([]);
  expect(JSON.stringify(orch.entries!())).toContain("FRESH_TASK");
});

test("raw paused/cancelled inbox and requested compaction refuse without consuming any input", async () => {
  const { project, transcript } = await fixture();
  const orch = await createOrchestrator({ project, transcript, provider: fakeProvider([]) });
  const before = await Bun.file(transcript.path).text();
  orch.cancel!();
  await put(project, "orchestrator", { from: "worker-a", text: "held report" });
  expect(await orch.pending()).toBe(false);
  await expect(orch.checkClear!()).rejects.toThrow("input is pending");
  await expect(orch.clear!()).rejects.toThrow("input is pending");
  expect((await drain(project, "orchestrator"))[0]?.text).toBe("held report");
  await orch.compact!();
  await expect(orch.clear!()).rejects.toThrow("running or compacting");
  expect(await Bun.file(transcript.path).text()).toBe(before);
});

test("running request refuses clear and confirmation eligibility is not an authorization token", async () => {
  const { project, transcript } = await fixture();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const fake = fakeProvider([[text("done")]]);
  const orch = await createOrchestrator({ project, transcript, tools: {}, provider: { ...fake, complete: async req => { entered.resolve(); await release.promise; return fake.complete(req); } } });
  await orch.checkClear!();
  await orch.say("arrived after checking");
  await expect(orch.clear!()).rejects.toThrow("input is pending");
  const turn = orch.turn(); await entered.promise;
  try { await expect(orch.clear!()).rejects.toThrow("running or compacting"); }
  finally { release.resolve(); await turn; }
  expect(JSON.stringify(await transcript.chain())).toContain("OLD_SECRET_TASK");
});

test("in-flight say refuses even before persistence; no automatic retries or loss", async () => {
  const { project, transcript } = await fixture();
  const release = Promise.withResolvers<void>();
  const orch = await createOrchestrator({ project, transcript, put: async (...args) => { await release.promise; return put(...args); } });
  const send = orch.say("not durable yet");
  try { await expect(orch.clear!()).rejects.toThrow("input is pending"); }
  finally { release.resolve(); await send; }
  expect((await drain(project, "orchestrator"))[0]?.text).toBe("not durable yet");
});

test("a local inbox put waiting for the shared lock refuses clear, not just say", async () => {
  const { project, transcript } = await fixture();
  const orch = await createOrchestrator({ project, transcript });
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const blocker = withProjectStateLock(project, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const clearing = orch.clear!();
  const sending = put(project, "orchestrator", { from: "worker-a", text: "pending publication" });
  expect(await pendingInput(project, "orchestrator")).toBe(true);
  release.resolve(); await blocker;
  await expect(clearing).rejects.toThrow("input is pending");
  await sending;
  expect((await drain(project, "orchestrator"))[0]?.text).toBe("pending publication");
});

test("cancelled/stale project confirmation cannot publish; prior context stays usable", async () => {
  const { project, transcript } = await fixture();
  const orch = await createOrchestrator({ project, transcript });
  const controller = new AbortController(); controller.abort(Error("cancel confirmation"));
  await expect(orch.clear!(controller.signal)).rejects.toThrow("cancel confirmation");
  await orch.checkClear!();
  rmSync(paths.project(project), { recursive: true });
  mkdirSync(paths.project(project));
  await expect(orch.clear!()).rejects.toThrow("project changed");
  expect(JSON.stringify(await transcript.chain())).toContain("OLD_SECRET_TASK");
  expect(await Bun.file(transcript.path).exists()).toBe(false);
});

for (const reason of ["cancel", "new-input", "failure"]) test(`${reason} during staged publication preserves bytes/head; clear blocks overlapping turns`, async () => {
  let armed = false;
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const io: Storage = { ...disk, open: async (path, flags) => {
    const file = await disk.open(path, flags);
    return { write: b => file.write(b), close: () => file.close(), sync: async () => {
      await file.sync();
      if (armed && flags === "wx") { entered.resolve(); await release.promise; if (reason === "failure") throw Error("storage failed"); }
    } };
  } };
  const { project, transcript } = await fixture(io);
  const provider = fakeProvider([[text("resumed")]]);
  const orch = await createOrchestrator({ project, transcript, provider, tools: {}, write: () => {} });
  const before = await Bun.file(transcript.path).text(), head = transcript.head();
  armed = true;
  const clearing = orch.clear!(); await entered.promise;
  expect(await orch.turn()).toEqual([]);
  await expect(orch.compact!()).rejects.toThrow("clear in progress");
  await expect(orch.clear!()).rejects.toThrow("clear in progress");
  let sending: Promise<void> | undefined;
  if (reason === "cancel") orch.cancel!();
  if (reason === "new-input") sending = orch.say("new input retained");
  release.resolve();
  await expect(clearing).rejects.toThrow();
  await sending;
  expect(transcript.head()).toBe(head);
  expect(await Bun.file(transcript.path).text()).toBe(before);
  expect(await open(transcript.path).chain()).toEqual(await transcript.chain());
  if (sending) expect((await drain(project, "orchestrator"))[0]?.text).toBe("new input retained");
  armed = false;
  await orch.say("resume the prior context"); await orch.turn();
  expect(JSON.stringify(provider.calls)).toContain("OLD_SECRET_TASK");
});

test("inbox inspection errors fail closed rather than clearing over uncertain input", async () => {
  const { project, transcript } = await fixture();
  const orch = await createOrchestrator({ project, transcript });
  await Bun.write(join(paths.inbox(project), "orchestrator"), "not a directory");
  await expect(orch.clear!()).rejects.toThrow();
  expect(JSON.stringify(await transcript.chain())).toContain("OLD_SECRET_TASK");
});

test("external-process send during publication waits for the boundary and remains durable new input", async () => {
  let armed = false;
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const io: Storage = { ...disk, open: async (path, flags) => {
    const file = await disk.open(path, flags);
    return { write: b => file.write(b), close: () => file.close(), sync: async () => {
      await file.sync(); if (armed && flags === "wx") { entered.resolve(); await release.promise; }
    } };
  } };
  const { project, transcript, dir } = await fixture(io);
  const orch = await createOrchestrator({ project, transcript });
  armed = true;
  const clearing = orch.clear!(); await entered.promise;
  // This child only puts a message into the isolated fixture; no model, tmux or network.
  const marker = join(dir, "child-started");
  const source = `import { put } from ${JSON.stringify(join(import.meta.dir, "../../data/inbox/inbox.ts"))}; await Bun.write(${JSON.stringify(marker)}, "ready"); await put("p", "orchestrator", { from: "worker-a", text: "new report" });`;
  const child = Bun.spawn([process.execPath, "-e", source], { env: { ...process.env, ORCA_HOME: dir }, stdout: "ignore", stderr: "pipe" });
  try {
    for (let i = 0; i < 200 && !await Bun.file(marker).exists(); i++) await Bun.sleep(5);
    expect(await Bun.file(marker).exists()).toBe(true);
    await Bun.sleep(20);
    expect(child.exitCode).toBeNull();
    // Published input is still empty while the external writer waits on our lock.
    expect(await pendingInput(project, "orchestrator")).toBe(false);
    release.resolve(); await clearing;
    expect(await child.exited).toBe(0);
    expect(await transcript.chain()).toEqual([]);
    expect((await drain(project, "orchestrator"))[0]?.text).toBe("new report");
  } finally { release.resolve(); await clearing.catch(() => {}); if (child.exitCode === null) child.kill(); await child.exited; }
});

test("an actively compacting orchestrator refuses clear, not just a queued compact request", async () => {
  const { project, transcript } = await fixture();
  await transcript.append({ type: "message", message: { role: "assistant", content: "old work " + "x".repeat(30000) } });
  await transcript.append({ type: "message", message: { role: "user", content: "recent work" } });
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const fake = fakeProvider([[text(JSON.stringify({ user: [], project: [], pending: ["OLD_SECRET_TASK"], tasks: [] }))]]);
  const orch = await createOrchestrator({ project, transcript, tools: {}, write() {}, provider: fakeProvider([]),
    rolling: { tailTokens: 100, loadProvider: async () => ({ ...fake, complete: async req => { entered.resolve(); await release.promise; return fake.complete(req); } }) } });
  await orch.compact!();
  const turn = orch.turn(); await entered.promise;
  try {
    await expect(orch.checkClear!()).rejects.toThrow("running or compacting");
    await expect(orch.clear!()).rejects.toThrow("running or compacting");
  } finally { release.resolve(); await turn; }
  expect(transcript.history!().some(e => e.type === "context-boundary")).toBe(false);
  expect(JSON.stringify(await transcript.chain())).toContain("OLD_SECRET_TASK");
});
