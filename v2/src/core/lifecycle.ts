// The ends of a conversation: its plugins' background `stop` (the daemon stopping) and `remove` (the conversation
// deleted) hooks, and deletion itself: daemon and agents stopped, hooks run, folders and worktrees removed.
import { deleteConversation, readConversation } from "./conversations";
import { stopDaemon } from "./daemon/client";
import { enabledNames } from "./plugins/enable";
import { availablePlugins } from "./plugins/loader";
import type { BackgroundHook } from "./plugins/types";
import { backgroundContext } from "./plugins/context";
import { stopAgent } from "./runner/runtime";
import { listRuns, live } from "./runner/runs";
import { pruneWorktrees } from "./runner/worktree";
import { trustState } from "./trust";

/** Run one background hook of every enabled plugin; a failing hook is reported, never fatal. */
export async function runBackgroundHooks(conversation: string, which: "stop" | "remove", log: (text: string) => void): Promise<void> {
  const meta = await readConversation(conversation);
  if (meta === null) return;
  const { plugins } = await availablePlugins(meta.directory, await trustState(meta.directory) === "trusted");
  for (const name of await enabledNames(conversation)) {
    const background = await plugins.get(name)?.background().catch(() => null) ?? null;
    const hook: BackgroundHook | null = background === null ? null : background[which];
    if (hook === null) continue;
    const ctx = backgroundContext(conversation, name, meta.directory);
    await hook(ctx).catch((error: unknown) => { log(`${name} ${which}: ${error instanceof Error ? error.message : String(error)}\n`); });
  }
}

export async function removeConversation(conversation: string, log: (text: string) => void): Promise<void> {
  const meta = await readConversation(conversation);
  if (meta === null) throw new Error(`no conversation ${conversation}`);
  await stopDaemon(conversation);
  for (const run of await listRuns(conversation)) if (live(run)) await stopAgent(conversation, run.agent);
  await runBackgroundHooks(conversation, "remove", log);
  await deleteConversation(conversation);
  await pruneWorktrees(meta.directory);
}
