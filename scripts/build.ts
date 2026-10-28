// Keep one build-output alias so an already-running pre-rename updater receives
// this binary rather than accidentally reinstalling its stale previous build.
import { constants } from "node:fs";
import { copyFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { owned, prepareArtifact } from "../src/core/install/installation";
import { legacy } from "../src/config/legacy";

const app = resolve(import.meta.dir, "..");
const artifact = await prepareArtifact(app);
const compatibilityArtifact = join(app, "dist", legacy.executable);
const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: app }).stdout.toString().trim();
const dirty = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: app }).stdout.toString().trim();
const buildId = `${revision || "unknown"}${dirty ? "-dirty" : ""}-${new Date().toISOString()}`;
await owned(compatibilityArtifact);
const child = Bun.spawn([process.execPath, "build", "src/cli/main.ts", "--compile", "--define", `ORCA_BUILD_ID=${JSON.stringify(buildId)}`, "--outfile", artifact], {
  cwd: app, stdin: "inherit", stdout: "inherit", stderr: "inherit",
});
const code = await child.exited;
if (code !== 0) process.exit(code);
const staged = join(app, "dist", `.orca-compat-${crypto.randomUUID()}`);
try {
  await copyFile(artifact, staged, constants.COPYFILE_EXCL);
  await owned(compatibilityArtifact);
  // Rename replaces the path itself; it cannot write through a raced symlink.
  await rename(staged, compatibilityArtifact);
} finally {
  await rm(staged, { force: true });
}
