import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withInstallation } from "./installation";

const binary = (dir: string, text: string): string => { const file = join(dir, `src-${crypto.randomUUID()}`); writeFileSync(file, text); chmodSync(file, 0o755); return file; };

test("install:local puts orca2 in ~/.local/bin with a receipt, replaces its own binary, and refuses one it did not install", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "orca2-install-")));
  const first = await withInstallation(home, false, installation => installation.replace(binary(home, "one")));
  expect(first).toEqual({ ok: true, data: join(home, ".local", "bin", "orca2") });
  expect(readFileSync(join(home, ".local", "bin", "orca2"), "utf8")).toBe("one");
  const second = await withInstallation(home, true, installation => installation.replace(binary(home, "two")));
  expect(second.ok).toBe(true);
  expect(readFileSync(join(home, ".local", "bin", "orca2"), "utf8")).toBe("two");
  writeFileSync(join(home, ".local", "bin", "orca2"), "#!/bin/sh\nexec bun main.ts\n");
  const refused = await withInstallation(home, false, installation => installation.replace(binary(home, "three")));
  expect(refused.ok).toBe(false);
  expect(refused.ok ? "" : refused.error).toContain("refusing to overwrite unrelated or modified executable");
  const fresh = mkdtempSync(join(tmpdir(), "orca2-install-"));
  mkdirSync(join(fresh, ".local", "bin"), { recursive: true });
  writeFileSync(join(fresh, ".local", "bin", "orca2"), "#!/bin/sh\n");
  const launcher = await withInstallation(fresh, false, installation => installation.replace(binary(fresh, "x")));
  expect(launcher.ok ? "" : launcher.error).toContain("launcher script you wrote yourself");
});
