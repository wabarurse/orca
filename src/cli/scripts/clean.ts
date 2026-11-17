import { join } from "node:path";
import { conversationIds, paths } from "../../config";
import { pruneBuildScratch } from "../../core/install";
import { cleanup } from "../../core/tmux";
import { listVerifications, pruneSettledProcesses } from "../../core/data/processes";
import { workspaces } from "../../core/data/projects";
import { ARCHIVE_DAYS, listBubbles, orphanBubbles, purgeNotebook, removeBubble } from "../../core/data/bubbles";
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
  // Bubbles: notebook pages archived longer than the retention go, and so does a bubble no conversation is attached to.
  try {
    const orphans = await orphanBubbles();
    for (const bubble of orphans) {
      if (apply) await removeBubble(bubble.id);
      changes.push({ path: join(paths.bubbles, bubble.id), disposition: `${apply ? "removed" : "would remove"}: bubble "${bubble.name}" has no conversation` });
    }
    for (const bubble of (await listBubbles()).filter(b => !orphans.some(o => o.id === b.id))) {
      for (const page of await purgeNotebook(bubble.id, Date.now(), ARCHIVE_DAYS, apply)) {
        changes.push({ path: join(paths.bubbles, bubble.id, "notebook", page.id), disposition: `${apply ? "removed" : "would remove"}: notebook page "${page.title}" archived over ${ARCHIVE_DAYS} days ago` });
      }
    }
  } catch (error) { changes.push({ path: paths.bubbles, disposition: `kept: inspection failed (${error})` }); }
  changes.push(...await pruneBuildScratch(join(paths.runtime, "app"), apply));
  return changes;
}
