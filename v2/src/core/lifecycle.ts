import { pluginData } from "./bubbles";
import { deleteConversation, readConversation } from "./conversations";
import { stopDaemon } from "./daemon/client";
import { put } from "./inbox";
import { enabledNames } from "./plugins/enable";
import { availablePlugins } from "./plugins/loader";
import type { BackgroundContext, BackgroundHook } from "./plugins/types";
import { stopAgent } from "./runner/runtime";
import { listRuns, live } from "./runner/runs";
import { pruneWorktrees } from "./runner/worktree";
import { errorMessage } from "./result";
import { trustState } from "./trust";

export async function runBackgroundHooks(conversation: string, which: "stop" | "remove", log: (text: string) => void): Promise<void> {
  const meta = await readConversation(conversation);
  if (meta === null) return;
  const { plugins } = await availablePlugins(meta.directory, await trustState(meta.directory) === "trusted");
  for (const name of await enabledNames(conversation)) {
    const background = await plugins.get(name)?.background().catch(() => null) ?? null;
    const hook: BackgroundHook | null = background === null ? null : background[which];
    if (hook === null) continue;
    const ctx: BackgroundContext = { plugin: name, conversation, directory: meta.directory, data: scope => pluginData(conversation, name, scope),
      notify: async text => { await put(conversation, "orchestrator", name, text, { images: [], delivery: "steer" }); } };
    await hook(ctx).catch((error: unknown) => { log(`${name} ${which}: ${errorMessage(error)}\n`); });
  }
}

export async function removeConversation(conversation: string, log: (text: string) => void): Promise<void> {
  const meta = await readConversation(conversation);
  if (meta === null) throw new Error(`no conversation ${conversation}`);
  await stopDaemon(conversation);
  for (const run of await listRuns(conversation)) if (live(run)) await stopAgent(conversation, run.agent);
  await runBackgroundHooks(conversation, "remove", log);
  const deleted = await deleteConversation(conversation);
  if (!deleted.ok) throw new Error(deleted.error);
  await pruneWorktrees(meta.directory);
}
