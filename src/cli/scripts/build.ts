import { resolve } from "node:path";
import { prepareArtifact } from "../../core/install";

const app = resolve(import.meta.dir, "../../..");
const artifact = await prepareArtifact(app);
const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: app }).stdout.toString().trim();
const dirty = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: app }).stdout.toString().trim();
const buildId = `${revision || "unknown"}${dirty ? "-dirty" : ""}-${new Date().toISOString()}`;
const child = Bun.spawn([process.execPath, "build", "src/cli/main.ts", "--compile", "--define", `ORCA_BUILD_ID=${JSON.stringify(buildId)}`, "--outfile", artifact], {
  cwd: app, stdin: "inherit", stdout: "inherit", stderr: "inherit",
});
process.exit(await child.exited);
