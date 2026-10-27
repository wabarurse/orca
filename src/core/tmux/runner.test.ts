import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

// config.ts reads ORCA_HOME at import time, so set it before importing the runner.
const home = mkdtempSync(join(tmpdir(), "orca-runner-"));
process.env.ORCA_HOME = home;
const { paths } = await import("../../config/config");
const { local, ensureWorktree, removeWorktree, tmux, tmuxSocket, confirmLaunch, LaunchFailed, sessionName, agentCommand, slug } = await import("./runner");
const { beginRun, claim, claimed, readRun } = await import("./exits");
const { launchIdentity } = await import("./cancellation");
const { pending } = await import("../data/inbox/inbox");
const { daemonPid, readStatus } = await import("../agent-loop/orc/channel");
const { ensureDaemon, stopDaemon } = await import("../agent-loop/orc/client");

const project = `rt-${process.pid}`;
const repo = paths.repo(project);
const hasTmux = Bun.which("tmux") !== null;

beforeAll(async () => {
  await $`mkdir -p ${repo}`.quiet();
  await $`git -C ${repo} init -q -b main`.quiet();
  await $`git -C ${repo} -c user.name=t -c user.email=t@t commit -q --allow-empty -m init`.quiet();
});

/** Wait until no agent process of this test's project is left (sh wrapper, agent, agent-exit), so nothing writes into home after it is removed.
 * The project id follows a space in their argv; orca's tmux server (started by `new-session -s orca-<project>`) is not an agent. */
async function agentsGone(): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await $`pgrep -f -- ${" " + project}`.quiet().nothrow()).exitCode !== 0) return;
    await Bun.sleep(50);
  }
  throw new Error("agent processes still running");
}

afterAll(async () => {
  if (hasTmux) {
    await tmux.killSession(sessionName(project));
    await agentsGone();
  }
  rmSync(home, { recursive: true, force: true });
});

async function branchOf(dir: string): Promise<string> {
  return (await $`git -C ${dir} rev-parse --abbrev-ref HEAD`.quiet().text()).trim();
}

describe("worktrees", () => {
  test("ensureWorktree creates a new branch from HEAD and reuses the checkout", async () => {
    const dir = await ensureWorktree(project, "task/t1");
    expect(dir).toBe(paths.worktree(project, "task-t1"));
    expect(existsSync(join(dir, ".git"))).toBe(true);
    expect(await branchOf(dir)).toBe("task/t1");
    // Second call (the reviewer) reuses the same worktree.
    expect(await ensureWorktree(project, "task/t1")).toBe(dir);
    await removeWorktree(project, "task/t1");
    expect(existsSync(dir)).toBe(false);
  });

  test("ensureWorktree checks out an existing branch", async () => {
    await $`git -C ${repo} branch task/t2`.quiet();
    const dir = await ensureWorktree(project, "task/t2");
    expect(await branchOf(dir)).toBe("task/t2");
    await removeWorktree(project, "task/t2");
  });

  test("removeWorktree is a no-op when nothing exists", async () => {
    await removeWorktree(project, "nope");
  });
});

test("agentCommand is an argv: workers run the fixed sh -c wrapper with values as parameters", () => {
  const cmd = agentCommand({ project: "p", role: "worker", branch: "feat/b" }, "r1");
  expect(cmd.slice(0, 2)).toEqual(["sh", "-c"]);
  expect(cmd.slice(3)).toEqual(["sh", home, "p", "worker", "feat/b", "r1", process.execPath, expect.stringMatching(/cli\/main\.ts$/)]);
  expect(cmd[2]).toContain(`agent --project "$project" --role "$role" --branch "$branch" --run "$run"`);
  expect(cmd[2]).toContain("0|70) ;;");
  expect(cmd[2]).not.toContain(home);
  expect(slug("feat/b c")).toBe("feat-b-c");
  // The orchestrator daemon runs under the same wrapper with an empty branch and the launch's run id, so it is supervised like a worker.
  const orch = agentCommand({ project: "p", role: "orchestrator" }, "r1");
  expect(orch.slice(0, 2)).toEqual(["sh", "-c"]);
  expect(orch.slice(3)).toEqual(["sh", home, "p", "orchestrator", "", "r1", process.execPath, expect.stringMatching(/cli\/main\.ts$/)]);
});

describe.skipIf(!hasTmux)("tmux", () => {
  const session = sessionName(project);

  test("start for a worker creates the worktree, session and window; stop removes them", async () => {
    await local.start({ project, role: "worker", branch: "task/t3" });
    const dir = paths.worktree(project, "task-t3");
    expect(await branchOf(dir)).toBe("task/t3");
    expect(await tmux.hasSession(session)).toBe(true);

    // The agent window may exit quickly (agent loop not implemented yet), so
    // check windowing with a long-lived command instead of the real one.
    await tmux.openWindow(session, "reviewer-task-t3", dir, "sleep 60");
    expect(await tmux.listWindows(session)).toContain("reviewer-task-t3");

    await local.stop(project, "task/t3");
    await agentsGone();
    expect(existsSync(dir)).toBe(false);
    expect((await tmux.listWindows(session)).some((w) => w.endsWith("-task-t3"))).toBe(false);
    expect(await tmux.hasSession(session)).toBe(true);
  });

  test("start for the orchestrator launches the supervised daemon, confirmed by its run record; stopDaemon ends it cleanly without a notice", async () => {
    await local.start({ project, role: "orchestrator" });
    const state = await readRun(project, "orchestrator");
    expect(state?.role).toBe("orchestrator");
    expect(state?.run).toBe(launchIdentity(project, "orchestrator")!);
    expect(await tmux.listWindows(session)).toContain("orchestrator");
    const pid = await daemonPid(project);
    expect(pid).toBe(state!.pid);
    expect(await ensureDaemon(project)).toBe("running"); // a second TUI finds it, never a second daemon
    await stopDaemon(project);
    expect(await daemonPid(project)).toBeUndefined();
    expect(readStatus(project)?.state).toBe("stopped");
    expect(claimed(project, "orchestrator", state!.run)).toBe(true); // its own close: no [agent-exit] notice
    expect(await pending(project, "orchestrator")).toBe(false);
    const deadline = Date.now() + 5000;
    while ((await tmux.listWindows(session)).includes("orchestrator") && Date.now() < deadline) await Bun.sleep(50);
    expect(await tmux.listWindows(session)).not.toContain("orchestrator");
  });

  test("confirmLaunch: a window that dies before writing its run record fails the launch, keeps the last output, kills the pane and closes the run", async () => {
    const pane = await tmux.openWindow(session, "worker-dead", repo, ["sh", "-c", "echo boom; echo 'cannot start' >&2; exit 3"]);
    expect(pane).toMatch(/^%\d+$/);
    const error = await confirmLaunch(project, "worker-dead", "run-dead", pane, true).catch((e) => e);
    expect(error).toBeInstanceOf(LaunchFailed);
    expect(error.message).toBe("worker-dead exited (code 3) before the agent started; last output:\nboom\ncannot start");
    expect(error.pane).toEqual({ dead: true, status: 3, signal: "" });
    expect(error.reported).toBe(true);
    expect(await tmux.pane(pane)).toBe(null);
    expect(await tmux.listWindows(session)).not.toContain("worker-dead");
    expect(claimed(project, "worker-dead", "run-dead")).toBe(true);
  });

  test("confirmLaunch: when the run was closed by someone else first, the failure says the notice is already in the inbox", async () => {
    const pane = await tmux.openWindow(session, "worker-told", repo, ["sh", "-c", "exit 4"]);
    expect(await claim(project, "worker-told", "run-told")).toBe(true);
    const error = await confirmLaunch(project, "worker-told", "run-told", pane, true).catch((e) => e);
    expect(error).toBeInstanceOf(LaunchFailed);
    expect(error.reported).toBe(false);
    expect(error.message).toBe("worker-told exited (code 4) before the agent started; its exit notice is already in your inbox; no output");
    expect(await tmux.pane(pane)).toBe(null);
  });

  test("confirmLaunch: cancelled while waiting closes the run and kills the pane, so nothing keeps running", async () => {
    const pane = await tmux.openWindow(session, "worker-cancel", repo, "sleep 60");
    const controller = new AbortController();
    const pending = confirmLaunch(project, "worker-cancel", "run-cancel", pane, true, controller.signal, 10_000);
    await Bun.sleep(150);
    controller.abort(new Error("cancelled by user"));
    await expect(pending).rejects.toThrow("cancelled by user");
    expect(await tmux.pane(pane)).toBe(null);
    expect(await tmux.listWindows(session)).not.toContain("worker-cancel");
    expect(claimed(project, "worker-cancel", "run-cancel")).toBe(true);
  });

  test("the server's global remain-on-exit keeps a window that dies at once, and the server runs from the state root, not a checkout", async () => {
    expect(Bun.spawnSync(tmux.argv("show-options", "-g", "-v", "remain-on-exit")).stdout.toString().trim()).toBe("on");
    const pid = Bun.spawnSync(tmux.argv("display-message", "-p", "#{pid}")).stdout.toString().trim();
    const cwd = Bun.spawnSync(["lsof", "-a", "-p", pid, "-d", "cwd", "-Fn"]).stdout.toString().match(/^n(.*)$/m)?.[1];
    if (cwd !== undefined) expect(cwd).toBe(realpathSync(home));
  });

  test("confirmLaunch: the run record for this run id is the evidence; then the pane no longer stays on exit", async () => {
    const pane = await tmux.openWindow(session, "worker-ok", repo, "sleep 60");
    const show = () => Bun.spawnSync(tmux.argv("display-message", "-p", "-t", pane, "#{remain-on-exit}")).stdout.toString().trim();
    expect(show()).toBe("on");
    await beginRun({ project, id: "worker-ok", run: "old-run", role: "worker", branch: "ok", cwd: repo }, 1);
    const pending = confirmLaunch(project, "worker-ok", "new-run", pane, true, undefined, 3000);
    await Bun.sleep(300);
    expect(show()).toBe("on"); // another run's record is not evidence
    await beginRun({ project, id: "worker-ok", run: "new-run", role: "worker", branch: "ok", cwd: repo }, process.pid);
    await pending;
    expect(show()).toBe("off");
    expect(await tmux.pane(pane)).toEqual({ dead: false, status: null, signal: "" });
    await tmux.killWindow(session, "worker-ok");
  });

  test("confirmLaunch: a pane still running at the deadline passes (a slow start is not a failure)", async () => {
    const pane = await tmux.openWindow(session, "worker-slow", repo, "sleep 60");
    await confirmLaunch(project, "worker-slow", "r", pane, true, undefined, 200);
    expect(await tmux.listWindows(session)).toContain("worker-slow");
    await tmux.killWindow(session, "worker-slow");
  });

  test("checkServer passes on a working server", async () => {
    await tmux.checkServer();
  });
});

test("every tmux call uses orca's own socket under ORCA_HOME, or -L orca when that path is too long", () => {
  expect(tmuxSocket()).toEqual(["-S", join(home, ".runtime", "tmux.sock")]);
  expect(tmux.argv("list-windows", "-t", "=s")).toEqual(["tmux", "-S", join(home, ".runtime", "tmux.sock"), "list-windows", "-t", "=s"]);
  const previous = process.env.ORCA_HOME;
  process.env.ORCA_HOME = join(tmpdir(), "x".repeat(120));
  try { expect(tmuxSocket()).toEqual(["-L", "orca"]); }
  finally { process.env.ORCA_HOME = previous; }
});

test("checkServer explains a server that cannot run commands and points at kill-server", async () => {
  const bin = mkdtempSync(join(home, "bin-"));
  writeFileSync(join(bin, "tmux"), `#!/bin/sh\necho "pwd: Operation not permitted" >&2\nexit 1\n`);
  chmodSync(join(bin, "tmux"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    const error = await tmux.checkServer().catch((e) => e);
    expect(error.message).toBe(`runner: the orca tmux server cannot run commands (pwd: Operation not permitted); its working directory is probably gone or not permitted. Stop it with \`tmux -S ${join(home, ".runtime", "tmux.sock")} kill-server\` (this also stops every agent on it) and spawn again`);
  } finally {
    process.env.PATH = path;
  }
});

test("local.running is null when tmux cannot be asked", async () => {
  const path = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    expect(await local.running("p", ["worker-x"])).toBe(null);
  } finally {
    process.env.PATH = path;
  }
});
