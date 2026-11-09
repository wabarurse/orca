// What a session carries besides transcripts: tasks, questions, images, model state. Two throwaway machines with temp
// ORCA_HOMEs; fake data only, no provider, tmux or network.
import { afterAll, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { paths, readProjectState, writeProjectState } from "../../config";
import { imageContent, legacyImageScope, materializeImages, saveImage, sessionImageScope } from "../data/images";
import { questions } from "../data/inbox";
import { ensureSessionId } from "../data/projects/session-id";
import { getTask, observeTaskPR, prepareTaskRun, registerTask, setTaskAttention, startTaskRun, allTasks } from "../data/tasks";
import { open } from "../data/transcripts";
import { png } from "../../test/image-fixture";
import { exportSession } from "./export";
import { resolveSelector } from "./local";
import { at, cleanup, exists, loopback, machine, project, quiet, read, say, session, type Machine } from "../../test/session-fixture";

afterAll(cleanup);

async function pair() {
  const a = await machine("mac"), b = await machine("server");
  await project(a, "orch-aaaa", "demo");
  await say(a, "orch-aaaa", ["hello", "hi there"]);
  return { a, b };
}
async function synced(a: Machine, b: Machine) {
  const r = await session(a, ["push", "demo", "server", "--checkout", b.repo], { transport: loopback(b) });
  expect(r.code).toBe(0);
  return at(b, () => resolveSelector("demo"));
}
const T1 = "11111111-1111-4111-8111-111111111111", T2 = "22222222-2222-4222-8222-222222222222";
const task = (m: Machine, p: string, id = T1) => at(m, () => registerTask(p, { id, name: `task ${id.slice(0, 2)}`, summary: "s", branch: `feat/${id.slice(0, 2)}`, authorized: true }));
const pr = (n: number) => ({ repository: "o/r", number: n, url: `https://github.com/o/r/pull/${n}`, head: "a".repeat(40) });
const merged = (m: Machine, p: string, id: string, n = 1) => at(m, () => observeTaskPR(p, id, { pr: pr(n), branch: `feat/${id.slice(0, 2)}`, state: "MERGED", mergedAt: "2026-01-01T00:00:00.000Z", ready: false, checks: "unknown" }));
const push = (a: Machine, b: Machine, ...flags: string[]) => session(a, ["push", "demo", "server", ...flags], { transport: loopback(b) });

test("tasks: union by id, a strict prefix takes the longer history, conflicts refuse, archived (merged) is terminal and wins", async () => {
  const { a, b } = await pair();
  const id = await synced(a, b);
  await task(a, "orch-aaaa", T1);
  await task(b, id, T2);
  // different tasks on each side: union (the transcripts are equal, so tasks may move both ways)
  const r = await push(a, b);
  expect(r.code).toBe(0);
  expect((await at(b, () => allTasks(id))).map(t => t.id).sort()).toEqual([T1, T2]);
  expect((await at(a, async () => (await allTasks("orch-aaaa")).map(t => t.id)))).toEqual([T1]);
  const pull = await session(a, ["pull", "demo", "server"], { transport: loopback(b) });
  expect(pull.code).toBe(0);
  expect((await at(a, () => allTasks("orch-aaaa"))).map(t => t.id).sort()).toEqual([T1, T2]);
  // project-local numbers belong to each machine: b numbered T2 first, T1 second; a the other way round
  expect((await at(b, () => getTask(id, T1))).number).toBe(2);
  expect((await at(a, () => getTask("orch-aaaa", T1))).number).toBe(1);
  // a's history of T1 is a strict prefix of b's after b adds an event: pushing the older side keeps b
  await at(b, () => setTaskAttention(id, T1, { kind: "blocked", reason: "b side" }));
  expect((await push(a, b)).code).toBe(0);
  expect((await at(b, () => getTask(id, T1))).attention?.reason).toBe("b side");
  // both advanced differently: conflict, whole transfer refused, nothing written
  await at(a, () => setTaskAttention("orch-aaaa", T1, { kind: "closed", reason: "a side" }));
  const before = JSON.stringify(await at(b, () => allTasks(id)));
  const conflict = await push(a, b);
  expect(conflict.code).toBe(1);
  expect(conflict.err).toContain("histories diverged");
  expect(JSON.stringify(await at(b, () => allTasks(id)))).toBe(before);
  // archived (merged) is terminal and wins whichever side holds it
  await at(b, () => observeTaskPR(id, T1, { pr: pr(7), branch: "feat/11", state: "OPEN", ready: false, checks: "unknown" }));
  await merged(b, id, T1, 7);
  const keep = await push(a, b);
  expect(keep.code).toBe(0);
  expect(keep.err).toContain("archived (merged) on the receiving side");
  expect((await at(b, () => getTask(id, T1))).archive?.reason).toBe("merged");
  const back = await session(a, ["pull", "demo", "server"], { transport: loopback(b) });
  expect(back.code).toBe(0);
  expect((await at(a, () => getTask("orch-aaaa", T1))).archive?.reason).toBe("merged");
});

test("unfinished tasks import as stopped runs with attention unknown; nothing is started", async () => {
  const { a, b } = await pair();
  const t = await task(a, "orch-aaaa", T1);
  await at(a, async () => {
    await prepareTaskRun("orch-aaaa", t.id, t.branch, { id: "run-1", agent: "worker-feat-11", role: "worker" });
    await startTaskRun("orch-aaaa", "run-1");
  });
  expect((await at(a, () => getTask("orch-aaaa", T1))).runs[0]!.state).toBe("started");
  const r = await push(a, b, "--checkout", b.repo);
  expect(r.code).toBe(0);
  expect(r.err).toContain("1 unfinished task(s) imported as stopped");
  const id = await at(b, () => resolveSelector("demo"));
  const imported = await at(b, () => getTask(id, T1));
  expect(imported.runs[0]).toMatchObject({ id: "run-1", state: "stopped" });
  expect(imported.runs[0]!.endedAt).toBeDefined();
  expect(imported.attention).toEqual({ kind: "unknown", reason: "interrupted by session transfer" });
  expect(imported.history.at(-1)!.kind).toBe("transfer_interrupted");
  // the sender's own copy is untouched, and pushing again is an unchanged no-op (the annotation is not independent work)
  expect((await at(a, () => getTask("orch-aaaa", T1))).runs[0]!.state).toBe("started");
  const again = await push(a, b);
  expect(again.code).toBe(0);
  expect(again.err).toContain("unchanged");
  expect(await exists(b, id, ".runtime")).toBe(false);
});

test("questions: closed beats open, a user's answer beats a withdrawal, a question closed differently on each side refuses", async () => {
  const { a, b } = await pair();
  const [q1, q2] = await at(a, () => questions.ask("orch-aaaa", [{ text: "one?" }, { text: "two?" }]));
  const id = await synced(a, b);
  const qfile = (m: Machine, p: string, qid: string) => at(m, () => Bun.file(join(paths.questions(p), `${qid}.json`)).json());
  expect((await qfile(b, id, q1!.id)).status).toBe("open");
  await at(a, () => questions.skip("orch-aaaa", q1!.id));
  expect((await push(a, b)).code).toBe(0);
  expect((await qfile(b, id, q1!.id)).status).toBe("skipped");
  expect((await qfile(b, id, q2!.id)).status).toBe("open");
  // an open copy never reopens a closed one
  await at(b, () => questions.skip(id, q2!.id));
  expect((await push(a, b)).code).toBe(0);
  expect((await qfile(b, id, q2!.id)).status).toBe("skipped");
  // withdrawn on one side, answered on the other: the answer wins
  const [q3] = await at(a, () => questions.ask("orch-aaaa", [{ text: "three?" }]));
  await push(a, b);
  await at(a, () => questions.withdraw("orch-aaaa", q3!.id, "answered in chat"));
  await at(b, async () => { const file = join(paths.questions(id), `${q3!.id}.json`); await writeFile(file, JSON.stringify({ ...(await Bun.file(file).json()), status: "answered", answer: "yes" })); });
  const win = await session(a, ["pull", "demo", "server"], { transport: loopback(b) });
  expect(win.code).toBe(0);
  expect((await qfile(a, "orch-aaaa", q3!.id)).answer).toBe("yes");
  // answered on one side, skipped by the user on the other: conflict
  const [q4] = await at(a, () => questions.ask("orch-aaaa", [{ text: "four?" }]));
  await push(a, b);
  await at(a, () => questions.skip("orch-aaaa", q4!.id));
  await at(b, async () => { const file = join(paths.questions(id), `${q4!.id}.json`); await writeFile(file, JSON.stringify({ ...(await Bun.file(file).json()), status: "answered", answer: "yes" })); });
  const conflict = await push(a, b);
  expect(conflict.code).toBe(1);
  expect(conflict.err).toContain("closed differently");
});

test("the orchestrator unit may not mix sources", async () => {
  const { a, b } = await pair();
  const id = await synced(a, b);
  await say(a, "orch-aaaa", ["a more", "a reply"]); // transcript moves a -> b
  await task(b, id);                                // while tasks move b -> a
  const r = await push(a, b);
  expect(r.code).toBe(1);
  expect(r.err).toContain("mixed sources for the orchestrator unit");
});

test("images round trip to a project with a different folder id and load byte-identically; a legacy-scoped reference is refused at export", async () => {
  const { a, b } = await pair();
  const ref = await at(a, () => saveImage("orch-aaaa", png()));
  const sid = await at(a, () => ensureSessionId("orch-aaaa"));
  expect(ref.scope).toBe(sessionImageScope(sid));
  await at(a, () => open(paths.transcript("orch-aaaa", "orchestrator")).append({ type: "message", message: { role: "user", content: imageContent("see this", [ref]) } }));
  const exported = await at(a, () => exportSession("orch-aaaa", quiet()));
  expect(exported.warnings.join("\n")).not.toContain("missing");
  expect((await push(a, b, "--checkout", b.repo)).code).toBe(0);
  const id = await at(b, () => resolveSelector("demo"));
  expect(id).not.toBe("orch-aaaa");
  const chain = await at(b, () => open(paths.transcript(id, "orchestrator")).chain());
  const blocks = (await at(b, () => materializeImages(id, chain))).flatMap(m => typeof m.content === "string" ? [] : m.content).filter(x => x.type === "image");
  expect(blocks.length).toBe(1);
  expect(Buffer.from((blocks[0] as { source: { data: string } }).source.data, "base64").equals(png())).toBe(true);
  expect(await read(b, id, "transcript/orchestrator.jsonl")).toBe(await read(a, "orch-aaaa", "transcript/orchestrator.jsonl"));
  // a reference still in the old folder-derived scope could not load anywhere else: export refuses, never rewrites
  const old = await at(a, () => saveImage("orch-aaaa", png(2, 1, 250)));
  const legacy = await at(a, () => legacyImageScope("orch-aaaa"));
  await at(a, () => open(paths.transcript("orch-aaaa", "orchestrator")).append({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "see" }] } }));
  await at(a, () => open(paths.transcript("orch-aaaa", "orchestrator")).append({ type: "message", message: { role: "user", content: imageContent("legacy", [{ ...old, scope: legacy }]) } }));
  const refused = await session(a, ["export", "demo", join(a.dir, "legacy.bundle")]);
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("legacy scope");
  expect(await Bun.file(join(a.dir, "legacy.bundle")).exists()).toBe(false);
});

test("image prompt journals and image files with a different byte stream under one id refuse", async () => {
  const { a, b } = await pair();
  const ref = await at(a, () => saveImage("orch-aaaa", png()));
  await at(a, () => open(paths.transcript("orch-aaaa", "orchestrator")).append({ type: "message", message: { role: "user", content: imageContent("see", [ref]) } }));
  const id = await synced(a, b);
  await at(b, () => writeFile(join(paths.project(id), "images", `${ref.id}.png`), png(1, 1, 7)));
  await say(a, "orch-aaaa", ["x"]);
  const r = await push(a, b);
  expect(r.code).toBe(1);
  expect(r.err).toContain("same id, different sha256");
});

test("model, per-model settings, role models and knowledge travel with the orchestrator; a newer destination keeps its own", async () => {
  const { a, b } = await pair();
  await at(a, async () => {
    writeProjectState("orch-aaaa", "model", "claude-opus-5-5");
    writeProjectState("orch-aaaa", "model-settings", { "claude-opus-5-5": { effort: "high" }, "claude-sonnet-5-5": { fast: false } });
    writeProjectState("orch-aaaa", "role-models", { anthropic: { worker: "claude-sonnet-5-5" } });
    writeProjectState("orch-aaaa", "facts", [{ id: "f1", text: "fact" }]);
    writeProjectState("orch-aaaa", "account", "anthropic:personal");
  });
  const r = await push(a, b, "--checkout", b.repo);
  expect(r.code).toBe(0);
  const id = await at(b, () => resolveSelector("demo"));
  const state = (key: string) => at(b, () => readProjectState<unknown>(id, key));
  expect(await state("model")).toBe("claude-opus-5-5");
  expect(await state("model-settings")).toEqual({ "claude-opus-5-5": { effort: "high" }, "claude-sonnet-5-5": { fast: false } });
  expect(await state("role-models")).toEqual({ anthropic: { worker: "claude-sonnet-5-5" } });
  expect(await state("facts")).toEqual([{ id: "f1", text: "fact" }]);
  expect(await state("account")).toBeUndefined();
  // per-model merge: the sending side's entry for a model replaces b's, b's other models are kept
  await at(b, () => writeProjectState(id, "model-settings", { "claude-opus-5-5": { effort: "low" }, "gpt-5": { effort: "medium" } }));
  await at(a, () => writeProjectState("orch-aaaa", "model-settings", { "claude-opus-5-5": { effort: "high" } }));
  await say(a, "orch-aaaa", ["more", "answer"]);
  expect((await push(a, b)).code).toBe(0);
  expect(await state("model-settings")).toEqual({ "claude-opus-5-5": { effort: "high" }, "gpt-5": { effort: "medium" } });
  // the destination is newer: its settings stay, and the difference is reported
  await say(b, id, ["b only", "b reply"]);
  await at(a, () => writeProjectState("orch-aaaa", "model", "claude-sonnet-5-5"));
  const keep = await push(a, b);
  expect(keep.code).toBe(0);
  expect(keep.err).toContain("kept this machine's");
  expect(await state("model")).toBe("claude-opus-5-5");
});

test("every project state key the source reads or writes is classified as carried or local", async () => {
  const { STATE_KEYS, LOCAL_STATE_KEYS } = await import("./snapshot");
  const classified = new Set<string>([...Object.values(STATE_KEYS), ...LOCAL_STATE_KEYS]);
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const root = join(import.meta.dir, "..", "..");
  const used = new Set<string>();
  const walk = (dir: string) => { for (const name of readdirSync(dir)) { const p = join(dir, name); if (statSync(p).isDirectory()) walk(p); else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) for (const m of readFileSync(p, "utf8").matchAll(/(?:read|write)ProjectState(?:<[^>]*>)?\([\w.()]+, "([a-z-]+)"/g)) used.add(m[1]!); } };
  walk(root);
  expect([...used].filter(k => !classified.has(k))).toEqual([]);
  for (const key of ["archived-agents"]) expect(classified.has(key)).toBe(true);
});

test("the entry types the ledger accepts are exactly the ones protocol/transcript.ts defines", async () => {
  const { KNOWN_TYPES } = await import("./ledger");
  const { readFileSync } = await import("node:fs");
  const defined = [...readFileSync(join(import.meta.dir, "..", "..", "protocol", "transcript.ts"), "utf8").matchAll(/^\s+type: "([a-z-]+)";/gm)].map(m => m[1]!);
  expect([...KNOWN_TYPES].sort()).toEqual([...new Set(defined)].sort());
});

test("tasks and questions in an empty project transfer as nothing, and a project with no tasks file is fine", async () => {
  const { a, b } = await pair();
  const r = await push(a, b, "--checkout", b.repo);
  expect(r.code).toBe(0);
  const id = await at(b, () => resolveSelector("demo"));
  expect(await at(b, () => allTasks(id))).toEqual([]);
});
