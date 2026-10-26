import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindingOption, interruptBinding, interruptClient, interruptExactRun, type InterruptTarget } from "./interrupt";

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

test("isolated tmux: Ctrl+C exit, ignored INT, stale run/PID, missing pane and respawn", async () => {
  // Never attach to or discover a real agent session. No default socket fallback.
  if (!Bun.which("tmux")) throw Error("tmux required for disposable interrupt fixture");
  const dir = mkdtempSync(join(tmpdir(), "orca-int-"));
  const query = interruptClient(["tmux", "-S", join(dir, "s"), "-f", "/dev/null"]);
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
    await query(["kill-server"], 2000);
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);
