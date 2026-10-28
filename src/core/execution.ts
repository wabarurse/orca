import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig, paths } from "../config";

/** Inspired by Codex/Claude Code's OS-backed execution boundary, not command
 * string filtering. This profile restricts writes; network and read access remain
 * available. Explicit full access remains supported, never an implicit fallback.
 * https://code.claude.com/docs/en/sandboxing
 * https://github.com/openai/codex/tree/main/codex-rs/exec-server */
export async function shellCommand(command: string, cwd: string, readOnly: boolean): Promise<string[]> {
  const argv = ["sh", "-c", command];
  if ((await loadConfig({ strict: true })).sandbox === "off") return argv;
  const workspace = realpathSync(cwd);
  const scratchPath = join(paths.runtime, "sandbox-tmp", createHash("sha256").update(`${workspace}:${readOnly}`).digest("hex"));
  mkdirSync(scratchPath, { recursive: true, mode: 0o700 });
  if (lstatSync(scratchPath).isSymbolicLink()) throw new Error("unsafe sandbox scratch directory");
  const scratch = realpathSync(scratchPath), writable = readOnly ? [] : [workspace, ...gitMetadata(workspace)];
  if (process.platform === "darwin") {
    const sandbox = Bun.which("sandbox-exec");
    if (!sandbox) throw new Error("workspace sandbox unavailable: sandbox-exec not found; select sandbox=off explicitly for full access");
    const writes = [scratch, "/dev", ...writable].map(p => `(subpath ${JSON.stringify(p)})`).join(" ");
    return [sandbox, "-p", `(version 1) (allow default) (deny file-write*) (allow file-write* ${writes})`,
      "/usr/bin/env", `TMPDIR=${scratch}`, `TMP=${scratch}`, `TEMP=${scratch}`, ...argv];
  }
  if (process.platform === "linux") {
    const sandbox = Bun.which("bwrap");
    if (!sandbox) throw new Error("workspace sandbox unavailable: bubblewrap not found; select sandbox=off explicitly for full access");
    return [sandbox, "--die-with-parent", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp",
      ...writable.flatMap(p => ["--bind", p, p]), "--setenv", "TMPDIR", "/tmp", "--chdir", workspace, "--", ...argv];
  }
  throw new Error("workspace sandbox is unsupported on this platform; no unsandboxed command was launched");
}
/** Worktree commits also write their owning repository's Git object/ref storage.
 * This is a filesystem write boundary, not per-ref Git authorization. */
function gitMetadata(cwd: string): string[] {
  const result = Bun.spawnSync(["git", "rev-parse", "--absolute-git-dir", "--git-common-dir"], { cwd, stderr: "ignore" });
  if (result.exitCode) return [];
  return [...new Set(result.stdout.toString().trim().split("\n").map(p => realpathSync(resolve(cwd, p))))];
}
