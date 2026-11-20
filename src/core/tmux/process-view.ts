// What a conversation has running in the background, for the work page's Processes tab: the pull requests the
// daemon's shared watcher is listening to, the commands agents started (local stacks, long checks), and the tmux
// sessions and Rex blocks agents opened themselves in this conversation's folders (`tmux new-session`, `rex run` from
// bash: no record exists for those, so they are found by where their panes run). Read-only, except the stops a person asks for there; a stop never restarts, retries or signals anything else, and the
// orchestrator is told who stopped it so it does not start the same thing again by itself.
import { join } from "node:path";
import { paths } from "../../config";
import { run } from "../proc";
import { observation, put } from "../data/inbox";
import { controlProcess, listProcesses, liveProcess, prWatchEnabled, processDirectory, processOutput, processOwner, readProcess, setPRWatchEnabled, unresolvedProcess, type ProcessRecord } from "../data/processes";
import { allTasks } from "../data/tasks";
import { activePRTask } from "./pr-observations";
import { tmux } from "./runner";
import { closeRexRow, REX_ROW, rexMux, rexPanes } from "./rex";

/** A watched pull request. `process` is the explicit `watch_pr` registration, null when only its task links it.
 * `state` is what the watcher last recorded (checks, review, mergeable, failing), null before its first look. */
export interface WatchRow {
  repository: string; number: number; url: string; tasks: { number: number | null; name: string; branch: string }[];
  process: string | null; state: Record<string, string> | null;
}
/** A background command and the end of what it has printed. */
export interface CommandRow { record: ProcessRecord; live: boolean; tail: string }
/** One pane of orca's tmux server, as `list-panes -a` reports it. */
export interface Pane { session: string; created: number; window: string; pane: string; path: string; command: string; live: boolean }
/** A tmux session an agent opened by itself: its windows, each with the end of what it shows. */
export interface SessionRow { name: string; createdAt: number; windows: (Pane & { tail: string })[] }
export interface ProcessView { watches: WatchRow[]; commands: CommandRow[]; sessions: SessionRow[] }
/** How the view asks tmux: every pane (null when tmux could not be asked), a pane's last lines, and ending a session. */
export interface Sessions { panes(): Promise<Pane[] | null>; tail(pane: string): Promise<string>; kill(session: string): Promise<void> }

const FIELDS = ["session_name", "session_created", "window_name", "pane_id", "pane_current_path", "pane_dead", "pane_start_command", "pane_current_command"];
// tmux 3.7 prints a tab in a format as "_", so the fields are split on printable text no path is likely to hold.
const SPLIT = " |orca| ";
const ask = (...args: string[]) => run(tmux.argv(...args), { cwd: paths.root, timeoutMs: 5000 });
/** orca's tmux server's panes; [] when tmux is not installed or its server is not running, null when it could not be asked. */
async function tmuxPanes(): Promise<Pane[] | null> {
  if (!Bun.which("tmux")) return [];
  const out = await ask("list-panes", "-a", "-F", FIELDS.map(field => `#{${field}}`).join(SPLIT));
  if (!out) return null;
  if (out.code !== 0) return /no server running|error connecting to .*\((No such file or directory|Connection refused)\)/i.test(out.err) ? [] : null;
  return out.out.split("\n").filter(Boolean).flatMap(line => {
    const [session, created, window, pane, path, dead, started, current] = line.split(SPLIT);
    return session && pane && path ? [{ session, created: Number(created) * 1000, window: window ?? "", pane, path, command: started || current || "", live: dead === "0" }] : [];
  });
}
/** tmux panes and Rex blocks together (a Rex row's session starts with REX_ROW); null when either could not be asked. */
export const sessions: Sessions = {
  async panes() {
    const [t, r] = await Promise.all([tmuxPanes(), rexPanes()]);
    return t && r && [...t, ...r];
  },
  async tail(pane) {
    if (pane.startsWith("block:")) return (await rexMux.capture(pane)).split("\n").slice(-TAIL_LINES).join("\n").trimEnd();
    return (await ask("capture-pane", "-p", "-J", "-S", `-${TAIL_LINES}`, "-t", pane))?.out.trimEnd() ?? "";
  },
  async kill(session) {
    if (session.startsWith(REX_ROW)) return closeRexRow(session);
    const out = await ask("kill-session", "-t", "=" + session);
    if (!out || out.code !== 0) throw new Error(`tmux could not end ${session}${out?.err ? `: ${out.err.trim()}` : ""}`);
  },
};
/** The sessions with a pane inside this conversation's worktrees or its checkout; orca's own (`orca-…`) are its
 * agents, shown on the Agents tab. Unknown (tmux not asked) is no rows, never a guess. */
async function agentSessions(project: string, from: Sessions): Promise<SessionRow[]> {
  const roots = [...paths.worktreeRoots(project), paths.repo(project)], inside = (path: string) => roots.some(root => path === root || path.startsWith(root + "/"));
  const panes = (await from.panes().catch(() => null) ?? []).filter(pane => !pane.session.startsWith("orca-"));
  const names = [...new Set(panes.filter(pane => inside(pane.path)).map(pane => pane.session))];
  return Promise.all(names.sort().map(async name => {
    const own = panes.filter(pane => pane.session === name);
    return { name, createdAt: own[0]!.created, windows: await Promise.all(own.map(async (pane, i) => ({ ...pane, tail: i < TAILED && pane.live ? await from.tail(pane.pane).catch(() => "") : "" }))) };
  }));
}

const RECENT_MS = 24 * 3_600_000, TAIL_BYTES = 4000, TAIL_LINES = 30, TAILED = 4;
async function tail(project: string, id: string): Promise<string> {
  const size = Bun.file(join(processDirectory(project, id), "output.txt")).size;
  if (!size) return "";
  const from = Math.max(0, size - TAIL_BYTES), text = (await processOutput(project, id, from, TAIL_BYTES)).content;
  const lines = text.split("\n");
  return (from ? lines.slice(1) : lines).slice(-TAIL_LINES).join("\n").trimEnd(); // a read from the middle starts inside a line
}

/** The agent-opened tmux sessions the Processes tab lists, without what their windows show: what the process tool's
 * list returns, so an agent and the tab agree on what is running. */
export const sessionRows = (project: string, from: Sessions = sessions): Promise<SessionRow[]> => agentSessions(project, { ...from, tail: async () => "" });

/** Watches by PR number; commands live first, then those that ended in the last day, newest first. */
export async function processView(project: string, now = Date.now(), from: Sessions = sessions): Promise<ProcessView> {
  const records = await listProcesses(project);
  const watches = new Map<string, WatchRow>();
  const watch = (repository: string, number: number) => {
    const key = `${repository}#${number}`;
    if (!watches.has(key)) watches.set(key, { repository, number, url: `https://github.com/${repository}/pull/${number}`, tasks: [], process: null, state: null });
    return watches.get(key)!;
  };
  for (const task of await allTasks(project)) {
    if (task.pr && activePRTask(task) && prWatchEnabled(project, task.pr)) watch(task.pr.repository, task.pr.number).tasks.push({ number: task.number ?? null, name: task.name, branch: task.branch });
  }
  for (const p of records) if (p.prWatch && p.prChecks && liveProcess(p) && prWatchEnabled(project, p.prChecks)) watch(p.prChecks.repository, p.prChecks.number).process = p.id;
  for (const [key, row] of watches) {
    const value = await observation(project, `pr:${key}`).catch(() => undefined);
    if (value && typeof value === "object") row.state = Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === "string" && v).map(([k, v]) => [k, String(v)]));
  }
  const shown = records.filter(p => !p.prWatch && (unresolvedProcess(p) || now - Date.parse(p.updatedAt) < RECENT_MS));
  const commands = await Promise.all(shown.map(async record => ({ record, live: unresolvedProcess(record), tail: await tail(project, record.id).catch(() => "") })));
  commands.sort((a, b) => Number(b.live) - Number(a.live) || b.record.createdAt.localeCompare(a.record.createdAt));
  return { watches: [...watches.values()].sort((a, b) => a.repository.localeCompare(b.repository) || a.number - b.number), commands, sessions: await agentSessions(project, from) };
}

/** How many things run in the background for the conversation right now: watched pull requests, commands still
 * running and agent-opened tmux sessions with a live window. For the status bar: no output is read. */
export async function processCount(project: string, from: Sessions = sessions): Promise<number> {
  const view = await processView(project, Date.now(), { ...from, tail: async () => "" });
  return view.watches.length + view.commands.filter(command => command.live).length + view.sessions.filter(session => session.windows.some(w => w.live)).length;
}

const told = (project: string, text: string) => put(project, "orchestrator", { from: "runtime", text });
/** The user stopped one command from the Processes tab: like Ctrl+C in its terminal, and the orchestrator is told. */
export async function stopCommand(project: string, id: string): Promise<void> {
  const p = await readProcess(project, id);
  if (p.prWatch) throw new Error("that is a PR watch, not a command");
  if (!unresolvedProcess(p)) throw new Error("that command has already ended");
  await controlProcess(project, id, "stop");
  await told(project, `[process-stopped] The user stopped background command ${id} (owner ${processOwner(p)}): ${p.command.replace(/\s+/g, " ").slice(0, 200)}. Nothing was restarted. Do not start it again unless the user asks.`);
}
/** The user ended one agent-opened tmux session: everything in its windows gets a hangup, and the orchestrator is told.
 * Only a session the view lists for this conversation can be ended, never one of orca's own. */
export async function stopSession(project: string, name: string, from: Sessions = sessions): Promise<void> {
  const row = (await agentSessions(project, from)).find(session => session.name === name);
  if (!row) throw new Error("that session has already ended");
  await from.kill(name);
  await told(project, `[session-stopped] The user ended tmux session ${name} (${row.windows.map(w => `${w.window}: ${w.command.replace(/\s+/g, " ").slice(0, 120) || "shell"}`).join("; ").slice(0, 400)}). Nothing was restarted. Do not start it again unless the user asks.`);
}
/** The user stopped listening to one PR: no more notices for it until it is watched again. GitHub is untouched. */
export async function stopWatch(project: string, pr: { repository: string; number: number }): Promise<void> {
  for (const p of await listProcesses(project)) {
    if (p.prWatch && liveProcess(p) && p.prChecks?.repository === pr.repository && p.prChecks.number === pr.number) await controlProcess(project, p.id, "stop");
  }
  setPRWatchEnabled(project, pr, false);
  await told(project, `[pr-watch-stopped] The user stopped the watch on PR ${pr.repository}#${pr.number}. No more notices will arrive for it; process watch_pr starts it again. The PR itself is unchanged.`);
}
