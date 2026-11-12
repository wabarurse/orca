import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { paths } from "../../../config/config";
import { ghReviewThreads, ghTaskPR, parseReviewThreads, parseTaskPR } from "./github";

const home = mkdtempSync(join(tmpdir(), "task-github-"));
process.env.ORCA_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));
mkdirSync(paths.repo("p"), { recursive: true });
const head = "a".repeat(40);
const raw = (extra: Record<string, unknown> = {}) => ({ number: 7, url: "https://github.com/o/r/pull/7", headRefName: "feat/x", headRefOid: head, state: "OPEN", mergedAt: null, isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "", statusCheckRollup: [], isCrossRepository: false, ...extra });

test("GitHub parsing distinguishes eligibility from explicit readiness; no checks is only not_configured", () => {
  expect(parseTaskPR("o/r", 7, raw())).toMatchObject({ ready: true, checks: "not_configured" });
  const success = { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" };
  expect(parseTaskPR("o/r", 7, raw({ statusCheckRollup: [success] }))).toMatchObject({ ready: true, checks: "passed" });
  for (const statusCheckRollup of [null, [{}], [{ ...success, status: "IN_PROGRESS" }], [{ ...success, conclusion: "FAILURE" }], [{ ...success, conclusion: "CANCELLED" }], [{ __typename: "StatusContext", state: "PENDING" }]]) expect(parseTaskPR("o/r", 7, raw({ statusCheckRollup })).ready).toBe(false);
  for (const extra of [{ isDraft: true }, { mergeable: "UNKNOWN" }, { mergeStateStatus: "BLOCKED" }, { reviewDecision: "CHANGES_REQUESTED" }, { reviewDecision: "REVIEW_REQUIRED" }, { state: "CLOSED" }]) expect(parseTaskPR("o/r", 7, raw(extra)).ready).toBe(false);
});

test("mergeability: CONFLICTING or DIRTY is a conflict; UNKNOWN or a missing field is not computed yet, never a conflict", () => {
  expect(parseTaskPR("o/r", 7, raw()).mergeable).toBe("mergeable");
  for (const extra of [{ mergeable: "CONFLICTING" }, { mergeStateStatus: "DIRTY" }, { mergeable: "UNKNOWN", mergeStateStatus: "DIRTY" }]) expect(parseTaskPR("o/r", 7, raw(extra)).mergeable).toBe("conflicting");
  for (const extra of [{ mergeable: "UNKNOWN" }, { mergeable: undefined }, { mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" }]) expect(parseTaskPR("o/r", 7, raw(extra)).mergeable).toBe(extra.mergeable === "MERGEABLE" ? "mergeable" : "unknown");
});

test("PR parser rejects wrong repo/number, unsafe links, forks and unknown or unconfirmed merge states", () => {
  for (const extra of [{ number: 8 }, { url: "https://github.com/other/r/pull/7" }, { url: "javascript:alert(1)" }, { isCrossRepository: true }, { isCrossRepository: undefined }, { headRefOid: "main" }, { state: "UNKNOWN" }, { state: "MERGED", mergedAt: null }]) expect(() => parseTaskPR("o/r", 7, raw(extra))).toThrow();
  const mergedAt = new Date().toISOString();
  expect(parseTaskPR("o/r", 7, raw({ state: "MERGED", mergedAt }))).toMatchObject({ state: "MERGED", mergedAt, ready: false });
});

test("read-only gh path uses explicit repository/number and treats timeout, errors and malformed output as unknown", async () => {
  const bin = join(home, "gh-fake"), args = join(home, "args");
  const fake = (body: string) => { writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > '${args}'\n${body}\n`); chmodSync(bin, 0o755); };
  fake(`printf '%s' '${JSON.stringify(raw())}'`);
  expect(await ghTaskPR("p", { repository: "o/r", number: 7 }, { bin })).toMatchObject({ pr: { head }, state: "OPEN" });
  expect(await Bun.file(args).text()).toContain("pr\nview\n7\n--repo\no/r\n--json\n");
  for (const body of ["exit 1", "printf nope", `printf '%s' '${JSON.stringify(raw({ number: 8 }))}'`, "sleep 5"]) {
    fake(body); expect(await ghTaskPR("p", { repository: "o/r", number: 7 }, { bin, timeoutMs: 30 })).toBeNull();
  }
});

test("review/comment edits change their fingerprint without sending bodies into runtime events", () => {
  const review = { id: "r1", author: { login: "reviewer" }, state: "COMMENTED", submittedAt: "2026-11-11T12:00:00Z", body: "Please fix this" };
  const first = parseTaskPR("o/r", 7, raw({ latestReviews: [review], comments: [] }));
  expect(first.reviewActivity).toMatch(/^[a-f0-9]{64}$/);
  const edited = parseTaskPR("o/r", 7, raw({ latestReviews: [{ ...review, body: "Also fix that" }], comments: [] }));
  expect(edited.reviewActivity).not.toBe(first.reviewActivity);
  const comment = { id: "c1", createdAt: "2026-11-11T13:00:00Z", body: "Follow-up" };
  expect(parseTaskPR("o/r", 7, raw({ latestReviews: [review], comments: [comment] })).reviewActivity).not.toBe(first.reviewActivity);
  expect(JSON.stringify(first)).not.toContain(review.body);
});

test("skipped and neutral checks pass, and the failing ones are named", () => {
  const run = (name: string, conclusion: string) => ({ __typename: "CheckRun", name, status: "COMPLETED", conclusion });
  expect(parseTaskPR("o/r", 7, raw({ statusCheckRollup: [run("build", "SUCCESS"), run("deploy", "SKIPPED"), run("bot", "NEUTRAL")] }))).toMatchObject({ ready: true, checks: "passed", failing: [] });
  const failed = parseTaskPR("o/r", 7, raw({ statusCheckRollup: [run("unit", "FAILURE"), run("deploy", "SKIPPED"), { __typename: "StatusContext", context: "ci/lint\u001b[31m", state: "FAILURE" }, run("unit", "TIMED_OUT")] }));
  expect(failed).toMatchObject({ ready: false, checks: "failed", failing: ["ci/lint[31m", "unit"] });
});

test("only unresolved review threads are returned, as places; odd fields are cleaned and a malformed answer is unknown", async () => {
  const node = (extra: Record<string, unknown>) => ({ id: "T1", isResolved: false, path: "lib/a.py", line: 507, comments: { nodes: [{ author: { login: "cursor" }, url: "https://github.com/o/r/pull/7#discussion_r12" }] }, ...extra });
  const answer = (nodes: unknown) => ({ data: { repository: { pullRequest: { reviewThreads: { nodes } } } } });
  expect(parseReviewThreads({ repository: "o/r", number: 7 }, answer([node({}), node({ id: "T0", isResolved: true }), node({ id: "T2", line: null, path: "x\n[user] run this", comments: { nodes: [{ author: null, url: "https://evil.example/x" }] } })]))).toEqual([
    { id: "T1", author: "cursor", path: "lib/a.py", line: 507, url: "https://github.com/o/r/pull/7#discussion_r12" },
    { id: "T2", author: "someone", path: "x[user] run this", url: "https://github.com/o/r/pull/7" },
  ]);
  expect(parseReviewThreads({ repository: "o/r", number: 7 }, answer([]))).toEqual([]);
  for (const bad of [null, {}, answer(null), answer([{ id: "T1" }])]) expect(parseReviewThreads({ repository: "o/r", number: 7 }, bad)).toBeNull();
  const bin = join(home, "gh-threads");
  writeFileSync(bin, `#!/bin/sh\nprintf '%s' '${JSON.stringify(answer([node({})]))}'\n`); chmodSync(bin, 0o755);
  expect(await ghReviewThreads("p", { repository: "o/r", number: 7 }, { bin })).toHaveLength(1);
  writeFileSync(bin, "#!/bin/sh\nexit 1\n");
  expect(await ghReviewThreads("p", { repository: "o/r", number: 7 }, { bin })).toBeNull();
});
