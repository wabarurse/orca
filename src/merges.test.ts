import { afterAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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

const { ghMerged, githubRepo, mergeNotice, mergeWatcher, originRepo, MERGE_POLL_MS, STALE_CLAIM_MS } = await import("./merges");
const { afterExit, beginRun, readRun, watchdog } = await import("./exits");
const { drain, put } = await import("./inbox");
const { ensureWorktree, slug } = await import("./runner");
const { paths } = await import("./config");
type MergedPR = import("./merges").MergedPR;
type Opts = import("./merges").MergeWatchOptions;

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

/** A branch with a worktree, one commit pushed to origin, and transcripts and inboxes for both agents. Returns the worktree and the pushed commit. */
async function branch(b: string): Promise<{ wt: string; oid: string }> {
  const wt = await ensureWorktree(project, b);
  writeFileSync(join(wt, `${slug(b)}.txt`), "work\n");
  await $`git -C ${wt} add . && git -C ${wt} commit -qm work && git -C ${wt} push -q origin ${b}`.quiet();
  mkdirSync(join(paths.project(project), "transcripts"), { recursive: true });
  for (const id of [`worker-${slug(b)}`, `reviewer-${slug(b)}`]) {
    writeFileSync(paths.transcript(project, id), "{}\n");
    await put(project, id, { from: "orchestrator", text: "hi" });
  }
  return { wt, oid: await sh(wt, "rev-parse", "HEAD") };
}

const NO_OID = "0".repeat(40);
const future = () => new Date(Date.now() + 60_000).toISOString();
const pr = (num: number, b: string, oid = NO_OID, extra: Partial<MergedPR> = {}): MergedPR =>
  ({ number: num, headRefName: b, url: `https://github.com/o/r/pull/${num}`, mergedAt: future(), headRefOid: oid, isCrossRepository: false, ...extra });
const url = (num: number) => `https://github.com/o/r/pull/${num}`;

/** A watcher on GitHub repo o/r with gh returning `prs`. */
const watch = (prs: MergedPR[] | (() => MergedPR[] | null), opts: Partial<Opts> = {}) =>
  mergeWatcher({ gh: async () => (typeof prs === "function" ? prs() : prs), repo: async () => "o/r", live: async () => [], ...opts });

const SUPERVISED = resolve(import.meta.dir, "exits.ts");

/** A real agent process: supervise() around a body that never ends, with its real signal handlers. */
async function agent(id: string, b: string, run: string): Promise<ReturnType<typeof Bun.spawn>> {
  const script = join(home, `${project}-${id}.ts`);
  writeFileSync(script, `import { supervise } from ${JSON.stringify(SUPERVISED)};
await supervise({ project: ${JSON.stringify(project)}, id: ${JSON.stringify(id)}, run: ${JSON.stringify(run)}, role: ${JSON.stringify(id.split("-")[0])}, branch: ${JSON.stringify(b)}, cwd: ${JSON.stringify(paths.worktree(project, slug(b)))} }, () => new Promise(() => {}), { log: () => {} });
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
const claimFile = (num: number) => join(paths.project(project), "merged", String(num));
const claimOf = (num: number) => JSON.parse(readFileSync(claimFile(num), "utf8")) as { outcome: string; ts: string; running?: string[] };

describe("a merged branch", () => {
  test("live agents: windows killed, cleanup done, one notice, no extra agent-exit", async () => {
    const { wt, oid } = await branch("feat");
    // main moves on origin; the cleanup fast-forwards the project's checkout.
    const other = join(home, `${project}-other`);
    await $`git clone -q ${origin} ${other}`.quiet();
    writeFileSync(join(other, "merged.txt"), "m\n");
    await $`git -C ${other} add . && git -C ${other} commit -qm merge && git -C ${other} push -q origin main`.quiet();

    const procs = { "worker-feat": await agent("worker-feat", "feat", "w1"), "reviewer-feat": await agent("reviewer-feat", "feat", "r1") };
    const tmux = fakeTmux({ ...procs });
    const check = watch([pr(7, "feat", oid)], { live: tmux.live, kill: tmux.kill });
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
    expect(msgs[0]!.text).toBe(`[agent-exit] worker-feat, reviewer-feat stopped: pr #7 (feat) merged (${url(7)}); cleaned up`);
    expect(claimOf(7)).toMatchObject({ outcome: "handled", running: ["worker-feat", "reviewer-feat"] });
  });

  test("uncommitted changes: agents stopped, worktree, branch and transcripts kept, the notice says so", async () => {
    const { wt, oid } = await branch("dirty");
    writeFileSync(join(wt, "wip.txt"), "wip\n");
    writeFileSync(join(wt, "wip2.txt"), "wip\n");
    const procs = { "worker-dirty": await agent("worker-dirty", "dirty", "w1") };
    const tmux = fakeTmux({ ...procs });
    expect(await watch([pr(8, "dirty", oid)], { live: tmux.live, kill: tmux.kill })(project)).toEqual([8]);
    expect(tmux.killed).toEqual(["worker-dirty"]);
    expect(await procs["worker-dirty"].exited).toBe(129);
    expect(existsSync(wt)).toBe(true);
    expect(await hasBranch(paths.repo(project), "dirty")).toBe(true);
    expect(await remoteHas("dirty")).toBe(true);
    expect(existsSync(paths.transcript(project, "worker-dirty"))).toBe(true);
    expect((await inbox()).map((m) => m.text)).toEqual([`[agent-exit] worker-dirty stopped: pr #8 (dirty) merged (${url(8)}); kept worktree: 2 uncommitted changes`]);
    expect(await watchdog({ live: async () => [], alive: () => false })(project)).toEqual([]);
  });

  test("no agents running: cleaned up, and the notice says so", async () => {
    const { oid } = await branch("idle");
    expect(await watch([pr(9, "idle", oid)], { kill: async () => { throw new Error("nothing to kill"); } })(project)).toEqual([9]);
    expect((await inbox()).map((m) => m.text)).toEqual([`[agent-exit] no agents running: pr #9 (idle) merged (${url(9)}); cleaned up`]);
    expect(existsSync(paths.worktree(project, "idle"))).toBe(false);
  });

  test("a local tip that is an ancestor of the PR's head (commits added on GitHub) is cleaned up", async () => {
    const { wt, oid } = await branch("behind");
    await $`git -C ${wt} reset -q --hard HEAD~1`.quiet();
    expect(await watch([pr(14, "behind", oid)])(project)).toEqual([14]);
    expect(existsSync(wt)).toBe(false);
    expect((await inbox())[0]!.text).toEndWith("; cleaned up");
  });

  test("unknown uncommitted count keeps the worktree", async () => {
    const { wt, oid } = await branch("unk");
    await watch([pr(10, "unk", oid)], { dirty: async () => null })(project);
    expect(existsSync(wt)).toBe(true);
    expect((await inbox())[0]!.text).toEndWith("kept worktree: unknown uncommitted changes");
  });

  test("an agent that has not exited after the wait: everything kept", async () => {
    const { wt, oid } = await branch("stubborn");
    const proc = Bun.spawn(["sh", "-c", "trap '' HUP; while :; do sleep 0.05; done"], { stdout: "ignore", stderr: "ignore" });
    try {
      await beginRun({ project, id: "worker-stubborn", run: "s1", role: "worker", branch: "stubborn", cwd: wt }, proc.pid);
      const tmux = fakeTmux({ "worker-stubborn": proc });
      expect(await watch([pr(15, "stubborn", oid)], { live: tmux.live, kill: tmux.kill, waitMs: 300 })(project)).toEqual([15]);
      expect(tmux.killed).toEqual(["worker-stubborn"]);
      expect(existsSync(wt)).toBe(true);
      expect(await hasBranch(paths.repo(project), "stubborn")).toBe(true);
      expect(existsSync(paths.transcript(project, "worker-stubborn"))).toBe(true);
      expect(readdirSync(paths.runs(project))).toContain("worker-stubborn.json");
      expect((await inbox()).map((m) => m.text)).toEqual([`[agent-exit] worker-stubborn stopped: pr #15 (stubborn) merged (${url(15)}); kept everything: an agent process is still running`]);
    } finally {
      proc.kill("SIGKILL");
    }
  });

  test("a new agent started on the branch during the stop: everything kept", async () => {
    const { wt, oid } = await branch("respawned");
    await beginRun({ project, id: "worker-respawned", run: "old", role: "worker", branch: "respawned", cwd: wt }, 2 ** 30);
    const kill = async () => { await beginRun({ project, id: "worker-respawned", run: "new", role: "worker", branch: "respawned", cwd: wt }, 2 ** 30); };
    expect(await watch([pr(16, "respawned", oid)], { live: async () => ["worker-respawned"], kill })(project)).toEqual([16]);
    expect(existsSync(wt)).toBe(true);
    expect(existsSync(paths.transcript(project, "worker-respawned"))).toBe(true);
    expect((await inbox())[0]!.text).toEndWith("kept everything: a new agent started on the branch");

    // A new window counts too.
    const b = await branch("window");
    let calls = 0;
    const live = async () => (calls++ ? ["reviewer-window"] : ["worker-window"]);
    expect(await watch([pr(17, "window", b.oid)], { live, kill: async () => {} })(project)).toEqual([17]);
    expect(existsSync(b.wt)).toBe(true);
    expect((await inbox())[0]!.text).toEndWith("kept everything: a new agent started on the branch");
  });
});

describe("not the PR's branch", () => {
  test("feat/a merged while a feat-a worktree exists (same slug): untouched, the notice says why", async () => {
    const { wt, oid } = await branch("feat-a");
    const killed: string[] = [];
    expect(await watch([pr(20, "feat/a", oid)], { live: async () => ["worker-feat-a"], kill: async (_p, w) => { killed.push(w); } })(project)).toEqual([20]);
    expect(killed).toEqual([]);
    expect(existsSync(wt)).toBe(true);
    expect(await hasBranch(paths.repo(project), "feat-a")).toBe(true);
    expect(existsSync(paths.transcript(project, "worker-feat-a"))).toBe(true);
    expect((await inbox()).map((m) => m.text)).toEqual([`[agent-exit] worker-feat-a left running: pr #20 (feat/a) merged (${url(20)}); kept: worktree is on feat-a`]);
    expect(claimOf(20).outcome).toBe("kept: worktree is on feat-a");
    expect(await watch([pr(20, "feat/a", oid)])(project)).toEqual([]); // seen
  });

  test("a local commit not in the PR's head: everything kept, agents left running", async () => {
    const { wt, oid } = await branch("more");
    writeFileSync(join(wt, "later.txt"), "after the merge\n");
    await $`git -C ${wt} add . && git -C ${wt} commit -qm later`.quiet();
    const killed: string[] = [];
    expect(await watch([pr(21, "more", oid)], { live: async () => ["worker-more"], kill: async (_p, w) => { killed.push(w); } })(project)).toEqual([21]);
    expect(killed).toEqual([]);
    expect(existsSync(wt)).toBe(true);
    expect(await hasBranch(paths.repo(project), "more")).toBe(true);
    expect((await inbox()).map((m) => m.text)).toEqual([`[agent-exit] worker-more left running: pr #21 (more) merged (${url(21)}); kept: branch has commits not in the pr`]);
  });

  test("a PR head unknown locally is fetched from origin before comparing", async () => {
    const { wt } = await branch("remote-ahead");
    const other = join(home, `${project}-ahead`);
    await $`git clone -q -b remote-ahead ${origin} ${other}`.quiet();
    writeFileSync(join(other, "suggestion.txt"), "s\n");
    await $`git -C ${other} add . && git -C ${other} commit -qm suggestion && git -C ${other} push -q origin remote-ahead`.quiet();
    const head = await sh(other, "rev-parse", "HEAD");
    expect(await watch([pr(22, "remote-ahead", head)])(project)).toEqual([22]);
    expect(existsSync(wt)).toBe(false);
  });
});

describe("left alone", () => {
  test("a closed-not-merged PR, a branch with no PR and a fork's PR are untouched", async () => {
    // gh lists merged PRs only: #3 (closed, branch "closed") is not among them, "nopr" has none, #5 is from a fork.
    const wts = [(await branch("closed")).wt, (await branch("nopr")).wt];
    const fork = await branch("forked");
    const killed: string[] = [];
    const check = watch([pr(4, "elsewhere"), pr(5, "forked", fork.oid, { isCrossRepository: true })], {
      live: async () => ["worker-closed", "worker-nopr", "worker-forked"],
      kill: async (_p, w) => { killed.push(w); },
    });
    expect(await check(project)).toEqual([]);
    expect(killed).toEqual([]);
    for (const wt of [...wts, fork.wt]) expect(existsSync(wt)).toBe(true);
    expect(existsSync(claimFile(5))).toBe(false);
    expect(await inbox()).toEqual([]);
  });

  test("main, the checked-out branch, origin's default branch and the orchestrator are never touched", async () => {
    // origin's default is "trunk"; the clone has main checked out.
    const repo = paths.repo(project);
    await $`git -C ${repo} push -q origin main:trunk`.quiet();
    await $`git -C ${repo} fetch -q origin`.quiet();
    await $`git -C ${repo} remote set-head origin trunk`.quiet();
    mkdirSync(join(paths.project(project), "transcripts"), { recursive: true });
    for (const b of ["main", "trunk", "master"]) writeFileSync(paths.transcript(project, `worker-${b}`), "{}\n");
    const killed: string[] = [];
    const check = watch([pr(1, "main"), pr(2, "HEAD"), pr(3, "trunk"), pr(4, "master")], { live: async () => ["orchestrator", "worker-main", "worker-trunk"], kill: async (_p, w) => { killed.push(w); } });
    expect(await check(project)).toEqual([]);
    expect(killed).toEqual([]);
    for (const b of ["main", "trunk", "master"]) expect(existsSync(paths.transcript(project, `worker-${b}`))).toBe(true);
    expect(await inbox()).toEqual([]);
  });

  test("reused(): a worktree made after the merge is left alone, one made before it is handled", async () => {
    const { wt, oid } = await branch("again");
    expect(await watch([pr(5, "again", oid, { mergedAt: "2020-01-01T00:00:00Z" })], { kill: async () => { throw new Error("no"); } })(project)).toEqual([]);
    expect(existsSync(wt)).toBe(true);
    expect(claimOf(5).outcome).toBe("branch reused after the merge");
    expect(await inbox()).toEqual([]);

    const old = await branch("older");
    const made = new Date(Date.now() - 3600_000);
    utimesSync(join(old.wt, ".git"), made, made);
    expect(await watch([pr(6, "older", old.oid, { mergedAt: new Date(Date.now() - 60_000).toISOString() })])(project)).toEqual([6]);
    expect(existsSync(old.wt)).toBe(false);
  });

  test("a merged PR with nothing left of its branch is only marked seen, so a later branch of that name is safe", async () => {
    expect(await watch([pr(6, "later")])(project)).toEqual([]);
    expect(claimOf(6).outcome).toBe("nothing to do");
    const { wt } = await branch("later");
    expect(await watch([pr(6, "later")])(project)).toEqual([]);
    expect(existsSync(wt)).toBe(true);
    expect(await inbox()).toEqual([]);
  });

  test("tmux could not be asked: the check is skipped and retried later", async () => {
    const { wt, oid } = await branch("tm");
    let live: string[] | null = null;
    let t = 0;
    const check = watch([pr(11, "tm", oid)], { live: async () => live, now: () => t });
    expect(await check(project)).toEqual([]);
    expect(existsSync(wt)).toBe(true);
    live = [];
    t += MERGE_POLL_MS;
    expect(await check(project)).toEqual([11]);
  });

  test("an origin that is not on GitHub: gh is never asked", async () => {
    await branch("local");
    let asked = 0;
    const check = mergeWatcher({ gh: async () => { asked++; return [pr(1, "local")]; }, live: async () => [] });
    expect(await originRepo(project)).toBe(null); // the test origin is a local path
    expect(await check(project)).toEqual([]);
    expect(asked).toBe(0);
  });
});

describe("gh", () => {
  const fake = (body: string) => {
    const f = join(home, `gh-${n++}`);
    writeFileSync(f, `#!/bin/sh\n${body}\n`);
    chmodSync(f, 0o755);
    return f;
  };
  const OID = "a".repeat(40);

  test("lists merged PRs of origin's repo with the expected arguments", async () => {
    const log = join(home, `gh-args-${n}`);
    const ok = { number: 3, headRefName: "a", url: "u", mergedAt: "2024-01-01T00:00:00Z", headRefOid: OID, isCrossRepository: false };
    const bin = fake(`echo "$@" > ${log}\necho '${JSON.stringify([ok, { number: "x" }, { ...ok, headRefOid: "nope" }])}'`);
    expect(await ghMerged(home, "o/r", { bin })).toEqual([ok]);
    expect((await Bun.file(log).text()).trim()).toBe("pr list --repo o/r --state merged --limit 100 --json number,headRefName,url,mergedAt,headRefOid,isCrossRepository");
  });

  test("githubRepo reads GitHub urls only", () => {
    for (const u of ["https://github.com/o/r.git", "https://github.com/o/r", "https://x@github.com/o/r/", "git@github.com:o/r.git", "ssh://git@github.com/o/r.git", "ssh://git@github.com:22/o/r"]) expect(githubRepo(u)).toBe("o/r");
    for (const u of ["/tmp/repo.git", "https://gitlab.com/o/r.git", "git@gitlab.com:o/r.git", "https://github.com.evil.io/o/r", "https://github.com/o", "https://github.com/o/r/pulls"]) expect(githubRepo(u)).toBe(null);
  });

  test("missing, failing, garbled or hanging gh gives null", async () => {
    expect(await ghMerged(home, "o/r", { bin: join(home, "no-such-gh") })).toBe(null);
    expect(await ghMerged(home, "o/r", { bin: fake("echo 'not logged in' >&2; exit 1") })).toBe(null);
    expect(await ghMerged(home, "o/r", { bin: fake("echo not json") })).toBe(null);
    expect(await ghMerged(home, "o/r", { bin: fake("echo '{}'") })).toBe(null);
    const t = Date.now();
    expect(await ghMerged(home, "o/r", { bin: fake("exec sleep 10"), timeoutMs: 200 })).toBe(null);
    expect(Date.now() - t).toBeLessThan(3000);
    expect(await ghMerged(join(home, "no-such-dir"), "o/r", { bin: fake("echo []") })).toBe(null);
    const path = process.env.PATH;
    process.env.PATH = join(home, "empty-path");
    try {
      expect(await ghMerged(home, "o/r")).toBe(null);
    } finally {
      process.env.PATH = path;
    }
  });

  test("the watcher does nothing when gh fails or throws, and tries again later", async () => {
    const { wt, oid } = await branch("g");
    let t = 0;
    let mode: "null" | "throw" | "ok" = "null";
    const check = watch(() => { if (mode === "throw") throw new Error("boom"); return mode === "ok" ? [pr(12, "g", oid)] : null; }, { now: () => t });
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
    const { oid } = await branch("twice");
    const killed: string[] = [];
    const opts = { live: async () => ["worker-twice"], kill: async (_p: string, w: string) => { killed.push(w); } };
    const [a, b] = [watch([pr(13, "twice", oid)], opts), watch([pr(13, "twice", oid)], opts)];
    const results = await Promise.all([a(project), b(project)]);
    expect(results.flat()).toEqual([13]);
    // A restart: a fresh watcher sees the same merge again.
    expect(await watch([pr(13, "twice", oid)], opts)(project)).toEqual([]);
    expect(killed).toEqual(["worker-twice"]);
    expect(await inbox()).toHaveLength(1);
  });

  test("a crash between the claim and the notice: a fresh 'started' claim waits, a stale one is taken over once with its running list", async () => {
    const { wt, oid } = await branch("crashed");
    const started = { outcome: "started", ts: new Date().toISOString(), branch: "crashed", url: url(30), mergedAt: future(), running: ["worker-crashed", "reviewer-crashed"] };
    mkdirSync(join(paths.project(project), "merged"), { recursive: true });
    writeFileSync(claimFile(30), JSON.stringify(started));
    expect(await watch([pr(30, "crashed", oid)])(project)).toEqual([]);
    expect(existsSync(wt)).toBe(true);

    writeFileSync(claimFile(30), JSON.stringify({ ...started, ts: new Date(Date.now() - STALE_CLAIM_MS - 1000).toISOString() }));
    const [a, b] = [watch([pr(30, "crashed", oid)]), watch([pr(30, "crashed", oid)])];
    expect((await Promise.all([a(project), b(project)])).flat()).toEqual([30]);
    expect(existsSync(wt)).toBe(false);
    expect((await inbox()).map((m) => m.text)).toEqual([`[agent-exit] worker-crashed, reviewer-crashed stopped: pr #30 (crashed) merged (${url(30)}); cleaned up`]);
    expect(claimOf(30).outcome).toBe("handled");
    expect(await watch([pr(30, "crashed", oid)])(project)).toEqual([]);
  });

  test("a failed send after the stop keeps the claim, and the retry still names the agents that were running", async () => {
    const { oid } = await branch("unsent");
    // The orchestrator's inbox can't be written: a file where its folder should be.
    mkdirSync(paths.inbox(project), { recursive: true });
    writeFileSync(join(paths.inbox(project), "orchestrator"), "");
    const killed: string[] = [];
    let live = ["worker-unsent"];
    const opts = { live: async () => live, kill: async (_p: string, w: string) => { killed.push(w); live = []; } };
    expect(await watch([pr(31, "unsent", oid)], opts)(project)).toEqual([]);
    expect(killed).toEqual(["worker-unsent"]);
    expect(claimOf(31)).toMatchObject({ outcome: "started", running: ["worker-unsent"] });

    rmSync(join(paths.inbox(project), "orchestrator"));
    const c = claimOf(31);
    writeFileSync(claimFile(31), JSON.stringify({ ...c, ts: new Date(Date.now() - STALE_CLAIM_MS - 1000).toISOString() }));
    expect(await watch([pr(31, "unsent", oid)], opts)(project)).toEqual([31]);
    expect((await inbox()).map((m) => m.text)).toEqual([`[agent-exit] worker-unsent stopped: pr #31 (unsent) merged (${url(31)}); cleaned up`]);
  });

  test("polls don't overlap, and gh is asked about every MERGE_POLL_MS", async () => {
    let calls = 0;
    let release!: () => void;
    let t = 0;
    const gate = new Promise<void>((r) => { release = r; });
    const check = mergeWatcher({ gh: async () => { calls++; await gate; return []; }, repo: async () => "o/r", live: async () => [], now: () => t });
    const first = check(project);
    await until(() => calls === 1);
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
  expect(mergeNotice(p, [], true, "cleaned up, except: git push --delete: denied")).toBe(`[agent-exit] no agents running: pr #1 (b) merged (${p.url}); cleaned up, except: git push --delete: denied`);
  expect(mergeNotice(p, ["worker-b"], false, "kept: worktree is on c")).toBe(`[agent-exit] worker-b left running: pr #1 (b) merged (${p.url}); kept: worktree is on c`);
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

test("task merge archival precedes cleanup and live-window checks, retains registry even with cleanup blocked", async () => {
  const { registerTask, observeTaskPR, listTasks, getTask } = await import("./tasks");
  const task = await registerTask(project, { name: "Inbox", summary: "Implement registry", branch: "feat/data", authorized: true });
  const { oid } = await branch("feat/data");
  await observeTaskPR(project, task.id, { pr: { repository: "o/r", number: 901, url: url(901), head: oid }, branch: task.branch, state: "OPEN", checks: "unknown", ready: false });
  // Tmux unavailable means no cleanup; confirmed merge still archives the row.
  const check = watch([pr(901, task.branch, oid)], { live: async () => null, pr: async () => null });
  expect(await check(project)).toEqual([]);
  expect(await listTasks(project)).toEqual([]);
  expect((await getTask(project, task.id)).archive?.reason).toBe("merged");
  expect(existsSync(paths.worktree(project, slug(task.branch)))).toBe(true);
  // Fresh watcher after restart does not duplicate merge history.
  await watch([pr(901, task.branch, oid)], { live: async () => null, pr: async () => null })(project);
  expect((await getTask(project, task.id)).history.filter(e => e.kind === "merged")).toHaveLength(1);
});

test("task exact PR polling retains failed/unknown/closed rows and handles merges outside newest-100 list", async () => {
  const { registerTask, observeTaskPR, listTasks, getTask } = await import("./tasks");
  const task = await registerTask(project, { name: "Task", summary: "Test polling", branch: "feat/older", authorized: true });
  const identity = { repository: "o/r", number: 902, url: url(902), head: NO_OID };
  const observed = { pr: identity, branch: task.branch, state: "OPEN" as const, checks: "unknown" as const, ready: false };
  await observeTaskPR(project, task.id, observed);
  for (const gh of [async () => null, async () => [], async () => { throw new Error("network"); }]) {
    await mergeWatcher({ repo: async () => "o/r", gh, live: async () => [], pr: async () => null })(project);
    expect(await listTasks(project)).toHaveLength(1);
  }
  await watch([], { pr: async () => ({ ...observed, state: "CLOSED" }) })(project);
  expect((await getTask(project, task.id)).attention?.kind).toBe("closed");
  expect(await listTasks(project)).toHaveLength(1);
  await watch([], { pr: async () => ({ ...observed, state: "MERGED", mergedAt: future() }) })(project);
  expect(await listTasks(project)).toEqual([]); expect((await getTask(project, task.id)).archive).toBeDefined();
});

test("malformed/foreign merged lookup never removes task rows; unassociated newer task on same branch survives", async () => {
  const { registerTask, observeTaskPR, listTasks } = await import("./tasks");
  const task = await registerTask(project, { name: "Old", summary: "Older task", branch: "feat/shared", authorized: true });
  const next = await registerTask(project, { name: "Next", summary: "Newer task", branch: task.branch, authorized: true });
  await observeTaskPR(project, task.id, { pr: { repository: "o/r", number: 903, url: url(903), head: NO_OID }, branch: task.branch, state: "OPEN", checks: "unknown", ready: false });
  for (const extra of [{ url: "https://github.com/other/r/pull/903" }, { mergedAt: "" }, { isCrossRepository: true }]) {
    await watch([pr(903, task.branch, NO_OID, extra)], { live: async () => null, pr: async () => null })(project);
    expect(await listTasks(project)).toHaveLength(2);
  }
  await watch([pr(903, task.branch)], { live: async () => null, pr: async () => null })(project);
  expect((await listTasks(project)).map(t => t.id)).toEqual([next.id]);
});
