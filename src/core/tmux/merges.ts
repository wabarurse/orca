// One shared, read-only PR observer. Agents register interest; the runtime owns
// the lifetime and notifications, without keeping workers or shell loops alive.
import { allTasks, getTask, ghTaskPR, observeTaskPR, originRepo } from "../data/tasks";
import { observe, discardObservation, flushObservations } from "../data/inbox";
import { listProcesses, liveProcess, prWatchEnabled, readProcess, saveProcess, type ProcessRecord } from "../data/processes";
import { execution } from "../data/projects/lifecycle";
import type { PRObservation, Task, TaskPR } from "../../protocol/task";
import { paths } from "../../config";
import { join } from "node:path";
import { tryStorageLock } from "../data";
import { activePRTask, notificationValue } from "./pr-observations";

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
    let release: (() => Promise<void>) | undefined;
    try {
      release = await tryStorageLock(join(paths.runtimeProject(project), "pr-observer.lock"));
      if (!release) return [];
      let tasks = (await allTasks(project)).filter(t => t.pr);
      const accept = (key: string) => {
        const match = /^(?:pr|merge):(.+)#(\d+)$/.exec(key);
        if (!match) return false;
        const pr = { repository: match[1]!, number: Number(match[2]) };
        const linked = tasks.filter(t => t.pr?.repository === pr.repository && t.pr.number === pr.number);
        return prWatchEnabled(project, pr) && (!linked.length || linked.some(t => !t.removedAt && t.attention?.kind !== "cancelled"));
      };
      await flushObservations(project, [], guard, accept); // Recover a batch without replaying work cancelled since it was staged.
      const pending: string[] = [];
      const stage: typeof observe = async (p, key, value, text, options = {}) => {
        pending.push(key);
        await observe(p, key, value, text, { ...options, defer: true, beforePublish: guard });
      };
      const retire = async (watch: ProcessRecord, reason: string) => {
        const current = await readProcess(project, watch.id);
        if (!liveProcess(current)) return;
        guard(); current.state = "exited"; current.reason = reason; current.updatedAt = new Date().toISOString();
        await saveProcess(current);
      };
      const registrations = (await listProcesses(project)).filter(p => p.prWatch && p.watchEpoch === epoch);
      const watches = registrations.filter(liveProcess);
      for (const p of registrations) if (p.prChecks && p.state === "exited" && /^PR (closed|merged)$/.test(p.reason ?? "")) {
        pending.push(`pr:${p.prChecks.repository}#${p.prChecks.number}`, `merge:${p.prChecks.repository}#${p.prChecks.number}`);
      }
      if (!tasks.length && !watches.length) { await flushObservations(project, pending, guard, accept); return []; }
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
        const key = `${pr.repository}#${pr.number}`;
        if (task.removedAt || task.attention?.kind === "cancelled") {
          await discardObservation(project, `pr:${key}`);
          await discardObservation(project, `merge:${key}`);
        } else if (task.archive) {
          await stage(project, `merge:${key}`, task.archive.mergedAt,
            `[pr-merged] PR #${pr.number} merged: ${pr.url}. Workspace and agents are preserved.`, { existingOnly: true });
        } else if (activePRTask(task)) group(pr).tasks.push(task);
        else pending.push(`pr:${key}`); // Finish a closure staged before a crash; no more GitHub polls.
      }
      for (const p of watches) if (p.prChecks?.repository === repository.toLowerCase() && prWatchEnabled(project, p.prChecks)) {
        const pr = p.prChecks;
        const linked = tasks.filter(t => t.pr?.repository === pr.repository && t.pr.number === pr.number);
        if (linked.length && !linked.some(activePRTask)) { await retire(p, "linked task is cancelled or finished"); continue; }
        group({ ...pr, url: `https://github.com/${pr.repository}/pull/${pr.number}` }).watches.push(p);
      }
      const merged = new Set<number>();
      for (const [key, entry] of groups) {
        guard();
        const observation = await (opts.pr ?? ghTaskPR)(project, entry.pr).catch(() => null);
        guard();
        if (!prWatchEnabled(project, entry.pr)) continue;
        if (!observation || observation.pr.repository !== entry.pr.repository || observation.pr.number !== entry.pr.number) continue;
        // A task may have been cancelled or unlinked while GitHub was queried.
        const currentTasks = await Promise.all(entry.tasks.map(t => getTask(project, t.id)));
        const matching = currentTasks.filter(t => activePRTask(t) && t.branch === observation.branch &&
          t.pr?.repository === entry.pr.repository && t.pr.number === entry.pr.number);
        const currentWatches = await Promise.all(entry.watches.map(p => readProcess(project, p.id).catch(error => { if (error.code === "ENOENT") return undefined; throw error; })));
        if (entry.tasks.length && !currentTasks.some(activePRTask)) {
          for (const watch of currentWatches) if (watch) await retire(watch, "linked task is cancelled or finished");
          await discardObservation(project, `pr:${key}`); continue;
        }
        if (entry.watches.length && !currentWatches.some(p => p && liveProcess(p) && p.watchEpoch === epoch)) continue;
        // A linked task must still match its branch; foreign snapshots cannot
        // publish a notification or mutate its state. Explicit watches use PR ID.
        if (!matching.length && !entry.watches.length) continue;
        const pr = observation.pr;
        const mergeText = `[pr-merged] PR #${pr.number} merged: ${pr.url}. Workspace and agents are preserved.`;
        if (observation.state === "MERGED") {
          if (!observation.mergedAt) continue;
          await stage(project, `merge:${key}`, observation.mergedAt, mergeText);
        } else {
          const value = { state: observation.state, head: pr.head, checks: observation.checks,
            review: observation.reviewDecision ?? "unknown", reviewActivity: observation.reviewActivity, mergeable: observation.mergeable ?? "unknown" };
          const text = `[pr-${observation.state === "CLOSED" ? "closed" : "updated"}] PR #${pr.number}: ${observation.state.toLowerCase()}; head ${pr.head}; checks ${value.checks}; review ${value.review || "none"}; mergeable ${value.mergeable}. ${pr.url}. Observation only; no command was started or retried.`;
          await stage(project, `pr:${key}`, value, text, {
            initialSilent: observation.state === "OPEN" && matching.every(t => t.pr?.head === pr.head) && entry.watches.every(w => w.prChecks?.head === pr.head),
            normalize: notificationValue,
          });
        }
        for (const task of matching) await observeTaskPR(project, task.id, observation, task.revision);
        if (observation.state === "MERGED") {
          merged.add(pr.number);
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
      tasks = (await allTasks(project)).filter(t => t.pr); // Recheck cancellation across the whole remote polling pass.
      await flushObservations(project, pending, guard, accept);
      return [...merged];
    } finally { await release?.(); busy.delete(project); }
  };
}
