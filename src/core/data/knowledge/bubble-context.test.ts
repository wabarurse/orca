import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../../../config";
import { ensureBubble, joinBubble, putPage, setBehavior, writeNode, type NodeWrite } from "../bubbles";
import { bubbleContext } from "./bubble-context";
import { updateContext } from "./knowledge";

// Isolated ORCA_HOME per test: never the real home.
let home: string, previous: string | undefined;
beforeEach(async () => {
  previous = process.env.ORCA_HOME;
  home = await mkdtemp(join(tmpdir(), "orca-bubble-context-")); process.env.ORCA_HOME = home;
  for (const project of ["one", "two"]) await mkdir(paths.project(project), { recursive: true });
});
afterEach(async () => {
  if (previous === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = previous;
  await rm(home, { recursive: true, force: true });
});
const node = (id: string, title: string, summary: string, text: string): NodeWrite => ({ node: id, title, summary, keywords: null, add: [{ text, sources: [] }], retire: [], revision: null });

test("a conversation without a bubble, or with an empty one, is shown nothing", async () => {
  expect(await bubbleContext("one", "anything", "orchestrator")).toEqual({});
  await ensureBubble("one");
  expect(await bubbleContext("one", "anything", "orchestrator")).toEqual({});
});

test("an orchestrator joining a bubble is shown its behavior, overview, index, notebook, peers and matches", async () => {
  const { id } = await ensureBubble("one", "agent notes");
  await writeNode(id, node("overview", "Overview", "Agent Notes turns what people say into saved facts.", "PR 1 and PR 2 are open."), "one");
  await writeNode(id, node("expected-behavior/start-date", "Start dates", "A start date blocks the days before it.", "\"available starting Nov 19\" saves an unavailable block until Nov 19."), "one");
  await writeNode(id, node("decisions/flags", "Feature flags", "No feature flags unless the user asks.", "User removed both sync flags."), "one");
  await setBehavior(id, { key: "replies", text: "Keep replies short.", source: "m1", quote: "small responses", at: "2026-11-16T00:00:00.000Z" });
  await putPage(id, { title: "Eval run", summary: "54 routing cases", content: "x" }, "worker-a");
  await updateContext("one", { goal: "Ship per-entry sync" });
  await joinBubble("two", id);
  const shown = await bubbleContext("two", "[user] what should we save when a note says available starting Nov 19?", "orchestrator");
  expect(Object.keys(shown).sort()).toEqual(["bubble", "bubble-hits", "bubble-orcs"]);
  expect(shown.bubble).toContain('Bubble "agent notes": the shared knowledge of 2 orchestrators.');
  expect(shown.bubble).toContain("- Keep replies short.");
  expect(shown.bubble).toContain("Agent Notes turns what people say into saved facts.\n- PR 1 and PR 2 are open.");
  expect(shown.bubble).toContain("- decisions/flags — No feature flags unless the user asks.");
  expect(shown.bubble).toContain("Eval run: 54 routing cases");
  expect(shown["bubble-orcs"]).toBe("Other orchestrators attached to this bubble and what each is working on:\n- one (one): Ship per-entry sync");
  expect(shown["bubble-hits"]!.split("\n")[1]).toBe("expected-behavior/start-date (rev 1) — A start date blocks the days before it.");
  expect(shown["bubble-hits"]).not.toContain("decisions/flags");
  expect((await bubbleContext("two", "hello", "orchestrator"))["bubble-hits"]).toBeUndefined();
});

test("a worker carries behavior and the overview but not the index", async () => {
  const { id } = await ensureBubble("one");
  await writeNode(id, node("overview", "Overview", "What the project is.", "Where it stands."), "one");
  await writeNode(id, node("decisions/flags", "Feature flags", "No feature flags unless the user asks.", "User removed both sync flags."), "one");
  const shown = await bubbleContext("one", "remove the feature flags from the sync code", "worker");
  expect(shown.bubble).toContain("What the project is.");
  expect(shown.bubble).toContain("Memory holds 2 nodes and the notebook 0 pages");
  expect(shown.bubble).not.toContain("- decisions/flags —");
  expect(shown["bubble-hits"]).toContain("decisions/flags (rev 1)");
});
