import { expect, test } from "bun:test";
import { z } from "zod";
import { fakeProvider, text, toolUse } from "../test/fake-provider";
import { tempHome } from "../test/home";
import { runHeadless } from "./headless";
import { readSpans } from "./spans";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ok, paths } from "../config";
import { createConversation } from "./conversations";

const home = tempHome("headless");

test("-p prints the final answer; --json streams every event and ends with the answer", async () => {
  let printed = "";
  const plain = fakeProvider([[text("42")]]);
  const code = await runHeadless({ prompt: "what is 6*7", json: false, model: null, cwd: home.path(), conversation: null, bundle: "orchestrator", yes: false,
    out: t => { printed += t; }, resolve: async () => ok({ model: "claude-sonnet-5-5", provider: plain, settings: null, contextLimit: null }) });
  expect(code).toBe(0);
  expect(printed).toBe("42\n");

  let lines = "";
  const json = fakeProvider([[text("checking"), toolUse("t1", "bash", { command: "echo hi" })], [text("done: hi")]]);
  await runHeadless({ prompt: "run echo", json: true, model: null, cwd: home.path(), conversation: null, bundle: "orchestrator", yes: false,
    out: t => { lines += t; }, resolve: async () => ok({ model: "claude-sonnet-5-5", provider: json, settings: null, contextLimit: null }) });
  const Event = z.looseObject({ kind: z.string(), conversation: z.string(), text: z.string().optional(), outcome: z.object({ text: z.string() }).optional(),
    span: z.object({ id: z.string(), kind: z.string(), label: z.string(), agent: z.string(), startedAt: z.string(), durationMs: z.number().optional() }).optional() });
  const events = lines.trim().split("\n").map(line => Event.parse(JSON.parse(line)));
  expect(events.filter(e => !e.kind.startsWith("span_")).map(e => e.kind)).toEqual(["start", "input", "text", "tool_start", "tool_end", "text", "end"]);
  const spanEvents = events.flatMap(e => e.span === undefined ? [] : [`${e.kind} ${e.span.kind} ${e.span.label}`]);
  expect(spanEvents).toEqual([
    "span_start prep session", "span_end prep session",
    "span_start prep request", "span_end prep request",
    "span_start model claude-sonnet-5-5", "span_end model claude-sonnet-5-5",
    "span_start tool bash: echo hi", "span_end tool bash: echo hi",
    "span_start prep request", "span_end prep request",
    "span_start model claude-sonnet-5-5", "span_end model claude-sonnet-5-5",
  ]);
  const ends = events.filter(e => e.kind === "span_end");
  expect(ends.every(e => typeof e.span?.durationMs === "number" && e.span.agent === "orchestrator")).toBe(true);
  const conversation = events[0]?.conversation ?? "";
  const recorded = await readSpans(conversation);
  expect(recorded.ok ? recorded.data.map(span => span.id) : []).toEqual(ends.map(e => e.span?.id ?? ""));
  expect(events.find(e => e.kind === "tool_end")?.outcome?.text).toBe("hi");
  expect(events.at(-1)).toMatchObject({ kind: "end", text: "done: hi" });
});

test("a worker bundle runs headless too, with write tools", async () => {
  let printed = "";
  const provider = fakeProvider([[text("ok")]]);
  await runHeadless({ prompt: "x", json: false, model: null, cwd: home.path(), conversation: null, bundle: "worker", yes: false,
    out: t => { printed += t; }, resolve: async () => ok({ model: "claude-sonnet-5-5", provider, settings: null, contextLimit: null }) });
  expect(printed).toBe("ok\n");
  expect(provider.calls[0]?.tools).toContain("write");
  expect(provider.calls[0]?.tools).not.toContain("subagent");
});

test("a real folder under a reserved $ORCA_DATA name is a notice; the session still runs and bash still sees $ORCA_DATA", async () => {
  const conversation = await createConversation(home.path(), "reserved");
  await mkdir(join(paths.data(conversation.id), "global"), { recursive: true });
  let lines = "";
  const provider = fakeProvider([[toolUse("t1", "bash", { command: "printf %s \"$ORCA_DATA\"" })], [text("done")]]);
  const code = await runHeadless({ prompt: "where", json: true, model: null, cwd: home.path(), conversation: conversation.id, bundle: "orchestrator", yes: false,
    out: t => { lines += t; }, resolve: async () => ok({ model: "claude-sonnet-5-5", provider, settings: null, contextLimit: null }) });
  expect(code).toBe(0);
  const Event = z.looseObject({ kind: z.string(), text: z.string().optional(), outcome: z.object({ text: z.string() }).optional() });
  const events = lines.trim().split("\n").map(line => Event.parse(JSON.parse(line)));
  expect(events.filter(e => e.kind === "notice").map(e => e.text ?? "").filter(notice => notice.includes("$ORCA_DATA/global is reserved"))).toHaveLength(1);
  expect(events.find(e => e.kind === "tool_end")?.outcome?.text).toBe(paths.data(conversation.id));
});
