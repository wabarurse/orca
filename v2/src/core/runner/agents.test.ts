import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { loadConfig, ok, paths, saveConfig } from "../../config";
import { fakeProvider, text, toolUse } from "../../test/fake-provider";
import { tempHome } from "../../test/home";
import { createConversation } from "../conversations";
import { readStatus } from "../daemon/channel";
import { ensureDaemon, say, stopDaemon } from "../daemon/client";
import { runHeadless } from "../headless";
import { registerBuiltins } from "../plugins/loader";
import { defineBackground, definePlugin, noHooks, type Runner } from "../plugins/types";
import { spanReport } from "../span-report";
import { readSpans } from "../spans";
import { openTranscript } from "../transcript";
import type { Span } from "../types";
import { launchCommand } from "./launch";
import { newRun, readRun, updateRun, writeRun } from "./runs";
import { chooseRunner, runnerNames, runtimeFor, selectedRunner, stopAgents } from "./runtime";

describe("runners and agent launch", () => {
  const home = tempHome("runtime");

  const fakeRunner = (name: string): Runner => ({ name, start: async () => ({ handle: name, pid: null }), alive: async () => [], stop: async () => undefined, attach: async () => ({ ok: false, error: "fake" }) });

  function register(names: string[]): void {
    registerBuiltins(names.map(name => ({
      name, dir: join(home.path(), name),
      index: async () => ({ default: definePlugin({ name, description: name, tools: [], prompt: [], skills: [], storage: [], hooks: noHooks(), bundles: [], guard: [], retention: [], provides: [], uses: [], emits: [], on: [], ui: null, background: "./background.ts" }) }),
      ui: null,
      background: async () => ({ default: defineBackground({ watchers: [], memory: null, runner: fakeRunner(name), stop: null, remove: null }) }),
    })));
  }

  afterEach(() => { registerBuiltins([]); });

  test("the core lists plain and every enabled runner plugin, saves the choice and falls back to plain", async () => {
    register(["tmux", "rex"]);
    await saveConfig({ plugins: ["tmux"], runner: "plain" });
    const c = await createConversation(home.path(), "mux");
    expect(await runnerNames(c.id)).toEqual(["plain", "tmux"]);
    expect(await chooseRunner(c.id, "rex")).toEqual({ ok: false, error: "unknown runner rex; choose plain, tmux" });
    expect((await loadConfig()).runner).toBe("plain");
    expect(await chooseRunner(c.id, "tmux")).toEqual({ ok: true, data: "tmux" });
    expect((await loadConfig()).runner).toBe("tmux");
    expect((await selectedRunner(c.id)).name).toBe("tmux");
    await saveConfig({ plugins: [] });
    expect(await runnerNames(c.id)).toEqual(["plain"]);
    expect((await selectedRunner(c.id)).name).toBe("plain");
  });

  test("the launch command keeps the environment out of argv in a private file that deletes itself", async () => {
    const log = join(home.path(), "agent.log");
    const command = await launchCommand({ conversation: "c", agent: "worker-a", argv: ["/bin/sh", "-c", 'echo "secret=$SECRET tmux=${TMUX:-unset}"'], cwd: home.path(), log,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", SECRET: "hunter2 'quoted'", TMUX: "launcher" } });
    expect(command.argv.join(" ")).not.toContain("hunter2");
    const file = command.argv[4] ?? "";
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const proc = Bun.spawn(command.argv, { cwd: home.path(), env: {}, stdout: "pipe" });
    const shown = await new Response(proc.stdout).text();
    expect(shown).toBe("secret=hunter2 'quoted' tmux=unset\n");
    expect(readFileSync(log, "utf8")).toBe(shown);
    expect(existsSync(file)).toBe(false);
  });

  test("the orchestrator can start an agent in a named runner without /mux, is refused one that is off, and show opens its window", async () => {
    const opened: string[] = [];
    const box: Runner = { name: "box", start: async () => ({ handle: "box", pid: null }), alive: async () => [], stop: async () => undefined,
      attach: async (_c, label) => { opened.push(label); return { ok: true, data: { kind: "shown", note: `${label} is open beside orca2` } }; } };
    registerBuiltins([{ name: "box", dir: join(home.path(), "box"), ui: null,
      index: async () => ({ default: definePlugin({ name: "box", description: "box", tools: [], prompt: [], skills: [], storage: [], hooks: noHooks(), bundles: [], guard: [], retention: [],
        provides: [], uses: [], emits: [], on: [], ui: null, background: "./background.ts" }) }),
      background: async () => ({ default: defineBackground({ watchers: [], memory: null, runner: box, stop: null, remove: null }) }) }]);
    await saveConfig({ plugins: ["box"], runner: "plain" });
    const c = await createConversation(home.path(), "split");
    const runtime = runtimeFor(c.id, "orchestrator", async () => false);
    await expect(runtime.spawn({ bundle: "worker", branch: "x", brief: "look around", fresh: false, images: [], runner: "rex" })).rejects.toThrow("unknown runner rex; this bubble has plain, box");
    const info = await runtime.spawn({ bundle: "worker", branch: "x", brief: "look around", fresh: false, images: [], runner: "box" });
    expect(info.runner).toBe("box");
    expect((await loadConfig()).runner).toBe("plain");
    await updateRun(c.id, info.agent, { state: "running", pid: process.pid });
    expect((await readRun(c.id, info.agent))?.runner).toBe("box");
    expect(await runtime.show(info.agent)).toBe(`${info.agent} is open beside orca2`);
    expect(opened).toEqual([info.agent]);
    await saveConfig({ plugins: [] });
  });

  test("stopAgents stops every live subagent of a chat the way subagent stop does, and leaves the orchestrator and finished runs alone", async () => {
    const c = await createConversation(home.path(), "kill");
    const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    const run = (agent: string, role: "orchestrator" | "worker", state: "running" | "exited", pid: number) =>
      ({ ...newRun({ conversation: c.id, agent, role, bundle: "worker", branch: agent, runner: "plain" }), state, pid, handle: String(pid) });
    await writeRun(run("worker-live", "worker", "running", child.pid));
    await writeRun(run("worker-done", "worker", "exited", child.pid));
    await writeRun(run("orchestrator", "orchestrator", "running", child.pid));
    expect(await stopAgents(c.id)).toEqual(["worker-live"]);
    expect((await readRun(c.id, "worker-live"))?.state).toBe("stopped");
    expect((await readRun(c.id, "worker-done"))?.state).toBe("exited");
    expect((await readRun(c.id, "orchestrator"))?.state).toBe("running");
    await child.exited;
  });
});

describe("headless runs", () => {
  const home = tempHome("headless");

  test("-p prints the final answer; --json streams every event and ends with the answer", async () => {
    let printed = "";
    const plain = fakeProvider([[text("42")]]);
    const code = await runHeadless({ prompt: "what is 6*7", json: false, model: null, cwd: home.path(), conversation: null, bundle: "orchestrator", yes: false,
      out: t => { printed += t; }, resolve: async () => ok({ model: "claude-sonnet-5-5", provider: plain, settings: null, contextLimit: null }) });
    expect(code).toBe(0);
    expect(printed).toBe("42\n");

    let lines = "";
    const json = fakeProvider([[text("checking"), toolUse("t1", "bash", { command: "echo hi" })], [text("done: hi")]]);
    await runHeadless({ prompt: "run echo", json: true, model: null, cwd: home.path(), conversation: null, bundle: "orchestrator", yes: false,
      out: t => { lines += t; }, resolve: async () => ok({ model: "claude-sonnet-5-5", provider: json, settings: null, contextLimit: null }) });
    const Event = z.looseObject({ kind: z.string(), conversation: z.string(), text: z.string().optional(), outcome: z.object({ text: z.string() }).optional(),
      span: z.object({ id: z.string(), kind: z.string(), label: z.string(), agent: z.string(), startedAt: z.string(), durationMs: z.number().optional() }).optional() });
    const events = lines.trim().split("\n").map(line => Event.parse(JSON.parse(line)));
    expect(events.filter(e => !e.kind.startsWith("span_") && e.kind !== "notice").map(e => e.kind)).toEqual(["start", "input", "text", "tool_start", "tool_end", "text", "end"]);
    const spanEvents = events.flatMap(e => e.span === undefined ? [] : [`${e.kind} ${e.span.kind} ${e.span.label}`]);
    expect(spanEvents).toEqual([
      "span_start prep session", "span_end prep session",
      "span_start prep request", "span_end prep request",
      "span_start model claude-sonnet-5-5", "span_end model claude-sonnet-5-5",
      "span_start tool bash: echo hi", "span_end tool bash: echo hi",
      "span_start prep request", "span_end prep request",
      "span_start model claude-sonnet-5-5", "span_end model claude-sonnet-5-5",
    ]);
    const ends = events.filter(e => e.kind === "span_end");
    expect(ends.every(e => typeof e.span?.durationMs === "number" && e.span.agent === "orchestrator")).toBe(true);
    const conversation = events[0]?.conversation ?? "";
    const recorded = await readSpans(conversation);
    expect(recorded.ok ? recorded.data.map(span => span.id) : []).toEqual(ends.map(e => e.span?.id ?? ""));
    expect(events.find(e => e.kind === "tool_end")?.outcome?.text).toBe("hi");
    expect(events.at(-1)).toMatchObject({ kind: "end", text: "done: hi" });
  });

  test("a worker bundle runs headless too, with write tools", async () => {
    let printed = "";
    const provider = fakeProvider([[text("ok")]]);
    await runHeadless({ prompt: "x", json: false, model: null, cwd: home.path(), conversation: null, bundle: "worker", yes: false,
      out: t => { printed += t; }, resolve: async () => ok({ model: "claude-sonnet-5-5", provider, settings: null, contextLimit: null }) });
    expect(printed).toBe("ok\n");
    expect(provider.calls[0]?.tools).toContain("write");
    expect(provider.calls[0]?.tools).not.toContain("subagent");
  });

  test("a real folder under a reserved $ORCA_DATA name is a notice; the session still runs and bash still sees $ORCA_DATA", async () => {
    const conversation = await createConversation(home.path(), "reserved");
    await mkdir(join(paths.data(conversation.id), "global"), { recursive: true });
    let lines = "";
    const provider = fakeProvider([[toolUse("t1", "bash", { command: "printf %s \"$ORCA_DATA\"" })], [text("done")]]);
    const code = await runHeadless({ prompt: "where", json: true, model: null, cwd: home.path(), conversation: conversation.id, bundle: "orchestrator", yes: false,
      out: t => { lines += t; }, resolve: async () => ok({ model: "claude-sonnet-5-5", provider, settings: null, contextLimit: null }) });
    expect(code).toBe(0);
    const Event = z.looseObject({ kind: z.string(), text: z.string().optional(), outcome: z.object({ text: z.string() }).optional() });
    const events = lines.trim().split("\n").map(line => Event.parse(JSON.parse(line)));
    expect(events.filter(e => e.kind === "notice").map(e => e.text ?? "").filter(notice => notice.includes("$ORCA_DATA/global is reserved"))).toHaveLength(1);
    expect(events.find(e => e.kind === "tool_end")?.outcome?.text).toBe(paths.data(conversation.id));
  });
});

describe("end to end through the CLI", () => {
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
    process.env.ORCA2_SELF = JSON.stringify([process.execPath, resolve(import.meta.dir, "../../cli/main.ts")]);
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
    expect((await readStatus(c.id))?.contextTokens).toBe(15);
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
});
