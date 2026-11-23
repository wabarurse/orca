import { expect, test } from "bun:test";
import { tempHome } from "../../test/home";
import { createConversation } from "../conversations";
import { pending } from "../inbox";
import { newRun, writeRun } from "../runner/runs";
import { backgroundContext } from "./context";

const home = tempHome("context");

test("tell reaches a running agent, and the orchestrator when the agent is not running", async () => {
  const c = await createConversation(home.path(), "c");
  await writeRun({ ...newRun({ conversation: c.id, agent: "worker-a", role: "worker", bundle: "worker", branch: "a", runner: "plain" }), state: "running", pid: process.pid });
  const ctx = backgroundContext(c.id, "demo", home.path());
  await ctx.tell("worker-a", "for you");
  await ctx.tell("worker-gone", "lost?");
  expect((await pending(c.id, "worker-a")).map(i => i.message.text)).toEqual(["for you"]);
  expect((await pending(c.id, "orchestrator")).map(i => `${i.message.from}: ${i.message.text}`)).toEqual(["demo: (for worker-gone, which is not running) lost?"]);
  expect((await ctx.agents()).map(a => a.agent)).toEqual(["worker-a"]);
});
