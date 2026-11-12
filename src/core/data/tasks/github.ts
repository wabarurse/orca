// Read-only GitHub identity and task PR validation. No publishing or merging here.
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { paths } from "../../../config";
import { run } from "../../proc";
import { taskPR, type TaskPR, type PRObservation, type ReviewThread } from "../../../protocol/task";
const quietEnv = () => ({ ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GIT_TERMINAL_PROMPT: "0" });
const git = (cwd: string, args: string[]) => run(["git", "-C", cwd, ...args], { cwd, timeoutMs: 10_000, env: quietEnv() });
const ok = (r: { code: number } | null) => r?.code === 0;

/** "owner/name" for a GitHub remote url (https, ssh or scp-like), else null. */
export function githubRepo(url: string): string | null {
  const m = url.trim().match(/^(?:(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/|(?:[^@/:]+@)?github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** The project's origin as "owner/name" when it is on GitHub. */
export async function originRepo(project: string): Promise<string | null> {
  const repo = paths.repo(project);
  if (!existsSync(repo)) return null;
  const res = await git(repo, ["remote", "get-url", "origin"]);
  return ok(res) ? githubRepo(res!.out) : null;
}

const FIELDS = "number,url,headRefName,headRefOid,state,mergedAt,isDraft,mergeable,mergeStateStatus,reviewDecision,latestReviews,comments,statusCheckRollup,isCrossRepository";
const obj = (raw: unknown): raw is Record<string, unknown> => !!raw && typeof raw === "object" && !Array.isArray(raw);
function reviewActivity(raw: Record<string, unknown>): string | undefined {
  if (!Array.isArray(raw.latestReviews) || !Array.isArray(raw.comments)) return;
  const values = [raw.latestReviews, raw.comments].map(items => items.map(item => {
    if (!obj(item)) return "unknown";
    return JSON.stringify([item.id, item.author, item.state, item.submittedAt, item.createdAt, item.updatedAt, item.body]);
  }).sort());
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}
/** A check GitHub skipped or marked neutral does not block a merge, so it passes.
 * Unknown check types and every other conclusion fail closed. */
const PASSING = ["SUCCESS", "SKIPPED", "NEUTRAL"];
function checkState(c: unknown): "passed" | "failed" | "pending" | "unknown" {
  if (!obj(c)) return "unknown";
  if (c.__typename === "CheckRun") return c.status === "COMPLETED" ? (PASSING.includes(String(c.conclusion)) ? "passed" : "failed") : "pending";
  if (c.__typename === "StatusContext") return c.state === "SUCCESS" ? "passed" : c.state === "PENDING" || c.state === "EXPECTED" ? "pending" : "failed";
  return "unknown";
}
function checks(raw: unknown): PRObservation["checks"] {
  if (!Array.isArray(raw)) return "unknown";
  if (!raw.length) return "not_configured";
  const states = raw.map(checkState);
  if (states.includes("unknown")) return "unknown";
  if (states.includes("failed")) return "failed";
  return states.includes("pending") ? "pending" : "passed";
}
const label = (raw: unknown, max: number) => String(raw ?? "").replace(/[^\w .:/@()\[\]+-]/g, "").trim().slice(0, max);
function failing(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const names = raw.filter(c => checkState(c) === "failed").map(c => label((c as Record<string, unknown>).name ?? (c as Record<string, unknown>).context, 60) || "unnamed check");
  return [...new Set(names)].sort().slice(0, 8);
}
export function parseTaskPR(repository: string, number: number, raw: unknown): PRObservation {
  if (!obj(raw) || raw.number !== number || !["OPEN", "CLOSED", "MERGED"].includes(String(raw.state)) || typeof raw.headRefName !== "string" || !raw.headRefName || raw.isCrossRepository !== false) throw new Error("invalid or foreign pr observation");
  const pr = taskPR({ repository, number, url: raw.url, head: raw.headRefOid });
  const state = raw.state as PRObservation["state"];
  if (state === "MERGED" && (typeof raw.mergedAt !== "string" || !Number.isFinite(Date.parse(raw.mergedAt)))) throw new Error("merge is not confirmed");
  const result = checks(raw.statusCheckRollup);
  // GitHub computes mergeability lazily: UNKNOWN (or a missing field) is "not yet", never a conflict.
  const mergeable = raw.mergeable === "CONFLICTING" || raw.mergeStateStatus === "DIRTY" ? "conflicting" : raw.mergeable === "MERGEABLE" ? "mergeable" : "unknown";
  return {
    pr, branch: raw.headRefName, state, ...(state === "MERGED" ? { mergedAt: raw.mergedAt as string } : {}), checks: result, mergeable,
    ...(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED", ""].includes(String(raw.reviewDecision)) ? { reviewDecision: raw.reviewDecision as PRObservation["reviewDecision"] } : {}),
    reviewActivity: reviewActivity(raw), failing: failing(raw.statusCheckRollup), ...(typeof raw.isDraft === "boolean" ? { draft: raw.isDraft } : {}),
    ready: state === "OPEN" && raw.isDraft === false && raw.mergeable === "MERGEABLE" && raw.mergeStateStatus === "CLEAN"
      && (raw.reviewDecision === "APPROVED" || raw.reviewDecision === "") && ["passed", "not_configured"].includes(result),
  };
}
/** Null never means merged, green, or absent CI. */
export async function ghTaskPR(project: string, pr: Pick<TaskPR, "repository" | "number">, opts: { bin?: string; timeoutMs?: number; signal?: AbortSignal; attached?: boolean } = {}): Promise<PRObservation | null> {
  const bin = opts.bin ?? Bun.which("gh", { PATH: process.env.PATH });
  if (!bin) return null;
  const result = await run([bin, "pr", "view", String(pr.number), "--repo", pr.repository, "--json", FIELDS], {
    cwd: paths.repo(project), timeoutMs: opts.timeoutMs ?? 20_000, env: quietEnv(), signal: opts.signal, attached: opts.attached,
  });
  if (!result || result.code !== 0) return null;
  try { return parseTaskPR(pr.repository, pr.number, JSON.parse(result.out)); }
  catch { return null; }
}

const THREADS = "query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n){pullRequest(number:$p){reviewThreads(first:100){nodes{id isResolved path line comments(first:1){nodes{author{login} url}}}}}}}";
/** Unresolved threads only, as places: author, file, line, link. Null when unreadable. */
export function parseReviewThreads(pr: Pick<TaskPR, "repository" | "number">, raw: unknown): ReviewThread[] | null {
  const nodes = (raw as any)?.data?.repository?.pullRequest?.reviewThreads?.nodes;
  if (!Array.isArray(nodes)) return null;
  const threads: ReviewThread[] = [];
  for (const node of nodes) {
    if (!obj(node) || typeof node.id !== "string" || typeof node.isResolved !== "boolean") return null;
    if (node.isResolved) continue;
    const first = (node.comments as any)?.nodes?.[0], url = String(first?.url ?? "");
    const expected = new RegExp(`^https://github\\.com/${pr.repository.replace(/[.]/g, "\\.")}/pull/${pr.number}#discussion_r\\d+$`, "i");
    threads.push({ id: label(node.id, 80), author: label(first?.author?.login, 40) || "someone", path: label(node.path, 160) || "the PR",
      ...(Number.isInteger(node.line) ? { line: node.line as number } : {}), url: expected.test(url) ? url : `https://github.com/${pr.repository}/pull/${pr.number}` });
  }
  return threads.sort((a, b) => a.id.localeCompare(b.id));
}
export async function ghReviewThreads(project: string, pr: Pick<TaskPR, "repository" | "number">, opts: { bin?: string; timeoutMs?: number } = {}): Promise<ReviewThread[] | null> {
  const bin = opts.bin ?? Bun.which("gh", { PATH: process.env.PATH }), [owner, name] = pr.repository.split("/");
  if (!bin || !owner || !name) return null;
  const result = await run([bin, "api", "graphql", "-f", `query=${THREADS}`, "-f", `o=${owner}`, "-f", `n=${name}`, "-F", `p=${pr.number}`], {
    cwd: paths.repo(project), timeoutMs: opts.timeoutMs ?? 20_000, env: quietEnv(),
  });
  if (!result || result.code !== 0) return null;
  try { return parseReviewThreads(pr, JSON.parse(result.out)); }
  catch { return null; }
}
