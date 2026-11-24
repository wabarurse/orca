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

const EXAMPLE = join(ROOT, "src/test/plugins/example");
const PLUGIN_API = new Set(["orca2/plugin", "orca2/plugin/testing", "bun:test"]);

test("the example plugin imports only orca2/plugin, node: modules and its own files, as a plugin outside the repository must", () => {
  const out: string[] = [];
  for (const file of files(EXAMPLE)) {
    for (const match of readFileSync(file, "utf8").matchAll(IMPORT)) {
      const spec = match[1] ?? match[2] ?? "";
      const own = spec.startsWith(".") && resolve(dirname(file), spec).startsWith(`${EXAMPLE}/`);
      if (!own && !PLUGIN_API.has(spec) && !spec.startsWith("node:")) out.push(`${relative(ROOT, file)} → ${spec}`);
    }
  }
  expect(out).toEqual([]);
});
