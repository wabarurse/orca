import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("clean previews explicitly, deletes by default and refuses conflicting flags before deleting", async () => {
  const home = await mkdtemp(join(tmpdir(), "orca-clean-cli-"));
  const app = join(home, ".runtime", "app"), bin = join(home, "bin");
  await mkdir(app, { recursive: true }); await mkdir(bin);
  // Only this fixture's unused scratch file is eligible; never inspect real handles or storage.
  await writeFile(join(bin, "lsof"), "#!/bin/sh\nexit 1\n");
  await chmod(join(bin, "lsof"), 0o700);
  const file = join(app, ".aaaa-00000000.bun-build"), retained = join(app, "keep.txt");
  const seed = async () => {
    await writeFile(file, "fixture");
    const old = new Date(Date.now() - 2 * 86400_000);
    await utimes(file, old, old);
  };
  const run = async (...args: string[]) => {
    const proc = Bun.spawn([process.execPath, "src/cli/main.ts", "clean", ...args], {
      cwd: import.meta.dir + "/../..", stdout: "pipe", stderr: "pipe",
      env: { ...process.env, ORCA_HOME: home, PATH: `${bin}:${process.env.PATH}` },
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code };
  };
  try {
    await seed(); await writeFile(retained, "keep");
    for (const flags of [["--preview"], ["--dry-run"]]) {
      const result = await run(...flags);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toContainEqual({ path: file, disposition: "eligible: unused Bun scratch older than one day" });
      expect(await Bun.file(file).exists()).toBe(true);
    }
    for (const flags of [["--preview", "--apply"], ["--dry-run", "--apply"], ["--preview", "--preview"], ["--unknown"]]) {
      const result = await run(...flags);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("clean accepts --preview");
      expect(await Bun.file(file).exists()).toBe(true);
    }
    for (const flags of [[], ["--apply"]]) {
      const result = await run(...flags);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toContainEqual({ path: file, disposition: "removed unused Bun scratch" });
      expect(await Bun.file(file).exists()).toBe(false);
      expect(await Bun.file(retained).text()).toBe("keep");
      if (!flags.length) await seed();
    }
  } finally { await rm(home, { recursive: true, force: true }); }
});
