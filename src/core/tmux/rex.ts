// Rex (superlogical.com/rex), the terminal multiplexer agents run in instead of tmux when config.toml says
// `mux = "rex"` (/mux). The same operations as runner.ts's `tmux`, over the rex CLI. A project's agents are windows
// of one Rex session labelled `orca-<project>`, so they show in Rex's session list beside the user's own; each window
// holds one block labelled with the agent id, and the window carries the same label. Blocks open with --keep-open:
// one that dies keeps its screen for the launch check (tmux's remain-on-exit), and a finished agent's last output
// stays readable until its next launch closes it. Every call passes --autostart=false, so asking about Rex never
// starts a Rex server; no server running means nothing runs in Rex.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../../config";
import { run, type ProcResult } from "../proc";

/** Where Rex.app keeps its CLI, for a process that did not start inside Rex (no REX_BIN_DIR) and has no `rex` on PATH. */
const APP_CLI = "/Applications/Rex.app/Contents/Helpers/Rex Server.rex/Contents/MacOS/rex";

/** The rex CLI: the one of the Rex terminal orca runs in, then PATH, then Rex.app's; null when Rex is not installed. */
export function rexBinary(): string | null {
  const dir = process.env.REX_BIN_DIR;
  if (dir && existsSync(join(dir, "rex"))) return join(dir, "rex");
  return Bun.which("rex") ?? (existsSync(APP_CLI) ? APP_CLI : null);
}

/** Written when orca first opens a Rex session in this home: until then nothing of orca's runs in Rex, so the
 * checks that look at both multiplexers skip Rex (and never ask a Rex server that has nothing of orca's). */
const marker = () => join(paths.runtime, "rex-used");
/** Whether orca may have agents in Rex: it is installed and orca has opened a session there. */
export const rexInUse = () => existsSync(marker()) && rexBinary() !== null;

/** A block's state as tmux reports a pane's (runner.ts PaneState). */
export interface BlockState { dead: boolean; status: number | null; signal: string }
/** One block of a session: its label, window and whether its program still runs. */
export interface Block { id: string; label: string; window: string; windowLabel: string; live: boolean; cwd: string; command: string }

type Answer = { ok: true; out: string } | { ok: false; gone: boolean; err: string };
/** Run the rex CLI. `gone`: the target (or the whole server) does not exist, as opposed to a failure to ask. */
async function rex(args: string[], signal?: AbortSignal, timeoutMs = 10_000): Promise<Answer> {
  const bin = rexBinary();
  if (!bin) return { ok: false, gone: true, err: "rex is not installed" };
  const res: ProcResult | null = await run([bin, "--autostart=false", ...args], { cwd: paths.root, timeoutMs, signal });
  if (!res) return { ok: false, gone: false, err: "rex did not answer" };
  if (res.code === 0) return { ok: true, out: res.out };
  const err = res.err.trim() || `exit ${res.code}`;
  return { ok: false, gone: /no Rex server is running|not found/i.test(err), err };
}
const json = <T>(text: string): T | null => { try { return JSON.parse(text) as T; } catch { return null; } };

interface Process { child?: { cwd?: string; name?: string; argv0?: string } | null; last_exit?: { exit_code: number; error: string } | null }
interface WindowList { windows: { window_id: string; label: string; layers: { blocks: { block_id: string; label: string }[] }[] }[] }

/** The session's id by its label: null when no such session (or no server), undefined when Rex could not be asked. */
async function sessionId(label: string, signal?: AbortSignal): Promise<string | null | undefined> {
  const res = await rex(["ls", "--json"], signal);
  if (!res.ok) return res.gone ? null : undefined;
  const list = json<{ sessions: { session_id: string; label: string }[] }>(res.out);
  if (!list) return undefined;
  return list.sessions.find(s => s.label === label)?.session_id ?? null;
}

/** A block's program, from `block call process`: null when the block is gone, undefined when Rex could not be asked. */
async function processOf(block: string, signal?: AbortSignal): Promise<Process | null | undefined> {
  const res = await rex(["block", "call", "-b", block, "process"], signal);
  if (!res.ok) return res.gone ? null : undefined;
  return json<Process>(res.out) ?? undefined;
}

const stateOf = (p: Process): BlockState => {
  if (p.child || !p.last_exit) return { dead: false, status: null, signal: "" };
  const signal = /^signal: (.+)$/.exec(p.last_exit.error)?.[1] ?? "";
  return { dead: true, status: p.last_exit.exit_code >= 0 ? p.last_exit.exit_code : null, signal };
};

/** Every block of the session with a label, as listed now; [] when the session is gone, null when Rex could not be asked. */
async function blocksOf(sid: string, signal?: AbortSignal): Promise<Block[] | null> {
  const res = await rex(["window", "ls", "-s", sid, "--json"], signal);
  if (!res.ok) return res.gone ? [] : null;
  const list = json<WindowList>(res.out);
  if (!list) return null;
  const blocks: Block[] = [];
  for (const window of list.windows) for (const layer of window.layers) for (const block of layer.blocks) {
    const p = await processOf(block.block_id, signal);
    if (p === undefined) return null;
    blocks.push({ id: block.block_id, label: block.label, window: window.window_id, windowLabel: window.label, live: !!p?.child,
      cwd: p?.child?.cwd ?? "", command: p?.child?.argv0 ?? p?.child?.name ?? "" });
  }
  return blocks;
}

async function sessionBlocks(session: string, signal?: AbortSignal): Promise<Block[] | null> {
  const sid = await sessionId(session, signal);
  if (sid === undefined) return null;
  return sid === null ? [] : blocksOf(sid, signal);
}

/** The labels orca gives its blocks (runner.ts windowName) and the idle shell's; blocks agents open have others. */
const AGENT_LABEL = /^(shell|orchestrator|worker(-.+)?|reviewer(-.+)?)$/;
const fail = (what: string, res: Answer): never => { throw new Error(`runner: rex ${what} failed: ${res.ok ? "unexpected output" : res.err}`); };

export const rexMux = {
  /** Create the project's session when missing; its first window is an idle shell (labelled "shell", like tmux's). */
  async ensureSession(session: string, cwd: string, signal?: AbortSignal): Promise<void> {
    const sid = await sessionId(session, signal);
    if (sid) return;
    if (sid === undefined) throw new Error("runner: rex could not list its sessions; is Rex running?");
    mkdirSync(paths.runtime, { recursive: true });
    writeFileSync(marker(), "");
    const res = await rex(["new", session, "-c", cwd, "--window", "shell", "--json"], signal);
    if (!res.ok) fail("new", res);
  },

  /** Rex must be installed and its server running: a launch never starts one. */
  async checkServer(signal?: AbortSignal): Promise<void> {
    if (!rexBinary()) throw new Error("runner: Rex is not installed; switch back with /mux tmux");
    const res = await rex(["ls", "-q"], signal);
    if (!res.ok) throw new Error(`runner: Rex is not answering (${res.err}); open Rex or switch back with /mux tmux`);
  },

  /**
   * Open a window labelled `name` in the session, its one block running `commandLine` in `cwd` (an argv runs directly,
   * a string through /bin/sh). A dead block of the same agent left from its last run is closed first. Returns the block id.
   */
  async openWindow(session: string, name: string, cwd: string, commandLine: string | string[], signal?: AbortSignal): Promise<string> {
    const sid = await sessionId(session, signal);
    if (!sid) throw new Error(`runner: rex session ${session} not found`);
    for (const block of await blocksOf(sid, signal) ?? []) if (block.label === name && !block.live) await rex(["block", "close", block.id], signal);
    const argv = typeof commandLine === "string" ? ["/bin/sh", "-c", commandLine] : commandLine;
    const res = await rex(["run", "-s", sid, "--label", name, "-c", cwd, "--keep-open", "--focus=false", "--shell=none", "--json", "--", ...argv], signal);
    if (!res.ok) return fail("run", res);
    const made = json<{ window_id?: string; block_ids?: string[] }>(res.out);
    const block = made?.block_ids?.[0];
    if (!block?.startsWith("block:")) return fail("run", { ok: true, out: res.out });
    if (made?.window_id) await rex(["window", "rename", "-s", sid, made.window_id, name], signal);
    return block;
  },

  /** Whether the block's program exited, and how; null when the block is gone or Rex could not be asked. */
  async pane(block: string, signal?: AbortSignal): Promise<BlockState | null> {
    const p = await processOf(block, signal);
    return p ? stateOf(p) : null;
  },

  /** The block's screen and scrollback as plain text; "" when it cannot be read. */
  async capture(block: string, signal?: AbortSignal): Promise<string> {
    const res = await rex(["capture", "-b", block, "--trim", "--unwrap"], signal);
    return res.ok ? res.out : "";
  },

  async killPane(block: string): Promise<void> {
    await rex(["block", "close", block]);
  },

  /** Labels of the session's orca blocks whose program still runs: [] when the session or server is gone, null when unknown. */
  async windows(session: string, signal?: AbortSignal): Promise<string[] | null> {
    const blocks = await sessionBlocks(session, signal);
    return blocks && [...new Set(blocks.filter(b => b.live && AGENT_LABEL.test(b.label)).map(b => b.label))];
  },

  /** The session's blocks by label, live or kept after exit (tmux's agentPanes). */
  async agentPanes(session: string, signal?: AbortSignal): Promise<{ name: string; live: boolean }[] | null> {
    const blocks = await sessionBlocks(session, signal);
    return blocks && blocks.filter(b => AGENT_LABEL.test(b.label)).map(b => ({ name: b.label, live: b.live }));
  },

  /** Close every window holding a block labelled `name`. */
  async killWindow(session: string, name: string): Promise<void> {
    const sid = await sessionId(session);
    if (!sid) return;
    const windows = new Set((await blocksOf(sid) ?? []).filter(b => b.label === name).map(b => b.window));
    for (const window of windows) await rex(["window", "close", "-s", sid, window]);
  },

  async killSession(session: string): Promise<void> {
    const sid = await sessionId(session);
    if (sid) await rex(["kill", sid]);
  },
};

/** Milliseconds since the epoch in a Rex id (a UUIDv7: its first 48 bits), 0 when it is not one. */
export const idTime = (id: string) => { const hex = /:([0-9a-f]{8})-([0-9a-f]{4})/.exec(id); return hex ? parseInt(hex[1]! + hex[2]!, 16) : 0; };

/** A Rex block as the Processes tab's pane: grouped by `session` (a Rex session, or one window of orca's own). */
export interface RexPane { session: string; created: number; window: string; pane: string; path: string; command: string; live: boolean }
/** A block orca opened in its own session: an agent's (or the idle shell), labelled like its window. Rex labels any
 * other terminal "shell" by default, so the block label alone cannot tell. */
const orcaBlock = (block: Block) => AGENT_LABEL.test(block.windowLabel) && block.label === block.windowLabel;
/** The prefix of a Processes row that stands for Rex blocks, not a tmux session. */
export const REX_ROW = "rex ";

/**
 * Blocks agents opened themselves (`rex run`, `rex split` from bash), across every Rex session: what tmux's
 * `list-panes -a` gives process-view.ts. In orca's own `orca-…` sessions the agents' blocks and the idle shell are
 * left out and each window is its own row (closing it must not close the agents); elsewhere a session is a row.
 * Null when Rex could not be asked; [] when orca has not used it, or it is not running.
 */
export async function rexPanes(signal?: AbortSignal): Promise<RexPane[] | null> {
  if (!rexInUse()) return [];
  const res = await rex(["ls", "--json"], signal, 5000);
  if (!res.ok) return res.gone ? [] : null;
  const sessions = json<{ sessions: { session_id: string; label: string }[] }>(res.out)?.sessions;
  if (!sessions) return null;
  const panes: RexPane[] = [];
  for (const session of sessions) {
    const blocks = await blocksOf(session.session_id, signal);
    if (blocks === null) return null;
    const ours = session.label.startsWith("orca-");
    for (const block of blocks) {
      if (ours && orcaBlock(block)) continue;
      panes.push({ session: REX_ROW + (ours ? `${session.label} · ${block.windowLabel}` : session.label), created: idTime(session.session_id),
        window: block.windowLabel, pane: block.id, path: block.cwd, command: block.command, live: block.live });
    }
  }
  return panes;
}

/** End a Processes row of Rex blocks: the agent-opened blocks of one window of orca's session, or a whole other session. */
export async function closeRexRow(row: string): Promise<void> {
  const name = row.slice(REX_ROW.length), [session = "", window] = name.split(" · ");
  const sid = await sessionId(session);
  if (!sid) throw new Error(`rex session ${session} not found`);
  if (window === undefined) {
    const res = await rex(["kill", sid]);
    if (!res.ok) throw new Error(`rex could not end ${session}: ${res.err}`);
    return;
  }
  for (const block of await blocksOf(sid) ?? []) if (block.windowLabel === window && !orcaBlock(block)) await rex(["block", "close", block.id]);
}
