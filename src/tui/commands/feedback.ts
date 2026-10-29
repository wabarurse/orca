import { put } from "../../core/data/inbox";
import { recordCorrection } from "../../core/data/knowledge";
import { readRun, local } from "../../core/tmux";
import { taskForRun } from "../../core/data/tasks";
import { registry } from "../../core/tools";
import type { Runner } from "../../core/tmux";
import type { Tool } from "../../core/tools";
import { paths } from "../../config";
import type { ImageRef } from "../../protocol";

/** Selecting an agent makes the recipient explicit. Preserve the original
 * human correction and let the normal spawn ownership gates handle idle resume. */
export async function sendAgentFeedback(project: string, agent: string, text: string, attachments: ImageRef[] = [], deps: { runner?: Runner; spawn?: Tool } = {}): Promise<string> {
  const state = await readRun(project, agent);
  if (!state?.branch || !["worker", "reviewer"].includes(state.role)) throw new Error("agent identity unavailable; return to the orchestrator to reconcile it");
  const inputId = crypto.randomUUID(), at = new Date().toISOString();
  await recordCorrection(project, { id: inputId, text: `[To ${agent}] ${text}`, at });
  const live = await (deps.runner ?? local).running(project, [agent]);
  if (live === null) throw new Error("cannot confirm agent status; feedback was retained in the working brief");
  if (live.includes(agent)) await put(project, agent, { from: "user", text, inputId, ...(attachments.length ? { attachments } : {}) });
  else {
    // User feedback authorizes this continuation; a passive process event does not.
    const task = await taskForRun(project, state.run);
    if (task?.archive) throw new Error("this branch was merged; ask the orchestrator for a linked follow-up");
    if (attachments.length) throw new Error("image feedback to an exited agent needs an orchestrator handoff; text was retained in the working brief");
    const result = await (deps.spawn ?? registry.spawn!).run({ prompt: `New user feedback (source ${inputId}): ${text}`, branch: state.branch,
      role: state.role, ...(task ? { taskId: task.id } : {}), ...(state.role === "reviewer" ? { reviewMode: "review" } : {}) },
      { project, role: "orchestrator", cwd: paths.repo(project) });
    if (typeof result === "string" && result.startsWith("refused:")) throw new Error(result);
  }
  await put(project, "orchestrator", { from: "runtime", text: `User feedback ${inputId} was delivered to ${agent}: ${text}\nThe worker owns the continuation; coordinate only if needed.` });
  return `${live.includes(agent) ? "delivered to" : "resumed"} ${agent}`;
}
