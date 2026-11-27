import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths, saveConfig } from "../config";
import { tempHome } from "../test/home";
import { ensureBubble, writeNode } from "./bubbles";
import { cleanStorage } from "./clean";
import { createConversation, deleteConversation, listConversations, readConversation } from "./conversations";
import { INPUT_HISTORY_LIMIT, readInputHistory, recordInput, remember } from "./input-history";
import { removeConversation } from "./lifecycle";
import { definePlugin, noHooks, registerBuiltins } from "./plugins";
import { archiveDue, purgeExpired } from "./retention";
import { isRepository, pruneWorktrees } from "./runner/worktree";
import { requestSettings } from "./session";
import { effortChoices, fastChoices, recentModels, setEffort, setFast, setModel } from "./settings";
import { archiveItems, restoreItems, shelfEntry } from "./shelf";
import { setTrust, trustState } from "./trust";

describe("conversation records", () => {
  test("a chat saved before effort and fast existed still loads, with neither set", async () => {
    const id = "c-0a1b2c3d";
    await mkdir(paths.conversation(id), { recursive: true });
    await Bun.write(paths.meta(id), JSON.stringify({ id, name: "old", directory: "/work/old", bubble: null, model: null, createdAt: "2026-11-22T23:15:58.179Z" }));
    const read = await readConversation(id);
    expect(read).toEqual({ id, name: "old", directory: "/work/old", bubble: null, noBubble: false, model: null, effort: null, fast: false, createdAt: "2026-11-22T23:15:58.179Z" });
    expect((await listConversations()).map(c => c.id)).toContain(id);
  });
});

describe("a chat's model, effort and fast mode", () => {
  const home = tempHome("settings");

  test("choices mark the chat's current value, default when nothing is saved", () => {
    expect(effortChoices("claude-opus-5-5", null).filter(c => c.current).map(c => c.value)).toEqual(["default"]);
    expect(effortChoices("claude-opus-5-5", "high").filter(c => c.current).map(c => c.value)).toEqual(["high"]);
    expect(fastChoices(true).filter(c => c.current).map(c => c.label)).toEqual(["on"]);
    expect(recentModels(["a", "b", "c", "d", "e", "f", "g", "h"], "h")).toEqual(["a", "b", "c", "d", "e", "f", "h"]);
  });

  test("switching model keeps the effort and fast mode it supports and drops the rest", async () => {
    const chat = await createConversation(home.path(), null);
    const effort = await setEffort({ ...chat, model: "claude-opus-5-5" }, "xhigh");
    if (!effort.ok) throw new Error(effort.error);
    const tuned = await setFast(effort.data, true);
    if (!tuned.ok) throw new Error(tuned.error);
    const kept = await setModel(tuned.data, "claude-fable-5");
    expect(kept.ok && { effort: kept.data.effort, fast: kept.data.fast }).toEqual({ effort: "xhigh", fast: false });
    const moved = await setModel(tuned.data, "claude-sonnet-4-6");
    expect(moved.ok && { effort: moved.data.effort, fast: moved.data.fast }).toEqual({ effort: null, fast: false });
    expect((await readConversation(chat.id))?.model).toBe("claude-sonnet-4-6");
    expect((await setFast({ ...chat, model: "claude-sonnet-4-6" }, true)).ok).toBe(false);
  });

  test("each request sends the chat's effort and fast mode when the model supports them", () => {
    expect(requestSettings("claude-opus-5-5", "high", true)).toEqual({ effort: "high", fast: true });
    expect(requestSettings("claude-opus-5-5", null, false)).toBeNull();
    expect(requestSettings("claude-sonnet-5-5", "high", true)).toEqual({ effort: "high" });
  });
});

describe("input history", () => {
  tempHome("input-history");

  test("remember skips consecutive duplicates and blank input, and keeps only the newest entries", () => {
    expect(remember(["a"], "a")).toEqual(["a"]);
    expect(remember(["a", "b"], "a")).toEqual(["a", "b", "a"]);
    expect(remember(["a"], "  ")).toEqual(["a"]);
    expect(remember(["a", "b", "c"], "d", 3)).toEqual(["b", "c", "d"]);
  });

  test("input history persists per conversation, bounded", async () => {
    expect(await readInputHistory("c-00000001")).toEqual([]);
    await recordInput("c-00000001", "hello");
    await recordInput("c-00000001", "/clear-chat");
    await recordInput("c-00000001", "/clear-chat");
    expect(await readInputHistory("c-00000001")).toEqual(["hello", "/clear-chat"]);
    expect(await readInputHistory("c-00000002")).toEqual([]);
    for (let i = 0; i < INPUT_HISTORY_LIMIT + 5; i++) await recordInput("c-00000003", `m${i}`);
    const kept = await readInputHistory("c-00000003");
    expect(kept.length).toBe(INPUT_HISTORY_LIMIT);
    expect(kept.at(-1)).toBe(`m${INPUT_HISTORY_LIMIT + 4}`);
  });
});

describe("folder trust", () => {
  let home = "";
  const saved = process.env.ORCA2_HOME;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "orca2-trust-")); process.env.ORCA2_HOME = home; });
  afterEach(() => { if (saved === undefined) delete process.env.ORCA2_HOME; else process.env.ORCA2_HOME = saved; rmSync(home, { recursive: true, force: true }); });

  test("every folder is trusted unless it was untrusted, and trust undoes that", async () => {
    const dir = join(home, "repo");
    expect(await trustState(dir)).toBe("trusted");
    await setTrust(dir, false);
    expect(await trustState(dir)).toBe("untrusted");
    expect(await trustState(join(dir, "sub"))).toBe("untrusted");
    await setTrust(dir, true);
    expect(await trustState(dir)).toBe("trusted");
  });
});

describe("archiving and purging", () => {
  tempHome("retention");
  const DAY = 86_400_000;
  const NOW = Date.parse("2026-11-22T12:00:00Z");
  const purged: string[] = [];
  const items = [
    { id: "old", at: new Date(NOW - 8 * DAY).toISOString() },
    { id: "fresh", at: new Date(NOW - 2 * DAY).toISOString() },
    { id: "kept", at: new Date(NOW - 30 * DAY).toISOString() },
  ];
  const plugin = definePlugin({
    name: "keeper", description: "test", tools: [], prompt: [], skills: [], storage: [], hooks: noHooks(), guard: [], bundles: [], provides: [], uses: [], emits: [], on: [], ui: null, background: null,
    retention: [{ tab: "things", archiveAfterDays: 7, purgeAfterDays: 14, settled: async () => items, locate: async () => null,
      purge: async ids => { purged.push(...ids); } }],
  });

  test("settled items are archived after their days (not ones the user restored); orca2 clean removes items archived past the purge days, previewing first", async () => {
    registerBuiltins([{ name: "keeper", dir: mkdtempSync(join(tmpdir(), "orca2-keeper-")), index: async () => ({ default: plugin }), ui: null, background: null }]);
    await saveConfig({ plugins: ["keeper"] });
    const chat = await createConversation(mkdtempSync(join(tmpdir(), "orca2-retention-")), "chat");
    await restoreItems(chat.id, "keeper/things", ["kept"], new Date(NOW - DAY).toISOString());

    expect((await archiveDue(chat.id, NOW, false)).map(c => c.disposition)).toEqual(["would archive: keeper things old, settled over 7 days ago"]);
    expect((await shelfEntry(chat.id, "keeper/things")).archived).toEqual({});
    await archiveDue(chat.id, NOW, true);
    expect(Object.keys((await shelfEntry(chat.id, "keeper/things")).archived)).toEqual(["old"]);
    expect(await archiveDue(chat.id, NOW, true)).toEqual([]);

    expect(await purgeExpired(chat.id, NOW + 13 * DAY, true)).toEqual([]);
    const later = NOW + 15 * DAY;
    expect((await purgeExpired(chat.id, later, false)).map(c => c.disposition)).toEqual(["would remove: archived keeper things old, archived over 14 days ago"]);
    expect(purged).toEqual([]);
    await purgeExpired(chat.id, later, true);
    expect(purged).toEqual(["old"]);
    expect((await shelfEntry(chat.id, "keeper/things")).archived).toEqual({});

    await archiveItems(chat.id, "keeper/things", ["fresh"], new Date(Date.now() - 20 * DAY).toISOString());
    const preview = await cleanStorage(false);
    expect(preview.map(c => c.disposition)).toContain("would remove: archived keeper things fresh, archived over 14 days ago");
    expect(purged).toEqual(["old"]);
    await cleanStorage(true);
    expect(purged).toEqual(["old", "fresh"]);
    await saveConfig({ plugins: [] });
  });
});

describe("orca2 clean", () => {
  const home = tempHome("clean");

  test("clean removes folders and worktrees deleted conversations left, and empty unattached bubbles; keeps dirty worktrees and bubbles with memory; --preview removes nothing", async () => {
    const kept = await createConversation(home.path(), "keeper");
    const stray = join(paths.conversations, "c-00000001");
    mkdirSync(join(stray, "data"), { recursive: true });
    const repo = join(home.path(), "repo");
    mkdirSync(repo);
    const git = (cwd: string, ...args: string[]): void => { Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd }); };
    git(repo, "init", "-q", "-b", "main"); writeFileSync(join(repo, "a"), "a"); git(repo, "add", "a"); git(repo, "commit", "-qm", "a");
    const gone = "c-00000002";
    const cleanTree = join(paths.worktrees(gone), "done"), dirtyTree = join(paths.worktrees(gone), "wip");
    mkdirSync(paths.worktrees(gone), { recursive: true });
    git(repo, "worktree", "add", "-q", "-b", "done", cleanTree); git(repo, "worktree", "add", "-q", "-b", "wip", dirtyTree);
    writeFileSync(join(dirtyTree, "draft"), "unsaved");
    const memory = await createConversation(home.path(), "memory");
    const full = await ensureBubble(memory.id);
    const emptyChat = await createConversation(home.path(), "empty");
    const empty = await ensureBubble(emptyChat.id);
    expect(full.ok && empty.ok).toBe(true);
    if (!full.ok || !empty.ok) return;
    expect((await writeNode(full.data.id, { node: "decisions/keep", title: "keep", summary: "kept", keywords: [], add: [{ text: "a decision", sources: [] }], retire: [], revision: null }, "test")).ok).toBe(true);
    await deleteConversation(memory.id);
    await deleteConversation(emptyChat.id);

    const preview = await cleanStorage(false);
    const said = preview.map(c => c.disposition).join("\n");
    expect(said).toContain("would remove: conversation \"c-00000001\"");
    expect(said).toContain("would remove: worktree done");
    expect(said).toContain("kept: worktree wip has uncommitted changes");
    expect(said).toContain(`would remove: bubble "${empty.data.name}" is empty`);
    expect(said).not.toContain(`bubble "${full.data.name}"`);
    expect(existsSync(stray) && existsSync(cleanTree)).toBe(true);

    await cleanStorage(true);
    expect(existsSync(stray)).toBe(false);
    expect(existsSync(cleanTree)).toBe(false);
    expect(existsSync(join(dirtyTree, "draft"))).toBe(true);
    expect(existsSync(paths.bubble(full.data.id))).toBe(true);
    expect(existsSync(paths.bubble(empty.data.id))).toBe(false);
    expect(existsSync(paths.meta(kept.id))).toBe(true);
  });
});

describe("removing a conversation", () => {
  const home = tempHome("worktree");

  test("a conversation whose folder is gone is still deleted, and git is never started in a missing folder", async () => {
    const gone = join(home.path(), "deleted-project");
    expect(await isRepository(gone)).toBe(false);
    await pruneWorktrees(gone);
    const conversation = await createConversation(gone, null);
    const removed = await removeConversation(conversation.id, () => {});
    expect(removed).toEqual({ ok: true, data: null });
    expect(await readConversation(conversation.id)).toBeNull();
  });
});
