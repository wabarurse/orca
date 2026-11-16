import { afterAll, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync, watch, writeFileSync } from "node:fs";
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
test("a refresh reads what was appended and keeps the entries it already had", async () => {
  const path = join(root, "append/t.jsonl"), reader = open(path), writer = open(path);
  await writer.append({ type: "message", message: { role: "user", content: "one" } });
  await reader.refresh!();
  const first = reader.history!()[0]!;
  await writer.append({ type: "message", message: { role: "assistant", content: "two ✓" } });
  await reader.refresh!();
  expect(reader.history!().map(e => e.type === "message" ? e.message.content : "")).toEqual(["one", "two ✓"]);
  expect(reader.history!()[0]).toBe(first); // not parsed again
  expect(reader.head()).toBe(writer.head());
});
test("a torn tail is skipped and the record after it is read", async () => {
  const path = join(root, "torn/t.jsonl"), reader = open(path), writer = open(path);
  await writer.append({ type: "message", message: { role: "user", content: "one" } });
  await reader.refresh!();
  appendFileSync(path, '{"type":"message","uuid":"torn');
  await reader.refresh!();
  expect(reader.history!()).toHaveLength(1);
  await writer.append({ type: "message", message: { role: "user", content: "two" } });
  await reader.refresh!();
  expect(reader.history!().map(e => e.type === "message" ? e.message.content : "")).toEqual(["one", "two"]);
});
test("a file that was replaced or cut back is read again from the start", async () => {
  const path = join(root, "replaced/t.jsonl"), reader = open(path), writer = open(path);
  await writer.append({ type: "message", message: { role: "user", content: "one" } });
  await writer.append({ type: "message", message: { role: "user", content: "two" } });
  await reader.refresh!();
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  writeFileSync(path, lines[0] + "\n"); // cut back: same file, shorter
  await reader.refresh!();
  expect(reader.history!()).toHaveLength(1);
  const other = { ...JSON.parse(lines[0]!), message: { role: "user", content: "other" } };
  writeFileSync(`${path}.new`, JSON.stringify(other) + "\n" + lines[1] + "\n"); renameSync(`${path}.new`, path); // replaced: another file
  await reader.refresh!();
  expect(reader.history!().map(e => e.type === "message" ? e.message.content : "")).toContain("other");
  writeFileSync(path, JSON.stringify({ ...other, message: { role: "user", content: "rewritten in place, and longer than before" } }) + "\n" + lines[1] + "\n"); // same file, same start, other bytes
  await reader.refresh!();
  expect(JSON.stringify(reader.history!())).toContain("rewritten in place");
});
