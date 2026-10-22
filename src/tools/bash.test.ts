import { beforeAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point config at a temp dir so tests never read the real ~/.parallels.
const home = mkdtempSync(join(tmpdir(), "parallels-bash-"));
process.env.PARALLELS_HOME = home;

let bash: typeof import("./bash").bash;
let truncateMiddle: typeof import("./bash").truncateMiddle;
beforeAll(async () => {
  ({ bash, truncateMiddle } = await import("./bash"));
});

const ctx = (cwd: string) => ({ project: "p", role: "worker" as const, cwd });

test("runs in cwd", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "parallels-cwd-")));
  expect((await bash.run({ command: "pwd" }, ctx(dir))).trim()).toBe(dir);
});

test("captures stderr and reports non-zero exit", async () => {
  const out = await bash.run({ command: "echo out; echo err >&2; exit 3" }, ctx(home));
  expect(out).toContain("out");
  expect(out).toContain("err");
  expect(out.trimEnd().endsWith("[exit 3]")).toBe(true);
});

test("no exit line on success", async () => {
  expect(await bash.run({ command: "echo hi" }, ctx(home))).toBe("hi\n");
});

test("truncateMiddle keeps head and tail", () => {
  const text = "HEAD" + "x".repeat(1000) + "TAIL";
  const out = truncateMiddle(text, 100);
  expect(out.startsWith("HEAD")).toBe(true);
  expect(out.endsWith("TAIL")).toBe(true);
  expect(out).toContain("...[truncated 908 bytes]...");
  expect(truncateMiddle("short", 100)).toBe("short");
});

test("long command output is truncated", async () => {
  const out = await bash.run({ command: "echo START; yes x | head -c 100000; echo END" }, ctx(home));
  expect(out.startsWith("START")).toBe(true);
  expect(out).toContain("END\n");
  expect(out).toContain("full output:");
  expect(Buffer.byteLength(out)).toBeLessThanOrEqual(4096);
  expect(out).toContain("[truncated");
});

test("sudo is refused", async () => {
  expect(await bash.run({ command: "sudo ls" }, ctx(home))).toBe("refused: sudo is not allowed");
  expect(await bash.run({ command: "echo pseudo" }, ctx(home))).toBe("pseudo\n");
});

test("cancellation kills a shell and its child, not just the displayed output", async () => {
  const controller = new AbortController();
  const pidFile = join(home, "child.pid");
  const result = bash.run({ command: `sleep 60 & echo $! > '${pidFile}'; wait` }, { ...ctx(home), signal: controller.signal });
  const deadline = Date.now() + 2000;
  while (!(await Bun.file(pidFile).exists()) && Date.now() < deadline) await Bun.sleep(5);
  const pid = Number(await Bun.file(pidFile).text());
  expect(pid).toBeGreaterThan(0);
  controller.abort(new Error("Cancelled by user"));
  await expect(result).rejects.toThrow("Cancelled by user");
  // A killed child can briefly be a zombie while reparented; ps must not show a live sleep.
  const state = await Bun.$`ps -o stat= -p ${pid}`.quiet().nothrow().text();
  expect(!state.trim() || state.trim().startsWith("Z")).toBe(true);
});

test("already-cancelled tools never start a command", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await expect(bash.run({ command: "touch should-not-exist" }, { ...ctx(home), signal: controller.signal })).rejects.toThrow("cancelled");
  expect(await Bun.file(join(home, "should-not-exist")).exists()).toBe(false);
});
