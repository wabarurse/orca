import { resolve } from "node:path";
import { prepareArtifact } from "../../core/install";

const app = resolve(import.meta.dir, "../../..");
const artifact = await prepareArtifact(app);
if (!artifact.ok) { process.stderr.write(`build: ${artifact.error}\n`); process.exit(1); }
const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: app }).stdout.toString().trim();
const dirty = Bun.spawnSync(["git", "status", "--porcelain", "--", "."], { cwd: app }).stdout.toString().trim();
const buildId = `${revision.length > 0 ? revision : "unknown"}${dirty.length > 0 ? "-dirty" : ""}-${new Date().toISOString()}`;
const child = Bun.spawn([process.execPath, "build", "src/cli/main.ts", "--compile", "--define", `ORCA2_BUILD_ID=${JSON.stringify(buildId)}`, "--outfile", artifact.data], {
  cwd: app, stdin: "inherit", stdout: "inherit", stderr: "inherit",
});
process.exit(await child.exited);
