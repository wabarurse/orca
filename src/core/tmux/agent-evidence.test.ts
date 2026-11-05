import { expect, spyOn, test } from "bun:test";
import { classifyAgent, processAlive } from "./agent-evidence";
import type { RunState } from "./exits";

test("PID probes use signal zero and distinguish recycled foreign-owned PIDs from uncertain ownership", () => {
  const uid = process.getuid!();
  const kill = spyOn(process, "kill").mockImplementation((_pid, signal) => {
    expect(signal).toBe(0); throw Object.assign(new Error("permission denied"), { code: "EPERM" });
  });
  try {
    expect(processAlive(12345, () => uid + 1000)).toBe(false);
    expect(processAlive(12345, () => uid)).toBeNull();
    expect(processAlive(12345, () => null)).toBeNull();
    const state = { run: "r1", pid: 12345, role: "worker", state: "reported", endedAt: "2026-11-04T00:00:00Z" } as RunState;
    expect(classifyAgent("worker-old", state, "r1", false, true, pid => processAlive(pid, () => uid + 1000)).status).toBe("exited");
    expect(classifyAgent("worker-old", state, "r1", false, true, pid => processAlive(pid, () => uid)).status).toBe("unknown");
    kill.mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
    expect(processAlive(12345, () => { throw new Error("must not inspect ownership"); })).toBe(false);
  } finally { kill.mockRestore(); }
});
test("own live process stays live without launching an ownership inspection", () => {
  expect(processAlive(process.pid, () => { throw new Error("unnecessary process inspection"); })).toBe(true);
  expect(processAlive(0)).toBeNull(); expect(processAlive(-1)).toBeNull();
});
