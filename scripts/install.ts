#!/usr/bin/env bun
// Local-only installer. Never touches PARALLELS_HOME, auth, projects, or shell files.
import { homedir } from "node:os";
import { resolve } from "node:path";
import { prepareArtifact, withInstallation } from "../src/installation";
export { installBinary } from "../src/installation";

async function main() {
  if (process.argv.length !== 2) throw new Error("usage: bun run install:local (installs to $HOME/.local/bin/parallels)");
  if (typeof Bun.isStandaloneExecutable !== "boolean") throw new Error("Bun 1.4.2 or newer is required to build parallels");
  const app = resolve(import.meta.dir, "..");
  const target = await withInstallation(homedir(), false, async installation => {
    const artifact = await prepareArtifact(app);
    const build = Bun.spawn([process.execPath, "run", "build"], { cwd: app, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    if (await build.exited !== 0) throw new Error("build failed; installed executable was not changed");
    return installation.replace(artifact);
  });
  console.log(`Installed ${target}\nAdd $HOME/.local/bin to PATH yourself if needed. No shell files or parallels state were changed.`);
}

if (import.meta.main) {
  try { await main(); }
  catch (error) {
    console.error(`install: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
