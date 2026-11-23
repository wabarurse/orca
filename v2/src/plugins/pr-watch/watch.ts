import { join } from "node:path";
import { z } from "zod";
import { errorMessage, fail, ok, parseJson, type Result } from "../../config";
import { writeAtomic } from "../../core/plugins";

export type GhResult = { code: number; stdout: string; stderr: string };
export const gh = {
  run: async (args: string[]): Promise<GhResult> => {
    try {
      const proc = Bun.spawn(["gh", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { code, stdout, stderr };
    } catch (error) {
      return { code: 127, stdout: "", stderr: errorMessage(error) };
    }
  },
};

const LinkedTasks = z.array(z.looseObject({
  number: z.number(),
  status: z.string(),
  branch: z.string().nullable(),
  pr: z.object({ repo: z.string(), number: z.number(), url: z.string() }).nullable(),
}));

const VerdictSchema = z.enum(["merged", "closed", "blocked", "clear"]);
const ObservationSchema = z.object({
  repo: z.string(),
  number: z.number(),
  url: z.string(),
  task: z.number(),
  branch: z.string().nullable(),
  verdict: VerdictSchema,
  blockers: z.array(z.string()),
  waiting: z.array(z.string()),
  head: z.string(),
  observedAt: z.string(),
});
const ObservationsSchema = z.record(z.string(), ObservationSchema);

const CheckSchema = z.looseObject({
  name: z.string().nullish(),
  context: z.string().nullish(),
  status: z.string().nullish(),
  conclusion: z.string().nullish(),
  state: z.string().nullish(),
});
const ViewSchema = z.looseObject({
  state: z.string(),
  isDraft: z.boolean().nullish(),
  mergeable: z.string(),
  mergeStateStatus: z.string(),
  reviewDecision: z.string().nullish(),
  statusCheckRollup: z.array(CheckSchema).nullish(),
  headRefOid: z.string(),
});

export type Verdict = z.infer<typeof VerdictSchema>;
export type Observation = z.infer<typeof ObservationSchema>;
export type View = z.infer<typeof ViewSchema>;

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

async function readJson<T>(path: string, schema: z.ZodType<T>, empty: T, what: string): Promise<Result<T>> {
  const file = Bun.file(path);
  if (!await file.exists()) return ok(empty);
  const json = parseJson(await file.text());
  if (!json.ok) return fail(`${what} is not valid JSON: ${json.error}`);
  const parsed = schema.safeParse(json.data);
  return parsed.success ? ok(parsed.data) : fail(`${what} is malformed: ${parsed.error.message}`);
}

export async function readObservations(dir: string): Promise<Result<Record<string, Observation>>> {
  return readJson(join(dir, "prs.json"), ObservationsSchema, {}, "prs.json");
}

async function observe(repo: string, number: number): Promise<View | null> {
  const result = await gh.run(["pr", "view", String(number), "--repo", repo, "--json", "state,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,headRefOid"]);
  if (result.code !== 0) return null;
  const json = parseJson(result.stdout);
  const parsed = json.ok ? ViewSchema.safeParse(json.data) : null;
  return parsed !== null && parsed.success ? parsed.data : null;
}

export async function watchOnce(dir: string, tasksFile: string, notify: (text: string) => Promise<void>): Promise<Result<number>> {
  const tasks = await readJson(tasksFile, LinkedTasks, [], "tasks.json");
  if (!tasks.ok) return tasks;
  const read = await readObservations(dir);
  if (!read.ok) return read;
  const seen = read.data;
  const notices: string[] = [];
  for (const task of tasks.data) {
    if (task.pr === null || task.status === "merged" || task.status === "closed") continue;
    const before = seen[key(task.pr.repo, task.pr.number)] ?? null;
    if (before !== null && (before.verdict === "merged" || before.verdict === "closed")) continue;
    const view = await observe(task.pr.repo, task.pr.number);
    if (view === null) continue;
    const now: Observation = { repo: task.pr.repo, number: task.pr.number, url: task.pr.url, task: task.number, branch: task.branch, ...judge(view), head: view.headRefOid, observedAt: new Date().toISOString() };
    seen[key(now.repo, now.number)] = now;
    const text = notice(before, now);
    if (text !== null) notices.push(text);
  }
  await writeAtomic(join(dir, "prs.json"), JSON.stringify(seen, null, 2));
  for (const text of notices) await notify(text);
  return ok(notices.length);
}
