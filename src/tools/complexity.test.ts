import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command } from "../proc";
import { complexity } from "./complexity";
import type { ToolContext } from "./index";

let cwd: string, oldHome: string | undefined;
let ctx: ToolContext;
beforeEach(async () => {
  cwd = mkdtempSync(join(tmpdir(), "parallels-complexity-tool-"));
  oldHome = process.env.PARALLELS_HOME;
  process.env.PARALLELS_HOME = join(cwd, "home");
  await Bun.write(join(cwd, "home/config.toml"), "cyclomatic = 1\ncognitive = 2\n");
  ctx = { cwd, project: "test", role: "reviewer", branch: "test" };
});
afterEach(() => {
  if (oldHome === undefined) delete process.env.PARALLELS_HOME;
  else process.env.PARALLELS_HOME = oldHome;
  rmSync(cwd, { recursive: true, force: true });
});
const write = (file: string, source: string) => Bun.write(join(cwd, file), source);
async function git(...args: string[]) {
  const result = await command(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], cwd);
  expect(result.code).toBe(0);
  return result.out.trim();
}

test("explicit files bound scoring and preserve measured config-threshold results without a Git base", async () => {
  await write("logic.ts", "function changed(a: boolean) { return a ? 1 : 0; }");
  await write("other.ts", "function excluded(a) { if (a) return 1; }");
  const out = await complexity.run({ files: ["logic.ts"], base: "missing-ref" }, ctx);
  expect(out).toContain("| logic.ts | changed | 1 | 2 | 1 | over |");
  expect(out).toContain("1 functions, 1 over the thresholds (cyclomatic > 1, cognitive > 2)");
  expect(out).not.toContain("excluded");
});

test("base selects changed files, not function deltas; unchanged functions remain baseline context", async () => {
  const baseline = "function baseline(a, b) { if (a) { if (b) return 1; } return 0; }\n";
  await git("init", "-b", "main");
  await write("logic.ts", baseline + "function changed() { return 0; }");
  await write("dirty.ts", "export const value = 1;");
  await write("untouched.ts", "function untouched() { return 1; }");
  await git("add", ".");
  await git("commit", "-m", "Baseline");
  const base = await git("rev-parse", "HEAD");
  await write("logic.ts", baseline + "function changed(a) { return a ? 1 : 0; }");
  await git("add", "logic.ts");
  await git("commit", "-m", "Change one function");
  await write("dirty.ts", "function dirty(a) { return a ? 1 : 0; }");
  await write("untracked.ts", "function untracked() { return 0; }");
  const out = await complexity.run({ base }, ctx);
  expect(out).toContain("| logic.ts | baseline | 1 | 3 | 3 | over |");
  expect(out).toContain("| logic.ts | changed | 2 | 2 | 1 | over |");
  expect(out).toContain("| dirty.ts | dirty | 1 | 2 | 1 | over |");
  expect(out).not.toContain("untouched");
  expect(out).not.toContain("untracked");
  expect(await complexity.run({ base, files: [] }, ctx)).toBe(out);
  expect(await complexity.run({ base: "missing-ref" }, ctx)).toStartWith("error: git diff against missing-ref failed:");
});

test("unsupported files and function-free sources are not reported as zero complexity", async () => {
  await write("guide.md", "Run `node example.js`.");
  await write("script.py", "def f(): pass");
  await write("prompt.ts", 'export const prompt = "Semantic agent instruction change";');
  expect(await complexity.run({ files: ["guide.md", "script.py"] }, ctx)).toBe("no javascript/typescript files to score");
  expect(await complexity.run({ files: ["prompt.ts"] }, ctx)).toBe("no functions found");
});

test("parse errors remain explicit alongside valid measured scores, never zero-score substitutes", async () => {
  await write("valid.ts", "function simple() { return 1; }");
  await write("invalid.ts", "function broken(");
  const out = await complexity.run({ files: ["valid.ts", "invalid.ts"] }, ctx);
  expect(out).toContain("| valid.ts | simple | 1 | 1 | 0 |  |");
  expect(out).toContain("could not parse:\ninvalid.ts:");
  expect(out).not.toContain("| invalid.ts |");
});
