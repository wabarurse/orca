import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../config";
import { ensureBubble, writeNode } from "./bubbles";
import { cleanStorage } from "./clean";
import { createConversation, deleteConversation } from "./conversations";
import { tempHome } from "../test/home";

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
