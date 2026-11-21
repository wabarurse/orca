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
import { errorMessage, fail, ok, type Result } from "../config";

export async function runBackgroundHooks(conversation: string, which: "stop" | "remove", log: (text: string) => void): Promise<void> {
  const meta = await readConversation(conversation);
  if (meta === null) return;
  const { plugins } = await availablePlugins(meta.directory, await trustState(meta.directory) === "trusted");
  for (const name of await enabledNames(conversation)) {
    const loaded = plugins.get(name);
    const background = loaded === undefined ? ok(null) : await loaded.background();
    if (!background.ok) { log(`${name} ${which}: ${background.error}\n`); continue; }
    const hook: BackgroundHook | null = background.data === null ? null : background.data[which];
    if (hook === null) continue;
    const ctx = backgroundContext(conversation, name, meta.directory);
    await hook(ctx).catch((error: unknown) => { log(`${name} ${which}: ${errorMessage(error)}\n`); });
  }
}

export async function removeConversation(conversation: string, log: (text: string) => void): Promise<Result<null>> {
  const meta = await readConversation(conversation);
  if (meta === null) return fail(`no conversation ${conversation}`);
  await stopDaemon(conversation);
  for (const run of await listRuns(conversation)) if (live(run)) await stopAgent(conversation, run.agent);
  await runBackgroundHooks(conversation, "remove", log);
  const deleted = await deleteConversation(conversation);
  if (!deleted.ok) return deleted;
  await pruneWorktrees(meta.directory);
  return ok(null);
}
