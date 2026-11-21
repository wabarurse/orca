import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { paths } from "../config";
import { tempHome } from "../test/home";
import { createConversation } from "./conversations";
import { ensureDaemon, say, stopDaemon } from "./daemon/client";
import { readRun } from "./runner/runs";
import { openTranscript } from "./transcript";

const home = tempHome("e2e");
let conversation = "";
afterAll(async () => { if (conversation.length > 0) await stopDaemon(conversation); delete process.env.ORCA2_SCRIPTED; delete process.env.ORCA2_SELF; });

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
  await ensureDaemon(c.id, null);
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
}, 30_000);
