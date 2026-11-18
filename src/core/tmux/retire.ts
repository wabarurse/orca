// Deleting, from the bottom of the tree up, without refusing because something is still running:
//
//   bubble   (nodes, pages, behavior)        archived when every one of its orcs is
//   └─ orc   one conversation                marked archived, leaves every list
//      └─ worktrees, tasks, questions        each marked archived
//         └─ agents, processes               asked to stop, waited for, then ended
//
// Nothing is removed here. An archived conversation keeps its files, history, branches and worktrees until
// `orca clean` purges it (ownership.ts `deleteProject` is that purge), and `restoreProject` brings it back.
// A stop is graceful first: the conversation's stop barrier, each agent's own cancellation, each command's
// stop file, each sandbox's close. Only what is still alive after `graceMs` is ended by closing its window.
import { existsSync } from "node:fs";
import { loadConfig, paths, saveConfig } from "../../config";
import { canArchiveTask } from "../../protocol/task";
import { bubbleMembers, readBubble } from "../data/bubbles";
import { questions } from "../data/inbox";
import { closeVerification, listProcesses, listVerifications, unresolvedProcess } from "../data/processes";
import { directories, projectIdentity, validProjectName, workViews, workspaces } from "../data/projects";
type ProjectArchive = directories.ProjectArchive;
const { projectArchive, setProjectArchive } = directories;
import { abandonTask, allTasks, removeTask, restoreTask } from "../data/tasks";
import { cancelSession } from "./cancellation";
import { archiveAgents, killProjectSession, listAgents, liveAgentsOrNull, restoreAgents } from "./liveness";
import { processView, sessions, type Sessions } from "./process-view";
import { sessionName, tmux } from "./runner";

export const GRACE_MS = 15_000;
export interface RetireOptions {
  /** Stop the conversation's orchestrator daemon and wait for it; the caller supplies it (the daemon client is above this layer). */
  stop: (project: string) => Promise<void>;
  /** Live agent windows, the idle session's close, one window's close, and tmux for agent-opened sessions. Tests replace them. */
  live?: (project: string) => Promise<string[] | null>;
  kill?: (project: string) => Promise<void>;
  killWindow?: (project: string, window: string) => Promise<void>;
  sessions?: Sessions;
  /** How long agents and commands get to stop by themselves before their windows are closed. */
  graceMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Runs once everything has stopped, before anything is marked (the TUI closes its page here). */
  beforeArchive?: (project: string) => Promise<void> | void;
}
/** What stopping a conversation did: who was running, who had to be ended, and what could not be done. */
export interface StopReport { agents: string[]; forced: string[]; commands: number; problems: string[] }
export interface ArchiveReport { project: string; stop: StopReport; archive: ProjectArchive; kept: string[] }

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Level four: everything running under one conversation stops, gracefully first. Its files are untouched. */
export async function stopTree(project: string, options: RetireOptions): Promise<StopReport> {
  const live = options.live ?? liveAgentsOrNull, sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const agents = await live(project);
  if (agents === null) throw new Error("cannot check live agents; nothing was stopped");
  const problems: string[] = [];
  const attempt = async (what: string, action: () => Promise<unknown>) => { try { await action(); } catch (error) { problems.push(`${what}: ${message(error)}`); } };
  const running = async () => (await listProcesses(project)).filter(p => !p.prWatch && unresolvedProcess(p));
  const commands = (await running().catch(() => [])).length;
  // The barrier first, so nothing new starts; it also cancels each agent's run, writes each command's stop file and closes sandboxes.
  await attempt("stop request", () => cancelSession(project, "orchestrator"));
  const from = options.sessions ?? sessions;
  await attempt("tmux sessions", async () => {
    for (const session of (await processView(project, Date.now(), { ...from, tail: async () => "" })).sessions) await from.kill(session.name);
  });
  const deadline = Date.now() + (options.graceMs ?? GRACE_MS);
  let left = agents, busy = commands;
  while ((left.length || busy) && Date.now() < deadline) {
    await sleep(250);
    left = await live(project) ?? left;
    busy = (await running().catch(() => [])).length;
  }
  // Still alive after the wait: the window is closed, which hangs up whatever runs in it.
  const closeWindow = options.killWindow ?? ((name: string, window: string) => tmux.killWindow(sessionName(name), window));
  for (const window of left) await attempt(`closing ${window}`, () => closeWindow(project, window));
  await attempt("sandboxes", async () => { for (const v of await listVerifications(project)) if (v.state !== "closed") await closeVerification(project, v.id); });
  if (busy) problems.push(`${busy} command${busy === 1 ? "" : "s"} had not stopped after the wait`);
  await options.stop(project); // The daemon last: it is what would start anything again.
  await attempt("tmux session", () => (options.kill ?? killProjectSession)(project));
  return { agents, forced: left, commands, problems };
}

/** Level three, then two: mark what the conversation owns archived, then the conversation itself. */
async function mark(project: string, kept: string[]): Promise<ProjectArchive> {
  const archive: ProjectArchive = { at: new Date().toISOString(), tasks: [], questions: [], agents: [], sessions: [] };
  for (const listed of await allTasks(project)) {
    if (listed.removedAt) continue;
    try {
      // Unfinished work is abandoned (its record and PR link stay); a task whose PR is still open cannot be, and stays as it is.
      if (!canArchiveTask(listed)) await abandonTask(project, listed.id, listed.revision);
      await removeTask(project, listed.id, true);
      archive.tasks.push(listed.id);
    } catch (error) { kept.push(`task "${listed.name}": ${message(error)}`); }
  }
  try {
    const hidden = workViews.workArchive(project, "questions");
    archive.questions = (await questions.all(project)).map(q => q.id).filter(id => !hidden[id]);
    workViews.setWorkArchived(project, "questions", archive.questions, true);
  } catch (error) { kept.push(`questions: ${message(error)}`); }
  try {
    const names = (await listAgents(project)).filter(agent => !agent.archived).map(agent => agent.name);
    archive.agents = (await archiveAgents(project, names, async () => [])).archived;
  } catch (error) { kept.push(`agents: ${message(error)}`); }
  // A worktree's session is archived at once, so the maintenance pass and `orca clean` may give its checkout back.
  const identity = projectIdentity(project);
  for (const session of workspaces.list()) {
    if (!session.disposable || session.cleanedAt || session.archivedAt || !session.members.some(m => m.project === project && m.identity === identity)) continue;
    if (workspaces.archive(session.id, session.lastActivityAt, Date.now(), true)) archive.sessions.push(session.id);
  }
  setProjectArchive(project, archive);
  return archive;
}

/** Delete one orc: stop everything under it, archive what it owns, archive it. Its files stay until `orca clean`. */
export async function archiveProject(project: string, options: RetireOptions): Promise<ArchiveReport> {
  if (!validProjectName(project)) throw new Error(`not a project name: ${project}`);
  if (!existsSync(paths.project(project))) throw new Error(`no project named ${project}`);
  if (projectArchive(project)) throw new Error(`${project} is already archived`);
  const stop = await stopTree(project, options);
  await options.beforeArchive?.(project);
  const kept: string[] = [];
  const archive = await mark(project, kept);
  const { pinned } = await loadConfig();
  if (pinned.includes(project)) await saveConfig({ pinned: pinned.filter(name => name !== project) });
  return { project, stop, archive, kept };
}

/** Bring an archived orc back as it was listed. Nothing is started: its stop barrier holds until the user types again. */
export async function restoreProject(project: string): Promise<void> {
  const archive = projectArchive(project);
  if (!archive) throw new Error(`${project} is not archived`);
  for (const id of archive.tasks) await restoreTask(project, id).catch(() => { /* purged or changed since: the rest still comes back */ });
  workViews.setWorkArchived(project, "questions", archive.questions, false);
  if (archive.agents.length) try { await restoreAgents(project, archive.agents); } catch { /* their marker is already gone */ }
  for (const id of archive.sessions) try { workspaces.touch(id); } catch { /* cleaned since: its checkout is gone, its branch is not */ }
  setProjectArchive(project, undefined);
}

/** Delete a bubble: delete each of its orcs. Every one is checked before the first is stopped; the bubble's nodes,
 * pages and behavior stay with the archived orcs and go when `orca clean` purges the last of them. */
export async function archiveBubble(id: string, options: RetireOptions): Promise<ArchiveReport[]> {
  if (!await readBubble(id)) throw new Error("no such bubble");
  const members = bubbleMembers(id).filter(project => existsSync(paths.project(project)) && !projectArchive(project));
  const live = options.live ?? liveAgentsOrNull;
  for (const project of members) if (await live(project) === null) throw new Error(`cannot check live agents of ${project}; nothing was stopped`);
  const reports: ArchiveReport[] = [];
  for (const project of members) reports.push(await archiveProject(project, options));
  return reports;
}

/** One line for the person who asked: what was stopped, what had to be ended, what stayed. */
export function describeArchive(reports: ArchiveReport[]): string {
  const sum = (pick: (report: ArchiveReport) => number) => reports.reduce((n, report) => n + pick(report), 0);
  const count = (n: number, word: string) => n ? `${n} ${word}${n === 1 ? "" : "s"}` : "";
  const stopped = [count(sum(r => r.stop.agents.length), "agent"), count(sum(r => r.stop.commands), "command")].filter(Boolean).join(" and ");
  const forced = sum(r => r.stop.forced.length), problems = reports.flatMap(r => [...r.stop.problems, ...r.kept]);
  return [stopped ? `stopped ${stopped}` : "", forced ? `${forced} did not stop in time and ${forced === 1 ? "was" : "were"} ended` : "",
    count(sum(r => r.archive.tasks.length), "task") && `${count(sum(r => r.archive.tasks.length), "task")} archived`,
    problems.length ? `kept as is: ${problems.join("; ")}` : ""].filter(Boolean).join("; ");
}
