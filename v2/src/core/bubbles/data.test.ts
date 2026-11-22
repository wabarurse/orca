import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../../config";
import { tempHome } from "../../test/home";
import { createConversation } from "../conversations";
import { ensureBubble, joinBubble } from "./store";
import { ensureDataDirs, pluginData } from "./data";

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
