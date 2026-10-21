import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

const home = mkdtempSync(join(tmpdir(), "parallels-exits-"));
process.env.PARALLELS_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));

const { createAgent } = await import("./agent");
const { afterExit, beginRun, claim, claimed, dirtyCount, noticeText, readRun, supervise, watchdog } = await import("./exits");
const { drain, put } = await import("./inbox");
const { agentCommand, slug, tmux } = await import("./runner");
const { message } = await import("./tools/message");
const { fakeProvider, text, toolUse } = await import("./test/fake-provider");
const { open } = await import("./transcript");
const { paths } = await import("./config");
type Tracker = import("./exits").Tracker;
type Tool = import("./tools/index").Tool;

let n = 0;
let project = "";
beforeEach(() => {
  project = `p${n++}`;
});

/** A git repo dir with `dirty` uncommitted files. */
async function repo(dirty: number): Promise<string> {
  const dir = mkdtempSync(join(home, "wt-"));
  await $`git init -q ${dir}`.quiet();
  for (let i = 0; i < dirty; i++) writeFileSync(join(dir, `f${i}`), "x");
  return dir;
}

const DEAD_PID = 2 ** 30; // no such process
const info = (cwd: string, run = "r1") => ({ project, id: "worker-feat", run, role: "worker" as const, branch: "feat", cwd });
const quiet = { log: () => {}, signals: () => () => {} };
const inbox = () => drain(project, "orchestrator");

const echo: Tool = {
  spec: { name: "echo", description: "echo", input_schema: { type: "object", properties: {} } },
  async run() { return "ok"; },
};

/** An agent body: a fake model scripted with `script`, tracked by supervise's tracker. */
const agentBody = (cwd: string, script: Parameters<typeof fakeProvider>[0]) => async (tracker: Tracker) => {
  const transcript = open(join(home, `${project}-${crypto.randomUUID()}.jsonl`));
  await transcript.append({ type: "message", message: { role: "user", content: "go" } });
  await createAgent({
    provider: fakeProvider(script),
    transcript,
    tools: { message, echo },
    model: "m",
    ctx: { project, role: "worker", branch: "feat", cwd },
    write: () => {},
    tracker,
  }).run();
};

describe("case 1: the loop throws", () => {
  test("one crash notice with the error, last tool, role, branch and dirty count; exit 70", async () => {
    const cwd = await repo(2);
    // One tool call, then the script runs out: the provider throws like an API error.
    const code = await supervise(info(cwd), agentBody(cwd, [[toolUse("t1", "message", { to: "user", text: "hi" })]]), quiet);
    expect(code).toBe(70);
    const msgs = await inbox();
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.from).toBe("worker-feat");
    const t = msgs[0]!.text;
    expect(t.startsWith("[agent-exit] worker-feat crashed: fake provider: script exhausted")).toBe(true);
    expect(t).toContain(`role worker; branch feat; last step: model request; last tool: message {"to":"user","text":"hi"}; uncommitted changes: 2`);
  });

  test("the shell follow-up after the crash sends nothing more", async () => {
    const cwd = await repo(0);
    expect(await supervise(info(cwd), async () => { throw new Error("boom"); }, quiet)).toBe(70);
    expect(await afterExit({ ...info(cwd), code: 70 })).toBe(false);
    const msgs = await inbox();
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.text).toContain("crashed: boom");
  });

  test("when the notice cannot be sent, the run stays open and the exit code is 1 so the follow-up tries", async () => {
    const cwd = await repo(0);
    mkdirSync(paths.inbox(project), { recursive: true });
    writeFileSync(join(paths.inbox(project), "orchestrator"), "not a dir");
    expect(await supervise(info(cwd), async () => { throw new Error("boom"); }, quiet)).toBe(1);
    expect(claimed(project, "worker-feat", "r1")).toBe(false);
  });

  test("a crash after a final report closes the run silently, exit 70", async () => {
    const cwd = await repo(0);
    const body = async (t: Tracker) => { await t.reported(); throw new Error("late"); };
    expect(await supervise(info(cwd), body, quiet)).toBe(70);
    expect(await inbox()).toEqual([]);
    expect(claimed(project, "worker-feat", "r1")).toBe(true);
  });
});

describe("case 2: killed or a non-zero exit", () => {
  test("killed mid-run: one notice naming the signal and the last step; a second follow-up sends nothing", async () => {
    const cwd = await repo(1);
    const t = await beginRun(info(cwd));
    await t.tool("bash", { command: "bun test" });
    expect(await afterExit({ ...info(cwd), code: 137 })).toBe(true);
    expect(await afterExit({ ...info(cwd), code: 137 })).toBe(false);
    const msgs = await inbox();
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.text).toBe(`[agent-exit] worker-feat exited (code 137, signal 9) without reporting (role worker; branch feat; last step: bash {"command":"bun test"}; uncommitted changes: 1)`);
  });

  test("died before the agent wrote its run: still one notice", async () => {
    const cwd = await repo(0);
    await beginRun(info(cwd, "old")); // an earlier run's state
    expect(await afterExit({ ...info(cwd, "new"), code: 1 })).toBe(true);
    const msgs = await inbox();
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.text).toContain("exited (code 1) without reporting (role worker; branch feat; last step: before the agent started");
  });

  test("nothing when the run ended on a report", async () => {
    const cwd = await repo(0);
    const t = await beginRun(info(cwd));
    await t.reported();
    expect(await afterExit({ ...info(cwd), code: 1 })).toBe(false);
    expect(await inbox()).toEqual([]);
  });

  test("a quick respawn keeps the old run's claim, so its follow-up sends no duplicate", async () => {
    const cwd = await repo(0);
    expect(await supervise(info(cwd, "a"), async () => { throw new Error("boom"); }, quiet)).toBe(70);
    await beginRun(info(cwd, "b")); // respawned before run a's follow-up ran
    expect(await afterExit({ ...info(cwd, "a"), code: 1 })).toBe(false);
    expect((await inbox()).length).toBe(1);
  });

  test("a new run prunes only claims older than a day", async () => {
    const cwd = await repo(0);
    expect(await claim(project, "worker-feat", "ancient")).toBe(true);
    expect(await claim(project, "worker-feat", "recent")).toBe(true);
    const old = (Date.now() - 2 * 24 * 3600 * 1000) / 1000;
    utimesSync(join(paths.runs(project), "worker-feat.ancient.exit"), old, old);
    await beginRun(info(cwd, "next"));
    expect(claimed(project, "worker-feat", "ancient")).toBe(false);
    expect(claimed(project, "worker-feat", "recent")).toBe(true);
  });
});

describe("signals", () => {
  test("SIGTERM: one 'killed by' notice from the in-memory state, exit 143; the follow-up adds nothing", async () => {
    const cwd = await repo(3);
    let fire!: (name: string, n: number) => void;
    let exited = -1;
    const done = new Promise<void>((resolve) => {
      void supervise(info(cwd), async (t) => {
        await t.tool("bash", { command: "sleep 999" });
        fire("SIGTERM", 15);
        await new Promise(() => {}); // never finishes, like a hung tool
      }, { log: () => {}, signals: (h) => { fire = h; return () => {}; }, exit: (code) => { exited = code; resolve(); } });
    });
    await done;
    expect(exited).toBe(143);
    expect(await afterExit({ ...info(cwd), code: 143 })).toBe(false);
    const msgs = await inbox();
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.text).toBe(`[agent-exit] worker-feat killed by SIGTERM (role worker; branch feat; last step: bash {"command":"sleep 999"}; uncommitted changes: 3)`);
  });

  test("a real process killed with SIGHUP sends its notice and exits 129", async () => {
    const cwd = await repo(0);
    const script = join(home, `sig-${project}.ts`);
    writeFileSync(script, `import { supervise } from ${JSON.stringify(join(import.meta.dir, "exits.ts"))};
process.exitCode = await supervise(${JSON.stringify(info(cwd))}, async (t) => { await t.tool("bash", { command: "wait" }); await new Promise(() => setInterval(() => {}, 1000)); }, { log: () => {} });`);
    const proc = Bun.spawn(["bun", script], { cwd, env: { ...process.env, PARALLELS_HOME: home }, stdout: "ignore", stderr: "ignore" });
    const deadline = Date.now() + 5000;
    while ((await readRun(project, "worker-feat"))?.step !== 'bash {"command":"wait"}' && Date.now() < deadline) await Bun.sleep(20);
    proc.kill("SIGHUP");
    expect(await proc.exited).toBe(129);
    const msgs = await inbox();
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.text).toContain("[agent-exit] worker-feat killed by SIGHUP (role worker; branch feat; last step: bash");
  });
});

describe("case 3: clean exit", () => {
  test("without a report: one notice", async () => {
    const cwd = await repo(0);
    expect(await supervise(info(cwd), agentBody(cwd, [[text("done, I think")]]), quiet)).toBe(0);
    const msgs = await inbox();
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.text).toBe("[agent-exit] worker-feat finished without reporting (role worker; branch feat; last step: model request; uncommitted changes: 0)");
  });

  test("ending on a report to the orchestrator: only the report", async () => {
    const cwd = await repo(0);
    const script = [[toolUse("t1", "message", { to: "orchestrator", text: "done" })], [text("")]];
    expect(await supervise(info(cwd), agentBody(cwd, script), quiet)).toBe(0);
    expect((await inbox()).map((m) => m.text)).toEqual(["done"]);
    expect((await readRun(project, "worker-feat"))!.state).toBe("reported");
    expect(claimed(project, "worker-feat", "r1")).toBe(true);
  });

  test("an interim report followed by more tool calls does not count", async () => {
    const cwd = await repo(0);
    const script = [[toolUse("t1", "message", { to: "orchestrator", text: "starting…" })], [toolUse("t2", "echo", {})], [text("")]];
    await supervise(info(cwd), agentBody(cwd, script), quiet);
    const msgs = await inbox();
    expect(msgs.map((m) => m.text.slice(0, 45))).toEqual(["starting…", "[agent-exit] worker-feat finished without rep"]);
    expect(msgs[1]!.text).toContain("last tool: echo {}");
  });

  test("a message to someone else is not a report", async () => {
    const cwd = await repo(0);
    const script = [[toolUse("t1", "message", { to: "user", text: "hi" })], [text("")]];
    await supervise(info(cwd), agentBody(cwd, script), quiet);
    const msgs = await inbox();
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.text).toContain("finished without reporting");
  });

  test("new instructions after the report need a new report", async () => {
    const cwd = await repo(0);
    // The orchestrator's note lands while the report is being sent, so it rides along with the result.
    const script = [[toolUse("t1", "message", { to: "orchestrator", text: "done" })], [text("")]];
    const body = agentBody(cwd, script);
    await supervise(info(cwd), async (t) => {
      const reported = t.reported.bind(t);
      t.reported = async () => { await reported(); await put(project, "worker-feat", { from: "orchestrator", text: "one more fix" }); };
      await body(t);
    }, quiet);
    const msgs = await inbox();
    expect(msgs.map((m) => m.text.slice(0, 45))).toEqual(["done", "[agent-exit] worker-feat finished without rep"]);
  });
});

describe("case 4: the watchdog", () => {
  const dead = new Set<number>([DEAD_PID]);
  const alive = (pid: number) => !dead.has(pid);
  /** A run for `id` owned by `pid`. */
  const run = async (id: string, pid: number) => beginRun({ ...info("/"), id }, pid);

  test("fires once for a vanished window whose run is open, silent and dead", async () => {
    const r = { a: await run("worker-a", DEAD_PID), b: await run("worker-b", DEAD_PID), c: await run("worker-c", DEAD_PID), d: await run("reviewer-a", DEAD_PID) };
    await r.a.reported(); // ended on a report: no notice
    await r.b.tool("bash", { command: "ls" }); // silent: notice
    expect(await claim(project, "worker-c", "r1")).toBe(true); // already sent its own notice
    // reviewer-a stays live.
    let live = ["worker-a", "worker-b", "worker-c", "reviewer-a"];
    const dirtyAt: string[] = [];
    const check = watchdog({ live: async () => live, alive, dirty: async (cwd) => { dirtyAt.push(cwd); return 4; } });
    expect(await check(project)).toEqual([]);
    live = ["reviewer-a"];
    expect(await check(project)).toEqual(["worker-b"]);
    expect(await check(project)).toEqual([]);
    const msgs = await inbox();
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.from).toBe("worker-b");
    expect(msgs[0]!.text).toBe(`[agent-exit] worker-b's window is gone (role worker; branch feat; last step: bash {"command":"ls"}; uncommitted changes: 4)`);
    expect(dirtyAt).toEqual([paths.worktree(project, slug("feat"))]);
  });

  test("waits while the process still lives, then fires once it is dead", async () => {
    const pid = 4242_4242;
    await run("worker-a", pid);
    let live = ["worker-a"];
    const check = watchdog({ live: async () => live, alive, dirty: async () => null });
    await check(project);
    live = [];
    expect(await check(project)).toEqual([]); // window gone, process not yet
    dead.add(pid);
    expect(await check(project)).toEqual(["worker-a"]);
    expect((await inbox())[0]!.text).toContain("worker-a's window is gone");
  });

  test("a failed tmux query is not 'no windows'", async () => {
    await run("worker-a", DEAD_PID);
    let live: string[] | null = ["worker-a"];
    const check = watchdog({ live: async () => live, alive, dirty: async () => null });
    await check(project);
    live = null;
    expect(await check(project)).toEqual([]);
    live = ["worker-a"];
    expect(await check(project)).toEqual([]);
    expect(await inbox()).toEqual([]);
  });

  test("startup sweep: the first check reports open, silent, dead runs without a live window", async () => {
    await run("worker-dead", DEAD_PID); // notice
    await run("worker-live", DEAD_PID); // window still live (pid reused, say): none
    await run("worker-running", process.pid); // process alive: none
    await (await run("worker-done", DEAD_PID)).reported(); // ended on a report: none
    await run("worker-closed", DEAD_PID);
    expect(await claim(project, "worker-closed", "r1")).toBe(true); // closed: none
    const check = watchdog({ live: async () => ["worker-live"], alive, dirty: async () => null });
    expect(await check(project)).toEqual(["worker-dead"]);
    expect(await check(project)).toEqual([]);
    const msgs = await inbox();
    expect(msgs.map((m) => m.text)).toEqual([`[agent-exit] worker-dead stopped while the TUI was not watching (role worker; branch feat; last step: starting; uncommitted changes: unknown)`]);
  });

  test("the first check never sweeps when tmux could not be asked", async () => {
    await run("worker-dead", DEAD_PID);
    let live: string[] | null = null;
    const check = watchdog({ live: async () => live, alive, dirty: async () => null });
    expect(await check(project)).toEqual([]);
    live = [];
    expect(await check(project)).toEqual(["worker-dead"]);
  });
});

describe("dirtyCount", () => {
  test("counts porcelain lines; null outside a repo", async () => {
    expect(await dirtyCount(await repo(2))).toBe(2);
    expect(await dirtyCount(mkdtempSync(join(home, "plain-")))).toBe(null);
    expect(await dirtyCount(join(home, "missing"))).toBe(null);
  });

  // Two fake gits: one logs its arguments and exits at once (no timing involved), one hangs.
  // A hanging git that logged first could be killed before it logged under load.
  const fakeGit = (script: string) => {
    const bin = mkdtempSync(join(home, "gitbin-"));
    writeFileSync(join(bin, "git"), `#!/bin/sh\n${script}\n`);
    chmodSync(join(bin, "git"), 0o755);
    return bin;
  };
  const quick = fakeGit(`echo "$@" > "$(dirname "$0")/log"`);
  const hangs = fakeGit("exec sleep 30");
  // Run once at load: on macOS the first exec of a new file waits for a system policy check,
  // which can outlast dirtyCount's 3s timeout under parallel load.
  Bun.spawnSync([join(quick, "git")]);

  test("uses --no-optional-locks and gives up after the timeout", async () => {
    const path = process.env.PATH;
    try {
      process.env.PATH = `${quick}:${path}`;
      expect(await dirtyCount(home)).toBe(0);
      expect(readFileSync(join(quick, "log"), "utf8").trim()).toBe("--no-optional-locks status --porcelain");
      process.env.PATH = `${hangs}:${path}`;
      const started = Date.now();
      expect(await dirtyCount(home, 200)).toBe(null);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      process.env.PATH = path;
    }
  });
});

test("noticeText keeps the error on one capped line", () => {
  const t = noticeText("worker-x", `crashed: ${"a\n".repeat(500)}`, { role: "worker", branch: "x", step: "s", tool: "s" }, null);
  expect(t).not.toContain("\n");
  expect(t.length).toBeLessThan(800);
});

describe("agentCommand", () => {
  const nasty = `it's a \\ "$(id)" \`id\` $HOME *`;
  const nastyBranch = `it's\\b`;

  // One fake `bun` for every test here, made and run once at load: on macOS the first exec of a new
  // file waits for a system policy check, which took over 5s (the test timeout) under parallel load.
  // It logs its argv and $PARALLELS_HOME into $FAKE_BUN and exits with $FAKE_BUN/code for `agent`.
  const fakeBin = mkdtempSync(join(home, "bin-"));
  writeFileSync(join(fakeBin, "bun"), `#!/bin/sh\nd="$FAKE_BUN"\nprintf '%s' "$PARALLELS_HOME" > "$d/home"\nfor a in "$@"; do printf '%s\\n' "$a"; done >> "$d/log"\necho --- >> "$d/log"\nif [ "$2" = agent ]; then exit "$(cat "$d/code")"; fi\nexit 0\n`);
  chmodSync(join(fakeBin, "bun"), 0o755);
  Bun.spawnSync([join(fakeBin, "bun")], { env: { ...process.env, FAKE_BUN: mkdtempSync(join(home, "warm-")) } });

  /** A dir for the fake `bun`'s log, with the code it exits with for `agent`, and the env that runs it. */
  function fakeBun(code: number) {
    const dir = mkdtempSync(join(home, "fake-"));
    const log = join(dir, "log");
    writeFileSync(join(dir, "code"), String(code));
    // Only complete calls (ended by ---): the follow-up may still be writing its argv when a test reads the log.
    const calls = () => (existsSync(log) ? readFileSync(log, "utf8") : "").split("---\n").slice(0, -1).map((c) => c.split("\n").filter(Boolean));
    const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, FAKE_BUN: dir };
    return { dir, env, calls };
  }

  /** agentCommand built with a PARALLELS_HOME full of quotes and backslashes. */
  function command(run: string) {
    const weirdHome = join(home, `ho'me\\ $x`);
    process.env.PARALLELS_HOME = weirdHome;
    try {
      return { argv: agentCommand({ project: nasty, role: "worker", branch: nastyBranch }, run), weirdHome };
    } finally {
      process.env.PARALLELS_HOME = home;
    }
  }

  /** Exec the argv directly, as tmux does with more than one argument. */
  async function runWith(code: number) {
    const { env, calls } = fakeBun(code);
    const { argv, weirdHome } = command("run1");
    const cwd = mkdtempSync(join(home, "cwd-"));
    const proc = Bun.spawn(argv, { cwd, env });
    return { exit: await proc.exited, calls: calls(), cwd, weirdHome };
  }

  const args = (cmd: string, extra: string[] = []) => [cmd, "--project", nasty, "--role", "worker", "--branch", nastyBranch, "--run", "run1", ...extra];

  test("a clean exit runs only the agent, with every value passed through verbatim", async () => {
    const { exit, calls, cwd } = await runWith(0);
    expect(exit).toBe(0);
    expect(calls.length).toBe(1);
    expect(calls[0]!.slice(1)).toEqual(args("agent"));
    expect(readdirSync(cwd)).toEqual([]);
  });

  test("a non-zero exit runs agent-exit with the same run id and the code", async () => {
    const { exit, calls } = await runWith(137);
    expect(exit).toBe(137);
    expect(calls.length).toBe(2);
    expect(calls[1]!.slice(1)).toEqual(args("agent-exit", ["--code", "137"]));
  });

  test("exit 70 (run already closed) skips the follow-up", async () => {
    const { exit, calls } = await runWith(70);
    expect(exit).toBe(70);
    expect(calls.length).toBe(1);
  });

  test("PARALLELS_HOME with ' and \\ reaches the agent intact", async () => {
    const { dir, env } = fakeBun(0);
    const { argv, weirdHome } = command("r");
    await Bun.spawn(argv, { env }).exited;
    expect(readFileSync(join(dir, "home"), "utf8")).toBe(weirdHome);
  });

  const shells = ["/bin/sh", "/bin/zsh", Bun.which("fish"), Bun.which("bash")].filter((s): s is string => !!s && existsSync(s));
  for (const shell of shells) {
    test.skipIf(!Bun.which("tmux"))(`through tmux with default-shell ${shell}`, async () => {
      const { env: fake, calls } = fakeBun(1);
      const { argv } = command("run1");
      const sock = join(mkdtempSync(join(tmpdir(), "pt-")), "s");
      const env = { ...fake, TMUX: "" };
      const t = (...a: string[]) => Bun.spawnSync(["tmux", "-S", sock, "-f", "/dev/null", ...a], { env });
      try {
        expect(t("new-session", "-d", "-s", "x", "-n", "shell").exitCode).toBe(0);
        t("set", "-g", "default-shell", shell);
        expect(t("new-window", "-d", "-t", "=x", "-n", "w", "--", ...argv).exitCode).toBe(0);
        const deadline = Date.now() + 5000;
        while (calls().length < 2 && Date.now() < deadline) await Bun.sleep(20);
        expect(calls().map((c) => c.slice(1))).toEqual([args("agent"), args("agent-exit", ["--code", "1"])]);
      } finally {
        t("kill-server");
      }
    });
  }

  test("the orchestrator gets no wrapper", () => {
    expect(agentCommand({ project: "p", role: "orchestrator" }, "r")[0]).toBe("env");
  });

  test("end to end: a real agent that crashes at start sends exactly one notice and exits 70", async () => {
    // No transcript seeded, so `parallels agent` throws; the follow-up is skipped.
    const cwd = await repo(0);
    mkdirSync(paths.project(project), { recursive: true });
    const proc = Bun.spawn(agentCommand({ project, role: "worker", branch: "feat" }, "e2e"), { cwd, stdout: "ignore", stderr: "ignore" });
    expect(await proc.exited).toBe(70);
    const msgs = await inbox();
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.text).toContain("[agent-exit] worker-feat crashed: agent: no transcript for worker-feat");
  });
});

describe("tmux.windows", () => {
  test("[] for a missing session, null when tmux is not on PATH", async () => {
    if (Bun.which("tmux")) expect(await tmux.windows(`no-such-${process.pid}`)).toEqual([]);
    const path = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      expect(await tmux.windows("x")).toBe(null);
    } finally {
      process.env.PATH = path;
    }
  });
});

test("the TUI runs the watchdog for each open page on every inbox poll", async () => {
  const { App } = await import("./tui/app");
  const checked: string[] = [];
  const term = { cols: 40, rows: 8, write() {}, onKey() {}, onResize() {}, open() {}, close() {}, eraseOnExit() {} };
  const orch = { async say() {}, async pending() { return false; }, async turn() { return []; } };
  const app = new App({ term, openOrchestrator: async () => orch, pollMs: 10, watchdog: async (p) => { checked.push(p); }, merges: async () => {} });
  const running = app.run("watched");
  const deadline = Date.now() + 2000;
  while (checked.length < 2 && Date.now() < deadline) await Bun.sleep(5);
  app.quit();
  await running;
  expect(checked.slice(0, 2)).toEqual(["watched", "watched"]);
});
