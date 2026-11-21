import { afterAll, beforeAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function tempHome(label: string): { path: () => string } {
  let home = "";
  const previous = process.env.ORCA2_HOME;
  beforeAll(() => { home = mkdtempSync(join(tmpdir(), `orca2-${label}-`)); process.env.ORCA2_HOME = home; });
  afterAll(() => {
    if (previous === undefined) delete process.env.ORCA2_HOME; else process.env.ORCA2_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });
  return { path: () => home };
}
