import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanCommand, cleanReport, formatBytes, sizeOf, type CleanRow } from "./clean";

const dir = mkdtempSync(join(tmpdir(), "orca-clean-report-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const rows: CleanRow[] = [
  { path: "/h/worktrees/a--1/feat-x", disposition: "eligible: archived workspace and owned resources", bytes: 1_400_000_000 },
  { path: "/h/worktrees/a--1/feat-y", disposition: "eligible: archived workspace and owned resources", bytes: 1_600_000_000 },
  { path: "/h/projects/orch-f4lc", disposition: "would remove: conversation \"falcon\" deleted 2026-11-10", bytes: 2_400_000_000 },
  { path: "/h/projects/p/tool-outputs/1.txt", disposition: "eligible: tool output older than 7 days", bytes: 640_000 },
  { path: "/h/worktrees/a--1/unify-tabs", disposition: "kept: a command is still running", bytes: 2_100_000_000 },
  { path: "run-1", disposition: "verification running", bytes: 0 },
];

test("the preview is a WHAT · ITEMS · SIZE table, biggest first, with a total, what is kept and the next step", () => {
  expect(cleanReport(rows, false, false).split("\n")).toEqual([
    "  WHAT                            ITEMS      SIZE",
    "  archived worktrees                  2    3.0 GB",
    "  deleted conversations               1    2.4 GB",
    "  old tool outputs                    1  640.0 KB",
    "  ───────────────────────────────────────────────",
    "  total                               4    5.4 GB",
    "",
    "  kept unify-tabs (a command is still running)",
    "",
    "  run orca clean to remove these",
  ]);
});

test("a real run reports what it removed and freed, and the branches local changes were saved to", () => {
  const done: CleanRow[] = [
    { path: "/h/projects/orch-f4lc", disposition: "removed: conversation \"falcon\" deleted 2026-11-10; local changes saved to orca-saved/feat-z-20261118-0912", bytes: 2_400_000_000 },
    { path: "/h/x/feat-x", disposition: "removed archived session", bytes: 1_000 },
  ];
  expect(cleanReport(done, true, false).split("\n")).toEqual([
    "  REMOVED                         ITEMS      SIZE",
    "  deleted conversations               1    2.4 GB",
    "  archived worktrees                  1    1.0 KB",
    "  ───────────────────────────────────────────────",
    "  freed                               2    2.4 GB",
    "✓ saved local changes to orca-saved/feat-z-20261118-0912",
  ]);
});

test("nothing to clean says so; colour only when asked; more than three kept rows are counted", () => {
  expect(cleanReport([], false, false)).toBe("✓ nothing to clean");
  expect(cleanReport([], false, true)).toContain("\x1b[32m✓\x1b[0m");
  const held = ["a", "b", "c", "d"].map(name => ({ path: `/w/${name}`, disposition: "kept: has uncommitted files", bytes: 1 }));
  expect(cleanReport(held, false, false)).toContain("kept a (has uncommitted files) · b (has uncommitted files) · c (has uncommitted files) · +1 more");
});

test("sizes come from disk before anything is removed, and a real run keeps them", async () => {
  mkdirSync(join(dir, "w", "sub"), { recursive: true });
  writeFileSync(join(dir, "w", "a"), "x".repeat(1500));
  writeFileSync(join(dir, "w", "sub", "b"), "y".repeat(500));
  expect(sizeOf(join(dir, "w"))).toBe(2000);
  expect(sizeOf(join(dir, "missing"))).toBe(0);
  const calls: boolean[] = [];
  const clean = async (apply: boolean) => {
    calls.push(apply);
    if (apply) rmSync(join(dir, "w"), { recursive: true, force: true });
    return [{ path: join(dir, "w"), disposition: apply ? "removed archived session" : "eligible: archived workspace and owned resources" }];
  };
  expect(await cleanCommand(true, false, clean)).toContain("freed                               1    2.0 KB");
  expect(calls).toEqual([false, true]);
  expect(await cleanCommand(false, false, async () => [])).toBe("✓ nothing to clean");
});

test("byte sizes read like people write them", () => {
  expect([0, 999, 1000, 1_536_000, 27_500_000_000].map(formatBytes)).toEqual(["0 B", "999 B", "1.0 KB", "1.5 MB", "27.5 GB"]);
});
