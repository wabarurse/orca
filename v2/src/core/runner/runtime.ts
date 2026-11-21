import { mkdir } from "node:fs/promises";
import { fail, loadConfig, ok, parseJson, paths, saveConfig, type Result } from "../../config";
import { askUser } from "../confirm";
import { readConversation } from "../conversations";
import { put } from "../inbox";
import { assemble } from "../plugins/assemble";
import { availablePlugins } from "../plugins/loader";
import { enabledNames } from "../plugins/enable";
import type { Runner } from "../plugins/types";
import { settled, type AgentInfo, type Runtime, type SpawnRequest } from "../tools/registry";
import { agentEnv } from "../tools/bash";
import { ensureDataDirs } from "../bubbles";
import { trustState } from "../trust";
import { plainRunner } from "./plain";
import { listRuns, live, newRun, readRun, updateRun, writeRun, type RunRecord } from "./runs";
import { slug, workspaceFor } from "./worktree";
import { z } from "zod";

export function selfCommand(): string[] {
  const forced = process.env.ORCA2_SELF;
  if (forced !== undefined && forced.length > 0) {
    const json = parseJson(forced);
    const command = json.ok ? z.array(z.string()).min(1).safeParse(json.data) : null;
    if (command === null || !command.success) throw new Error("ORCA2_SELF must be a JSON list of strings (the command that runs orca2)");
    return command.data;
  }
  const script = process.argv[1];
  return script !== undefined && script.endsWith(".ts") ? [process.execPath, script] : [process.execPath];
}

export async function runners(conversation: string): Promise<Runner[]> {
  const meta = await readConversation(conversation);
  const directory = meta?.directory ?? null;
  const trusted = directory === null ? false : await trustState(directory) === "trusted";
  const { plugins } = await availablePlugins(directory, trusted);
  const out: Runner[] = [plainRunner];
  for (const name of await enabledNames(conversation)) {
    const background = await plugins.get(name)?.background();
    const runner = background?.ok === true ? background.data?.runner ?? null : null;
    if (runner !== null) out.push(runner);
  }
  return out;
}

export async function runnerNames(conversation: string): Promise<string[]> {
  return [...new Set((await runners(conversation)).map(r => r.name))];
}

export async function chooseRunner(conversation: string, name: string): Promise<Result<string>> {
  const names = await runnerNames(conversation);
  if (!names.includes(name)) return fail(`unknown runner ${name}; choose ${names.join(", ")}`);
  await saveConfig({ runner: name });
  return ok(name);
}

export async function selectedRunner(conversation: string): Promise<Runner> {
  const wanted = (await loadConfig()).runner;
  return (await runners(conversation)).find(r => r.name === wanted) ?? plainRunner;
}

export const toInfo = (run: RunRecord): AgentInfo => ({ agent: run.agent, role: run.role, bundle: run.bundle, branch: run.branch, state: run.state, pid: run.pid,
  runner: run.runner, startedAt: run.startedAt, endedAt: run.endedAt, log: run.log, lastTool: run.lastTool });

export async function launch(record: RunRecord, cwd: string, extra: string[], command: "agent" | "daemon" = "agent"): Promise<Result<RunRecord>> {
  const runner = (await runners(record.conversation)).find(r => r.name === record.runner) ?? plainRunner;
  const data = await ensureDataDirs(record.conversation);
  if (!data.ok) return data;
  const argv = [...selfCommand(), command, "--conversation", record.conversation, "--agent", record.agent, "--run", record.run, ...extra];
  await mkdir(paths.logs(record.conversation), { recursive: true, mode: 0o700 });
  const { handle, pid } = await runner.start({ conversation: record.conversation, agent: record.agent, argv, cwd, env: agentEnv(record.conversation, record.agent, data.data), log: record.log });
  return ok((await updateRun(record.conversation, record.agent, { handle, pid: pid ?? record.pid })) ?? record);
}

export async function stopAgent(conversation: string, agent: string): Promise<string> {
  const run = await readRun(conversation, agent);
  if (run === null) return `no agent ${agent}`;
  if (!live(run)) return `${agent} is not running (${run.state})`;
  const runner = (await runners(conversation)).find(r => r.name === run.runner) ?? plainRunner;
  await runner.stop(conversation, agent);
  await updateRun(conversation, agent, { state: "stopped", endedAt: new Date().toISOString() });
  return `stopped ${agent}`;
}

export function runtimeFor(conversation: string, self: string, confirm: (question: string) => Promise<boolean>): Runtime {
  return {
    async spawn(request: SpawnRequest): Promise<AgentInfo> {
      const meta = await readConversation(conversation);
      if (meta === null) throw new Error(`no conversation ${conversation}`);
      const trusted = await trustState(meta.directory) === "trusted";
      const shape = settled(await assemble({ conversation, agent: "check", bundle: request.bundle, branch: request.branch, cwd: meta.directory, directory: meta.directory, trusted }));
      const prefix = shape.bundle.name === "orchestrator" ? null : shape.bundle.name;
      if (prefix === null) throw new Error("the orchestrator bundle cannot be spawned");
      const agent = `${prefix}-${slug(request.branch)}`;
      const existing = await readRun(conversation, agent);
      if (existing !== null && live(existing)) {
        await put(conversation, agent, self, request.brief, { images: request.images, delivery: "steer" });
        return { ...toInfo(existing), state: "running" };
      }
      const cwd = settled(await workspaceFor(conversation, meta.directory, request.branch));
      await put(conversation, agent, self, request.brief, { images: request.images, delivery: "steer" });
      const record = newRun({ conversation, agent, role: shape.bundle.role, bundle: shape.bundle.name, branch: request.branch, runner: (await selectedRunner(conversation)).name });
      await writeRun(record);
      const started = settled(await launch(record, cwd, ["--bundle", shape.bundle.name, "--branch", request.branch, "--cwd", cwd, ...(request.fresh ? ["--fresh"] : [])]));
      return toInfo(started);
    },
    async agents() {
      return (await listRuns(conversation)).filter(run => run.agent !== "orchestrator").map(run => ({ ...toInfo(run), state: run.state === "running" && !live(run) ? "exited" : run.state }));
    },
    stop: agent => stopAgent(conversation, agent),
    confirm,
  };
}

export const fileConfirm = (conversation: string, agent: string, signal: AbortSignal) => (question: string): Promise<boolean> => askUser(conversation, agent, question, signal);
