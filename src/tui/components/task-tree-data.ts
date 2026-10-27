import { check, object, sha, taskDependencies, taskPR, taskStatuses, type Task, type TaskTreeView } from "../../protocol/tasks";

/** History is intentionally not read or cloned: it is not displayed by this view. */
export type TreeTask = Omit<Task, "history"> & { dependsOn: string[] };

/** Reject, never truncate evidence: 256 tasks, 1024 edges, 128 runs/task,
 * 8192 UTF-16 units/string and 262144 units of displayed source strings/registry.
 * Limits are checked before segmentation, serialization or any copying of strings.
 * Only known durable fields are inspected; projection display fields are not trusted.
 */
export function treeTasks(input: readonly (Task | TaskTreeView)[]): TreeTask[] {
  check(Array.isArray(input) && input.length <= 256, "Graph limit: 256 tasks");
  let remaining = 262144;
  const string = (value: unknown): string => {
    check(typeof value === "string", "invalid task metadata string");
    check(value.length <= 8192, "Metadata limit: 8192 units/string");
    remaining -= value.length;
    check(remaining >= 0, "Metadata limit: 262144 units/registry");
    return value;
  };
  const strings = (raw: Record<string, unknown>, keys: string[]) => {
    const result: Record<string, string> = {};
    for (const key of keys) result[key] = string(raw[key]);
    return result;
  };
  const pr = (raw: unknown) => {
    check(object(raw), "invalid task PR");
    strings(raw, ["repository", "url", "head"]);
    return taskPR(raw);
  };
  const runs = (raw: unknown): Task["runs"] => {
    check(Array.isArray(raw), "invalid task runs");
    check(raw.length <= 128, "Metadata limit: 128 runs/task");
    return raw.map(run => {
      check(object(run), "invalid task run");
      const values = strings(run, ["id", "agent", "preparedAt"]);
      check(run.role === "worker" || run.role === "reviewer", "invalid run role");
      check(["prepared", "started", "stopped", "failed"].includes(String(run.state)), "invalid run state");
      const result = { ...values, role: run.role, state: run.state } as Task["runs"][number];
      for (const key of ["startedAt", "endedAt"] as const) {
        if (run[key] !== undefined) result[key] = string(run[key]);
      }
      if (run.reviewMode !== undefined) {
        check(run.reviewMode === "review" || run.reviewMode === "watch-ci", "invalid review mode");
        result.reviewMode = run.reviewMode;
      }
      return result;
    });
  };
  const readiness = (raw: unknown): Task["readiness"] => {
    if (raw === undefined) return undefined;
    check(object(raw), "invalid readiness");
    const values = strings(raw, ["head", "run", "validatedAt", "validation"]);
    check(sha(values.head), "invalid readiness head");
    check(raw.checks === "passed" || raw.checks === "not_configured", "invalid readiness checks");
    return { ...values, checks: raw.checks } as Task["readiness"];
  };
  const attention = (raw: unknown): Task["attention"] => {
    if (raw === undefined) return undefined;
    check(object(raw), "invalid attention");
    check(["waiting", "blocked", "cancelled", "closed", "unknown"].includes(String(raw.kind)), "invalid attention kind");
    return { kind: raw.kind, reason: string(raw.reason) } as Task["attention"];
  };
  const archive = (raw: unknown): Task["archive"] => {
    if (raw === undefined) return undefined;
    check(object(raw) && raw.reason === "merged", "invalid archive");
    return { reason: "merged", mergedAt: string(raw.mergedAt), archivedAt: string(raw.archivedAt), pr: pr(raw.pr) };
  };
  let edgeCount = 0;
  const tasks = input.map(item => {
    check(object(item), "invalid task record");
    const raw = "source" in item ? item.source : item;
    check(object(raw), "invalid task source");
    const values = strings(raw, ["id", "name", "summary", "branch", "createdAt", "updatedAt"]);
    check(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(values.id!), "invalid task identity");
    check(taskStatuses.includes(raw.status as Task["status"]), "invalid task lifecycle");
    check(Number.isSafeInteger(raw.revision) && Number(raw.revision) > 0, "invalid revision");
    if (raw.dependsOn !== undefined) {
      check(Array.isArray(raw.dependsOn) && raw.dependsOn.length <= 256, "invalid/oversized dependencies");
      for (const dep of raw.dependsOn) string(dep);
      edgeCount += raw.dependsOn.length;
    }
    check(edgeCount <= 1024, "Graph limit: 1024 dependencies");
    const task = { ...values, status: raw.status, revision: raw.revision,
      dependsOn: taskDependencies(raw.dependsOn, values.id!), runs: runs(raw.runs),
      pr: raw.pr === undefined ? undefined : pr(raw.pr), readiness: readiness(raw.readiness),
      attention: attention(raw.attention), archive: archive(raw.archive),
    } as TreeTask;
    if (task.status === "ready_to_merge") {
      check(task.pr && task.readiness && task.pr.head === task.readiness.head, "ready requires matching validation");
    }
    return task;
  });
  return tasks.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
