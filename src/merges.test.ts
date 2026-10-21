import { afterAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { $ } from "bun";

const home = mkdtempSync(join(tmpdir(), "parallels-merges-"));
process.env.PARALLELS_HOME = home;
for (const k of ["GIT_AUTHOR_NAME", "GIT_COMMITTER_NAME"]) process.env[k] = "t";
for (const k of ["GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL"]) process.env[k] = "t@t";
afterAll(() => rmSync(home, { recursive: true, force: true }));
// Real git, gh and bun processes: slow on a loaded machine.
setDefaultTimeout(30_000);

const { ghMerged, mergeNotice, mergeWatcher, MERGE_POLL_MS } = await import("./merges");
const { afterExit, readRun, watchdog } = await import("./exits");
const { drain, put } = await import("./inbox");
const { ensureWorktree } = await import("./runner");
const { paths } = await import("./config");
type MergedPR = import("./merges").MergedPR;

/** Poll until `f` holds, or fail after `ms`. */
async function until(f: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await f())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
}

let n = 0;
let project = "";
let origin = "";
beforeEach(async () => {
  project = `m${n++}`;
  origin = join(home, `${project}-origin.git`);
  const seed = join(home, `${project}-seed`);
  await $`git init -q --bare -b main ${origin}`.quiet();
  await $`git init -q -b main ${seed}`.quiet();
  writeFileSync(join(seed, "README"), "x\n");
  await $`git -C ${seed} add . && git -C ${seed} commit -qm init && git -C ${seed} push -q ${origin} main`.quiet();
  mkdirSync(paths.project(project), { recursive: true });
  await $`git clone -q ${origin} ${paths.repo(project)}`.quiet();
});

const sh = async (cwd: string, ...args: string[]) => (await $`git -C ${cwd} ${args}`.quiet().nothrow()).stdout.toString().trim();
const hasBranch = async (cwd: string, b: string) => (await $`git -C ${cwd} rev-parse --verify --quiet refs/heads/${b}`.quiet().nothrow()).exitCode === 0;
const remoteHas = async (b: string) => (await $`git -C ${origin} rev-parse --verify --quiet refs/heads/${b}`.quiet().nothrow()).exitCode === 0;

/** A branch with a worktree, one commit pushed to origin, and transcripts and inboxes for both agents. */
async function branch(b: string): Promise<string> {
  const wt = await ensureWorktree(project, b);
  writeFileSync(join(wt, `${b}.txt`), "work\n");
  await $`git -C ${wt} add . && git -C ${wt} commit -qm work && git -C ${wt} push -q origin ${b}`.quiet();
  mkdirSync(join(paths.project(project), "transcripts"), { recursive: true });
  for (const id of [`worker-${b}`, `reviewer-${b}`]) {
    writeFileSync(paths.transcript(project, id), "{}\n");
    await put(project, id, { from: "orchestrator", text: "hi" });
  }
  return wt;
}

const pr = (num: number, b: string, mergedAt = new Date(Date.now() + 60_000).toISOString()): MergedPR => ({ number: num, headRefName: b, url: `https://github.com/o/r/pull/${num}`, mergedAt });

const SUPERVISED = resolve(import.meta.dir, "exits.ts");

/** A real agent process: supervise() around a body that never ends, with its real signal handlers. */
async function agent(id: string, b: string, run: string): Promise<ReturnType<typeof Bun.spawn>> {
  const script = join(home, `${project}-${id}.ts`);
  writeFileSync(script, `import { supervise } from ${JSON.stringify(SUPERVISED)};
await supervise({ project: ${JSON.stringify(project)}, id: ${JSON.stringify(id)}, run: ${JSON.stringify(run)}, role: ${JSON.stringify(id.split("-")[0])}, branch: ${JSON.stringify(b)}, cwd: ${JSON.stringify(paths.worktree(project, b))} }, () => new Promise(() => {}), { log: () => {} });
`);
  const proc = Bun.spawn(["bun", script], { env: { ...process.env, PARALLELS_HOME: home }, stdout: "ignore", stderr: "ignore" });
  await until(async () => (await readRun(project, id))?.pid === proc.pid);
  await Bun.sleep(100); // signal handlers are installed right after the run state is written
  return proc;
}

/** A fake tmux: windows in a list; killing one hangs up its process, as tmux kill-window does. */
function fakeTmux(windows: Record<string, ReturnType<typeof Bun.spawn> | null>) {
  const killed: string[] = [];
  return {
    killed,
    live: async () => Object.keys(windows),
    kill: async (_p: string, w: string) => {
      killed.push(w);
      windows[w]?.kill("SIGHUP");
      delete windows[w];
    },
  };
}

const inbox = () => drain(project, "orchestrator");

describe("a merged branch", () => {
  test("live agents: windows killed, cleanup done, one notice, no extra agent-exit", async () => {
    const wt = await branch("feat");
    // main moves on origin; the cleanup fast-forwards the project's checkout.
    const other = join(home, `${project}-other`);
    await $`git clone -q ${origin} ${other}`.quiet();
    writeFileSync(join(other, "merged.txt"), "m\n");
    await $`git -C ${other} add . && git -C ${other} commit -qm merge && git -C ${other} push -q origin main`.quiet();

    const procs = { "worker-feat": await agent("worker-feat", "feat", "w1"), "reviewer-feat": await agent("reviewer-feat", "feat", "r1") };
    const tmux = fakeTmux({ ...procs });
    const check = mergeWatcher({ gh: async () => [pr(7, "feat")], live: tmux.live, kill: tmux.kill });
    expect(await check(project)).toEqual([7]);

    expect(tmux.killed.sort()).toEqual(["reviewer-feat", "worker-feat"]);
    for (const p of Object.values(procs)) expect(await p.exited).toBe(129); // their SIGHUP path ran and found the run closed
    expect(existsSync(wt)).toBe(false);
    expect(await hasBranch(paths.repo(project), "feat")).toBe(false);
    expect(await remoteHas("feat")).toBe(false);
    for (const id of ["worker-feat", "reviewer-feat"]) {
      expect(existsSync(paths.transcript(project, id))).toBe(false);
      expect(existsSync(join(paths.inbox(project), id))).toBe(false);
    }
    expect(readdirSync(paths.runs(project)).sort()).toEqual(["reviewer-feat.r1.exit", "worker-feat.w1.exit"]);
    expect(await sh(paths.repo(project), "rev-parse", "HEAD")).toBe(await sh(origin, "rev-parse", "main"));

    // The shell follow-ups and the watchdog stay silent: the claims hold.
    for (const [id, run] of [["worker-feat", "w1"], ["reviewer-feat", "r1"]] as const) {
      expect(await afterExit({ project, id, run, role: id.startsWith("worker") ? "worker" : "reviewer", branch: "feat", cwd: wt, code: 129 })).toBe(false);
    }
    expect(await watchdog({ live: async () => [], alive: () => false })(project)).toEqual([]);
    const msgs = await inbox();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.text).toBe("[agent-exit] worker-feat, reviewer-feat stopped: PR #7 merged (https://github.com/o/r/pull/7); cleaned up");
    expect(existsSync(join(paths.project(project), "merged", "7"))).toBe(true);
  });

  test("uncommitted changes: agents stopped, worktree, branch and transcripts kept, the notice says so", async () => {
    const wt = await branch("dirty");
    writeFileSync(join(wt, "wip.txt"), "wip\n");
    writeFileSync(join(wt, "wip2.txt"), "wip\n");
    const procs = { "worker-dirty": await agent("worker-dirty", "dirty", "w1") };
    const tmux = fakeTmux({ ...procs });
    const check = mergeWatcher({ gh: async () => [pr(8, "dirty")], live: tmux.live, kill: tmux.kill });
    expect(await check(project)).toEqual([8]);
    expect(tmux.killed).toEqual(["worker-dirty"]);
    expect(await procs["worker-dirty"].exited).toBe(129);
    expect(existsSync(wt)).toBe(true);
    expect(await hasBranch(paths.repo(project), "dirty")).toBe(true);
    expect(await remoteHas("dirty")).toBe(true);
    expect(existsSync(paths.transcript(project, "worker-dirty"))).toBe(true);
    const msgs = await inbox();
    expect(msgs.map((m) => m.text)).toEqual(["[agent-exit] worker-dirty stopped: PR #8 merged (https://github.com/o/r/pull/8); kept worktree: 2 uncommitted changes"]);
    expect(await watchdog({ live: async () => [], alive: () => false })(project)).toEqual([]);
  });

  test("no agents running: cleaned up, and the notice says so", async () => {
    await branch("idle");
    const check = mergeWatcher({ gh: async () => [pr(9, "idle")], live: async () => [], kill: async () => { throw new Error("nothing to kill"); } });
    expect(await check(project)).toEqual([9]);
    expect((await inbox()).map((m) => m.text)).toEqual(["[agent-exit] no agents running on idle: PR #9 merged (https://github.com/o/r/pull/9); cleaned up"]);
    expect(existsSync(paths.worktree(project, "idle"))).toBe(false);
  });

  test("unknown uncommitted count keeps the worktree", async () => {
    const wt = await branch("unk");
    const check = mergeWatcher({ gh: async () => [pr(10, "unk")], live: async () => [], dirty: async () => null });
    await check(project);
    expect(existsSync(wt)).toBe(true);
    expect((await inbox())[0]!.text).toEndWith("kept worktree: unknown uncommitted changes");
  });
});

describe("left alone", () => {
  test("a closed-not-merged PR and a branch with no PR are untouched", async () => {
    // gh lists merged PRs only: #3 (closed, branch "closed") is not among them, "nopr" has none.
    const wts = [await branch("closed"), await branch("nopr")];
    const killed: string[] = [];
    const check = mergeWatcher({ gh: async () => [pr(4, "elsewhere")], live: async () => ["worker-closed", "worker-nopr"], kill: async (_p, w) => { killed.push(w); } });
    expect(await check(project)).toEqual([]);
    expect(killed).toEqual([]);
    for (const wt of wts) expect(existsSync(wt)).toBe(true);
    expect(await inbox()).toEqual([]);
  });

  test("main (the checked-out branch) and the orchestrator are never touched", async () => {
    mkdirSync(join(paths.project(project), "transcripts"), { recursive: true });
    writeFileSync(paths.transcript(project, "worker-main"), "{}\n");
    const killed: string[] = [];
    const check = mergeWatcher({ gh: async () => [pr(1, "main"), pr(2, "HEAD")], live: async () => ["orchestrator", "worker-main"], kill: async (_p, w) => { killed.push(w); } });
    expect(await check(project)).toEqual([]);
    expect(killed).toEqual([]);
    expect(existsSync(paths.transcript(project, "worker-main"))).toBe(true);
    expect(await inbox()).toEqual([]);
  });

  test("a branch name reused after the merge is not taken for the merged PR", async () => {
    const wt = await branch("again");
    const check = mergeWatcher({ gh: async () => [pr(5, "again", "2020-01-01T00:00:00Z")], live: async () => ["worker-again"], kill: async () => { throw new Error("no"); } });
    expect(await check(project)).toEqual([]);
    expect(existsSync(wt)).toBe(true);
    expect(await inbox()).toEqual([]);
  });

  test("a merged PR with nothing left of its branch is only marked seen, so a later branch of that name is safe", async () => {
    const check = mergeWatcher({ gh: async () => [pr(6, "later")], live: async () => [], now: () => 0 });
    expect(await check(project)).toEqual([]);
    expect(existsSync(join(paths.project(project), "merged", "6"))).toBe(true);
    const wt = await branch("later");
    const again = mergeWatcher({ gh: async () => [pr(6, "later")], live: async () => [] });
    expect(await again(project)).toEqual([]);
    expect(existsSync(wt)).toBe(true);
    expect(await inbox()).toEqual([]);
  });

  test("tmux could not be asked: the check is skipped and retried later", async () => {
    const wt = await branch("tm");
    let live: string[] | null = null;
    let t = 0;
    const check = mergeWatcher({ gh: async () => [pr(11, "tm")], live: async () => live, now: () => t });
    expect(await check(project)).toEqual([]);
    expect(existsSync(wt)).toBe(true);
    live = [];
    t += MERGE_POLL_MS;
    expect(await check(project)).toEqual([11]);
  });
});

describe("gh", () => {
  const fake = (body: string) => {
    const f = join(home, `gh-${n++}`);
    writeFileSync(f, `#!/bin/sh\n${body}\n`);
    chmodSync(f, 0o755);
    return f;
  };

  test("lists merged PRs with the expected arguments", async () => {
    const log = join(home, `gh-args-${n}`);
    const bin = fake(`echo "$@" > ${log}\necho '[{"number":3,"headRefName":"a","url":"u","mergedAt":"2024-01-01T00:00:00Z"},{"number":"x"}]'`);
    expect(await ghMerged(home, { bin })).toEqual([{ number: 3, headRefName: "a", url: "u", mergedAt: "2024-01-01T00:00:00Z" }]);
    expect((await Bun.file(log).text()).trim()).toBe("pr list --state merged --json number,headRefName,url,mergedAt");
  });

  test("missing, failing, garbled or hanging gh gives null", async () => {
    expect(await ghMerged(home, { bin: join(home, "no-such-gh") })).toBe(null);
    expect(await ghMerged(home, { bin: fake("echo 'not logged in' >&2; exit 1") })).toBe(null);
    expect(await ghMerged(home, { bin: fake("echo not json") })).toBe(null);
    expect(await ghMerged(home, { bin: fake("echo '{}'") })).toBe(null);
    const t = Date.now();
    expect(await ghMerged(home, { bin: fake("exec sleep 10"), timeoutMs: 200 })).toBe(null);
    expect(Date.now() - t).toBeLessThan(3000);
    expect(await ghMerged(join(home, "no-such-dir"), { bin: fake("echo []") })).toBe(null);
    const path = process.env.PATH;
    process.env.PATH = join(home, "empty-path");
    try {
      expect(await ghMerged(home)).toBe(null);
    } finally {
      process.env.PATH = path;
    }
  });

  test("the watcher does nothing when gh fails or throws, and tries again later", async () => {
    const wt = await branch("g");
    let t = 0;
    let mode: "null" | "throw" | "ok" = "null";
    const check = mergeWatcher({
      gh: async () => { if (mode === "throw") throw new Error("boom"); return mode === "ok" ? [pr(12, "g")] : null; },
      live: async () => [],
      now: () => t,
    });
    expect(await check(project)).toEqual([]);
    mode = "throw";
    t += MERGE_POLL_MS;
    expect(await check(project)).toEqual([]);
    expect(existsSync(wt)).toBe(true);
    expect(await inbox()).toEqual([]);
    mode = "ok";
    t += MERGE_POLL_MS;
    expect(await check(project)).toEqual([12]);
  });
});

describe("once", () => {
  test("the same merge seen twice, or by two watchers at once, gives one notice", async () => {
    await branch("twice");
    const killed: string[] = [];
    const opts = () => ({ gh: async () => [pr(13, "twice")], live: async () => ["worker-twice"], kill: async (_p: string, w: string) => { killed.push(w); } });
    const [a, b] = [mergeWatcher(opts()), mergeWatcher(opts())];
    const results = await Promise.all([a(project), b(project)]);
    expect(results.flat()).toEqual([13]);
    // A restart: a fresh watcher sees the same merge again.
    expect(await mergeWatcher(opts())(project)).toEqual([]);
    expect(killed).toEqual(["worker-twice"]);
    expect(await inbox()).toHaveLength(1);
  });

  test("polls don't overlap, and gh is asked about every MERGE_POLL_MS", async () => {
    let calls = 0;
    let release!: () => void;
    let t = 0;
    const gate = new Promise<void>((r) => { release = r; });
    const check = mergeWatcher({ gh: async () => { calls++; await gate; return []; }, live: async () => [], now: () => t });
    const first = check(project);
    t += MERGE_POLL_MS; // due again, but the first check is still running
    expect(await check(project)).toEqual([]);
    expect(calls).toBe(1);
    release();
    await first;
    await check(project); // still due: the skipped one did not count
    expect(calls).toBe(2);
    t += MERGE_POLL_MS - 1;
    await check(project);
    expect(calls).toBe(2);
    t += 1;
    await check(project);
    expect(calls).toBe(3);
    await check("other-project"); // per project
    expect(calls).toBe(4);
  });
});

test("mergeNotice", () => {
  const p = pr(1, "b");
  expect(mergeNotice(p, [], { dirty: 0, problems: ["git push --delete: denied"] })).toBe(`[agent-exit] no agents running on b: PR #1 merged (${p.url}); cleaned up, except: git push --delete: denied`);
  expect(mergeNotice(p, ["worker-b"], { dirty: 3, alive: true })).toBe(`[agent-exit] worker-b stopped: PR #1 merged (${p.url}); kept worktree: 3 uncommitted changes; an agent process is still exiting`);
});

test("the TUI runs the merge watcher for each open page on every inbox poll", async () => {
  const { App } = await import("./tui/app");
  const checked: string[] = [];
  const term = { cols: 40, rows: 8, write() {}, onKey() {}, onResize() {}, open() {}, close() {}, eraseOnExit() {} };
  const orch = { async say() {}, async pending() { return false; }, async turn() { return []; } };
  const app = new App({ term, openOrchestrator: async () => orch, pollMs: 10, watchdog: async () => {}, merges: async (p) => { checked.push(p); } });
  const running = app.run("watched");
  await until(() => checked.length >= 2, 2000);
  app.quit();
  await running;
  expect(checked.slice(0, 2)).toEqual(["watched", "watched"]);
});
