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

const CORE = ["src/core", "src/config", "src/api"].map(dir => join(ROOT, dir));
const inside = (target: string, dir: string): boolean => target === dir || target.startsWith(`${dir}/`);

function crossPluginImports(pluginsDir: string): string[] {
  const out: string[] = [];
  for (const plugin of readdirSync(pluginsDir, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
    const own = join(pluginsDir, plugin.name);
    for (const file of files(own)) {
      const allowed = [own, ...CORE, ...(file.endsWith(".test.ts") ? [join(ROOT, "src/test")] : [])];
      for (const match of readFileSync(file, "utf8").matchAll(IMPORT)) {
        const spec = match[1] ?? match[2] ?? "";
        if (!spec.startsWith(".")) continue;
        const target = resolve(dirname(file), spec);
        if (!allowed.some(dir => inside(target, dir))) out.push(`${relative(ROOT, file)} → ${spec}`);
      }
    }
  }
  return out;
}

test("a plugin imports only from the core (src/core, src/config, src/api), never from another plugin", () => {
  expect(crossPluginImports(join(ROOT, "src/plugins"))).toEqual([]);
});
