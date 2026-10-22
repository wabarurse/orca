import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

// config.ts reads PARALLELS_HOME at import time, so set it before importing the runner.
const home = mkdtempSync(join(tmpdir(), "parallels-runner-"));
process.env.PARALLELS_HOME = home;
const { paths } = await import("./config");
const { local, ensureWorktree, removeWorktree, tmux, sessionName, agentCommand, slug } = await import("./runner");

const project = `rt-${process.pid}`;
const repo = paths.repo(project);
const hasTmux = Bun.which("tmux") !== null;

beforeAll(async () => {
  await $`mkdir -p ${repo}`.quiet();
  await $`git -C ${repo} init -q -b main`.quiet();
  await $`git -C ${repo} -c user.name=t -c user.email=t@t commit -q --allow-empty -m init`.quiet();
});

/** Wait until no agent process of this test's project is left (sh wrapper, agent, agent-exit), so nothing writes into home after it is removed. */
async function agentsGone(): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await $`pgrep -f -- ${project}`.quiet().nothrow()).exitCode !== 0) return;
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
  expect(cmd.slice(3)).toEqual(["sh", home, "p", "worker", "feat/b", "r1", process.execPath, expect.stringMatching(/cli\.ts$/)]);
  expect(cmd[2]).toContain(`agent --project "$project" --role "$role" --branch "$branch" --run "$run"`);
  expect(cmd[2]).toContain("0|70) ;;");
  expect(cmd[2]).not.toContain(home);
  expect(slug("feat/b c")).toBe("feat-b-c");
  const orch = agentCommand({ project: "p", role: "orchestrator" }, "r1");
  expect(orch).toEqual(["env", `PARALLELS_HOME=${home}`, process.execPath, expect.stringMatching(/cli\.ts$/), "agent", "--project", "p", "--role", "orchestrator"]);
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

  test("start for the orchestrator runs in repo/ and reuses the session", async () => {
    await local.start({ project, role: "orchestrator" });
    expect(await tmux.hasSession(session)).toBe(true);
    expect(existsSync(paths.worktree(project, "orchestrator"))).toBe(false);
  });
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
