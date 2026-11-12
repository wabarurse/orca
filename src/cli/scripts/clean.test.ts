import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../../config";
import { cleanStorage } from "./clean";

let home: string;
const before = process.env.ORCA_HOME;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "orca-clean-")); process.env.ORCA_HOME = home; });
afterEach(async () => { if (before === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = before; await rm(home, { recursive: true, force: true }); });

test("clean lists an idle project's stale tool outputs in preview without deleting, then removes them", async () => {
  const dir = join(paths.project("idle"), "tool-outputs"), ago = new Date(Date.now() - 8 * 86400_000);
  const old = join(dir, `${crypto.randomUUID()}.partial`), nested = join(dir, "evidence", "clip.mp4"), fresh = join(dir, `${crypto.randomUUID()}.txt`);
  await mkdir(join(dir, "evidence"), { recursive: true });
  for (const path of [old, nested, fresh]) await Bun.write(path, "output");
  for (const path of [old, nested]) await utimes(path, ago, ago);

  const preview = await cleanStorage(false);
  expect(preview.filter(c => c.disposition.startsWith("eligible: tool output")).map(c => c.path).sort()).toEqual([old]);
  for (const path of [old, nested, fresh]) expect(await Bun.file(path).exists()).toBe(true);

  const applied = await cleanStorage(true);
  expect(applied.filter(c => c.disposition.startsWith("removed tool output")).map(c => c.path).sort()).toEqual([old]);
  expect(await Bun.file(old).exists()).toBe(false); expect(await Bun.file(nested).exists()).toBe(true);
  expect(await Bun.file(fresh).exists()).toBe(true);
});
