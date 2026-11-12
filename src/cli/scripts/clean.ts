import { join } from "node:path";
import { conversationIds, paths } from "../../config";
import { pruneBuildScratch } from "../../core/install";
import { cleanup } from "../../core/tmux";
import { listVerifications, pruneSettledProcesses } from "../../core/data/processes";
import { workspaces } from "../../core/data/projects";
import { pruneProjectOutputs } from "../../core/tools/bash";

/** The caller selects preview or deletion explicitly; only owned disposable resources qualify. */
export async function cleanStorage(apply: boolean) {
  const changes: { path: string; disposition: string }[] = [];
  const current = conversationIds(paths.root);
  const projects = new Set([...current, ...workspaces.list().filter(w => !w.cleanedAt).map(w => w.members[0]!.project)]);
  for (const project of projects) {
    try {
      if (current.includes(project)) for (const v of await listVerifications(project)) changes.push({ path: v.id, disposition: `verification ${v.state}` });
      // One preview overlay for both: the outputs discovery would register count as registered here too.
      const inspect = async () => {
        changes.push(...await cleanup.cleanManagedWorkspaces(project, apply));
        if (current.includes(project)) changes.push(...await pruneProjectOutputs(project, apply));
      };
      await (apply ? inspect() : workspaces.preview(inspect));
      if (current.includes(project)) changes.push(...await pruneSettledProcesses(project, apply));
    } catch (error) { changes.push({ path: project, disposition: `kept: inspection failed (${error})` }); }
  }
  changes.push(...await pruneBuildScratch(join(paths.runtime, "app"), apply));
  return changes;
}
