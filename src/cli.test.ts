import { expect, test } from "bun:test";
import pkg from "../package.json";

test("`parallels version` prints the package.json version", async () => {
  const proc = Bun.spawn(["bun", "src/cli.ts", "version"], {
    cwd: import.meta.dir + "/..",
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  expect(out).toBe(`${pkg.version}\n`);
});
