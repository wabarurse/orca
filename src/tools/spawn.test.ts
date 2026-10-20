import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../config";
import { drain } from "../inbox";
import type { Runner, StartOptions } from "../runner";
import { open } from "../transcript";
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
const ctx = (role: ToolContext["role"], branch?: string): ToolContext => ({ project: "p", role, branch, cwd: "/" });

test("spawn seeds the worker transcript with the prompt and starts it on the branch", async () => {
  const id = await spawn.run({ prompt: "Add a login page", branch: "feat/login" }, ctx("orchestrator"));
  expect(id).toBe("worker-feat-login");
  expect(started).toEqual([{ project: "p", role: "worker", branch: "feat/login" }]);
  const chain = await open(paths.transcript("p", "worker-feat-login")).chain();
  expect(chain).toEqual([{ role: "user", content: "Branch: feat/login\n\nAdd a login page" }]);
});

test("spawn with role reviewer uses the same branch and its own transcript", async () => {
  const id = await spawn.run({ prompt: "Review it", branch: "feat/login", role: "reviewer" }, ctx("orchestrator"));
  expect(id).toBe("reviewer-feat-login");
  expect(started.at(-1)).toEqual({ project: "p", role: "reviewer", branch: "feat/login" });
});

test("spawning again on the same branch appends to the existing transcript", async () => {
  await spawn.run({ prompt: "Round two", branch: "feat/login", role: "reviewer" }, ctx("orchestrator"));
  const chain = await open(paths.transcript("p", "reviewer-feat-login")).chain();
  expect(chain.map((m) => m.content)).toEqual(["Branch: feat/login\n\nReview it", "Branch: feat/login\n\nRound two"]);
});

test("spawn refuses missing input and non-orchestrators", async () => {
  expect(await spawn.run({ prompt: "x" }, ctx("orchestrator"))).toContain("required");
  expect(await spawn.run({ prompt: "x", branch: "b" }, ctx("worker", "b"))).toContain("only the orchestrator");
  expect(started).toHaveLength(3);
});

test("message delivers to the named inbox and refuses self or empty", async () => {
  expect(await message.run({ to: "orchestrator", text: "done, PR #4" }, ctx("worker", "feat/login"))).toBe("sent to orchestrator");
  expect(await message.run({ to: "user", text: "all green" }, ctx("orchestrator"))).toBe("sent to user");
  expect(await message.run({ to: "worker-feat-login", text: "also fix the test" }, ctx("orchestrator"))).toBe("sent to worker-feat-login");
  expect(await message.run({ to: "worker-b", text: "  " }, ctx("worker", "b"))).toContain("empty");
  expect(await message.run({ text: "x" }, ctx("worker", "b"))).toContain("`to` is required");
  expect(await message.run({ to: "worker-b", text: "hi me" }, ctx("worker", "b"))).toContain("own inbox");
  expect((await drain("p", "orchestrator")).map((m) => [m.from, m.text])).toEqual([["worker-feat-login", "done, PR #4"]]);
  expect((await drain("p", "user")).map((m) => m.from)).toEqual(["orchestrator"]);
  expect((await drain("p", "worker-feat-login")).map((m) => m.text)).toEqual(["also fix the test"]);
});
