import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../../../config/config";
import { drain, pending, pendingInput, userInEpoch } from "./inbox";
import { advanceInputEpoch } from "./user-input";
import { all, answer, ask as realAsk, cleanQuestions, list, skip, withdraw } from "./questions";
import { ask as askTool } from "../../tools/ask";
import { registry } from "../../tools/index";
import { toolsFor } from "../../tools/registry";

const ask: typeof realAsk = async (project, ...args) => {
  mkdirSync(paths.project(project), { recursive: true });
  return realAsk(project, ...args);
};
const home = mkdtempSync(join(tmpdir(), "orca-questions-"));
process.env.ORCA_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));

test("questions list in ask order, a file each, no temp files", async () => {
  const n = 50;
  await ask("q1", Array.from({ length: n }, (_, i) => ({ text: String(i), default: "x" })));
  expect((await list("q1")).map((q) => q.text)).toEqual(Array.from({ length: n }, (_, i) => String(i)));
  const files = readdirSync(paths.questions("q1"));
  expect(files.length).toBe(n);
  expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
});

test("answers deliver normally; skip durably closes without a reply or applying the default", async () => {
  const [a, b] = await ask("q2", [
    { text: "Which DB?", options: ["sqlite", "postgres"], default: "sqlite" },
    { text: "Dark mode?", default: "no" },
  ]);
  await answer("q2", a!.id, "postgres");
  await skip("q2", b!.id);
  expect(await list("q2")).toEqual([]);
  expect((await all("q2")).map((q) => [q.status, q.answer])).toEqual([["answered", "postgres"], ["skipped", undefined]]);
  const msgs = await drain("q2", "orchestrator");
  expect(msgs.map((m) => m.from)).toEqual(["user"]);
  expect(msgs.map((m) => m.text)).toEqual([
    `[${a!.id}] answer to "Which DB?": postgres`,
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
  const results = await Promise.allSettled([answer("q5", q!.id, "a"), answer("q5", q!.id, "b")]);
  expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
  expect((await drain("q5", "orchestrator")).length).toBe(1);
  expect(await list("q5")).toEqual([]);
});

for (const def of [undefined, "yes, ship it"]) {
  test(`skip is durable, silent and keeps FIFO/history with default ${def}`, async () => {
    const project = def ? "skip-default" : "skip-no-default";
    const epoch = advanceInputEpoch(project);
    const qs = await ask(project, [{ text: "Approval?", default: def }, { text: "Second?" }, { text: "Third?" }]);
    const original = (await all(project))[0]!;
    expect(await skip(project, qs[0]!.id)).toEqual({ ...original, status: "skipped" });
    // Fresh disk reads (no in-memory cache), including a new process/restart.
    expect((await list(project)).map(q => q.id)).toEqual(qs.slice(1).map(q => q.id));
    const child = Bun.spawn([process.execPath, "-e", 'import { list } from "./src/core/data/inbox/questions.ts"; console.log(JSON.stringify(await list(process.argv[1])));', project], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ORCA_HOME: paths.root } });
    expect(await child.exited).toBe(0);
    expect(JSON.parse(await new Response(child.stdout).text())).toEqual(qs.slice(1));
    expect((await all(project))[0]).toEqual({ ...original, status: "skipped" });
    expect(await pending(project, "orchestrator")).toBe(false);
    expect(await pendingInput(project, "orchestrator")).toBe(false);
    expect(await userInEpoch(project, "orchestrator", epoch)).toBe(false);
    expect(existsSync(paths.inbox(project))).toBe(false);
    for (const to of ["orchestrator", "user", "worker-test"]) expect(await drain(project, to)).toEqual([]);
    await expect(skip(project, qs[0]!.id)).rejects.toThrow("already skipped");
    await expect(answer(project, qs[0]!.id, "yes")).rejects.toThrow("already skipped");
  });
}

test("simultaneous skips and answer-vs-skip races close once; only a winning answer delivers", async () => {
  for (let i = 0; i < 20; i++) {
    const project = `close-race-${i}`;
    const [q] = await ask(project, [{ text: "Race?", default: "suggested" }]);
    const actions = i < 10
      ? [() => skip(project, q!.id), () => skip(project, q!.id)]
      : [() => answer(project, q!.id, "explicit"), () => skip(project, q!.id)];
    if (i % 2) actions.reverse();
    const results = await Promise.allSettled(actions.map(action => action()));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const saved = (await all(project))[0]!;
    const messages = await drain(project, "orchestrator");
    expect(messages.map(m => m.text)).toEqual(saved.status === "answered" ? [`[${q!.id}] answer to "Race?": explicit`] : []);
    expect(await list(project)).toEqual([]);
    expect(readdirSync(paths.questions(project)).filter(n => n.endsWith(".closed"))).toEqual([`${q!.id}.closed`]);
  }
});

test("skip does not depend on a writable delivery inbox", async () => {
  const [q] = await ask("skip-broken-inbox", [{ text: "Dismiss?", default: "yes" }]);
  mkdirSync(paths.inbox("skip-broken-inbox"), { recursive: true });
  const box = join(paths.inbox("skip-broken-inbox"), "orchestrator");
  writeFileSync(box, "not a directory");
  await skip("skip-broken-inbox", q!.id);
  expect(await list("skip-broken-inbox")).toEqual([]);
  expect(await Bun.file(box).text()).toBe("not a directory");
});

for (const action of [answer, skip]) {
  test(`${action.name}: real persistence failure releases claim, retains open record and can retry`, async () => {
    const project = `write-failure-${action.name}`;
    const [q] = await ask(project, [{ text: "Retry?", default: "yes" }]);
    const write = Bun.write;
    let blocked = "";
    // Force an actual filesystem write error AFTER the exclusive claim: the
    // atomic temp destination is a directory, not a mocked thrown exception.
    const spy = spyOn(Bun, "write").mockImplementation((async (destination: string, data: string) => {
      if (destination.startsWith(paths.questions(project))) {
        expect(existsSync(join(paths.questions(project), `${q!.id}.closed`))).toBe(true);
        blocked = destination;
        mkdirSync(destination);
      }
      return write(destination, data);
    }) as typeof Bun.write);
    try { await expect(action(project, q!.id, "explicit")).rejects.toThrow(); }
    finally { spy.mockRestore(); if (blocked) rmSync(blocked, { recursive: true, force: true }); }
    expect(await list(project)).toEqual([q!]);
    expect(existsSync(join(paths.questions(project), `${q!.id}.closed`))).toBe(false);
    expect(await pendingInput(project, "orchestrator")).toBe(false);
    await action(project, q!.id, "explicit");
    expect(await list(project)).toEqual([]);
    expect((await drain(project, "orchestrator")).length).toBe(action === answer ? 1 : 0);
  });
}

test("malformed ids/records refuse closing without a claim, rewrite or message", async () => {
  for (const id of ["", "..", "../q", "a/b", "a\\b", "bad\n", "q\u202e"]) {
    await expect(skip("bad-ids", id)).rejects.toThrow("bad question id");
  }
  await expect(skip("bad-ids", "missing")).rejects.toThrow("no question");
  const [q] = await ask("invalid-close", [{ text: "Q?" }]);
  const file = join(paths.questions("invalid-close"), `${q!.id}.json`);
  for (const record of ["{", JSON.stringify({ ...q, id: "other" }), JSON.stringify({ ...q, options: 3 })]) {
    writeFileSync(file, record);
    await expect(skip("invalid-close", q!.id)).rejects.toThrow();
    expect(await Bun.file(file).text()).toBe(record);
    expect(existsSync(join(paths.questions("invalid-close"), `${q!.id}.closed`))).toBe(false);
  }
  expect(await drain("invalid-close", "orchestrator")).toEqual([]);
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
  mkdirSync(paths.runtimeProject("bad-store"), { recursive: true });
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

test("the orchestrator's close withdraws with a reason: no reply, no answer, scoped to its project", async () => {
  const [a, b] = await ask("wd1", [{ text: "Which DB?", default: "sqlite" }, { text: "Port?" }]);
  const [other] = await ask("wd1-other", [{ text: "Elsewhere?" }]);
  expect(await withdraw("wd1", a!.id, "answered in chat")).toEqual({ ...a!, status: "skipped", reason: "answered in chat" });
  expect((await list("wd1")).map(q => q.id)).toEqual([b!.id]);
  expect((await all("wd1"))[0]).toEqual({ ...a!, status: "skipped", reason: "answered in chat" });
  expect((await all("wd1"))[0]!.answer).toBeUndefined();
  expect(await drain("wd1", "orchestrator")).toEqual([]);
  expect(await pendingInput("wd1", "orchestrator")).toBe(false);
  await expect(withdraw("wd1", other!.id, "outdated")).rejects.toThrow("no question");
  expect(await list("wd1-other")).toEqual([other!]);
  await expect(withdraw("wd1", b!.id, "  ")).rejects.toThrow("needs a reason");
  await expect(withdraw("wd1", b!.id, "x".repeat(201))).rejects.toThrow("over 200");
  await expect(withdraw("wd1", a!.id, "again")).rejects.toThrow("already skipped");
  await expect(withdraw("wd1", "../x", "r")).rejects.toThrow("bad question id");
});

test("a user's answer wins over the orchestrator's close, either way round, and is delivered once", async () => {
  // Answered first: the close is refused and the answer stays.
  const [q1] = await ask("wd2", [{ text: "Ship?" }]);
  await answer("wd2", q1!.id, "yes");
  await expect(withdraw("wd2", q1!.id, "outdated")).rejects.toThrow("already answered");
  expect((await all("wd2"))[0]).toMatchObject({ status: "answered", answer: "yes" });
  expect((await drain("wd2", "orchestrator")).length).toBe(1);
  // Withdrawn first: a later answer is still recorded and delivered, once.
  const [q2] = await ask("wd3", [{ text: "Color?" }]);
  await withdraw("wd3", q2!.id, "answered in chat");
  const saved = await answer("wd3", q2!.id, "blue");
  expect(saved).toMatchObject({ status: "answered", answer: "blue", reason: "answered in chat" });
  expect((await drain("wd3", "orchestrator")).map(m => m.text)).toEqual([`[${q2!.id}] answer to "Color?": blue`]);
  await expect(answer("wd3", q2!.id, "red")).rejects.toThrow("already answered");
  await expect(withdraw("wd3", q2!.id, "again")).rejects.toThrow("already answered");
  expect(await drain("wd3", "orchestrator")).toEqual([]);
  // A user's own Skip or delete is never answerable later.
  const [q3] = await ask("wd4", [{ text: "Skip me?" }]);
  await skip("wd4", q3!.id);
  await expect(answer("wd4", q3!.id, "late")).rejects.toThrow("already skipped");
});

test("concurrent answer and close: the answer is always delivered exactly once", async () => {
  for (let i = 0; i < 20; i++) {
    const project = `wd-race-${i}`;
    const [q] = await ask(project, [{ text: "Race?" }]);
    const actions = [() => answer(project, q!.id, "explicit"), () => withdraw(project, q!.id, "outdated")];
    if (i % 2) actions.reverse();
    const results = await Promise.allSettled(actions.map(action => action()));
    expect(results.some(r => r.status === "fulfilled")).toBe(true);
    expect((await all(project))[0]).toMatchObject({ status: "answered", answer: "explicit" });
    expect((await drain(project, "orchestrator")).map(m => m.text)).toEqual([`[${q!.id}] answer to "Race?": explicit`]);
    expect(await list(project)).toEqual([]);
  }
});

test("the ask tool lists pending questions and closes ids with a reason; an answer the user gave first is quoted", async () => {
  const ctx = { project: "wd5", cwd: "/", role: "orchestrator" as const };
  expect(await askTool.run({ action: "list" }, ctx)).toBe("no pending questions");
  const [a, b, c] = await ask("wd5", [{ text: "A?", options: ["x", "y"], default: "x" }, { text: "B?" }, { text: "C?" }]);
  const listed = await askTool.run({ action: "list" }, ctx);
  expect(listed).toStartWith("3 pending, oldest first:\n");
  expect(listed).toContain(`- ${a!.id} (asked ${a!.ts}): A? [options: x | y] [default: x]`);
  await answer("wd5", c!.id, "done");
  await drain("wd5", "orchestrator");
  const out = await askTool.run({ action: "close", ids: [a!.id, b!.id, c!.id, "missing"], reason: "answered in chat" }, ctx);
  expect(out).toBe(`closed 2 of 4:\nclosed ${a!.id}\nclosed ${b!.id}\nnot closed ${c!.id}: the user already answered: done\nnot closed missing: no question missing`);
  expect(await list("wd5")).toEqual([]);
  expect(await drain("wd5", "orchestrator")).toEqual([]);
  expect(await askTool.run({ action: "close", ids: [], reason: "r" }, ctx)).toStartWith("refused");
  expect(await askTool.run({ action: "close", ids: ["x"] }, ctx)).toBe("refused: close needs a short reason");
  expect(await askTool.run({ action: "close", ids: Array.from({ length: 21 }, (_, i) => `q${i}`), reason: "r" }, ctx)).toBe("refused: over 20 ids in one close");
  expect(await askTool.run({ action: "nope" }, ctx)).toBe("refused: unknown action nope");
  expect(await askTool.run({ action: "list" }, { ...ctx, role: "worker", branch: "b" })).toStartWith("refused");
});
