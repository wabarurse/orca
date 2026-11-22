#!/usr/bin/env bun
import { homedir } from "node:os";
import { resolve } from "node:path";
import { errorMessage, fail } from "../../config";
import { prepareArtifact, withInstallation } from "../../core/install";

async function main(): Promise<number> {
  if (process.argv.length !== 2) { process.stderr.write("usage: bun run install:local (installs to $HOME/.local/bin/orca2)\n"); return 1; }
  const app = resolve(import.meta.dir, "../../..");
  const installed = await withInstallation(homedir(), false, async installation => {
    const artifact = await prepareArtifact(app);
    if (!artifact.ok) return artifact;
    const build = Bun.spawn([process.execPath, "run", "build"], { cwd: app, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    if (await build.exited !== 0) return fail("build failed; installed executable was not changed");
    return installation.replace(artifact.data);
  }).catch((error: unknown) => fail(errorMessage(error)));
  if (!installed.ok) { process.stderr.write(`install: ${installed.error}\n`); return 1; }
  process.stdout.write(`installed ${installed.data}\nadd $HOME/.local/bin to PATH yourself if needed. no shell files or orca2 state were changed.\n`);
  return 0;
}

if (import.meta.main) process.exitCode = await main();
