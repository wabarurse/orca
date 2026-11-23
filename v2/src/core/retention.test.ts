import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../config";
import { cleanStorage } from "./clean";
import { createConversation } from "./conversations";
import { definePlugin, noHooks, registerBuiltins } from "./plugins";
import { archiveDue, purgeExpired } from "./retention";
import { archiveItems, restoreItems, shelfEntry } from "./shelf";
import { tempHome } from "../test/home";

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
  name: "keeper", description: "test", tools: [], prompt: [], skills: [], storage: [], hooks: noHooks(), guard: [], bundles: [], ui: null, background: null,
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
