// One shared, read-only PR observer. Agents register interest; the runtime owns
// the lifetime and notifications, without keeping workers or shell loops alive.
import { allTasks, ghTaskPR, observeTaskPR, originRepo } from "../data/tasks";
import { observe } from "../data/inbox";
import { listProcesses, liveProcess, prWatchEnabled, readProcess, saveProcess, type ProcessRecord } from "../data/processes";
import { execution } from "../data/projects/lifecycle";
import type { PRObservation, Task, TaskPR } from "../../protocol/task";

export const MERGE_POLL_MS = 30_000;
export interface MergeWatchOptions {
  repo?: typeof originRepo;
  pr?: (project: string, pr: TaskPR) => Promise<PRObservation | null>;
  now?: () => number;
  everyMs?: number;
}

export function mergeWatcher(opts: MergeWatchOptions = {}) {
  const last = new Map<string, number>(), busy = new Set<string>();
  const now = opts.now ?? Date.now, every = opts.everyMs ?? MERGE_POLL_MS;
  return async (project: string): Promise<number[]> => {
    if (execution.stopped(project) || busy.has(project) || now() - (last.get(project) ?? -Infinity) < every) return [];
    const epoch = execution.epoch(project), guard = () => execution.assertActive(project, epoch);
    busy.add(project); last.set(project, now());
    try {
      const tasks = (await allTasks(project)).filter(t => !t.removedAt && t.pr);
      const registrations = (await listProcesses(project)).filter(p => p.prWatch && p.watchEpoch === epoch);
      const watches = registrations.filter(liveProcess);
      if (!tasks.length && !watches.length) return [];
      const repository = await (opts.repo ?? originRepo)(project);
      if (!repository) return [];
      const groups = new Map<string, { pr: TaskPR; tasks: Task[]; watches: ProcessRecord[] }>();
      const group = (pr: TaskPR) => {
        const key = `${pr.repository}#${pr.number}`;
        if (!groups.has(key)) groups.set(key, { pr, tasks: [], watches: [] });
        return groups.get(key)!;
      };
      for (const task of tasks) {
        const pr = task.pr!;
        if (pr.repository !== repository.toLowerCase()) continue;
        if (!prWatchEnabled(project, pr)) continue;
        if (task.archive) {
          await observe(project, `merge:${pr.repository}#${pr.number}`, task.archive.mergedAt,
            `[pr-merged] PR #${pr.number} merged: ${pr.url}. Workspace and agents are preserved.`, { existingOnly: true, beforePublish: guard });
        } else group(pr).tasks.push(task);
      }
      for (const p of watches) if (p.prChecks?.repository === repository.toLowerCase() && prWatchEnabled(project, p.prChecks)) {
        const pr = p.prChecks;
        group({ ...pr, url: `https://github.com/${pr.repository}/pull/${pr.number}` }).watches.push(p);
      }
      const merged = new Set<number>();
      for (const [key, entry] of groups) {
        guard();
        const observation = await (opts.pr ?? ghTaskPR)(project, entry.pr).catch(() => null);
        guard();
        if (!prWatchEnabled(project, entry.pr)) continue;
        if (!observation || observation.pr.repository !== entry.pr.repository || observation.pr.number !== entry.pr.number) continue;
        const matching = entry.tasks.filter(t => t.branch === observation.branch);
        const currentWatches = await Promise.all(entry.watches.map(p => readProcess(project, p.id).catch(error => { if (error.code === "ENOENT") return undefined; throw error; })));
        if (entry.watches.length && !currentWatches.some(p => p && liveProcess(p) && p.watchEpoch === epoch)) continue;
        // A linked task must still match its branch; foreign snapshots cannot
        // publish a notification or mutate its state. Explicit watches use PR ID.
        if (!matching.length && !entry.watches.length) continue;
        const pr = observation.pr;
        const mergeText = `[pr-merged] PR #${pr.number} merged: ${pr.url}. Workspace and agents are preserved.`;
        if (observation.state === "MERGED") {
          if (!observation.mergedAt) continue;
          await observe(project, `merge:${key}`, observation.mergedAt, mergeText, { defer: true, beforePublish: guard });
        }
        for (const task of matching) await observeTaskPR(project, task.id, observation, task.revision);
        if (observation.state === "MERGED") {
          await observe(project, `merge:${key}`, observation.mergedAt, mergeText, { beforePublish: guard });
          merged.add(pr.number);
        } else {
          const value = { state: observation.state, head: pr.head, checks: observation.checks,
            review: observation.reviewDecision ?? "unknown", reviewActivity: observation.reviewActivity, mergeable: observation.mergeable ?? "unknown" };
          const text = `[pr-${observation.state === "CLOSED" ? "closed" : "updated"}] PR #${pr.number}: ${observation.state.toLowerCase()}; head ${pr.head}; checks ${value.checks}; review ${value.review || "none"}; mergeable ${value.mergeable}. PR state or review/comment activity changed; inspect relevant feedback if needed. ${pr.url}. Observation only; no command was started or retried.`;
          await observe(project, `pr:${key}`, value, text, {
            initialSilent: !entry.watches.length && observation.state === "OPEN" && observation.checks !== "failed" &&
              observation.reviewDecision !== "CHANGES_REQUESTED" && matching.every(t => t.pr?.head === pr.head),
            beforePublish: guard,
          });
        }
        // Stop only the shared registration, never a worker, branch or command.
        for (const watch of currentWatches) {
          if (!watch) continue;
          const p = await readProcess(project, watch.id).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
          if (!p) continue;
          if (!liveProcess(p) || p.watchEpoch !== epoch) continue;
          if (p.prChecks?.head !== pr.head || observation.state !== "OPEN") {
            p.prChecks = { repository: pr.repository, number: pr.number, head: pr.head };
            p.updatedAt = new Date().toISOString();
            if (observation.state !== "OPEN") { p.state = "exited"; p.reason = `PR ${observation.state.toLowerCase()}`; }
            await saveProcess(p);
          }
        }
      }
      return [...merged];
    } finally { busy.delete(project); }
  };
}
