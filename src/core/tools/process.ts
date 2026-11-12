import { rm } from "node:fs/promises";
import { join } from "node:path";
import { registerPRWatch, handoffProcess, processOwner, processInspection, unresolvedProcess, controlProcess, processDirectory, listProcesses, processOutput, readProcess, reconcileProcesses, liveProcess, type ProcessRecord } from "../data/processes";
import { sessionId } from "../tmux";
import { originRepo } from "../data/tasks";
import { sha } from "../../protocol/task";
import { observation, pending } from "../data/inbox";
import type { Tool, ToolContext } from "./registry";

const view = (p: ProcessRecord) => ({ id: p.id, owner: processOwner(p), createdBy: p.owner, kind: p.prWatch ? "pr_watch" : "command", state: p.state, settledAt: p.settledAt, exitCode: p.exitCode, reason: p.reason, cleanupBlocker: p.state === "unknown" && !p.settledAt ? processInspection()(p) : undefined, readyUrl: p.readyAt ? p.readyUrl : undefined, updatedAt: p.updatedAt });

/** Block on persisted state until the process leaves its running state or is
 * ready, its watched PR's recorded observation changes, this agent's inbox has
 * input, the call is cancelled or the timeout passes. Read-only: the completion
 * event is still delivered to the owner by the supervisor, exactly as without a wait. */
export async function waitForProcess(ctx: ToolContext, id: string, timeoutMs: number, pollMs = 1000): Promise<string> {
  const started = Date.now(), agent = sessionId(ctx.role, ctx.branch);
  const watched = async (p: ProcessRecord) => {
    if (!p.prWatch || !p.prChecks) return undefined;
    const key = `${p.prChecks.repository}#${p.prChecks.number}`;
    return { ...p.prChecks, observed: await observation(ctx.project, `pr:${key}`), mergedAt: await observation(ctx.project, `merge:${key}`) };
  };
  let p = await readProcess(ctx.project, id);
  const baseline = JSON.stringify(await watched(p));
  for (let polls = 1; ; polls++) {
    const pr = await watched(p);
    const returned = !liveProcess(p) ? "settled" : p.readyAt ? "ready" : JSON.stringify(pr) !== baseline ? "pr_changed"
      : ctx.signal?.aborted ? "cancelled" : await pending(ctx.project, agent) ? "inbox" : Date.now() - started >= timeoutMs ? "timeout" : undefined;
    if (returned) {
      const path = join(processDirectory(ctx.project, p.id), "output.txt"), size = Bun.file(path).size;
      const out = p.prWatch ? undefined : await processOutput(ctx.project, p.id, Math.max(0, size - 2000), 2000);
      return JSON.stringify({ ...view(p), waitedMs: Date.now() - started, returned, timedOut: returned === "timeout" || undefined,
        interrupted: returned === "inbox" || returned === "cancelled" ? returned : undefined, pr, tail: out?.content, output: out?.path, cursor: out?.cursor });
    }
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); ctx.signal?.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, Math.min(pollMs, Math.max(0, started + timeoutMs - Date.now())));
      ctx.signal?.addEventListener("abort", done, { once: true });
    });
    if (polls % 5 === 0) await reconcileProcesses(ctx.project); // notice a dead supervisor instead of waiting on it
    p = await readProcess(ctx.project, id);
  }
}

export const processTool: Tool = {
  spec: { name: "process", description: "Manage background commands: list, status, output, wait, input, stop, forget or handoff. wait blocks until the command settles or is ready, a watched PR changes, a message arrives or timeout_s passes, and returns status plus an output tail; use it instead of sleep. Handoff transfers control and pending/future events to another existing agent in this conversation without restarting the command; supply to and a reason describing remaining responsibility. Sandbox commands retain their environment lifetime. watch_pr registers ongoing project-owned PR monitoring (CI, review decision, head, closure, merge) in the shared runtime observer, without a shell or command slot; notifications go to the orchestrator after workers finish. Use a PR number and full head SHA in the project origin. Then wait or yield; no Bash polling loops. Status separates unknown outcomes from verified stopped processes. Checks alone do not establish merge readiness. The orchestrator can control all project commands.",
    input_schema: { type: "object", properties: { action: { type: "string", enum: ["list", "status", "output", "wait", "input", "stop", "forget", "handoff", "watch_pr"] }, id: { type: "string" }, to: { type: "string", description: "Existing agent ID in this conversation, or orchestrator." }, reason: { type: "string", description: "Remaining responsibility for handoff." }, cursor: { type: "integer", minimum: 0 }, timeout_s: { type: "integer", minimum: 1, maximum: 900, description: "For wait; default 300." }, text: { type: "string" }, number: { type: "integer", minimum: 1, description: "GitHub PR number for watch_pr." }, head: { type: "string", description: "Full current PR head SHA for watch_pr." } }, required: ["action"] } },
  async run(input, ctx) {
    await reconcileProcesses(ctx.project);
    const owner = sessionId(ctx.role, ctx.branch);
    if (input.action === "list") return JSON.stringify((await listProcesses(ctx.project)).filter(p => ctx.role === "orchestrator" || processOwner(p) === owner || p.prWatch)
      .map(p => ({ id: p.id, owner: processOwner(p), createdBy: p.owner, kind: p.prWatch ? "pr_watch" : "command", state: p.state, settledAt: p.settledAt, readyUrl: p.readyAt ? p.readyUrl : undefined, exitCode: p.exitCode })));
    if (input.action === "watch_pr") {
      const { number, head } = input;
      if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1 || typeof head !== "string" || !sha(head)) {
        throw new Error("watch_pr requires a GitHub PR number and full head SHA");
      }
      const repository = await originRepo(ctx.project);
      if (!repository) throw new Error("project origin is not on GitHub");
      return JSON.stringify(await registerPRWatch(ctx.project, { repository: repository.toLowerCase(), number, head: head.toLowerCase() }, ctx.executionEpoch));
    }
    const p = await readProcess(ctx.project, String(input.id ?? ""));
    if (ctx.role !== "orchestrator" && processOwner(p) !== owner && !(p.prWatch && ["status", "output", "wait"].includes(String(input.action)))) throw new Error("process belongs to another agent");
    if (input.action === "handoff") {
      if (typeof input.to !== "string" || typeof input.reason !== "string") throw new Error("handoff requires to and reason");
      return JSON.stringify(await handoffProcess(ctx.project, p.id, { actor: owner, to: input.to, reason: input.reason, epoch: ctx.executionEpoch }));
    }
    if (input.action === "forget") {
      if (unresolvedProcess(p) || p.custody?.pending || p.events.some(e => !e.delivered)) throw new Error("only settled processes with delivered events can be forgotten");
      await rm(processDirectory(ctx.project, p.id), { recursive: true }); return `forgot ${p.id}`;
    }
    if (input.action === "status") return JSON.stringify(view(p));
    if (input.action === "wait") {
      const seconds = input.timeout_s ?? 300;
      if (typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds < 1 || seconds > 900) throw new Error("timeout_s must be 1–900");
      return waitForProcess(ctx, p.id, seconds * 1000);
    }
    if (input.action === "output") return JSON.stringify(await processOutput(ctx.project, p.id, Number(input.cursor ?? 0)));
    if (input.action === "stop" || input.action === "input") {
      await controlProcess(ctx.project, p.id, input.action, typeof input.text === "string" ? input.text : undefined);
      return `${input.action} delivered to ${p.id}`;
    }
    throw new Error("unknown process action");
  },
};
