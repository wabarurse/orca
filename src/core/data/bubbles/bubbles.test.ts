import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../../../config";
import { behavior, BEHAVIOR, bubbleDir, bubbleMembers, ensureBubble, joinBubble, leaveBubble, listBubbles, listPages, memoryNodes, NOTEBOOK, peekBubble, purgeNotebook,
  putPage, queryPage, readNode, readPage, renderIndex, searchNodes, setBehavior, tokens, writeNode, type NodeWrite } from ".";

// Isolated ORCA_HOME per test: never the real home.
let home: string, previous: string | undefined;
beforeEach(async () => {
  previous = process.env.ORCA_HOME;
  home = await mkdtemp(join(tmpdir(), "orca-bubbles-")); process.env.ORCA_HOME = home;
  for (const project of ["one", "two"]) await mkdir(paths.project(project), { recursive: true });
});
afterEach(async () => {
  if (previous === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = previous;
  await rm(home, { recursive: true, force: true });
});
const write = (node: string, extra: Partial<NodeWrite> = {}): NodeWrite => ({ node, title: null, summary: null, keywords: null, add: [], retire: [], revision: null, ...extra });

test("a conversation has no bubble until it needs one, and a second conversation can join it", async () => {
  expect(peekBubble("one")).toBeNull();
  const bubble = await ensureBubble("one", "agent notes");
  expect(peekBubble("one")).toBe(bubble.id);
  expect((await ensureBubble("one", "another name")).id).toBe(bubble.id);
  await joinBubble("two", bubble.id);
  expect(bubbleMembers(bubble.id)).toEqual(["one", "two"]);
  expect((await listBubbles()).map(b => b.name)).toEqual(["agent notes"]);
});

test("the bubble's files stay until its last conversation leaves", async () => {
  const bubble = await ensureBubble("one");
  await joinBubble("two", bubble.id);
  expect(await leaveBubble("one")).toEqual({ bubble: bubble.id, removed: false });
  expect(existsSync(bubbleDir(bubble.id))).toBe(true);
  await rm(paths.project("one"), { recursive: true });
  expect(await leaveBubble("two")).toEqual({ bubble: bubble.id, removed: true });
  expect(existsSync(bubbleDir(bubble.id))).toBe(false);
});

test("a node is created with a title and summary, and another orchestrator sees it", async () => {
  const { id } = await ensureBubble("one");
  await expect(writeNode(id, write("decisions/flags", { add: [{ text: "No feature flags unless asked.", sources: ["m1"] }] }), "one")).rejects.toThrow("needs a title and a summary");
  const node = await writeNode(id, write("decisions/flags", { title: "Feature flags", summary: "No feature flags unless the user asks.", keywords: ["Flags"],
    add: [{ text: "User said \"this is default behavior, no flags\".", sources: ["m1"] }] }), "one", "2026-11-16T00:00:00.000Z");
  expect(node.revision).toBe(1);
  expect(await readNode(id, "decisions/flags")).toEqual({ id: "decisions/flags", title: "Feature flags", summary: "No feature flags unless the user asks.", keywords: ["flags"],
    updated: "2026-11-16T00:00:00.000Z", revision: 1, entries: [{ text: "User said \"this is default behavior, no flags\".", at: "2026-11-16T00:00:00.000Z", author: "one", sources: ["m1"], retired: null }] });
  await expect(writeNode(id, write("flags", { title: "x", summary: "y" }), "one")).rejects.toThrow("invalid memory node id");
});

test("adding an entry needs no revision; changing the summary or retiring an entry does", async () => {
  const { id } = await ensureBubble("one");
  await writeNode(id, write("expected-behavior/start-date", { title: "Start dates", summary: "A start date marks nothing before it.", add: [{ text: "Earlier days stay untouched.", sources: [] }] }), "one");
  const added = await writeNode(id, write("expected-behavior/start-date", { add: [{ text: "Seen in production on Nov 10.", sources: [] }] }), "two");
  expect(added.revision).toBe(2);
  const change = write("expected-behavior/start-date", { summary: "A start date blocks the days before it.", retire: [0], add: [{ text: "User restored the blocking rule.", sources: ["m9"] }] });
  await expect(writeNode(id, { ...change, revision: 1 }, "two")).rejects.toThrow("is at revision 2, not 1");
  const node = await writeNode(id, { ...change, revision: 2 }, "two", "2026-11-17T00:00:00.000Z");
  expect(node.summary).toBe("A start date blocks the days before it.");
  expect(node.entries.map(e => e.retired)).toEqual(["2026-11-17T00:00:00.000Z", null, null]);
  expect((await memoryNodes(id))[0]!.entries.length).toBe(3);
});

test("search finds the node and the lines inside it, by identifier or by wording, and skips retired lines", async () => {
  const { id } = await ensureBubble("one");
  await writeNode(id, write("work-log/sync-entries", { title: "Per-entry sync stack", summary: "#25988 records per-entry changes; #26041 makes one item per changed entry.",
    add: [{ text: "PR #26041 (PHO-18782 sits inside it) is stacked on #25988.", sources: [] }, { text: "AGENT_NOTES_SYNC_ENTRY_ITEMS_ENABLED was removed at the user's request.", sources: [] }] }), "one");
  await writeNode(id, write("how-it-works/memory-writes", { title: "Memory writes", summary: "Luna plans each memory write against stored fragments.", keywords: ["contradiction"],
    add: [{ text: "It drops duplicates and resolves conflicting facts.", sources: [] }, { text: "An old append-only writer existed.", sources: [] }] }), "one");
  const stale = await readNode(id, "how-it-works/memory-writes");
  await writeNode(id, write("how-it-works/memory-writes", { retire: [1], revision: stale!.revision }), "one");
  const nodes = await memoryNodes(id);
  const byId = searchNodes(nodes, ["what is PHO-18782"]);
  expect(byId[0]!.id).toBe("work-log/sync-entries");
  expect(byId[0]!.entries[0]).toEqual({ n: 0, text: "PR #26041 (PHO-18782 sits inside it) is stacked on #25988." });
  expect(searchNodes(nodes, ["#26041"])[0]!.id).toBe("work-log/sync-entries");
  expect(searchNodes(nodes, ["sync_entry_items flag"])[0]!.entries[0]!.n).toBe(1);
  const worded = searchNodes(nodes, ["how did we implement contradiction resolution", "conflicting facts"]);
  expect(worded[0]!.id).toBe("how-it-works/memory-writes");
  expect(worded[0]!.entries.map(e => e.n)).toEqual([0]);
  expect(searchNodes(nodes, ["append-only writer"]).flatMap(h => h.entries.map(e => e.text))).not.toContain("An old append-only writer existed.");
  expect(searchNodes(nodes, ["zebra"])).toEqual([]);
  expect(tokens("PHO-18782 and #26041")).toEqual(["pho-18782", "pho", "18782", "#26041", "26041"]);
});

test("the index lists every node while it fits, then shrinks the busiest branch", async () => {
  const { id } = await ensureBubble("one");
  for (let n = 0; n < 12; n++) await writeNode(id, write(`how-it-works/part-${String(n).padStart(2, "0")}`, { title: `Part ${n}`, summary: `Part ${n} does its job in a specific way.` }), "one", `2026-11-${String(n + 1).padStart(2, "0")}T00:00:00.000Z`);
  await writeNode(id, write("goals/main", { title: "Goal", summary: "Keep facts about people accurate." }), "one");
  const nodes = await memoryNodes(id);
  expect(renderIndex(nodes).split("\n").filter(row => row.startsWith("- ")).length).toBe(13);
  const small = renderIndex(nodes, 700);
  expect(small).toContain("- goals/main — Keep facts about people accurate.");
  expect(small).toContain("(12 nodes, newest");
  expect(small).toContain("- how-it-works/part-11");
  expect(small).not.toContain("- how-it-works/part-00");
});

test("a notebook page is listed by its summary and read or queried by range", async () => {
  const { id } = await ensureBubble("one");
  const page = await putPage(id, { title: "Eval results", summary: "routing_ehr_notes, 54 cases, XML Decisions", content: Array.from({ length: 50 }, (_, n) => `case ${n + 1},${n % 7 === 0 ? "fail" : "pass"}`).join("\n") }, "worker-a");
  expect((await listPages(id)).map(p => [p.title, p.author, p.archivedAt])).toEqual([["Eval results", "worker-a", null]]);
  expect(await readPage(id, page.id, 49, 10)).toBe(`${page.id} "Eval results" lines 49-50 of 50\ncase 49,pass\ncase 50,fail`);
  expect((await readPage(id, page.id, 1, 2)).split("\n")[0]).toBe(`${page.id} "Eval results" lines 1-2 of 50 (continue with start_line 3)`);
  expect((await queryPage(id, page.id, ",fail$")).split("\n").slice(0, 2)).toEqual([`${page.id} "Eval results": 8 matching lines of 50`, "1: case 1,fail"]);
  await expect(readPage(id, "page-00000000")).rejects.toThrow("no notebook page");
});

test("over the limit the coldest page is archived, a read restores it, and old archives are purged", async () => {
  const { id } = await ensureBubble("one");
  const ids: string[] = [];
  for (let n = 0; n < NOTEBOOK.pages + 1; n++) ids.push((await putPage(id, { title: `t${n}`, summary: "s", content: "x" }, "one", new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString())).id);
  const archived = (await listPages(id)).filter(p => p.archivedAt);
  expect(archived.map(p => p.id)).toEqual([ids[0]!]);
  expect(await purgeNotebook(id, Date.parse(archived[0]!.archivedAt!) + 13 * 86_400_000)).toEqual([]);
  expect(await readPage(id, ids[0]!, 1, 1, "2026-02-01T00:00:00.000Z")).toContain("\nx");
  const after = await listPages(id);
  expect(after.find(p => p.id === ids[0])!.archivedAt).toBeNull();
  expect(after.filter(p => p.archivedAt).map(p => p.id)).toEqual([ids[1]!]);
  const gone = await purgeNotebook(id, Date.parse("2026-02-01T00:00:00.000Z") + 15 * 86_400_000);
  expect(gone.map(p => p.id)).toEqual([ids[1]!]);
  expect((await listPages(id)).length).toBe(NOTEBOOK.pages);
  await expect(readPage(id, ids[1]!)).rejects.toThrow("no notebook page");
});

test("behavior lines are capped and replaced by key", async () => {
  const { id } = await ensureBubble("one");
  const line = (key: string, text: string) => ({ key, text, source: "m1", quote: text, at: "2026-11-16T00:00:00.000Z" });
  await setBehavior(id, line("replies", "Keep replies short."));
  await setBehavior(id, line("replies", "Keep replies short and use tables."));
  expect((await behavior(id)).map(l => l.text)).toEqual(["Keep replies short and use tables."]);
  for (let n = 1; n < BEHAVIOR.lines; n++) await setBehavior(id, line(`k${n}`, `rule ${n}`));
  await expect(setBehavior(id, line("extra", "one more"))).rejects.toThrow("already has 20 behavior lines");
  await setBehavior(id, { key: "k1", text: null });
  expect((await setBehavior(id, line("extra", "one more"))).length).toBe(BEHAVIOR.lines);
});
