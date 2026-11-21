import { expect, test } from "bun:test";
import { fakeProvider, text, toolUse } from "../test/fake-provider";
import { tempHome } from "../test/home";
import { runHeadless } from "./headless";

const home = tempHome("headless");

test("-p prints the final answer; --json streams every event and ends with the answer", async () => {
  let printed = "";
  const plain = fakeProvider([[text("42")]]);
  const code = await runHeadless({ prompt: "what is 6*7", json: false, model: null, cwd: home.path(), conversation: null, bundle: "orchestrator", yes: false, trust: false,
    out: t => { printed += t; }, resolve: async () => ({ model: "claude-sonnet-5-5", provider: plain, settings: null, contextLimit: null }) });
  expect(code).toBe(0);
  expect(printed).toBe("42\n");

  let lines = "";
  const json = fakeProvider([[text("checking"), toolUse("t1", "bash", { command: "echo hi" })], [text("done: hi")]]);
  await runHeadless({ prompt: "run echo", json: true, model: null, cwd: home.path(), conversation: null, bundle: "orchestrator", yes: false, trust: false,
    out: t => { lines += t; }, resolve: async () => ({ model: "claude-sonnet-5-5", provider: json, settings: null, contextLimit: null }) });
  const events = lines.trim().split("\n").map(line => JSON.parse(line) as { kind: string; text?: string; outcome?: { text: string } });
  expect(events.map(e => e.kind).filter(kind => kind !== "notice")).toEqual(["start", "input", "text", "tool_start", "tool_end", "text", "end"]);
  expect(events.find(e => e.kind === "tool_end")?.outcome?.text).toBe("hi");
  expect(events.at(-1)).toMatchObject({ kind: "end", text: "done: hi" });
});

test("a worker bundle runs headless too, with write tools", async () => {
  let printed = "";
  const provider = fakeProvider([[text("ok")]]);
  await runHeadless({ prompt: "x", json: false, model: null, cwd: home.path(), conversation: null, bundle: "worker", yes: false, trust: false,
    out: t => { printed += t; }, resolve: async () => ({ model: "claude-sonnet-5-5", provider, settings: null, contextLimit: null }) });
  expect(printed).toBe("ok\n");
  expect(provider.calls[0]!.tools).toContain("write");
  expect(provider.calls[0]!.tools).not.toContain("subagent");
});
