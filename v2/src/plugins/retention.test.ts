import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../config";
import { createConversation } from "../core/conversations";
import { saveImage } from "../core/images";
import { backgroundContext, registerBuiltins } from "../core/plugins";
import { archiveDue, purgeExpired } from "../core/retention";
import { shelfEntry } from "../core/shelf";
import { tempHome } from "../test/home";
import { png } from "../test/image-fixture";
import { BUILTINS } from ".";
import { imageRetention } from "./images/retention";
import { changeTasks, readTasks, type Task } from "./tasks/store";
import { taskRetention } from "./tasks/retention";

tempHome("plugin-retention");
const DAY = 86_400_000;
const NOW = Date.parse("2026-11-22T12:00:00Z");
const ago = (days: number): string => new Date(NOW - days * DAY).toISOString();
const task = (number: number, status: Task["status"], updated: string): Task =>
  ({ number, id: `t${number}`, name: `task ${number}`, summary: "", branch: `b${number}`, status, pr: null, dependsOn: [], created: updated, updated, notes: [] });

test("tasks: merged or closed ones are archived 7 days after they settled and removed 14 days after that; open ones never are", async () => {
  registerBuiltins(BUILTINS);
  await saveConfig({ plugins: ["tasks"] });
  const chat = await createConversation(mkdtempSync(join(tmpdir(), "orca2-ttl-")), "chat");
  const ctx = backgroundContext(chat.id, "tasks", chat.directory);
  const dir = await ctx.data("conversation");
  if (!dir.ok) throw new Error(dir.error);
  await changeTasks(dir.data, async () => ({ tasks: [task(1, "merged", ago(8)), task(2, "closed", ago(3)), task(3, "working", ago(30))], result: null }));
  expect(await taskRetention.settled(ctx)).toEqual([{ id: "1", at: ago(8) }, { id: "2", at: ago(3) }]);
  await archiveDue(chat.id, NOW, true);
  expect(Object.keys((await shelfEntry(chat.id, "tasks/tasks")).archived)).toEqual(["1"]);
  await purgeExpired(chat.id, NOW + 15 * DAY, true);
  const left = await readTasks(dir.data);
  expect(left.ok ? left.data.map(t => t.number) : []).toEqual([2, 3]);
  await taskRetention.purge(["3"], ctx);
  const still = await readTasks(dir.data);
  expect(still.ok ? still.data.map(t => t.number) : []).toEqual([2, 3]);
  await saveConfig({ plugins: [] });
});

test("images: archived a day after they arrived, files removed 14 days after that, sized for clean by their file", async () => {
  registerBuiltins(BUILTINS);
  await saveConfig({ plugins: ["images"] });
  const chat = await createConversation(mkdtempSync(join(tmpdir(), "orca2-ttl-")), "chat");
  const saved = await saveImage(chat.id, new Uint8Array(png()));
  if (!saved.ok) throw new Error(saved.error);
  const ctx = backgroundContext(chat.id, "images", chat.directory);
  const file = await imageRetention.locate(saved.data, ctx);
  expect(file === null ? false : existsSync(file)).toBe(true);
  if (file === null) return;
  utimesSync(file, new Date(NOW - 2 * DAY), new Date(NOW - 2 * DAY));
  expect((await archiveDue(chat.id, NOW, true)).map(c => c.disposition)).toEqual([`archived: images images ${saved.data}, settled over 1 day ago`]);
  expect((await purgeExpired(chat.id, NOW + 13 * DAY, false))).toEqual([]);
  const purged = await purgeExpired(chat.id, NOW + 15 * DAY, true);
  expect(purged.map(c => c.path)).toEqual([file]);
  expect(existsSync(file)).toBe(false);
  await saveConfig({ plugins: [] });
});
