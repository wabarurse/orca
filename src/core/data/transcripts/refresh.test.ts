import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, watch } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { open } from "./transcript";
import { watchedSleep } from "../../agent-loop/orc/daemon";
const root = mkdtempSync(join(tmpdir(), "orca-refresh-idle-"));
process.env.ORCA_HOME = join(root, "home");
afterAll(() => rmSync(root, { recursive: true, force: true }));
test("unchanged refresh creates no lock events; another writer still becomes visible", async () => {
  const path = join(root, "transcript/t.jsonl"), reader = open(path);
  await reader.append({ type: "message", message: { role: "user", content: "before" } });
  let events = 0; const watcher = watch(join(root, "transcript"), () => { events++; });
  try {
    await Bun.sleep(80); events = 0;
    for (let i = 0; i < 20; i++) await reader.refresh!();
    await Bun.sleep(80); expect(events).toBe(0);
    await open(path).append({ type: "message", message: { role: "user", content: "after" } });
    await reader.refresh!(); expect(JSON.stringify(await reader.chain())).toContain("after");
  } finally { watcher.close(); }
});
test("transcript lock activity cannot wake an otherwise idle daemon", async () => {
  const dir = join(root, "watched"), t = open(join(dir, "orchestrator.jsonl"));
  const watcher = watchedSleep([dir]);
  try {
    await t.refresh!();
    const at = performance.now(); await watcher.sleep(150);
    expect(performance.now() - at).toBeGreaterThanOrEqual(120);
  } finally { watcher.close(); }
});
