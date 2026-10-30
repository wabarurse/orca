import { editableTool } from "../core/definitions";
// The `orca agent` process: runAgent publishes the launch, supervises a worker or
// reviewer (run record, exit notice on a crash) and runs one agent session over
// the loop in core/agent-loop/loop/agent.ts. The orchestrator role hands over to
// the daemon entry (./daemon).

import { loadConfig, paths } from "../config";
import { createAgent, type AgentOptions } from "../core/agent-loop/loop";
import { effectiveFlow } from "../core/data/projects";
import { execution } from "../core/data/projects/lifecycle";
import { effectiveModel, projectModelResolver } from "../core/data/projects";
import { open } from "../core/data/transcripts";
import { rolePrompt } from "../core/prompt";
import { launchEpoch, launchIdentity, SETTLED_EXIT, publishLaunch, watchCancellation } from "../core/tmux";
import { supervise, type Tracker } from "../core/tmux";
import { sessionId } from "../core/tmux";
import { registry } from "../core/tools";
import { toolsFor, type Tool, type ToolResult } from "../core/tools";
import { pending } from "../core/data/inbox";
import { recoverableProcesses, listProcesses, liveProcess, controlProcess, reconcileProcesses } from "../core/data/processes";
import { agentKnowledge } from "../core/data/knowledge";

/**
 * Run an agent process. Workers and reviewers are supervised: a crash or an
 * exit without a report sends an `[agent-exit]` notice to the orchestrator.
 * Returns the process exit code. `exit` is how the CLI ends the process at once
 * when the orchestrator's project is deleted underneath it; without it (tests,
 * in-process callers) the outcome comes back as the code and nothing exits.
 */
export async function runAgent(opts: AgentOptions, exit?: (code: number) => void): Promise<number> {
  const run = opts.run ?? crypto.randomUUID();
  const published = launchIdentity(opts.project, sessionId(opts.role, opts.branch));
  if (opts.run && published && published !== run) return SETTLED_EXIT;
  if (execution.stale(opts.project, launchEpoch(opts.project, sessionId(opts.role, opts.branch), run) ?? execution.epoch(opts.project))) return SETTLED_EXIT;
  if (!opts.run) publishLaunch(opts.project, sessionId(opts.role, opts.branch), run);
  opts = { ...opts, run };
  if (opts.role === "orchestrator") {
    // The long-lived daemon loop; imported lazily so a worker process never loads it.
    const { orchestratorAgent } = await import("./daemon");
    return orchestratorAgent({ ...opts, run }, exit);
  }
  if (!opts.branch) {
    await startAgent(opts);
    return 0;
  }
  const info = {
    project: opts.project,
    id: sessionId(opts.role, opts.branch),
    run: opts.run || crypto.randomUUID().slice(0, 8),
    role: opts.role,
    branch: opts.branch,
    cwd: process.cwd(),
  };
  return supervise(info, (tracker) => startAgent({ ...opts, run: info.run }, tracker));
}

async function startAgent(opts: AgentOptions, tracker?: Tracker): Promise<void> {
  const epoch = launchEpoch(opts.project, sessionId(opts.role, opts.branch), opts.run!) ?? execution.epoch(opts.project);
  const cancellation = new AbortController();
  const unwatch = watchCancellation(opts.project, sessionId(opts.role, opts.branch), cancellation, opts.run!);
  try { await agentSession(opts, cancellation.signal, tracker, epoch); }
  catch (error) {
    if (cancellation.signal.aborted) {
      for (const p of await listProcesses(opts.project)) if (p.owner === sessionId(opts.role, opts.branch) && liveProcess(p)) await controlProcess(opts.project, p.id, "stop").catch(() => {});
    }
    throw cancellation.signal.aborted ? cancellation.signal.reason : error;
  }
  finally { unwatch(); }
}

async function agentSession(opts: AgentOptions, signal: AbortSignal, tracker: Tracker | undefined, epoch: string): Promise<void> {
  const config = await loadConfig();
  const model = await effectiveModel(opts.project, opts.role); // this role's model: its /model override, else the project model
  // One transcript per role per branch, so a restart resumes it. spawn seeds
  // it with the prompt before starting this process.
  const transcript = open(paths.transcript(opts.project, sessionId(opts.role, opts.branch)));
  if (transcript.head() === null) {
    if (opts.branch) throw new Error(`agent: no transcript for ${sessionId(opts.role, opts.branch)}; spawn seeds it`);
    await transcript.append({ type: "meta", role: opts.role, model });
  }

  const tools: Record<string, Tool<ToolResult>> = {};
  for (const name of toolsFor[opts.role]) {
    const tool = registry[name];
    if (tool) tools[name] = editableTool(tool);
  }

  const agent = createAgent({
    signal,
    loadContext: query => agentKnowledge(opts.project, process.cwd(), query),
    toolConcurrency: config.toolConcurrency,
    resolveModel: projectModelResolver(opts.project, opts.loadProvider, opts.role), // worker or reviewer: that role's override applies
    transcript,
    tools,
    model,
    compaction: { enabled: config.compact, fallback: config.contextLimitFallback, triggerTokens: config.workerContextTokens },
    system: rolePrompt(opts.role, { ...config, ...await effectiveFlow(opts.project, config) }), // this project's review rounds and dispatch, not config.toml's
    ctx: { run: opts.run, project: opts.project, role: opts.role, branch: opts.branch, cwd: process.cwd(), executionEpoch: epoch },
    tracker,
  });
  // Wait in the runtime, not through model polling. A worker remains responsive
  // to feedback while its commands execute; the existing agent loop consumes events.
  const id = sessionId(opts.role, opts.branch);
  for (;;) {
    await agent.run();
    let waiting = false;
    while (!await pending(opts.project, id)) {
      signal.throwIfAborted();
      await reconcileProcesses(opts.project);
      if (!(await recoverableProcesses(opts.project)).some(p => p.owner === id && liveProcess(p))) {
        if (!await pending(opts.project, id)) return;
        break;
      }
      if (!waiting) { await tracker?.waiting?.(); waiting = true; }
      await Bun.sleep(200);
    }
  }
}
