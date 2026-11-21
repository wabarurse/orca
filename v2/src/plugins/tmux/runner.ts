// The tmux runner: each conversation is a session `orca2-<conversation>` on orca2's own tmux server, each agent a
// window named after its id. Never the user's default server: a stale one whose cwd has gone opens every window with
// a broken cwd (tmux/tmux#5473), so the server is orca2's and starts from orca2's home.
import { join } from "node:path";
import { paths } from "../../config";
import type { Launch, Runner } from "../../core/plugins/types";
import { exec, sessionName, which, windowCommand, type Answer } from "./launch";

/** A unix socket path longer than this does not fit `sun_path`; tmux then uses a named socket instead. */
const SOCKET_MAX = 100;

/** The socket flags of orca2's tmux server. */
export function socketArgs(): string[] {
  const socket = join(paths.runtime, "tmux.sock");
  return Buffer.byteLength(socket) <= SOCKET_MAX ? ["-S", socket] : ["-L", "orca2"];
}

async function tmux(args: string[]): Promise<Answer | null> {
  const bin = which("tmux");
  return bin === null ? null : exec([bin, ...socketArgs(), ...args]);
}
/** The session (or the whole server) does not exist, as opposed to tmux failing to answer. */
const gone = (err: string): boolean => /can't find session|no server running|error connecting|no such file|session not found/i.test(err);
const failed = (what: string, res: Answer | null): Error => new Error(`tmux ${what} failed: ${res === null ? "tmux did not run" : res.err.trim() || `exit ${res.code}`}`);

/** Open the agent's window, creating the session with it when there is none; returns the pane id. */
async function openWindow(launch: Launch, argv: string[]): Promise<string> {
  const session = sessionName(launch.conversation);
  const common = ["-n", launch.agent, "-c", launch.cwd, "-P", "-F", "#{pane_id}", "--", ...argv];
  const has = await tmux(["has-session", "-t", `=${session}`]);
  let res = has?.code === 0 ? null : await tmux(["new-session", "-d", "-s", session, ...common]);
  if (res === null || (res.code !== 0 && /duplicate session/i.test(res.err))) res = await tmux(["new-window", "-d", "-t", `=${session}:`, ...common]);
  const pane = res?.code === 0 ? res.out.trim() : "";
  if (!pane.startsWith("%")) throw failed("new-window", res);
  return pane;
}

export const tmuxRunner: Runner = {
  name: "tmux",
  async start(launch) {
    const command = await windowCommand(launch);
    try { return { handle: await openWindow(launch, command.argv), pid: null }; }
    catch (error) { await command.cleanup(); throw error; }
  },
  async alive(conversation) {
    const res = await tmux(["list-windows", "-t", `=${sessionName(conversation)}`, "-F", "#{window_name}"]);
    if (res === null) return null;
    if (res.code !== 0) return gone(res.err) ? [] : null;
    return [...new Set(res.out.split("\n").map(l => l.trim()).filter(l => l.length > 0))];
  },
  async stop(conversation, agent) {
    await tmux(["kill-window", "-t", `=${sessionName(conversation)}:=${agent}`]);
  },
};
