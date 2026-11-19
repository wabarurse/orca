import { afterEach, expect, test } from "bun:test";
import { pull } from "./pull";

afterEach(() => { process.exitCode = 0; });

const run = async (update: () => Promise<{ binary: string; from: string; to: string }>, isTTY = false) => {
  let text = "";
  const write = (chunk: string) => { text += chunk; return true; };
  await pull({ write, isTTY }, { write, isTTY: false }, false, update);
  return text;
};

test("one line: the commit moved, it was already up to date, or (on stderr) the pull failed and the old orca stays", async () => {
  const binary = "/nonexistent/orca-binary";
  expect(await run(async () => ({ binary, from: "792bace1111", to: "80a2ed92222" }))).toStartWith("✓ orca 792bace → 80a2ed9\n");
  expect(await run(async () => ({ binary, from: "80a2ed92222", to: "80a2ed92222" }))).toStartWith("✓ orca 80a2ed9 is already up to date\n");
  expect(await run(async () => { throw new Error("harness build failed (exit 1): src/tui/app.ts"); })).toBe("✗ orca pull failed: harness build failed (exit 1): src/tui/app.ts\n  the installed orca was not replaced\n");
  expect(process.exitCode).toBe(1);
});

test("on a terminal the progress line is replaced by the result", async () => {
  const text = await run(async () => { throw new Error("offline"); }, true);
  expect(text).toStartWith("pulling orca…\r\x1b[2K✗ orca pull failed: offline\n");
});
