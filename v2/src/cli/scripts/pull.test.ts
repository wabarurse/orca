import { expect, test } from "bun:test";
import { fail, ok } from "../../config";
import { pull } from "./pull";

const sink = (): { write: (text: string) => void; isTTY: boolean; text: () => string } => {
  let all = "";
  return { write: text => { all += text; }, isTTY: false, text: () => all };
};

test("orca2 pull prints one line: moved, already up to date, or failed with the old binary kept; a successful pull starts the reload", async () => {
  const reloads: string[] = [];
  const reload = (binary: string): { ok: true; data: string } => { reloads.push(binary); return ok("log"); };
  const moved = sink(), err = sink();
  expect(await pull(moved, err, false, async () => ok({ binary: "/b/orca2", from: "a".repeat(40), to: "b".repeat(40) }), reload)).toBe(0);
  expect(moved.text()).toBe(`✓ orca2 aaaaaaa → bbbbbbb\n`);
  const same = sink();
  expect(await pull(same, err, false, async () => ok({ binary: "/b/orca2", from: "c".repeat(40), to: "c".repeat(40) }), reload)).toBe(0);
  expect(same.text()).toBe(`✓ orca2 ccccccc is already up to date\n`);
  expect(reloads).toEqual(["/b/orca2", "/b/orca2"]);
  const failed = sink(), failedErr = sink();
  expect(await pull(failed, failedErr, false, async () => fail("harness checkout has dirty or untracked files"), reload)).toBe(1);
  expect(failedErr.text()).toContain("✗ orca2 pull failed: harness checkout has dirty or untracked files");
  expect(failedErr.text()).toContain("the installed orca2 was not replaced");
  expect(reloads.length).toBe(2);
});
