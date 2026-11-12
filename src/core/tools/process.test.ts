import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processTool, waitForProcess } from "./process";
import { processDirectory, readProcess, saveProcess, type ProcessRecord } from "../data/processes";
import { observe, pending, put } from "../data/inbox";
import { assertLayout, paths } from "../../config";
import type { ToolContext } from "./registry";

let home: string, ctx: ToolContext, previous: string | undefined;
beforeEach(async () => {
  previous = process.env.ORCA_HOME;
  home = await mkdtemp(join(tmpdir(), "orca-process-wait-")); process.env.ORCA_HOME = home;
  assertLayout(home);
  await mkdir(paths.project("test"), { recursive: true });
  ctx = { project: "test", role: "worker", branch: "work", cwd: home, run: crypto.randomUUID() };
});
afterEach(async () => {
  if (previous === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = previous;
  await rm(home, { recursive: true, force: true });
});
/** A running command record whose supervisor is this (live) test process. */
async function running(patch: Partial<ProcessRecord> = {}): Promise<ProcessRecord> {
  const at = new Date().toISOString();
  const p: ProcessRecord = { id: crypto.randomUUID(), project: "test", owner: "worker-work", role: "worker", branch: "work", cwd: home, command: "true",
    createdAt: at, updatedAt: at, state: "running", supervisorPid: process.pid, timeoutMs: 0, maxBytes: 4096, notify: true, events: [], ...patch };
  await saveProcess(p);
  return p;
}
const wait = async (id: string, timeoutMs = 2000, context = ctx) => JSON.parse(await waitForProcess(context, id, timeoutMs, 2));

test("wait returns the exit code and a bounded output tail when the command settles", async () => {
  const p = await running();
  const result = wait(p.id);
  await Bun.sleep(10);
  await writeFile(join(processDirectory("test", p.id), "output.txt"), "x".repeat(3000) + "\n12 pass\n");
  await saveProcess({ ...p, state: "exited", exitCode: 0, settledAt: new Date().toISOString() });
  const r = await result;
  expect(r).toMatchObject({ id: p.id, kind: "command", state: "exited", exitCode: 0, returned: "settled", cursor: 3009 });
  expect(r.tail).toHaveLength(2000); expect(r.tail.endsWith("12 pass\n")).toBe(true);
  expect(r.timedOut).toBeUndefined(); expect(r.interrupted).toBeUndefined(); expect(r.waitedMs).toBeGreaterThanOrEqual(0);
  // Read-only: nothing was marked delivered or consumed on the owner's behalf.
  expect((await readProcess("test", p.id)).events).toEqual([]);
});

test("wait returns the current status with timedOut when nothing changes", async () => {
  const p = await running();
  expect(await wait(p.id, 10)).toMatchObject({ state: "running", returned: "timeout", timedOut: true, tail: "" });
});

test("wait reports readiness of a service that is still running", async () => {
  const p = await running({ readyUrl: "http://127.0.0.1:1/", readyAt: new Date().toISOString() });
  expect(await wait(p.id)).toMatchObject({ state: "running", returned: "ready", readyUrl: "http://127.0.0.1:1/" });
});

test("wait stops promptly when the tool call is cancelled", async () => {
  const p = await running(), abort = new AbortController();
  const result = waitForProcess({ ...ctx, signal: abort.signal }, p.id, 60_000, 30_000);
  await Bun.sleep(10); abort.abort();
  expect(JSON.parse(await result)).toMatchObject({ state: "running", returned: "cancelled", interrupted: "cancelled" });
});

test("wait returns early when a message reaches this agent's inbox, leaving it unread", async () => {
  const p = await running();
  const result = wait(p.id, 60_000);
  await Bun.sleep(10);
  await put("test", "worker-other", { from: "user", text: "not for this agent" });
  await put("test", "worker-work", { from: "user", text: "stop, wrong branch" });
  expect(await result).toMatchObject({ state: "running", returned: "inbox", interrupted: "inbox" });
  expect(await pending("test", "worker-work")).toBe(true);
});

test("wait is refused for another agent's command and validates timeout_s", async () => {
  const p = await running({ owner: "worker-other", branch: "other" });
  await expect(processTool.run({ action: "wait", id: p.id }, ctx)).rejects.toThrow("process belongs to another agent");
  await expect(processTool.run({ action: "wait", id: p.id, timeout_s: 901 }, { ...ctx, role: "orchestrator", branch: undefined })).rejects.toThrow("timeout_s must be 1–900");
});

test("wait does not hang on a command whose supervisor died", async () => {
  const dead = Bun.spawn(["true"]); await dead.exited;
  const old = new Date(Date.now() - 60_000).toISOString();
  // Already dead when called: the tool's reconcile settles it as unknown first.
  const a = await running({ supervisorPid: dead.pid, createdAt: old, notify: false });
  expect(JSON.parse(await processTool.run({ action: "wait", id: a.id, timeout_s: 5 }, ctx))).toMatchObject({ state: "unknown", returned: "settled" });
  // Dies during the wait: the periodic reconcile notices.
  const b = await running();
  const result = wait(b.id, 5000);
  await saveProcess({ ...b, supervisorPid: dead.pid, createdAt: old });
  expect(await result).toMatchObject({ state: "unknown", returned: "settled", reason: expect.stringContaining("supervisor disappeared") });
});

test("wait on a PR watch returns when the shared observer records a change", async () => {
  const repo = paths.repo("test"); await mkdir(repo, { recursive: true });
  const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo }).exitCode;
  expect(git("init", "-q")).toBe(0); expect(git("remote", "add", "origin", "https://github.com/o/r.git")).toBe(0);
  const head = "a".repeat(40);
  const { process: id } = JSON.parse(await processTool.run({ action: "watch_pr", number: 3, head }, ctx));
  const value = { state: "OPEN", head, checks: "pending", review: "unknown", mergeable: "unknown" };
  await observe("test", "pr:o/r#3", value, "baseline", { defer: true });
  expect(await wait(id, 10)).toMatchObject({ kind: "pr_watch", returned: "timeout", pr: { number: 3, head, observed: { checks: "pending" } } });
  const result = wait(id, 5000); // a worker may wait on the orchestrator-owned watch
  await Bun.sleep(10);
  await observe("test", "pr:o/r#3", { ...value, checks: "failed" }, "changed", { defer: true });
  const r = await result;
  expect(r).toMatchObject({ kind: "pr_watch", state: "running", returned: "pr_changed", pr: { observed: { checks: "failed" } } });
  expect(r.tail).toBeUndefined();
  expect(await pending("test", "worker-work")).toBe(false);
});
