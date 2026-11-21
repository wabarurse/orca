// pr-watch's observation: read the tasks plugin's file (read only; only its tools change tasks), ask gh about each
// linked PR that is not settled, keep the latest observation per PR in $ORCA_DATA/pr-watch/prs.json and decide which
// changes deserve one notice. The first sight of a PR records silently unless it is already blocked.
import { join } from "node:path";
import { writeAtomic } from "../../core/conversations";

export type GhResult = { code: number; stdout: string; stderr: string };
/** How the watcher asks GitHub; tests replace `run`. */
export const gh = {
  run: async (args: string[]): Promise<GhResult> => {
    const proc = Bun.spawn(["gh", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout, stderr };
  },
};

/** The part of a tasks-plugin task this watcher reads. */
type LinkedTask = { number: number; status: string; branch: string | null; pr: { repo: string; number: number; url: string } | null };

export type Verdict = "merged" | "closed" | "blocked" | "clear";
export type Observation = {
  repo: string;
  number: number;
  url: string;
  task: number;
  branch: string | null;
  verdict: Verdict;
  /** What an agent can fix: conflicts, failing checks by name, requested changes. */
  blockers: string[];
  /** What nobody here can fix yet: running checks, a required review, a draft. */
  waiting: string[];
  head: string;
  observedAt: string;
};

type Check = { __typename: string; name: string | null; context: string | null; status: string | null; conclusion: string | null; state: string | null };
type View = { state: string; isDraft: boolean | null; mergeable: string; mergeStateStatus: string; reviewDecision: string | null; statusCheckRollup: Check[] | null; headRefOid: string };

const FAILED = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);

export function judge(view: View): { verdict: Verdict; blockers: string[]; waiting: string[] } {
  if (view.state === "MERGED") return { verdict: "merged", blockers: [], waiting: [] };
  if (view.state === "CLOSED") return { verdict: "closed", blockers: [], waiting: [] };
  const checks = view.statusCheckRollup ?? [];
  const failing = checks.filter(c => FAILED.has(c.conclusion ?? c.state ?? "")).map(c => c.name ?? c.context ?? "unnamed");
  const running = checks.some(c => (c.status !== null && c.status !== undefined && c.status !== "COMPLETED") || c.state === "PENDING" || c.state === "EXPECTED");
  const blockers = [
    ...(view.mergeable === "CONFLICTING" || view.mergeStateStatus === "DIRTY" ? ["conflicts with its base branch"] : []),
    ...(failing.length > 0 ? [`failing checks: ${failing.join(", ")}`] : []),
    ...(view.reviewDecision === "CHANGES_REQUESTED" ? ["changes requested"] : []),
  ];
  const waiting = [...(running ? ["checks still running"] : []), ...(view.reviewDecision === "REVIEW_REQUIRED" ? ["an approving review"] : []), ...(view.isDraft === true ? ["it is a draft"] : [])];
  return { verdict: blockers.length > 0 ? "blocked" : "clear", blockers, waiting };
}

/** The one notice a change deserves, or null. */
export function notice(before: Observation | null, now: Observation): string | null {
  const pr = `PR #${now.number} (task #${now.task}${now.branch === null ? "" : ` on ${now.branch}`})`;
  const blocked = `[pr-blocked] ${pr} cannot merge: ${now.blockers.join("; ")}${now.waiting.length > 0 ? `. Waiting on: ${now.waiting.join(", ")}` : ""}`;
  if (before === null) return now.verdict === "blocked" ? blocked : null;
  const same = before.verdict === now.verdict && before.blockers.join("\n") === now.blockers.join("\n");
  if (same) return null;
  if (now.verdict === "merged") return `[pr-merged] ${pr} merged`;
  if (now.verdict === "closed") return `[pr-closed] ${pr} closed without merging`;
  if (now.verdict === "blocked") return blocked;
  return before.verdict === "blocked" ? `[pr-updated] ${pr}: nothing fixable blocks the merge` : null;
}

const key = (repo: string, number: number): string => `${repo}#${number}`;

export async function readObservations(dir: string): Promise<Record<string, Observation>> {
  const file = Bun.file(join(dir, "prs.json"));
  return await file.exists() ? await file.json() as Record<string, Observation> : {};
}

/** One pass: observe every unsettled linked PR, save the observations, then send one notice per change. */
export async function watchOnce(dir: string, tasksFile: string, notify: (text: string) => Promise<void>): Promise<void> {
  const file = Bun.file(tasksFile);
  if (!await file.exists()) return;
  const tasks = await file.json() as LinkedTask[];
  const seen = await readObservations(dir);
  const notices: string[] = [];
  for (const task of tasks) {
    if (task.pr === null || task.status === "merged" || task.status === "closed") continue;
    const before = seen[key(task.pr.repo, task.pr.number)] ?? null;
    if (before !== null && (before.verdict === "merged" || before.verdict === "closed")) continue;
    const result = await gh.run(["pr", "view", String(task.pr.number), "--repo", task.pr.repo, "--json", "state,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,headRefOid"]);
    if (result.code !== 0) continue;
    let view: View;
    try { view = JSON.parse(result.stdout) as View; } catch { continue; }
    const now: Observation = { repo: task.pr.repo, number: task.pr.number, url: task.pr.url, task: task.number, branch: task.branch, ...judge(view), head: view.headRefOid, observedAt: new Date().toISOString() };
    seen[key(now.repo, now.number)] = now;
    const text = notice(before, now);
    if (text !== null) notices.push(text);
  }
  // Saved before notifying: a crash in between loses a notice rather than repeating it on every pass.
  await writeAtomic(join(dir, "prs.json"), JSON.stringify(seen, null, 2));
  for (const text of notices) await notify(text);
}
