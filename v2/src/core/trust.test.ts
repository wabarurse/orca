import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTrust, trustState } from "./trust";

let home = "";
const saved = process.env.ORCA2_HOME;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "orca2-trust-")); process.env.ORCA2_HOME = home; });
afterEach(() => { if (saved === undefined) delete process.env.ORCA2_HOME; else process.env.ORCA2_HOME = saved; rmSync(home, { recursive: true, force: true }); });

test("every folder is trusted unless it was untrusted, and trust undoes that", async () => {
  const dir = join(home, "repo");
  expect(await trustState(dir)).toBe("trusted");
  await setTrust(dir, false);
  expect(await trustState(dir)).toBe("untrusted");
  expect(await trustState(join(dir, "sub"))).toBe("untrusted");
  await setTrust(dir, true);
  expect(await trustState(dir)).toBe("trusted");
});
