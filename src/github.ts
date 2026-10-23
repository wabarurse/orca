// Read-only GitHub identity and task PR validation. No publishing or merging here.
import { existsSync } from "node:fs";
import { paths } from "./config";
import { run } from "./proc";
import { taskPR, type TaskPR, type PRObservation } from "./tasks";
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

const FIELDS = "number,url,headRefName,headRefOid,state,mergedAt,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,isCrossRepository";
const obj = (raw: unknown): raw is Record<string, unknown> => !!raw && typeof raw === "object" && !Array.isArray(raw);
/** Unknown check types/conclusions fail closed, including skipped/neutral checks. */
function checks(raw: unknown): PRObservation["checks"] {
  if (!Array.isArray(raw)) return "unknown";
  if (!raw.length) return "not_configured";
  const states = raw.map(c => {
    if (!obj(c)) return "unknown";
    if (c.__typename === "CheckRun") return c.status === "COMPLETED" ? (c.conclusion === "SUCCESS" ? "passed" : "failed") : "pending";
    if (c.__typename === "StatusContext") return c.state === "SUCCESS" ? "passed" : c.state === "PENDING" ? "pending" : "failed";
    return "unknown";
  });
  if (states.includes("unknown")) return "unknown";
  if (states.includes("failed")) return "failed";
  return states.includes("pending") ? "pending" : "passed";
}
export function parseTaskPR(repository: string, number: number, raw: unknown): PRObservation {
  if (!obj(raw) || raw.number !== number || !["OPEN", "CLOSED", "MERGED"].includes(String(raw.state)) || typeof raw.headRefName !== "string" || !raw.headRefName || raw.isCrossRepository !== false) throw new Error("invalid or foreign pr observation");
  const pr = taskPR({ repository, number, url: raw.url, head: raw.headRefOid });
  const state = raw.state as PRObservation["state"];
  if (state === "MERGED" && (typeof raw.mergedAt !== "string" || !Number.isFinite(Date.parse(raw.mergedAt)))) throw new Error("merge is not confirmed");
  const result = checks(raw.statusCheckRollup);
  return {
    pr, branch: raw.headRefName, state, ...(state === "MERGED" ? { mergedAt: raw.mergedAt as string } : {}), checks: result,
    ready: state === "OPEN" && raw.isDraft === false && raw.mergeable === "MERGEABLE" && raw.mergeStateStatus === "CLEAN"
      && (raw.reviewDecision === "APPROVED" || raw.reviewDecision === "") && ["passed", "not_configured"].includes(result),
  };
}
/** Null never means merged, green, or absent CI. */
export async function ghTaskPR(project: string, pr: Pick<TaskPR, "repository" | "number">, opts: { bin?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<PRObservation | null> {
  const bin = opts.bin ?? Bun.which("gh");
  if (!bin) return null;
  const result = await run([bin, "pr", "view", String(pr.number), "--repo", pr.repository, "--json", FIELDS], {
    cwd: paths.repo(project), timeoutMs: opts.timeoutMs ?? 20_000, env: quietEnv(), signal: opts.signal,
  });
  if (!result || result.code !== 0) return null;
  try { return parseTaskPR(pr.repository, pr.number, JSON.parse(result.out)); }
  catch { return null; }
}
