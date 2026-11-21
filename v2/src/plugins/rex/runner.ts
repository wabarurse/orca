// The Rex runner (superlogical.com/rex): a conversation's agents are windows of one Rex session labelled
// `orca2-<conversation>`, so they show in Rex's session list beside the user's own; each window holds one block
// labelled with the agent id, and the window carries the same label. Blocks open with --keep-open: a finished agent's
// last screen stays readable until its next launch closes it. Every call passes --autostart=false, so asking about
// Rex never starts a Rex server, and Rex is asked only once orca2 has opened a session there (the marker below).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../../config";
import type { Runner } from "../../core/plugins/types";
import { exec, sessionName, which, windowCommand } from "../tmux/launch";

/** Where Rex.app keeps its CLI, for a process with no REX_BIN_DIR and no `rex` on PATH. */
const APP_CLI = "/Applications/Rex.app/Contents/Helpers/Rex Server.rex/Contents/MacOS/rex";

/** The rex CLI: the one of the Rex terminal orca2 runs in, then PATH, then Rex.app's; null when Rex is not installed. */
export function rexBinary(): string | null {
  const dir = process.env.REX_BIN_DIR;
  if (dir !== undefined && dir.length > 0 && existsSync(join(dir, "rex"))) return join(dir, "rex");
  return which("rex") ?? (existsSync(APP_CLI) ? APP_CLI : null);
}

/** Written when orca2 first opens a Rex session: until then nothing of orca2's runs in Rex. */
const marker = (): string => join(paths.globalData, "rex", "used");
export const rexUsed = (): boolean => existsSync(marker());

type Reply = { ok: true; out: string } | { ok: false; gone: boolean; err: string };
async function rex(args: string[]): Promise<Reply> {
  const bin = rexBinary();
  if (bin === null) return { ok: false, gone: true, err: "rex is not installed" };
  const res = await exec([bin, "--autostart=false", ...args]);
  if (res === null) return { ok: false, gone: false, err: "rex did not answer" };
  if (res.code === 0) return { ok: true, out: res.out };
  const err = res.err.trim() || `exit ${res.code}`;
  return { ok: false, gone: /no Rex server is running|not found/i.test(err), err };
}
const parse = <T>(text: string): T | null => { try { return JSON.parse(text) as T; } catch { return null; } };

type Sessions = { sessions: { session_id: string; label: string }[] };
type Windows = { windows: { window_id: string; label: string; layers: { blocks: { block_id: string; label: string }[] }[] }[] };
type Process = { child: unknown; last_exit: unknown };
type Block = { id: string; label: string; window: string; windowLabel: string; live: boolean };

/** The session's id by its label: null when there is none (or no server), undefined when Rex could not be asked. */
async function sessionId(label: string): Promise<string | null | undefined> {
  const res = await rex(["ls", "--json"]);
  if (!res.ok) return res.gone ? null : undefined;
  const list = parse<Sessions>(res.out);
  return list === null ? undefined : list.sessions.find(s => s.label === label)?.session_id ?? null;
}

/** Every block of the session; [] when the session is gone, null when Rex could not be asked. */
async function blocksOf(sid: string): Promise<Block[] | null> {
  const res = await rex(["window", "ls", "-s", sid, "--json"]);
  if (!res.ok) return res.gone ? [] : null;
  const list = parse<Windows>(res.out);
  if (list === null) return null;
  const blocks: Block[] = [];
  for (const window of list.windows) for (const layer of window.layers) for (const block of layer.blocks) {
    const p = await rex(["block", "call", "-b", block.block_id, "process"]);
    if (!p.ok && !p.gone) return null;
    const child = p.ok ? parse<Process>(p.out)?.child ?? null : null;
    blocks.push({ id: block.block_id, label: block.label, window: window.window_id, windowLabel: window.label, live: child !== null });
  }
  return blocks;
}

/** An agent's block: orca2 labels it and its window with the agent id; the idle shell and blocks agents open differ. */
const agentBlock = (b: Block): boolean => b.label === b.windowLabel && b.label !== "shell";

/** The session's id, creating it (with an idle shell window, as `rex new` needs one) when missing. */
async function ensureSession(session: string, cwd: string): Promise<string> {
  const sid = await sessionId(session);
  if (sid !== null && sid !== undefined) return sid;
  if (sid === undefined) throw new Error("rex could not list its sessions; is Rex running?");
  mkdirSync(join(paths.globalData, "rex"), { recursive: true, mode: 0o700 });
  writeFileSync(marker(), "");
  const res = await rex(["new", session, "-c", cwd, "--window", "shell", "--json"]);
  if (!res.ok) throw new Error(`rex new failed: ${res.err}`);
  const made = parse<{ session_id: string }>(res.out)?.session_id ?? await sessionId(session);
  if (typeof made !== "string") throw new Error(`rex session ${session} did not appear`);
  return made;
}

export const rexRunner: Runner = {
  name: "rex",
  async start(launch) {
    if (rexBinary() === null) throw new Error("Rex is not installed; choose another runner with /mux");
    const sid = await ensureSession(sessionName(launch.conversation), launch.cwd);
    for (const block of await blocksOf(sid) ?? []) if (block.label === launch.agent && !block.live) await rex(["block", "close", block.id]);
    const command = await windowCommand(launch);
    const res = await rex(["run", "-s", sid, "--label", launch.agent, "-c", launch.cwd, "--keep-open", "--focus=false", "--shell=none", "--json", "--", ...command.argv]);
    const made = res.ok ? parse<{ window_id: string | null; block_ids: string[] | null }>(res.out) : null;
    const block = made?.block_ids?.[0] ?? "";
    if (!block.startsWith("block:")) {
      await command.cleanup();
      throw new Error(`rex run failed: ${res.ok ? "unexpected output" : res.err}`);
    }
    if (typeof made?.window_id === "string") await rex(["window", "rename", "-s", sid, made.window_id, launch.agent]);
    return { handle: block, pid: null };
  },
  async alive(conversation) {
    if (!rexUsed() || rexBinary() === null) return [];
    const sid = await sessionId(sessionName(conversation));
    if (sid === undefined) return null;
    if (sid === null) return [];
    const blocks = await blocksOf(sid);
    return blocks === null ? null : [...new Set(blocks.filter(b => b.live && agentBlock(b)).map(b => b.label))];
  },
  async stop(conversation, agent) {
    if (!rexUsed()) return;
    const sid = await sessionId(sessionName(conversation));
    if (sid === null || sid === undefined) return;
    const windows = new Set((await blocksOf(sid) ?? []).filter(b => b.label === agent && agentBlock(b)).map(b => b.window));
    for (const window of windows) await rex(["window", "close", "-s", sid, window]);
  },
};
