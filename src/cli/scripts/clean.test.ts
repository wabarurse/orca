import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { askYes, cleanCommand, cleanReport, cleanStorage, formatBytes, quietProgress, sizeOf, terminalProgress, type CleanIO, type CleanProgress, type CleanRow } from "./clean";

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
  expect(cleanReport(rows, "preview", false).split("\n")).toEqual([
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
  expect(cleanReport(done, "removed", false).split("\n")).toEqual([
    "  REMOVED                         ITEMS      SIZE",
    "  deleted conversations               1    2.4 GB",
    "  archived worktrees                  1    1.0 KB",
    "  ───────────────────────────────────────────────",
    "  freed                               2    2.4 GB",
    "✓ saved local changes to orca-saved/feat-z-20261118-0912",
  ]);
});

test("nothing to clean says so; colour only when asked; more than three kept rows are counted", () => {
  expect(cleanReport([], "preview", false)).toBe("✓ nothing to clean");
  expect(cleanReport([], "preview", true)).toContain("\x1b[38;5;151m✓\x1b[0m");
  const held = ["a", "b", "c", "d"].map(name => ({ path: `/w/${name}`, disposition: "kept: has uncommitted files", bytes: 1 }));
  expect(cleanReport(held, "preview", false)).toContain("kept a (has uncommitted files) · b (has uncommitted files) · c (has uncommitted files) · +1 more");
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
  expect(await cleanCommand(true, io(null), clean)).toContain("freed                               1    2.0 KB");
  expect(calls).toEqual([false, true]);
  expect(await cleanCommand(false, io(null), async () => [])).toBe("✓ nothing to clean");
});

const io = (confirm: CleanIO["confirm"]): CleanIO => ({ colour: false, confirm, progress: quietProgress });
const eligible = [{ path: "/h/worktrees/a--1/feat-x", disposition: "eligible: archived workspace and owned resources", bytes: 1000 }];

test("a real run shows what would go and asks first; only yes removes, a no runs nothing destructive", async () => {
  const calls: boolean[] = [], asked: string[] = [];
  const clean = async (apply: boolean) => { calls.push(apply); return apply ? [{ ...eligible[0]!, disposition: "removed archived session" }] : eligible; };
  expect(await cleanCommand(true, io(async table => { asked.push(table); return false; }), clean)).toBe("nothing removed");
  expect(calls).toEqual([false]);
  expect(asked[0]!.split("\n")).toEqual([
    "  WHAT                            ITEMS      SIZE",
    "  archived worktrees                  1    1.0 KB",
    "  ───────────────────────────────────────────────",
    "  total                               1    1.0 KB",
  ]);
  expect(await cleanCommand(true, io(async () => true), clean)).toContain("freed                               1    1.0 KB");
  expect(calls).toEqual([false, false, true]);
});

test("nothing to remove says so without asking, kept rows included; a preview never asks", async () => {
  const ask = async () => { throw new Error("asked"); };
  const keptOnly = async () => [{ path: "/w/a", disposition: "kept: has uncommitted files", bytes: 1 }];
  expect(await cleanCommand(true, io(ask), keptOnly)).toBe("✓ nothing to clean\n\n  kept a (has uncommitted files)");
  expect(await cleanCommand(false, io(ask), async () => eligible)).toContain("run orca clean to remove these");
});

test("the answer is yes only for y or Y; anything else, or an input that ends unanswered, is no", async () => {
  const answer = async (typed: string | null) => {
    const input = new PassThrough(), output = new PassThrough();
    let shown = "";
    output.on("data", chunk => { shown += chunk; });
    const result = askYes("Delete these? [y/N] ", input, output);
    if (typed === null) input.end(); else input.write(typed);
    const yes = await result;
    return { yes, shown };
  };
  expect(await answer("y\n")).toEqual({ yes: true, shown: "Delete these? [y/N] y\n" });
  expect((await answer(" Y \n")).yes).toBe(true);
  for (const typed of ["n\n", "\n", "yes\n", "sure\n"]) expect((await answer(typed)).yes).toBe(false);
  expect(await answer(null)).toEqual({ yes: false, shown: "Delete these? [y/N] \n" });
});

test("progress is one redrawn stderr line that is cleared at the end, and nothing at all off a terminal", () => {
  const stream = (isTTY: boolean) => {
    const writes: string[] = [];
    return { writes, isTTY, columns: 80, write: (text: string) => writes.push(text) };
  };
  const tty = stream(true), bar = terminalProgress(tty, false);
  bar.step("scanning projects", 1, 4); bar.step("scanning projects", 2, 4); bar.end(); bar.end();
  expect(tty.writes).toEqual([
    `\r\x1b[2K  ${"━".repeat(20)} scanning projects 1/4…`,
    `\r\x1b[2K  ${"━".repeat(20)} scanning projects 2/4…`,
    "\r\x1b[2K",
  ]);
  const narrow = { ...stream(true), columns: 20 };
  terminalProgress(narrow, false).step("scanning projects", 1, 4);
  expect(narrow.writes).toEqual(["\r\x1b[2Kscanning projects 1"]);
  const piped = stream(false), quiet = terminalProgress(piped, true);
  quiet.step("scanning projects", 1, 4); quiet.end();
  expect(piped.writes).toEqual([]);
});

test("the scan reports each phase as it goes and ends the progress once, in an empty home", async () => {
  const previous = process.env.ORCA_HOME;
  process.env.ORCA_HOME = join(dir, "home");
  try {
    const steps: string[] = [];
    let ended = 0;
    const progress: CleanProgress = { step: (label, done, total) => steps.push(`${label} ${done}/${total}`), end: () => { ended++; } };
    expect(await cleanStorage(false, async () => { throw new Error("purged"); }, progress)).toEqual([]);
    expect(steps).toEqual(["scanning bubbles 0/1", "scanning build scratch 0/1"]);
    expect(ended).toBe(1);
  } finally { if (previous === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = previous; }
});

test("byte sizes read like people write them", () => {
  expect([0, 999, 1000, 1_536_000, 27_500_000_000].map(formatBytes)).toEqual(["0 B", "999 B", "1.0 KB", "1.5 MB", "27.5 GB"]);
});
