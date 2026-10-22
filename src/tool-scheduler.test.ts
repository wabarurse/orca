import { test, expect } from "bun:test";
import { scheduleTools } from "./tool-scheduler";
test("independent calls overlap, barriers wait, results retain order", async () => {
  const events: string[] = []; let active = 0, max = 0;
  const result = await scheduleTools([0, 1, 2, 3, 4], n => n !== 2, async n => {
    if (n === 2) expect(active).toBe(0);
    events.push(`start${n}`); active++; max = Math.max(max, active);
    await Bun.sleep(n === 0 ? 15 : 3); active--; events.push(`end${n}`); return n;
  }, 2);
  expect(result).toEqual([0, 1, 2, 3, 4]); expect(max).toBe(2);
  expect(events.indexOf("start2")).toBeGreaterThan(events.indexOf("end0"));
  expect(events.indexOf("start3")).toBeGreaterThan(events.indexOf("end2"));
});
test("default scheduler is sequential and failure drains running calls", async () => {
  let active = 0; let max = 0;
  await scheduleTools([1, 2, 3], () => true, async n => { max = Math.max(max, ++active); await Bun.sleep(1); active--; return n; });
  expect(max).toBe(1);
  let completed = false;
  await expect(scheduleTools([0, 1, 2], () => true, async n => {
    if (n === 0) { await Bun.sleep(1); throw new Error("failed"); }
    await Bun.sleep(10); completed = true; return n;
  }, 2)).rejects.toThrow("failed");
  expect(completed).toBe(true);
});
