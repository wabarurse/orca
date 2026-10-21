import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cancelSession, watchCancellation } from "./cancellation";
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
  const off = watchCancellation("p", "worker-x", worker);
  const otherOff = watchCancellation("p", "reviewer-x", reviewer);
  let nextOff = () => {};
  try {
    await cancelSession("p", "worker-x");
    await until(() => worker.signal.aborted);
    expect(reviewer.signal.aborted).toBe(false);
    const next = new AbortController();
    nextOff = watchCancellation("p", "worker-x", next);
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
  expect(JSON.stringify(messages)).toContain("Cancelled by user");
  expect(provider.calls).toHaveLength(1);
  expect((await drain(project, "orchestrator"))[0]!.text).toContain("cancelled by user");
  const next = fakeProvider([[text("continuing original task")]]);
  expect(await runAgent({ project, branch, role: "worker", loadProvider: async () => next })).toBe(0);
  expect(next.calls[0]!.messages).toEqual(messages);
});

test("cancellation during supervised startup targets that run, never its replacement", async () => {
  const project = "startup", id = "reviewer-x";
  await Bun.write(`${paths.runs(project)}/${id}.json`, JSON.stringify({ run: "first" }));
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
