import { expect, test } from "bun:test";
import { join } from "node:path";
import { createConversation, readConversation } from "../conversations";
import { removeConversation } from "../lifecycle";
import { tempHome } from "../../test/home";
import { isRepository, pruneWorktrees } from "./worktree";

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
