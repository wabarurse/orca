import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drain } from "../inbox";
import type { Runner, StartOptions } from "../runner";
import { readTasks } from "../tasks";
import type { ToolContext } from "./index";
import { message } from "./message";
import { makeSpawn } from "./spawn";

const home = mkdtempSync(join(tmpdir(), "parallels-spawn-"));
process.env.PARALLELS_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));

const started: StartOptions[] = [];
const fakeRunner: Runner = {
  async start(opts) {
    started.push(opts);
  },
  async stop() {},
};
const spawn = makeSpawn(fakeRunner);
const ctx = (role: ToolContext["role"], taskId?: string): ToolContext => ({ project: "p", role, taskId, cwd: "/" });

test("spawn with desc adds a task and starts a worker on its branch", async () => {
  const id = await spawn.run({ desc: "Add a login page" }, ctx("orchestrator"));
  expect(id).toBe("t1");
  expect(started).toEqual([{ project: "p", role: "worker", taskId: "t1", branch: "t1-add-a-login-page" }]);
  expect((await readTasks("p"))[0]?.status).toBe("working");
});

test("spawn with task starts a reviewer on the same branch", async () => {
  const id = await spawn.run({ task: "t1" }, ctx("orchestrator"));
  expect(id).toBe("t1");
  expect(started.at(-1)).toEqual({ project: "p", role: "reviewer", taskId: "t1", branch: "t1-add-a-login-page" });
  expect((await readTasks("p"))[0]?.status).toBe("review");
});

test("spawn refuses unknown tasks, empty input and non-orchestrators", async () => {
  expect(await spawn.run({ task: "t9" }, ctx("orchestrator"))).toContain("no task t9");
  expect(await spawn.run({}, ctx("orchestrator"))).toContain("refused");
  expect(await spawn.run({ desc: "x" }, ctx("worker", "t1"))).toContain("only the orchestrator");
  expect(started).toHaveLength(2);
});

test("message routes workers to the inbox and the orchestrator to the outbox", async () => {
  expect(await message.run({ text: "done, PR #4" }, ctx("worker", "t1"))).toBe("sent");
  expect(await message.run({ text: "all green" }, ctx("orchestrator"))).toBe("sent");
  expect(await message.run({ text: "  " }, ctx("worker", "t1"))).toContain("empty");
  const inbox = await drain("p");
  const outbox = await drain("p", "outbox");
  expect(inbox).toHaveLength(1);
  expect(inbox[0]?.from).toBe("worker-t1");
  expect(outbox[0]?.from).toBe("orchestrator");
});
