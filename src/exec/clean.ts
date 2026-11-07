import { join } from "node:path";
import { conversationIds, paths } from "../config";
import { pruneBuildScratch } from "../core/install";
import { cleanManagedWorkspaces } from "../core/tmux";
import { listVerifications, reconcileVerifications, pruneSettledProcesses } from "../core/data/processes";

/** Inspect by default. Applying is restricted to Orca-owned disposable resources. */
export async function cleanStorage(apply = false) {
  const changes: { path: string; disposition: string }[] = [];
  for (const project of conversationIds(paths.root)) {
    try {
      if (apply) await reconcileVerifications(project, undefined, undefined, true);
      for (const v of await listVerifications(project)) changes.push({ path: v.id, disposition: `verification ${v.state}` });
      changes.push(...await cleanManagedWorkspaces(project, apply));
      changes.push(...await pruneSettledProcesses(project, apply));
    } catch (error) { changes.push({ path: project, disposition: `kept: inspection failed (${error})` }); }
  }
  changes.push(...await pruneBuildScratch(join(paths.runtime, "app"), apply));
  return changes;
}
