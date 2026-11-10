import { expect, test } from "bun:test";
import { processCleanupBlocker } from "./cleanup-guard";
import type { ProcessRecord } from "./store";

const record = (extra: Partial<ProcessRecord> = {}): ProcessRecord => ({
  id: "test-command", project: "p", owner: "worker-test", role: "worker", cwd: "/tmp", command: "unused",
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", state: "unknown",
  supervisorPid: 101, pid: 102, timeoutMs: 1000, maxBytes: 1000, notify: true,
  reason: "supervisor disappeared; effects unknown", events: [], ...extra,
});
const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };

test("unknown and stale running outcomes do not block when every recorded process is absent", () => {
  for (const state of ["starting", "running", "unknown"] as const) {
    const p = record({ state }), before = structuredClone(p), probes: number[] = [];
    expect(processCleanupBlocker(p, pid => { probes.push(pid); fail("ESRCH"); })).toBeUndefined();
    expect(probes).toEqual([101, 102, -102]);
    expect(p).toEqual(before);
  }
});

test("live supervisors, commands and descendant groups each prevent cleanup", () => {
  for (const target of [101, 102, -102]) {
    const result = processCleanupBlocker(record(), pid => { if (pid !== target) fail("ESRCH"); });
    expect(result).toContain("test-command (worker-test)");
    expect(result).toContain("is still present");
    expect(result).toContain(String(Math.abs(target)));
    if (target < 0) expect(result).toContain("process group");
  }
});

test("permission and unexpected inspection failures are never treated as absent", () => {
  for (const target of [101, 102, -102]) for (const code of ["EPERM", "EACCES", "EIO"]) {
    const result = processCleanupBlocker(record(), pid => fail(pid === target ? code : "ESRCH"));
    expect(result).toContain("cannot inspect");
    expect(result).toContain(code);
  }
});

test("incomplete or invalid PID records cannot permit cleanup or probe arbitrary groups", () => {
  for (const field of ["pid", "supervisorPid"] as const) for (const pid of [undefined, 0, -1, 1.5, NaN, 2 ** 32]) {
    let probed = false;
    expect(processCleanupBlocker(record({ [field]: pid }), () => { probed = true; })).toContain("missing or invalid PID");
    expect(probed).toBe(false);
  }
});

test("settled command history needs no operating-system inspection", () => {
  for (const state of ["exited", "failed", "cancelled", "timed_out"] as const) {
    let probed = false;
    expect(processCleanupBlocker(record({ state }), () => { probed = true; })).toBeUndefined();
    expect(probed).toBe(false);
  }
});
