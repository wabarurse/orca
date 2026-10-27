import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindingOption, interruptBinding, interruptClient, interruptExactRun, type InterruptTarget, type TmuxQuery } from "./interrupt";

const target = (): InterruptTarget => ({ project: "test", task: "task", branch: "feat/exact", agent: "worker-feat-exact", run: crypto.randomUUID(), token: crypto.randomUUID(), pane: "%1", pid: 123 });

test("exact identity, uncertain transport, and bounded observation", async () => {
  const t = target();
  const commands: string[][] = [];
  const r = await interruptExactRun(t, async args => { commands.push(args); return commands.length === 1 ? "sent" : "exited"; });
  expect(r.status).toBe("agent-exited-cleanup-unverified");
  expect(r.warning).toContain("hard-kill");
  expect(r.warning).toContain("Retain branch ownership");
  expect(commands[0]!.join(" ")).toContain(interruptBinding(t));
  expect(commands[0]!.slice(0, 4)).toEqual(["if-shell", "-F", "-t", "%1"]);
  expect((await interruptExactRun(t, async () => null)).status).toBe("unknown");
  expect((await interruptExactRun(t, async () => { throw Error("offline"); })).status).toBe("unknown");
  expect((await interruptExactRun(t, async () => "sent", 0)).status).toBe("unknown");
  expect((await interruptExactRun(t, async args => args[0] === "if-shell" ? "sent" : "running", 20)).status).toBe("still-running");
  for (const field of ["project", "task", "branch", "agent", "run", "token"] as const) {
    expect(interruptBinding({ ...t, [field]: field === "token" ? crypto.randomUUID() : "other" })).not.toBe(interruptBinding(t));
  }
  expect(() => interruptBinding({ ...t, pane: "%1 ; kill-server" })).toThrow();
});

test("wall-clock jumps do not change observation deadline or clipped query budget", async () => {
  const wall = spyOn(Date, "now").mockReturnValue(1_000_000);
  const monotonic = spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValueOnce(105).mockReturnValueOnce(140);
  const budgets: number[] = [];
  try {
    const result = await interruptExactRun(target(), async (args, budget) => {
      budgets.push(budget);
      wall.mockReturnValue(args[0] === "if-shell" ? -1_000_000 : 9_000_000);
      return args[0] === "if-shell" ? "sent" : "running";
    }, 50);
    expect(result.status).toBe("still-running");
    expect(budgets).toEqual([1000, 45]);
    expect(wall).not.toHaveBeenCalled();
  } finally { wall.mockRestore(); monotonic.mockRestore(); }
});

async function teardown(query: TmuxQuery, dir: string): Promise<void> {
  // A failed/ambiguous kill must leave the socket and recovery metadata intact.
  if (await query(["kill-server"], 2000).catch(() => null) === null) {
    throw Error(`fixture kill-server unconfirmed; recovery directory retained: ${dir}`);
  }
  rmSync(dir, { recursive: true, force: true });
}

test("fixture teardown retains recovery data on null/error and removes only on success", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orca-int-teardown-"));
  const recovery = join(dir, "recovery.json");
  writeFileSync(recovery, "no server; simulated teardown");
  try {
    for (const query of [async () => null, async () => { throw Error("transport failure"); }]) {
      await expect(teardown(query, dir)).rejects.toThrow(`recovery directory retained: ${dir}`);
      expect(existsSync(recovery)).toBe(true);
    }
    await teardown(async () => "", dir);
    expect(existsSync(dir)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); } // no real server in this test
});

test("isolated tmux: Ctrl+C exit, ignored INT, stale run/PID, missing pane and respawn", async () => {
  // Never attach to or discover a real agent session. No default socket fallback.
  if (!Bun.which("tmux")) throw Error("tmux required for disposable interrupt fixture");
  const dir = mkdtempSync(join(tmpdir(), "orca-int-"));
  const argv = ["tmux", "-S", join(dir, "s"), "-f", "/dev/null"];
  writeFileSync(join(dir, "recovery.json"), JSON.stringify({ argv, session: "fixture" }));
  const query = interruptClient(argv);
  const cmd = async (...args: string[]) => {
    const out = await query(args, 2000);
    if (out === null) throw Error(`fixture tmux failed: ${args[0]}`);
    return out;
  };
  const launch = async (ignore = false) => {
    const script = `process.on('SIGINT',()=>{${ignore ? "" : "process.exit(0)"}}); console.log('READY'); setInterval(()=>{},1000)`;
    const command = `exec '${process.execPath.replaceAll("'", "'\\''")}' -e '${script.replaceAll("'", "'\\''")}'`;
    const line = await cmd("new-window", "-d", "-P", "-F", "#{pane_id} #{pane_pid}", "-t", "fixture", command);
    const [pane, pid] = line.split(" ");
    const t = { ...target(), pane: pane!, pid: Number(pid) };
    await cmd("set-option", "-p", "-t", t.pane, bindingOption, interruptBinding(t));
    for (let i = 0; i < 80; i++) {
      if ((await cmd("capture-pane", "-p", "-t", t.pane)).includes("READY")) return { t, command };
      await Bun.sleep(25);
    }
    throw Error("fixture not ready");
  };
  try {
    await cmd("new-session", "-d", "-s", "fixture", "sleep 60");
    await cmd("set-option", "-g", "remain-on-exit", "on");
    const exiting = await launch();
    expect((await interruptExactRun(exiting.t, query, 1500)).status).toBe("agent-exited-cleanup-unverified");
    expect((await interruptExactRun(exiting.t, query)).status).toBe("agent-exited-cleanup-unverified");
    const ignored = await launch(true);
    expect((await interruptExactRun(ignored.t, query, 100)).status).toBe("still-running");
    const fresh = await launch();
    expect((await interruptExactRun({ ...fresh.t, run: "old-run" }, query)).status).toBe("unknown");
    expect((await interruptExactRun({ ...fresh.t, pid: fresh.t.pid + 1 }, query)).status).toBe("unknown");
    expect(await cmd("display-message", "-p", "-t", fresh.t.pane, "#{pane_dead}")).toBe("0");
    // tmux retains user options across respawn! PID check rejects this reuse;
    // activation must prohibit respawn, since eventual PID reuse is possible.
    await cmd("respawn-pane", "-k", "-t", exiting.t.pane, exiting.command);
    expect((await interruptExactRun(exiting.t, query)).status).toBe("unknown");
    expect((await interruptExactRun({ ...fresh.t, pane: "%999999" }, query)).status).toBe("unknown");
  } finally {
    // Teardown only disposable test processes; not implementation escalation.
    await teardown(query, dir);
  }
}, 15_000);
