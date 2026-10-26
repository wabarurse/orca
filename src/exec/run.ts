// The `orca agent` process: runAgent publishes the launch, supervises a worker or
// reviewer (run record, exit notice on a crash) and runs one agent session over
// the loop in core/agent-loop/loop/agent.ts. The orchestrator role hands over to
// the daemon entry (./daemon).

import { loadConfig, paths } from "../config/config";
import { createAgent, type AgentOptions } from "../core/agent-loop/loop/agent";
import { effectiveFlow } from "../core/data/projects/flow";
import { effectiveModel, projectModelResolver } from "../core/data/projects/project-model";
import { open } from "../core/data/transcripts/transcript";
import { rolePrompt } from "../core/prompt/shared";
import { publishLaunch, watchCancellation } from "../core/tmux/cancellation";
import { supervise, type Tracker } from "../core/tmux/exits";
import { sessionId } from "../core/tmux/runner";
import { registry } from "../core/tools/index";
import { toolsFor, type Tool } from "../core/tools/registry";

/**
 * Run an agent process. Workers and reviewers are supervised: a crash or an
 * exit without a report sends an `[agent-exit]` notice to the orchestrator.
 * Returns the process exit code.
 */
export async function runAgent(opts: AgentOptions): Promise<number> {
  const run = opts.run ?? crypto.randomUUID();
  if (!opts.run) publishLaunch(opts.project, sessionId(opts.role, opts.branch), run);
  opts = { ...opts, run };
  if (opts.role === "orchestrator") {
    // The long-lived daemon loop; imported lazily so a worker process never loads it.
    const { orchestratorAgent } = await import("./daemon");
    return orchestratorAgent({ ...opts, run });
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
  const cancellation = new AbortController();
  const unwatch = watchCancellation(opts.project, sessionId(opts.role, opts.branch), cancellation, opts.run!);
  try { await agentSession(opts, cancellation.signal, tracker); }
  catch (error) { throw cancellation.signal.aborted ? cancellation.signal.reason : error; }
  finally { unwatch(); }
}

async function agentSession(opts: AgentOptions, signal: AbortSignal, tracker?: Tracker): Promise<void> {
  const config = await loadConfig();
  const model = await effectiveModel(opts.project);
  // One transcript per role per branch, so a restart resumes it. spawn seeds
  // it with the prompt before starting this process.
  const transcript = open(paths.transcript(opts.project, sessionId(opts.role, opts.branch)));
  if (transcript.head() === null) {
    if (opts.branch) throw new Error(`agent: no transcript for ${sessionId(opts.role, opts.branch)}; spawn seeds it`);
    await transcript.append({ type: "meta", role: opts.role, model });
  }

  const tools: Record<string, Tool> = {};
  for (const name of toolsFor[opts.role]) {
    const tool = registry[name];
    if (tool) tools[name] = tool;
  }

  const agent = createAgent({
    signal,
    toolConcurrency: config.toolConcurrency,
    resolveModel: projectModelResolver(opts.project, opts.loadProvider),
    transcript,
    tools,
    model,
    compaction: { enabled: config.compact, fallback: config.contextLimitFallback },
    system: rolePrompt(opts.role, { ...config, ...await effectiveFlow(opts.project, config) }), // this project's review rounds and dispatch, not config.toml's
    ctx: { run: opts.run, project: opts.project, role: opts.role, branch: opts.branch, cwd: process.cwd() },
    tracker,
  });
  await agent.run();
}
