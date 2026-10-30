// Merge observation is read-only with respect to agents, workspaces and branches.
// A linked PR updates its task and emits a durable notification; cleanup is explicit work.
import { allTasks, ghTaskPR, observeTaskPR, originRepo } from "../data/tasks";
import { observe } from "../data/inbox";
import type { PRObservation, TaskPR } from "../../protocol/task";

export const MERGE_POLL_MS = 30_000;
export interface MergeWatchOptions {
  repo?: typeof originRepo;
  pr?: (project: string, pr: TaskPR) => Promise<PRObservation | null>;
  now?: () => number;
  everyMs?: number;
}

/** Poll only PRs linked to this project's task list, coalescing shared PRs.
 * No tmux queries, branch mutation, agent termination, fetch/rebase or CI workflow. */
export function mergeWatcher(opts: MergeWatchOptions = {}) {
  const last = new Map<string, number>(), busy = new Set<string>();
  const now = opts.now ?? Date.now, every = opts.everyMs ?? MERGE_POLL_MS;
  return async (project: string): Promise<number[]> => {
    if (busy.has(project) || now() - (last.get(project) ?? -Infinity) < every) return [];
    busy.add(project); last.set(project, now());
    try {
      const tasks = (await allTasks(project)).filter(t => !t.removedAt && t.pr);
      if (!tasks.length) return []; // No remote calls for conversations with no tracked PRs.
      const repository = await (opts.repo ?? originRepo)(project);
      if (!repository) return [];
      const observations = new Map<string, PRObservation | null>(), merged = new Set<number>();
      for (const task of tasks) {
        const pr = task.pr!;
        if (pr.repository !== repository.toLowerCase()) continue;
        const key = `${pr.repository}#${pr.number}`;
        if (task.archive) {
          // Also drains a notification left pending by a crash after task publication.
          await observe(project, `merge:${key}`, task.archive.mergedAt,
            `[pr-merged] PR #${pr.number} (${task.branch}) merged: ${pr.url}. Task recorded as merged; workspace and agents are preserved.`, { existingOnly: true });
          continue;
        }
        if (!observations.has(key)) observations.set(key, await (opts.pr ?? ghTaskPR)(project, pr).catch(() => null));
        const observation = observations.get(key);
        if (!observation) continue; // Unknown is not a merge or permission to act.
        // Commit task state before delivering its notification. Identity/head checks
        // remain in observeTaskPR; foreign or mismatched observations are refused.
        if (observation.state === "MERGED" && observation.mergedAt && observation.branch === task.branch
          && observation.pr.repository === pr.repository && observation.pr.number === pr.number) {
          // Stage the outbox before archiving. A restart drains existing events,
          // never inventing notifications for every historical merged task.
          await observe(project, `merge:${key}`, observation.mergedAt,
            `[pr-merged] PR #${pr.number} (${task.branch}) merged: ${pr.url}. Task recorded as merged; workspace and agents are preserved.`, { defer: true });
        }
        const updated = await observeTaskPR(project, task.id, observation, task.revision);
        if (updated.archive) {
          await observe(project, `merge:${key}`, updated.archive.mergedAt,
            `[pr-merged] PR #${pr.number} (${task.branch}) merged: ${pr.url}. Task recorded as merged; workspace and agents are preserved.`);
          merged.add(pr.number);
        }
      }
      return [...merged];
    } finally { busy.delete(project); }
  };
}
