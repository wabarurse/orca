import { agentActivity, sessionId, type AgentActivity } from "../tmux";
import { existingTasks } from "../data/tasks";
import { execution } from "../data/projects/lifecycle";

type Inspect = (project: string) => Promise<{ observedAt: string; agents: AgentActivity[] }>;
/** Enqueue is not processing or a launch acknowledgment. No retries or wakeups. */
export async function messageReceipt(project: string, to: string, inputId: string, inspect: Inspect = agentActivity): Promise<string> {
  let activity: Awaited<ReturnType<Inspect>> | undefined;
  try { activity = await inspect(project); } catch { /* Queue publication already succeeded; never imply it failed. */ }
  const row = activity?.agents.find(agent => agent.agent === to), record = row?.record;
  const finishing = row?.status === "running" && record?.state === "reported" && record.step !== "waiting for background commands";
  let resumeHint: { tool: "spawn"; branch: string; role: "worker" | "reviewer"; taskId?: string; prompt: string } | undefined;
  let held: boolean | null = null;
  try {
    held = execution.stopped(project);
    if (!held && row && (row.status === "exited" || finishing) && record?.branch &&
        ["worker", "reviewer"].includes(record.role) && sessionId(record.role, record.branch) === to) {
      const task = existingTasks(project).find(task => task.runs.some(run => run.id === record.run && run.agent === to));
      if (!task?.archive && !["cancelled", "closed"].includes(task?.attention?.kind ?? "")) {
        resumeHint = { tool: "spawn", branch: record.branch, role: record.role as "worker" | "reviewer", ...(task ? { taskId: task.id } : {}),
          prompt: `Continue only the already-authorized assignment. Read the queued follow-up ${inputId}; do not repeat a correction already consumed or completed.` };
      }
    }
  } catch { /* Unknown ownership never grants permission to resume. */ }
  return JSON.stringify({ to, inputId, enqueued: true, agentStarted: false, processingConfirmed: false,
    recipientStatus: row?.status ?? "unknown", observedAt: activity?.observedAt,
    acceptsFollowUps: row?.status === "running" && !finishing, finishing, projectStopped: held,
    nextAction: held !== false ? "Do not resume stopped or unverified work without fresh human authorization. This message is retained in its inbox."
      : "Sending only enqueues. For an already-authorized continuation, use spawn on the same unmerged branch/task; verify its result/report before claiming progress. A status question is not restart authorization.",
    ...(resumeHint ? { resumeHint } : {}) });
}
