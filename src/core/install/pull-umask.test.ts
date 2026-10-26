import { expect, test } from "bun:test";

// Isolate the caller's umask from the test runner and other concurrent work.
for (const mask of [0o002, 0o077]) {
  test(`pull succeeds with caller umask ${mask.toString(8)} without relaxing it`, async () => {
    const child = Bun.spawn([process.execPath, "--eval", `
      import { lstat, rm, utimes } from "node:fs/promises";
      import { join } from "node:path";
      import { pullHarness, updateCommand } from ${JSON.stringify(import.meta.dir + "/pull.ts")};
      import { pullFixture } from ${JSON.stringify(import.meta.dir + "/../../test/pull-fixture.ts")};
      process.umask(0o022);
      const f = await pullFixture();
      try {
        // Force Git status to refresh the index's cached working-tree stat.
        const time = new Date(Date.now() + 1000);
        await utimes(join(f.app, "tracked"), time, time);
        process.umask(${mask});
        const observed = [];
        await pullHarness({ ...f.options, command: async (argv, cwd, env) => {
          if (argv.includes("install") || argv.includes("build")) {
            const name = argv.includes("install") ? "node_modules" : "dist";
            // Exercise real dependency/build subprocess writes, without network or compilation.
            const result = await updateCommand([process.execPath, "--eval",
              'import { mkdirSync, writeFileSync } from "node:fs"; ' +
              'mkdirSync(process.argv[1], { recursive: true }); ' +
              'writeFileSync(process.argv[1] + "/umask-probe", "fixture");'
              , name], cwd, env);
            if (result.code) throw new Error(result.err);
            observed.push((await lstat(join(cwd, name, "umask-probe"))).mode & 0o777);
          }
          return f.command(argv, cwd, env);
        } });
        console.log(JSON.stringify({
          mask: process.umask(), index: (await lstat(join(f.app, ".git/index"))).mode & 0o777,
          head: await f.g(f.app, "rev-parse", "HEAD"), expectedHead: f.after,
          binary: await f.binary(), observed,
        }));
      } finally { await rm(f.root, { recursive: true, force: true }); }
    `], { stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, err }).toEqual({ code: 0, err: "" });
    const result = JSON.parse(out);
    expect(result.mask).toBe(mask);
    expect(result.index & 0o022).toBe(0);
    expect(result.head).toBe(result.expectedHead);
    expect(result.binary).toBe("new executable");
    expect(result.observed).toEqual(mask === 0o077 ? [0o600, 0o600] : [0o644, 0o644]);
  });
}
