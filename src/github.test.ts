import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { paths } from "./config";
import { ghTaskPR, parseTaskPR } from "./github";

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
  for (const statusCheckRollup of [null, [{}], [{ ...success, status: "IN_PROGRESS" }], [{ ...success, conclusion: "FAILURE" }], [{ ...success, conclusion: "SKIPPED" }], [{ __typename: "StatusContext", state: "PENDING" }]]) expect(parseTaskPR("o/r", 7, raw({ statusCheckRollup })).ready).toBe(false);
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
