// Keep one build-output alias so an already-running pre-rename updater receives
// this binary rather than accidentally reinstalling its stale previous build.
import { constants } from "node:fs";
import { copyFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { owned, prepareArtifact } from "../src/installation";
import { legacy } from "../src/legacy";

const app = resolve(import.meta.dir, "..");
const artifact = await prepareArtifact(app);
const compatibilityArtifact = join(app, "dist", legacy.executable);
await owned(compatibilityArtifact);
const child = Bun.spawn([process.execPath, "build", "src/cli.ts", "--compile", "--outfile", artifact], {
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
