// Read-only execution inventory shared by the model's runtime tool and the TUI.
// Context observations, task stages and queued messages never prove liveness.
import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { paths } from "../../config";
import type { AgentInfo } from "../../protocol";
import { existingTasks } from "../data/tasks";
import { pendingCount } from "../data/inbox";
import { launchIdentity } from "./cancellation";
import { readRun, type RunState } from "./exits";
import { sessionName, tmux } from "./runner";
import { classifyAgent, processAlive } from "./agent-evidence";

const valid = (name: string) => /^(worker|reviewer)(-[A-Za-z0-9._-]+)?$/.test(name);
export interface AgentActivity {
  agent: string; status: "running" | "exited" | "unknown"; reason: string;
  run?: string; pid?: number; record: RunState | null;
  queuedMessages: number | null; task?: { id: string; number?: number; name: string };
}
interface Options {
  panes?: () => ReturnType<typeof tmux.agentPanes>;
  processAlive?: (pid: number) => boolean | null;
  read?: typeof readRun;
  launch?: typeof launchIdentity;
}
async function names(path: string): Promise<string[]> {
  return readdir(path).catch(error => { if (error.code === "ENOENT") return []; throw error; });
}
export async function agentActivity(project: string, options: Options = {}) {
  const errors: string[] = [];
  const inventory = async (path: string) => names(path).catch(() => { errors.push(`cannot inspect ${path}`); return []; });
  const [panes, runs, transcripts, inboxes] = await Promise.all([
    (options.panes?.() ?? tmux.agentPanes(sessionName(project))).catch(() => null),
    inventory(paths.runs(project)), inventory(dirname(paths.transcript(project, "orchestrator"))), inventory(paths.inbox(project)),
  ]);
  if (panes === null) errors.push("cannot verify tmux agent panes");
  const paneMap = new Map<string, boolean>();
  for (const pane of panes ?? []) if (valid(pane.name)) paneMap.set(pane.name, paneMap.get(pane.name) === true || pane.live);
  const agents = [...new Set([...runs.filter(n => n.endsWith(".json")).map(n => n.slice(0, -5)),
    ...transcripts.filter(n => n.endsWith(".jsonl")).map(n => n.slice(0, -6)), ...inboxes, ...paneMap.keys()])].filter(valid).sort();
  let tasks: ReturnType<typeof existingTasks> = [];
  try {
    // A status read must never bootstrap legacy identity during a task lookup.
    if (existsSync(join(paths.project(project), ".identity.json"))) tasks = existingTasks(project);
    else errors.push("task associations unavailable: conversation identity is missing");
  } catch { errors.push("task associations unavailable"); }
  const rows = await Promise.all(agents.map(async (agent): Promise<AgentActivity> => {
    const launch = (options.launch ?? launchIdentity)(project, agent);
    const record = await (options.read ?? readRun)(project, agent);
    const queuedMessages = await pendingCount(project, agent).catch(() => { errors.push(`cannot inspect queued messages for ${agent}`); return null; });
    const current = (options.launch ?? launchIdentity)(project, agent);
    const activity = current !== launch ? { status: "unknown" as const, reason: "launch changed during inspection" }
      : classifyAgent(agent, record, current, paneMap.get(agent), panes !== null, options.processAlive ?? processAlive);
    const task = tasks.find(t => t.runs.some(r => r.agent === agent && r.id === record?.run && r.id === current));
    return { agent, ...activity, run: record?.run, pid: record?.pid, record, queuedMessages,
      ...(task ? { task: { id: task.id, number: task.number, name: task.name } } : {}) };
  }));
  const inventoryComplete = panes !== null && !errors.some(e => e.startsWith("cannot inspect") && !e.includes("queued messages"));
  const verificationComplete = inventoryComplete && !rows.some(a => a.status === "unknown");
  return { observedAt: new Date().toISOString(), inventoryComplete, verificationComplete,
    runningCount: verificationComplete ? rows.filter(a => a.status === "running").length : null,
    verifiedRunningCount: rows.filter(a => a.status === "running").length, agents: rows, errors };
}
/** The frequent TUI count check needs no transcript contents, clocks or archive metadata. */
export async function activeAgentRows(project: string): Promise<AgentInfo[]> {
  const snapshot = await agentActivity(project);
  if (!snapshot.agents.length && !snapshot.verificationComplete) throw new Error("agent activity could not be verified");
  return snapshot.agents.map(a => ({ name: a.agent, live: a.status === "running", status: a.status,
    inventoryComplete: snapshot.inventoryComplete, queuedMessages: a.queuedMessages }));
}
