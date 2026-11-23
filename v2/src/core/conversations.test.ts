import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { paths } from "../config";
import { listConversations, readConversation } from "./conversations";

test("a chat saved before effort and fast existed still loads, with neither set", async () => {
  const id = "c-0a1b2c3d";
  await mkdir(paths.conversation(id), { recursive: true });
  await Bun.write(paths.meta(id), JSON.stringify({ id, name: "old", directory: "/work/old", bubble: null, model: null, createdAt: "2026-11-22T23:15:58.179Z" }));
  const read = await readConversation(id);
  expect(read).toEqual({ id, name: "old", directory: "/work/old", bubble: null, noBubble: false, model: null, effort: null, fast: false, createdAt: "2026-11-22T23:15:58.179Z" });
  expect((await listConversations()).map(c => c.id)).toContain(id);
});
