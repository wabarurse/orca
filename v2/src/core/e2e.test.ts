import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { paths } from "../config";
import { tempHome } from "../test/home";
import { createConversation } from "./conversations";
import { ensureDaemon, say, stopDaemon } from "./daemon/client";
import { readRun } from "./runner/runs";
import { spanReport } from "./span-report";
import { readSpans } from "./spans";
import { openTranscript } from "./transcript";
import type { Span } from "./types";

let conversation = "";
let group: number | null = null;
const groupAlive = (pgid: number): boolean => { try { process.kill(-pgid, 0); return true; } catch { return false; } };
const endGroup = async (pgid: number): Promise<void> => {
  const signals: NodeJS.Signals[] = ["SIGTERM", "SIGKILL"];
  for (const signal of signals) {
    if (!groupAlive(pgid)) return;
    try { process.kill(-pgid, signal); } catch {}
    for (let i = 0; i < 30 && groupAlive(pgid); i++) await Bun.sleep(100);
  }
};
afterAll(async () => {
  if (conversation.length > 0) await stopDaemon(conversation);
  if (group !== null) await endGroup(group);
  delete process.env.ORCA2_SCRIPTED;
  delete process.env.ORCA2_SELF;
});
const home = tempHome("e2e");

const tool = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
const text = (t: string) => ({ type: "text", text: t, citations: null });

test("orchestrator → worker → report → orchestrator, through the daemon and the plain runner", async () => {
  const repo = join(home.path(), "repo");
  mkdirSync(repo, { recursive: true });
  for (const args of [["init", "-q", "-b", "main"], ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]]) {
    expect(Bun.spawnSync(["git", ...args], { cwd: repo }).exitCode).toBe(0);
  }
  const scripts = join(home.path(), "scripts");
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(scripts, "orchestrator.json"), JSON.stringify([
    [tool("o1", "subagent", { action: "spawn", branch: "fix", brief: "write hello.txt saying hi, then report" })],
    [text("started a worker")],
    [text("the worker wrote hello.txt")],
  ]));
  writeFileSync(join(scripts, "worker-fix.json"), JSON.stringify([
    [tool("w1", "write", { path: "hello.txt", content: "hi\n" })],
    [tool("w2", "inbox", { to: "orchestrator", text: "done: wrote hello.txt" })],
    [text("reported")],
  ]));
  process.env.ORCA2_SCRIPTED = scripts;
  process.env.ORCA2_SELF = JSON.stringify([process.execPath, resolve(import.meta.dir, "../cli/main.ts")]);
  const c = await createConversation(repo, "e2e");
  conversation = c.id;
  await say(c.id, "please add hello.txt", [], "steer");
  const daemon = await ensureDaemon(c.id, null);
  expect(daemon.ok).toBe(true);
  if (daemon.ok) {
    const pgid = Number(Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(daemon.data)]).stdout.toString().trim());
    group = Number.isInteger(pgid) && pgid > 1 ? pgid : null;
  }
  const transcript = openTranscript(paths.transcript(c.id, "orchestrator"));
  const replies = (): string[] => { transcript.refresh(); return transcript.all().flatMap(e => e.type === "message" && e.message.role === "assistant" && Array.isArray(e.message.content) ? e.message.content.flatMap(b => b.type === "text" ? [b.text] : []) : []); };
  for (let i = 0; i < 200 && !replies().includes("the worker wrote hello.txt"); i++) await Bun.sleep(100);
  const log = (agent: string): string => { try { return readFileSync(join(paths.logs(c.id), `${agent}.log`), "utf8"); } catch { return "(no log)"; } };
  expect(replies(), `orchestrator log:\n${log("orchestrator")}\nworker log:\n${log("worker-fix")}`).toEqual(["started a worker", "the worker wrote hello.txt"]);
  const worktree = paths.worktree(c.id, "fix");
  expect(readFileSync(join(worktree, "hello.txt"), "utf8")).toBe("hi\n");
  expect(Bun.spawnSync(["git", "branch", "--show-current"], { cwd: worktree }).stdout.toString().trim()).toBe("fix");
  expect(existsSync(join(repo, "hello.txt"))).toBe(false);
  expect((await readRun(c.id, "worker-fix"))?.state).toBe("reported");
  const inbox = transcript.all().flatMap(e => e.type === "message" ? e.inbox : []).map(m => `${m.from}: ${m.text}`);
  expect(inbox).toEqual(["user: please add hello.txt", "worker-fix: done: wrote hello.txt"]);

  let spans: Span[] = [];
  for (let i = 0; i < 50; i++) {
    const read = await readSpans(c.id);
    spans = read.ok ? read.data : [];
    if (spans.some(span => span.agent === "worker-fix" && span.kind === "tool" && span.label.startsWith("inbox"))) break;
    await Bun.sleep(100);
  }
  const has = (agent: string, kind: string, label: string): boolean => spans.some(span => span.agent === agent && span.kind === kind && span.label.startsWith(label));
  expect(has("orchestrator", "tool", "subagent: fix, worker")).toBe(true);
  expect(has("orchestrator", "model", "claude")).toBe(true);
  expect(has("orchestrator", "wait-worker", "worker-fix")).toBe(true);
  expect(has("worker-fix", "spawn", "worker-fix")).toBe(true);
  expect(has("worker-fix", "tool", "write: hello.txt")).toBe(true);
  expect(has("worker-fix", "tool", "inbox: orchestrator")).toBe(true);
  expect(spans.filter(span => span.agent === "worker-fix" && span.kind === "model").every(span => span.detail.input === 10 && span.detail.output === 5)).toBe(true);
  for (const agent of ["orchestrator", "worker-fix"]) {
    const flat = spans.filter(span => span.agent === agent && (span.kind === "model" || span.kind === "tool" || span.kind === "spawn"))
      .map(span => [Date.parse(span.startedAt), Date.parse(span.endedAt)]).sort((x, y) => (x[0] ?? 0) - (y[0] ?? 0));
    for (let i = 1; i < flat.length; i++) expect(flat[i]?.[0] ?? 0).toBeGreaterThanOrEqual(flat[i - 1]?.[1] ?? 0);
  }
  const report = spanReport(c.id, spans);
  const total = (kinds: Record<string, number>): number => Object.values(kinds).reduce((a, b) => a + b, 0);
  expect(total(report.kinds)).toBe(report.wallMs);
  for (const agent of report.agents) expect(total(agent.kinds)).toBe(agent.wallMs);
  expect(report.agents.map(agent => agent.agent).sort()).toEqual(["orchestrator", "worker-fix"]);
}, 30_000);
