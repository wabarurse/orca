import { rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { provider as loadProvider } from "../api";
import { providerFor } from "../api/model";
import { fail, loadConfig, ok, paths, type Result } from "../config";
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
import { scriptedProvider } from "./scripted";
import { ensureBuiltinSkills } from "./builtin-skills";
import { spanRecorder, type Spans } from "./spans";

export type SessionInput = {
  conversation: string;
  agent: string;
  bundle: string;
  branch: string | null;
  cwd: string | null;
  fresh: boolean;
  requireInput: boolean;
  emit: (event: AgentEvent) => void;
  signal: AbortSignal;
  runtime: Runtime;
  compactRequested: () => boolean;
  model: string | null;
  keep: { transcript: Transcript; rolling: RollingCompactor | null } | null;
  resolve: (() => Promise<Result<Resolved>>) | null;
};

export type Session = { assembled: Assembled; transcript: Transcript; run: () => Promise<RunResult>; rolling: RollingCompactor | null };

export async function resolveModel(conversation: string, override: string | null): Promise<Result<Resolved>> {
  const config = await loadConfig();
  const meta = await readConversation(conversation);
  const model = override ?? meta?.model ?? config.model;
  const scripted = process.env.ORCA2_SCRIPTED;
  if (scripted !== undefined && scripted.length > 0) return ok({ model, provider: scriptedProvider(scripted), settings: null, contextLimit: null });
  const name = providerFor(model);
  const provider = await loadProvider(name, { profile: name === "anthropic" ? config.account : config.openaiAccount });
  return provider.ok ? ok({ model, provider: provider.data, settings: null, contextLimit: null }) : provider;
}

export async function openSession(input: SessionInput): Promise<Result<Session>> {
  const spans = spanRecorder(input.conversation, input.agent, input.emit);
  const opening = spans.begin("prep", "session", null, null);
  try { return await assembleSession(input, spans); }
  finally { opening.end({}); }
}

async function assembleSession(input: SessionInput, spans: Spans): Promise<Result<Session>> {
  const meta = await readConversation(input.conversation);
  if (meta === null) return fail(`no conversation ${input.conversation}`);
  const cwd = input.cwd ?? meta.directory;
  const trusted = await trustState(meta.directory) === "trusted";
  const shaped = await assemble({ conversation: input.conversation, agent: input.agent, bundle: input.bundle, cwd, directory: meta.directory, trusted });
  if (!shaped.ok) return shaped;
  const assembled = shaped.data;
  for (const problem of assembled.problems) input.emit({ kind: "notice", text: `plugin ${problem.name}: ${problem.problem}` });
  const path = paths.transcript(input.conversation, input.agent);
  if (input.fresh && existsSync(path)) await rename(path, path.replace(/\.jsonl$/, `.${Date.now()}.jsonl`));
  const transcript = input.keep?.transcript ?? openTranscript(path);
  transcript.refresh();
  const dataDirs = await ensureDataDirs(input.conversation);
  if (!dataDirs.ok) input.emit({ kind: "notice", text: dataDirs.error });
  const data = dataDirs.ok ? dataDirs.data : paths.data(input.conversation);
  const skills = [...assembled.skills, ...await ensureBuiltinSkills()];
  const config = await loadConfig();
  let rolling: RollingCompactor | null = input.keep?.rolling ?? null;
  if (assembled.bundle.role === "orchestrator" && rolling === null) {
    const sections = [];
    for (const loaded of assembled.plugins) {
      const background = await loaded.background();
      if (!background.ok) { input.emit({ kind: "notice", text: `plugin ${loaded.plugin.name}: ${background.error}` }); continue; }
      const memory = background.data?.memory ?? null;
      if (memory === null) continue;
      const ctx: BackgroundContext = { plugin: loaded.plugin.name, conversation: input.conversation, directory: meta.directory,
        data: scope => pluginData(input.conversation, loaded.plugin.name, scope),
        notify: async text => { await put(input.conversation, "orchestrator", loaded.plugin.name, text, { images: [], delivery: "steer" }); } };
      sections.push({ title: memory.title, text: () => memory.text(ctx) });
    }
    rolling = new RollingCompactor(input.conversation, transcript, { small: config.smallSummaries, triggerTokens: null, tailTokens: null, sections });
  }
  const resolve = input.resolve ?? (() => resolveModel(input.conversation, input.model));
  const resolved = await resolve();
  if (!resolved.ok) return resolved;
  const first = resolved.data;
  const plugins = assembled.plugins.map(p => p.plugin.name);
  const last = transcript.all().findLast(entry => entry.type === "meta");
  if (last?.type !== "meta" || last.model !== first.model || last.plugins.join(",") !== plugins.join(","))
    await transcript.append({ type: "meta", role: assembled.bundle.role, agent: input.agent, model: first.model, plugins });
  input.emit({ kind: "start", agent: input.agent, role: assembled.bundle.role, model: first.model });
  const agent = createAgent({
    conversation: input.conversation, agent: input.agent, role: assembled.bundle.role, branch: input.branch, cwd, data, trusted,
    pluginSkills: skills, transcript, tools: assembled.tools, system: assembled.system,
    resolve,
    context: query => referenceSections({ conversation: input.conversation, role: assembled.bundle.role, cwd, trusted, pluginSkills: skills, query }),
    hooks: assembled.hooks, guard: assembled.guard, runtime: input.runtime, emit: input.emit, signal: input.signal, concurrency: config.toolConcurrency,
    rolling, requireInput: input.requireInput, compactRequested: input.compactRequested, spans,
  });
  return ok({ assembled, transcript, run: agent.run, rolling });
}
