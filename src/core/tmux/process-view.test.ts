import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../../config";
import { observe } from "../data/inbox";
import { prWatchEnabled, processDirectory, registerPRWatch, saveProcess, type ProcessRecord } from "../data/processes";
import { observeTaskPR, registerTask } from "../data/tasks";
import { processView, stopCommand, stopWatch } from "./process-view";

// Isolated ORCA_HOME per test: never the real home, GitHub or a real command.
let root: string, previous: string | undefined;
const project = "p", head = "a".repeat(40), now = Date.parse("2026-11-17T12:00:00Z");
beforeEach(() => { previous = process.env.ORCA_HOME; root = mkdtempSync(join(tmpdir(), "orca-process-view-")); process.env.ORCA_HOME = root; mkdirSync(paths.project(project), { recursive: true }); });
afterEach(() => { if (previous === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = previous; rmSync(root, { recursive: true, force: true }); });
const messages = () => existsSync(join(paths.inbox(project), "orchestrator")) ? readdirSync(join(paths.inbox(project), "orchestrator")).filter(n => n.endsWith(".json")).map(n => JSON.parse(readFileSync(join(paths.inbox(project), "orchestrator", n), "utf8")) as { from: string; text: string }) : [];
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
async function command(n: number, extra: Partial<ProcessRecord>): Promise<ProcessRecord> {
  const at = new Date(now - 60_000).toISOString();
  const record: ProcessRecord = { id: id(n), project, owner: "worker-feat", role: "worker", cwd: "/repo", command: `bun run   stack ${n}`, createdAt: at, updatedAt: at,
    state: "running", timeoutMs: 0, maxBytes: 0, notify: false, events: [], ...extra };
  await saveProcess(record);
  return record;
}

test("the view lists the PRs being watched with what was last seen, and commands live first with their last output", async () => {
  const task = await registerTask(project, { name: "Sync notes", summary: "s", branch: "feat/sync", authorized: true });
  await observeTaskPR(project, task.id, { pr: { repository: "o/r", number: 7, url: "https://github.com/o/r/pull/7", head }, branch: "feat/sync", state: "OPEN", ready: false, checks: "failed" });
  await observe(project, "pr:o/r#7", { state: "OPEN", head, checks: "failed", failing: "policy", review: "APPROVED", mergeable: "mergeable" }, "seen", { initialSilent: true });
  await registerPRWatch(project, { repository: "o/r", number: 9, head });
  const live = await command(1, { readyUrl: "http://localhost:3000", readyAt: new Date(now).toISOString() });
  writeFileSync(join(processDirectory(project, live.id), "output.txt"), `${"x".repeat(5000)}\nlistening on 3000\nready\n`);
  await command(2, { state: "exited", exitCode: 0, updatedAt: new Date(now - 3_600_000).toISOString() });
  await command(3, { state: "failed", exitCode: 1, updatedAt: new Date(now - 3 * 86_400_000).toISOString() }); // ended days ago: not shown
  const view = await processView(project, now);
  expect(view.watches.map(w => [w.number, w.tasks.map(t => t.name), w.process !== null, w.state?.checks ?? null, w.state?.failing ?? null])).toEqual([
    [7, ["Sync notes"], false, "failed", "policy"], [9, [], true, null, null]]);
  expect(view.commands.map(c => [c.record.id, c.live, c.tail])).toEqual([[id(1), true, "listening on 3000\nready"], [id(2), false, ""]]);
});

test("stopping a watch ends the notices for that PR and tells the orchestrator; stopping a command asks its supervisor and tells it too", async () => {
  const task = await registerTask(project, { name: "Sync notes", summary: "s", branch: "feat/sync", authorized: true });
  await observeTaskPR(project, task.id, { pr: { repository: "o/r", number: 7, url: "https://github.com/o/r/pull/7", head }, branch: "feat/sync", state: "OPEN", ready: false, checks: "pending" });
  await registerPRWatch(project, { repository: "o/r", number: 7, head });
  await stopWatch(project, { repository: "o/r", number: 7 });
  expect(prWatchEnabled(project, { repository: "o/r", number: 7 })).toBe(false);
  expect((await processView(project, now)).watches).toEqual([]);
  const live = await command(1, {});
  await stopCommand(project, live.id);
  expect(existsSync(join(processDirectory(project, live.id), "stop"))).toBe(true);
  expect(messages().map(m => [m.from, m.text.split("]")[0] + "]"]).sort()).toEqual([["runtime", "[pr-watch-stopped]"], ["runtime", "[process-stopped]"]]);
  expect(messages().find(m => m.text.startsWith("[process-stopped]"))!.text).toContain("bun run stack 1. Nothing was restarted.");
  const ended = await command(2, { state: "exited", exitCode: 0 });
  await expect(stopCommand(project, ended.id)).rejects.toThrow("already ended");
  expect(messages()).toHaveLength(2);
});
