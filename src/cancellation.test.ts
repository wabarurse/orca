import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cancelSession, publishLaunch, watchCancellation } from "./cancellation";
import { paths } from "./config";
import { runAgent } from "./agent";
import { open } from "./transcript";
import { fakeProvider, text, toolUse } from "./test/fake-provider";
import { paired } from "./tool-pairs";
import { drain } from "./inbox";

const home = mkdtempSync(join(tmpdir(), "parallels-cancellation-"));
process.env.PARALLELS_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));

async function until(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check() && Date.now() < deadline) await Bun.sleep(5);
  expect(check()).toBe(true);
}

test("session cancellation targets only one role and ignores stale requests on restart", async () => {
  const worker = new AbortController(), reviewer = new AbortController();
  publishLaunch("p", "worker-x", "first");
  publishLaunch("p", "reviewer-x", "reviewer");
  const off = watchCancellation("p", "worker-x", worker, "first");
  const otherOff = watchCancellation("p", "reviewer-x", reviewer, "reviewer");
  let nextOff = () => {};
  try {
    await cancelSession("p", "worker-x");
    await until(() => worker.signal.aborted);
    expect(reviewer.signal.aborted).toBe(false);
    const next = new AbortController();
    publishLaunch("p", "worker-x", "next");
    nextOff = watchCancellation("p", "worker-x", next, "next");
    await Bun.sleep(150);
    expect(next.signal.aborted).toBe(false);
    await cancelSession("p", "worker-x");
    await until(() => next.signal.aborted);
  } finally { off(); otherOff(); nextOff(); }
});

test("selected worker cancels real bash, saves paired results, exits cleanly, and restarts with history", async () => {
  const project = "worker-cancel", branch = "x", id = "worker-x";
  const path = paths.transcript(project, id);
  const transcript = open(path);
  await transcript.append({ type: "meta", role: "worker", branch, model: "m" });
  await transcript.append({ type: "message", message: { role: "user", content: "original task" } });
  const marker = join(home, "running");
  const provider = fakeProvider([[toolUse("shell", "bash", { command: `echo ready > '${marker}'; sleep 60` }), toolUse("skipped", "bash", { command: "echo should-not-run" })]]);
  const running = runAgent({ project, branch, role: "worker", loadProvider: async () => provider });
  await until(() => Bun.file(marker).size > 0);
  await cancelSession(project, id);
  expect(await running).toBe(0);
  const messages = await open(path).chain();
  expect(paired(messages)).toBe(true);
  expect(JSON.stringify(messages)).toContain("cancelled by user");
  expect(provider.calls).toHaveLength(1);
  expect((await drain(project, "orchestrator"))[0]!.text).toContain("cancelled by user");
  const next = fakeProvider([[text("continuing original task")]]);
  expect(await runAgent({ project, branch, role: "worker", loadProvider: async () => next })).toBe(0);
  expect(next.calls[0]!.messages).toEqual(messages);
});

test("cancellation during supervised startup targets that run, never its replacement", async () => {
  const project = "startup", id = "reviewer-x";
  await Bun.write(`${paths.runs(project)}/${id}.json`, JSON.stringify({ run: "first" }));
  publishLaunch(project, id, "first");
  await cancelSession(project, id);
  const first = new AbortController(), next = new AbortController();
  const off = watchCancellation(project, id, first, "first");
  const nextOff = watchCancellation(project, id, next, "next");
  try {
    expect(first.signal.aborted).toBe(true);
    await Bun.sleep(110);
    expect(next.signal.aborted).toBe(false);
  } finally { off(); nextOff(); }
});

test("undefined and stale run requests never match a later exact launch", async () => {
  const project = "foreign", id = "worker-x";
  publishLaunch(project, id, "new");
  for (const run of [undefined, "old"]) {
    await Bun.write(`${paths.transcript(project, id)}.cancel`, JSON.stringify({ token: "foreign", run }));
    const controller = new AbortController();
    const off = watchCancellation(project, id, controller, "new");
    try { await Bun.sleep(110); expect(controller.signal.aborted).toBe(false); }
    finally { off(); }
  }
});

test("cancelled notice reaches orchestrator with non-recovery policy; only user continuation spawns again", async () => {
  const { supervise } = await import("./exits");
  const { Cancelled } = await import("./cancellation");
  const { createOrchestrator } = await import("./orchestrator");
  const { makeSpawn } = await import("./tools/spawn");
  const project = "cancel-notice";
  await supervise({ project, id: "worker-x", run: "cancelled", role: "worker", branch: "x", cwd: home }, async t => {
    await t.reported(); // cancellation is still distinct even just after a report
    throw new Cancelled();
  });
  const { registerTask } = await import("./tasks");
  const taskId = (await registerTask(project, { name: "Resume x", summary: "Authorized original task", branch: "x", authorized: true })).id;
  let calls = 0, starts = 0;
  const provider: import("./providers").Provider = { name: "anthropic", async models() { return []; }, async complete(req) {
    calls++;
    const messages = JSON.stringify(req.messages);
    expect(messages).toContain("[agent-cancelled]");
    expect(messages).not.toContain("[agent-exit]");
    expect(messages).toContain("leave stopped until the user explicitly authorizes continuation");
    expect(req.system).toContain("no respawn or tool retry without explicit user authorization");
    if (calls === 2) {
      expect(messages).toContain("Continue worker-x");
      return { stop: "tool_use", content: [toolUse("restart", "spawn", { taskId, branch: "x", prompt: "Continue authorized task" })] };
    }
    return { stop: "end", content: [text("stopped as requested")] };
  } };
  const orch = await createOrchestrator({ project, provider, write() {}, tools: { spawn: makeSpawn({ async running() { return []; }, async start() { starts++; }, async stop() {} }) } });
  await orch.turn();
  expect(calls).toBe(1);
  expect(starts).toBe(0);
  expect(await orch.pending()).toBe(false);
  await orch.say("Continue worker-x");
  await orch.turn();
  expect(starts).toBe(1);
});
