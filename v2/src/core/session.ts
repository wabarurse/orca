// One agent run, assembled: its conversation, bundle, plugins, transcript, model and loop.
import { rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { provider as loadProvider } from "../api";
import { providerFor } from "../api/model";
import { loadConfig, paths } from "../config";
import { ensureDataDirs } from "./bubbles";
import { readConversation } from "./conversations";
import { referenceSections } from "./knowledge";
import { createAgent, type Resolved, type RunResult } from "./loop/agent";
import { RollingCompactor } from "./loop/rolling";
import { assemble, type Assembled } from "./plugins/assemble";
import type { BackgroundContext } from "./plugins/types";
import type { Runtime } from "./tools/registry";
import { openTranscript, type Transcript } from "./transcript";
import { trustState } from "./trust";
import type { AgentEvent } from "./types";
import { put } from "./inbox";
import { pluginData } from "./bubbles";

export type SessionInput = {
  conversation: string;
  agent: string;
  bundle: string;
  branch: string | null;
  /** The working folder; null uses the conversation's folder. */
  cwd: string | null;
  fresh: boolean;
  requireInput: boolean;
  emit: (event: AgentEvent) => void;
  signal: AbortSignal;
  runtime: Runtime;
  compactRequested: () => boolean;
  /** Overrides the model for this run (headless --model); null uses the conversation's or the config's. */
  model: string | null;
  /** The daemon keeps its transcript and background memory across turns; null opens them fresh. */
  keep: { transcript: Transcript; rolling: RollingCompactor | null } | null;
};

export type Session = { assembled: Assembled; transcript: Transcript; run: () => Promise<RunResult>; rolling: RollingCompactor | null };

/** The model, provider and settings a request uses now. */
export async function resolveModel(conversation: string, override: string | null): Promise<Resolved> {
  const config = await loadConfig();
  const meta = await readConversation(conversation);
  const model = override ?? meta?.model ?? config.model;
  const name = providerFor(model);
  const provider = await loadProvider(name, { profile: name === "anthropic" ? config.account : config.openaiAccount });
  return { model, provider, settings: null, contextLimit: null };
}

export async function openSession(input: SessionInput): Promise<Session> {
  const meta = await readConversation(input.conversation);
  if (meta === null) throw new Error(`no conversation ${input.conversation}`);
  const cwd = input.cwd ?? meta.directory;
  const trusted = await trustState(meta.directory) === "trusted";
  const assembled = await assemble({ conversation: input.conversation, agent: input.agent, bundle: input.bundle, cwd, directory: meta.directory, trusted });
  for (const problem of assembled.problems) input.emit({ kind: "notice", text: `plugin ${problem.name}: ${problem.problem}` });
  const path = paths.transcript(input.conversation, input.agent);
  if (input.fresh && existsSync(path)) await rename(path, path.replace(/\.jsonl$/, `.${Date.now()}.jsonl`));
  const transcript = input.keep?.transcript ?? openTranscript(path);
  transcript.refresh();
  const data = await ensureDataDirs(input.conversation);
  const config = await loadConfig();
  let rolling: RollingCompactor | null = input.keep?.rolling ?? null;
  if (assembled.bundle.role === "orchestrator" && rolling === null) {
    const sections = [];
    for (const loaded of assembled.plugins) {
      const memory = (await loaded.background())?.memory ?? null;
      if (memory === null) continue;
      const ctx: BackgroundContext = { plugin: loaded.plugin.name, conversation: input.conversation, directory: meta.directory,
        data: scope => pluginData(input.conversation, loaded.plugin.name, scope),
        notify: async text => { await put(input.conversation, "orchestrator", loaded.plugin.name, text, { images: [], delivery: "steer" }); } };
      sections.push({ title: memory.title, text: () => memory.text(ctx) });
    }
    rolling = new RollingCompactor(input.conversation, transcript, { small: config.smallSummaries, triggerTokens: null, tailTokens: null, sections });
  }
  const first = await resolveModel(input.conversation, input.model);
  const plugins = assembled.plugins.map(p => p.plugin.name);
  const last = transcript.all().findLast(entry => entry.type === "meta");
  if (last?.type !== "meta" || last.model !== first.model || last.plugins.join(",") !== plugins.join(","))
    await transcript.append({ type: "meta", role: assembled.bundle.role, agent: input.agent, model: first.model, plugins });
  input.emit({ kind: "start", agent: input.agent, role: assembled.bundle.role, model: first.model });
  const agent = createAgent({
    conversation: input.conversation, agent: input.agent, role: assembled.bundle.role, branch: input.branch, cwd, data, trusted,
    pluginSkills: assembled.skills, transcript, tools: assembled.tools, system: assembled.system,
    resolve: () => resolveModel(input.conversation, input.model),
    context: query => referenceSections({ conversation: input.conversation, role: assembled.bundle.role, cwd, trusted, pluginSkills: assembled.skills, query }),
    hooks: assembled.hooks, runtime: input.runtime, emit: input.emit, signal: input.signal, concurrency: config.toolConcurrency,
    rolling, requireInput: input.requireInput, compactRequested: input.compactRequested,
  });
  return { assembled, transcript, run: agent.run, rolling };
}
