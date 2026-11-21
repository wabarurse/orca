// v2 is self-contained: no file under v2/src imports anything outside v2 (in particular nothing from v1's src/).
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const IMPORT = /(?:import|export)\s[^"']*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : []);
}

test("every relative import stays inside v2", () => {
  const outside: string[] = [];
  for (const file of files(join(ROOT, "src"))) {
    for (const match of readFileSync(file, "utf8").matchAll(IMPORT)) {
      const spec = match[1] ?? match[2] ?? "";
      if (!spec.startsWith(".")) continue;
      const target = resolve(dirname(file), spec);
      if (relative(ROOT, target).startsWith("..")) outside.push(`${relative(ROOT, file)} → ${spec}`);
    }
  }
  expect(outside).toEqual([]);
});
