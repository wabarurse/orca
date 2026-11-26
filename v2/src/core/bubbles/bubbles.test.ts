import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { cp, lstat, mkdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createBubble, joinBubble, readBubble } from ".";
import { paths } from "../../config";
import { tempHome } from "../../test/home";
import { bubbleChoices, bubbleEntries } from "../../tui/bubbles";
import { createConversation, readConversation } from "../conversations";
import { behavior, BEHAVIOR, setBehavior } from "./behavior";
import { ensureDataDirs, pluginData } from "./data";
import { mergeBubbles, mergeNode, unionBehavior, unionEntries, unionPlugins } from "./merge";
import { type Entry, type MemoryNode, memoryNodes, writeNode } from "./nodes";
import { listPages, putPage } from "./notebook";
import { bubblesFor, ensureBubble, listBubbles, setBubbleDirectory, setBubblePlugin } from "./store";

describe("bubble records and folders", () => {
  const home = tempHome("bubble-store");

  test("a bubble written before folders still reads (with no folder, offered nowhere); pointed at a folder it serves that folder and the ones inside it", async () => {
    mkdirSync(join(paths.bubbles, "bubble-0000000a"), { recursive: true });
    writeFileSync(join(paths.bubbles, "bubble-0000000a", "bubble.json"), JSON.stringify({ id: "bubble-0000000a", name: "raven", createdAt: "2026-11-17T17:13:41.091Z", plugins: { on: [], off: [] } }));
    expect((await listBubbles()).map(b => [b.name, b.directory])).toEqual([["raven", null]]);
    const repo = join(home.path(), "raven");
    expect(await bubblesFor(repo)).toEqual([]);
    expect((await setBubbleDirectory("bubble-0000000a", repo)).ok).toBe(true);
    expect((await bubblesFor(repo)).map(b => b.name)).toEqual(["raven"]);
    expect((await bubblesFor(join(repo, "apps", "web"))).map(b => b.name)).toEqual(["raven"]);
    expect(await bubblesFor(`${repo}-fork`)).toEqual([]);
  });
});

describe("the bubble picker", () => {
  const home = tempHome("tui-bubbles");

  test("the picker offers the folder's bubbles first, then every other bubble labelled with its folder, and joining one from another folder keeps its folder", async () => {
    const a = join(home.path(), "a"), b = join(home.path(), "b");
    const inB = await createConversation(b, null);
    const other = await createBubble(inB.id, "zebra");
    const inA = await createConversation(a, null);
    const own = await createBubble(inA.id, "yak");
    if (!other.ok || !own.ok) throw new Error("bubbles not created");
    const { entries } = await bubbleEntries(join(a, "sub"));
    expect(entries.map(e => [e.bubble.name, e.here])).toEqual([["yak", true], ["zebra", false]]);
    const { options, choices } = await bubbleChoices(a);
    expect(options[1]?.startsWith("yak")).toBe(true);
    expect(options[2]?.startsWith("zebra")).toBe(true);
    expect(options[2]?.endsWith(b)).toBe(true);
    expect(choices[2]).toEqual({ kind: "join", id: other.data.id });
    const fresh = await createConversation(a, null);
    expect((await joinBubble(fresh.id, other.data.id)).ok).toBe(true);
    expect((await readConversation(fresh.id))?.bubble).toBe(other.data.id);
    expect((await readBubble(other.data.id))?.directory).toBe(b);
  });
});

describe("bubble memory, notebook and plugin data", () => {
  const home = tempHome("data");

  const bubbleOf = async (conversation: string): Promise<string> => {
    const ensured = await ensureBubble(conversation);
    if (!ensured.ok) throw new Error(ensured.error);
    return ensured.data.id;
  };

  describe("$ORCA_DATA", () => {
    test("a conversation without a bubble gets its folder and the global link, but no bubble link", async () => {
      const c = await createConversation(home.path(), "plain");
      const data = await ensureDataDirs(c.id);
      expect(data).toEqual({ ok: true, data: paths.data(c.id) });
      expect(await readlink(join(paths.data(c.id), "global"))).toBe(paths.globalData);
      expect(existsSync(join(paths.data(c.id), "bubble"))).toBe(false);
    });

    test("the bubble link appears when the conversation gets a bubble and follows it when it joins another", async () => {
      const one = await createConversation(home.path(), "one"), two = await createConversation(home.path(), "two");
      await ensureDataDirs(one.id);
      const first = await bubbleOf(one.id), second = await bubbleOf(two.id);
      const link = join(paths.data(one.id), "bubble");
      expect(await readlink(link)).toBe(paths.bubbleData(first));
      await writeFile(join(link, "note.txt"), "shared");
      expect(await readFile(join(paths.bubbleData(first), "note.txt"), "utf8")).toBe("shared");
      const joined = await joinBubble(one.id, second);
      expect(joined.ok).toBe(true);
      expect(await readlink(link)).toBe(paths.bubbleData(second));
    });

    test("a real folder under a reserved name is refused, not replaced, and the other link is still made", async () => {
      const c = await createConversation(home.path(), "reserved");
      await mkdir(join(paths.data(c.id), "global", "plugin"), { recursive: true });
      const bubble = await bubbleOf(c.id);
      const data = await ensureDataDirs(c.id);
      expect(data.ok).toBe(false);
      if (!data.ok) expect(data.error).toContain("$ORCA_DATA/global is reserved");
      expect((await lstat(join(paths.data(c.id), "global"))).isDirectory()).toBe(true);
      expect(await readlink(join(paths.data(c.id), "bubble"))).toBe(paths.bubbleData(bubble));
      expect(await pluginData(c.id, "notes", "conversation")).toEqual({ ok: true, data: join(paths.data(c.id), "notes") });
      expect((await pluginData(c.id, "notes", "global")).ok).toBe(false);
    });

    test("plugin data has three scopes, a bubble only once there is one, and no reserved plugin names", async () => {
      const c = await createConversation(home.path(), "scopes");
      expect(await pluginData(c.id, "notes", "global")).toEqual({ ok: true, data: join(paths.data(c.id), "global", "notes") });
      expect(existsSync(join(paths.globalData, "notes"))).toBe(true);
      expect((await pluginData(c.id, "notes", "bubble")).ok).toBe(false);
      const bubble = await bubbleOf(c.id);
      expect(await pluginData(c.id, "notes", "bubble")).toEqual({ ok: true, data: join(paths.data(c.id), "bubble", "notes") });
      expect(existsSync(join(paths.bubbleData(bubble), "notes"))).toBe(true);
      expect((await pluginData(c.id, "global", "conversation")).ok).toBe(false);
    });

    test("removing the conversation folder removes its links and keeps what they point at", async () => {
      const c = await createConversation(home.path(), "removed");
      const bubble = await bubbleOf(c.id);
      const global = await pluginData(c.id, "keep", "global"), shared = await pluginData(c.id, "keep", "bubble");
      if (!global.ok || !shared.ok) throw new Error("plugin data");
      await writeFile(join(global.data, "kept.txt"), "global");
      await writeFile(join(shared.data, "kept.txt"), "bubble");
      await rm(paths.conversation(c.id), { recursive: true, force: true });
      expect(await readFile(join(paths.globalData, "keep", "kept.txt"), "utf8")).toBe("global");
      expect(await readFile(join(paths.bubbleData(bubble), "keep", "kept.txt"), "utf8")).toBe("bubble");
    });
  });
});

describe("merging bubbles", () => {
  const home = tempHome("bubble-merge");
  const NOW = "2026-05-01T00:00:00.000Z";
  const options = { dryRun: false, force: false, now: NOW };

  async function bubble(name: string): Promise<{ chat: string; id: string }> {
    const chat = await createConversation(home.path(), name);
    const made = await createBubble(chat.id, name);
    if (!made.ok) throw new Error(made.error);
    return { chat: chat.id, id: made.data.id };
  }

  const entry = (text: string, at: string, retired: string | null = null): Entry => ({ text, at, author: "orchestrator", sources: [], retired });
  const node = (entries: Entry[], title = "T", summary = "S"): MemoryNode => ({ id: "goals/x", title, summary, keywords: [], updated: "", revision: 3, entries });
  const line = (key: string, text: string) => ({ key, text, confidence: "explicit" as const, source: "", quote: "", at: NOW });

  describe("merge helpers", () => {
    test("same-id entries are unioned by date, exact duplicates dropped, a retirement kept", () => {
      const a = [entry("one", "2026-01-01"), entry("three", "2026-03-01")];
      const b = [entry("two", "2026-02-01"), entry("one", "2026-01-01", "2026-04-01")];
      const { entries, added } = unionEntries(a, b);
      expect(added).toBe(1);
      expect(entries.map(e => [e.text, e.retired])).toEqual([["one", "2026-04-01"], ["two", null], ["three", null]]);
    });

    test("the target's title and summary win; an empty one falls back to the source's", () => {
      expect(mergeNode(node([]), node([entry("n", "2026-01-01")], "other", "theirs"), NOW).node).toMatchObject({ title: "T", summary: "S", revision: 4, updated: NOW });
      expect(mergeNode(node([], "", ""), node([], "other", "theirs"), NOW).node).toMatchObject({ title: "other", summary: "theirs" });
      const same = node([entry("n", "2026-01-01")]);
      expect(mergeNode(same, node([entry("n", "2026-01-01")]), NOW).node).toBe(same);
    });

    test("behavior drops normalized duplicates and renames a clashing key", () => {
      const merged = unionBehavior([line("tone", "Be brief.")], [line("tone2", "  be   BRIEF "), line("tone", "Use tables")]);
      expect(merged.duplicates).toEqual(["tone2"]);
      expect(merged.rekeyed).toEqual([{ from: "tone", to: "tone-2" }]);
      expect(merged.lines.map(l => l.key)).toEqual(["tone", "tone-2"]);
    });

    test("plugin switches union with the target winning a conflict", () => {
      expect(unionPlugins({ on: ["a"], off: ["b"] }, { on: ["b", "c"], off: ["a", "d"] })).toEqual({ on: ["c"], off: ["d"], conflicts: ["b", "a"] });
    });
  });

  describe("mergeBubbles", () => {
    test("a dry run reports and writes nothing", async () => {
      const from = await bubble("dry-from"), into = await bubble("dry-into");
      expect((await writeNode(from.id, { node: "goals/dry", title: "Dry", summary: "dry run", keywords: null, add: [{ text: "fact", sources: [] }], retire: [], revision: null }, "o")).ok).toBe(true);
      const plan = await mergeBubbles(from.id, into.id, { ...options, dryRun: true });
      expect(plan.ok && plan.data.nodes.added).toEqual(["goals/dry"]);
      expect(await memoryNodes(into.id)).toEqual([]);
      expect((await readConversation(from.chat))?.bubble).toBe(from.id);
      expect((await readBubble(from.id))?.name).toBe("dry-from");
    });

    test("memory, notebook, behavior, chats, plugins and data move; the source stays as a renamed backup", async () => {
      const from = await bubble("src"), into = await bubble("dst");
      const page = await putPage(from.id, { title: "Log", summary: "a log", content: "hello" }, "o");
      if (!page.ok) throw new Error(page.error);
      await cp(join(paths.bubble(from.id), "notebook"), join(paths.bubble(into.id), "notebook"), { recursive: true });
      await writeNode(from.id, { node: "goals/shared", title: "From title", summary: "from", keywords: null, add: [{ text: `see ${page.data.id}`, sources: [page.data.id] }], retire: [], revision: null }, "o", "2026-02-01T00:00:00.000Z");
      await writeNode(into.id, { node: "goals/shared", title: "Into title", summary: "into", keywords: null, add: [{ text: `mine ${page.data.id}`, sources: [] }], retire: [], revision: null }, "o", "2026-01-01T00:00:00.000Z");
      await writeNode(from.id, { node: "decisions/only-from", title: "Only", summary: "only from", keywords: null, add: [{ text: "x", sources: [] }], retire: [], revision: null }, "o");
      await setBehavior({ kind: "bubble", bubble: into.id }, line("a", "Be brief"));
      await setBehavior({ kind: "bubble", bubble: from.id }, line("b", "be brief."));
      await setBehavior({ kind: "bubble", bubble: from.id }, line("c", "Use tables"));
      await setBubblePlugin(into.id, "tasks", "off");
      await setBubblePlugin(from.id, ["tasks", "images"], "on");
      await mkdir(join(paths.bubbleData(from.id), "p"), { recursive: true });
      await mkdir(join(paths.bubbleData(into.id), "p"), { recursive: true });
      await writeFile(join(paths.bubbleData(from.id), "p", "new.json"), "from");
      await writeFile(join(paths.bubbleData(from.id), "p", "same.json"), "from");
      await writeFile(join(paths.bubbleData(into.id), "p", "same.json"), "into");

      const merged = await mergeBubbles("src", "dst", options);
      if (!merged.ok) throw new Error(merged.error);
      const plan = merged.data;
      expect(plan.pages.renamed.length).toBe(1);
      const renamed = plan.pages.renamed[0]?.to ?? "";
      const nodes = await memoryNodes(into.id);
      expect(nodes.map(n => n.id)).toEqual(["decisions/only-from", "goals/shared"]);
      const shared = nodes.find(n => n.id === "goals/shared");
      expect(shared?.title).toBe("Into title");
      expect(shared?.entries.map(e => e.text)).toEqual([`mine ${page.data.id}`, `see ${renamed}`]);
      expect(shared?.entries[1]?.sources).toEqual([renamed]);
      expect(await readFile(join(paths.bubble(into.id), "memory", "INDEX.md"), "utf8")).toContain("- decisions/only-from — only from");
      expect((await listPages(into.id)).map(p => p.id).sort()).toEqual([page.data.id, renamed].sort());
      expect(existsSync(join(paths.bubble(into.id), "notebook", `${renamed}.txt`))).toBe(true);
      expect((await behavior({ kind: "bubble", bubble: into.id })).map(l => l.key)).toEqual(["a", "c"]);
      expect((await readBubble(into.id))?.plugins).toEqual({ on: ["images"], off: ["tasks"] });
      expect(plan.plugins.conflicts).toEqual(["tasks"]);
      expect(plan.data).toEqual({ copied: ["p/new.json"], clashes: ["p/same.json"] });
      expect(await readFile(join(paths.bubbleData(into.id), "p", "same.json"), "utf8")).toBe("into");
      expect((await readConversation(from.chat))?.bubble).toBe(into.id);
      expect((await readBubble(from.id))?.name).toBe("src (merged into dst)");
      expect((await listBubbles()).some(b => b.id === from.id)).toBe(true);
    });

    test("a behavior union over the cap fails before writing unless --force keeps the target's lines first", async () => {
      const from = await bubble("cap-from"), into = await bubble("cap-into");
      for (let n = 0; n < BEHAVIOR.lines; n++) await setBehavior({ kind: "bubble", bubble: into.id }, line(`i${n}`, `into ${n}`));
      await setBehavior({ kind: "bubble", bubble: from.id }, line("f", "from line"));
      const refused = await mergeBubbles(from.id, into.id, options);
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error).toContain("cap-from: f — from line");
      expect((await readConversation(from.chat))?.bubble).toBe(from.id);
      const forced = await mergeBubbles(from.id, into.id, { ...options, force: true });
      expect(forced.ok && forced.data.behavior.dropped).toEqual(["f"]);
      expect((await behavior({ kind: "bubble", bubble: into.id })).length).toBe(BEHAVIOR.lines);
    });

    test("a bubble cannot merge into itself", async () => {
      const one = await bubble("self");
      expect((await mergeBubbles(one.id, one.id, options)).ok).toBe(false);
    });
  });
});
