import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../../config";
import { joinBubble, listPages, peekBubble } from "../data/bubbles";
import { knowledge } from "./knowledge";
import { notebook } from "./notebook";
import { registry } from "./index";
import { toolsFor, type ToolContext } from "./registry";

// Isolated ORCA_HOME per test: never the real home.
let home: string, previous: string | undefined;
const orc: ToolContext = { project: "one", role: "orchestrator", cwd: "/" };
const second: ToolContext = { project: "two", role: "orchestrator", cwd: "/" };
const worker: ToolContext = { project: "one", role: "worker", branch: "fix-sync", cwd: "/" };
beforeEach(async () => {
  previous = process.env.ORCA_HOME;
  home = await mkdtemp(join(tmpdir(), "orca-knowledge-tool-")); process.env.ORCA_HOME = home;
  for (const project of ["one", "two"]) await mkdir(paths.project(project), { recursive: true });
});
afterEach(async () => {
  if (previous === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = previous;
  await rm(home, { recursive: true, force: true });
});
const write = (ctx: ToolContext, extra: Record<string, unknown>) => knowledge.run({ action: "write", node: "decisions/flags", ...extra }, ctx);

test("every role has knowledge and notebook; only reads may run in parallel", () => {
  for (const role of ["orchestrator", "worker", "reviewer"] as const) { expect(toolsFor[role]).toContain("knowledge"); expect(toolsFor[role]).toContain("notebook"); }
  expect(registry.knowledge).toBe(knowledge); expect(registry.notebook).toBe(notebook);
  expect(knowledge.parallel!({ action: "search" })).toBe(true);
  expect(knowledge.parallel!({ action: "write" })).toBe(false);
});

test("an empty bubble reads as empty without being created", async () => {
  expect(await knowledge.run({ action: "search", queries: ["flags"] }, orc)).toBe("knowledge is empty: nothing has been written to this bubble yet");
  expect(await notebook.run({ action: "list" }, orc)).toBe("the notebook is empty");
  expect(peekBubble("one")).toBeNull();
});

test("one orchestrator writes, another attached to the bubble finds and reads it", async () => {
  expect(await write(orc, { title: "Feature flags", summary: "No feature flags unless the user asks.", add: [{ text: "User: \"this is default behavior, no flags\".", sources: ["input-7"] }] }))
    .toBe("wrote decisions/flags (rev 1, 1 current entries): No feature flags unless the user asks.");
  await joinBubble("two", peekBubble("one")!);
  expect(await knowledge.run({ action: "search", queries: ["are feature flags allowed"] }, second)).toBe('decisions/flags (rev 1) — No feature flags unless the user asks.\n  [0] User: "this is default behavior, no flags".');
  const read = await knowledge.run({ action: "read", ids: ["decisions/flags", "goals/none"] }, second);
  expect(read).toContain("decisions/flags (rev 1) Feature flags\nNo feature flags unless the user asks.\n[0] User: \"this is default behavior, no flags\". (");
  expect(read).toContain("one; sources: input-7)");
  expect(read).toContain("goals/none: no such node");
  expect(await knowledge.run({ action: "list", branch: "decisions" }, second)).toBe("- decisions/flags — No feature flags unless the user asks.");
});

test("replacing a fact retires the old entry and needs the revision; a stale writer is told to read again", async () => {
  await write(orc, { title: "Feature flags", summary: "Flags are fine.", add: [{ text: "Flags are fine." }] });
  await joinBubble("two", peekBubble("one")!);
  await write(second, { add: [{ text: "A second orchestrator adds a detail." }] });
  await expect(write(orc, { summary: "No feature flags unless the user asks.", retire: [0], revision: 1, add: [{ text: "User removed the flags." }] })).rejects.toThrow("is at revision 2, not 1");
  expect(await write(orc, { summary: "No feature flags unless the user asks.", retire: [0], revision: 2, add: [{ text: "User removed the flags." }] })).toContain("rev 3, 2 current entries");
  const read = await knowledge.run({ action: "read", ids: ["decisions/flags"] }, second);
  expect(read).not.toContain("[0] Flags are fine.");
  expect(read).toContain("(1 retired entry kept as history in the node file)");
});

test("workers read knowledge but cannot write it; they write the notebook", async () => {
  await expect(write(worker, { title: "t", summary: "s" })).rejects.toThrow("workers read knowledge");
  expect(await notebook.run({ action: "put", title: "Eval run", summary: "54 routing cases", content: "case 1,pass\ncase 2,fail" }, worker)).toMatch(/^saved page-[a-f0-9]{8} "Eval run" \(23 bytes\)$/);
  const [page] = await listPages(peekBubble("one")!);
  expect(page!.author).toBe("worker-fix-sync");
  expect(await notebook.run({ action: "query", id: page!.id, pattern: "fail" }, orc)).toBe(`${page!.id} "Eval run": 1 matching line of 2\n2: case 2,fail`);
  expect(await notebook.run({ action: "list" }, orc)).toBe(`- ${page!.id} — Eval run: 54 routing cases (23 bytes)`);
  await expect(notebook.run({ action: "put", title: "x", summary: "y" }, worker)).rejects.toThrow("exactly one of content or path");
});
