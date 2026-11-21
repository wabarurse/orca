import { join } from "node:path";
import { fail, ok, paths, type Result } from "../../config";
import { exec, launchCommand, which, type Answer, type Launch, type Runner } from "../../core/plugins";
import { settled } from "../../core/tools/registry";

const SOCKET_MAX = 100;

export const sessionName = (conversation: string): string => `orca2-${conversation}`;

export function socketArgs(): string[] {
  const socket = join(paths.runtime, "tmux.sock");
  return Buffer.byteLength(socket) <= SOCKET_MAX ? ["-S", socket] : ["-L", "orca2"];
}

async function tmux(args: string[]): Promise<Result<Answer>> {
  const bin = which("tmux");
  return bin === null ? fail("tmux is not installed") : exec([bin, ...socketArgs(), ...args]);
}

const gone = (err: string): boolean => /can't find session|no server running|error connecting|no such file|session not found/i.test(err);

function failed(what: string, res: Result<Answer>): string {
  if (!res.ok) return `tmux ${what} failed: ${res.error}`;
  const err = res.data.err.trim();
  return `tmux ${what} failed: ${err.length > 0 ? err : `exit ${res.data.code}`}`;
}

async function openWindow(launch: Launch, argv: string[]): Promise<Result<string>> {
  const session = sessionName(launch.conversation);
  const common = ["-n", launch.agent, "-c", launch.cwd, "-P", "-F", "#{pane_id}", "--", ...argv];
  const has = await tmux(["has-session", "-t", `=${session}`]);
  const exists = has.ok && has.data.code === 0;
  const created = exists ? null : await tmux(["new-session", "-d", "-s", session, ...common]);
  const retry = created === null || !created.ok || (created.data.code !== 0 && /duplicate session/i.test(created.data.err));
  const res = retry ? await tmux(["new-window", "-d", "-t", `=${session}:`, ...common]) : created;
  const pane = res.ok && res.data.code === 0 ? res.data.out.trim() : "";
  return pane.startsWith("%") ? ok(pane) : fail(failed("new-window", res));
}

export const tmuxRunner: Runner = {
  name: "tmux",
  async start(launch) {
    const command = await launchCommand(launch);
    const pane = await openWindow(launch, command.argv);
    if (!pane.ok) await command.cleanup();
    return { handle: settled(pane), pid: null };
  },
  async alive(conversation) {
    const res = await tmux(["list-windows", "-t", `=${sessionName(conversation)}`, "-F", "#{window_name}"]);
    if (!res.ok) return null;
    if (res.data.code !== 0) return gone(res.data.err) ? [] : null;
    return [...new Set(res.data.out.split("\n").map(l => l.trim()).filter(l => l.length > 0))];
  },
  async stop(conversation, agent) {
    await tmux(["kill-window", "-t", `=${sessionName(conversation)}:=${agent}`]);
  },
};
