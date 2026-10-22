#!/usr/bin/env bun
// Local-only installer. Never touches PARALLELS_HOME, auth, projects, or shell files.
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, rename, rm, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const RECEIPT = ".parallels-install.json";
const KIND = "parallels-local-install-v1";
const digest = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

async function stat(path: string) {
  try { return await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function owned(path: string, directory = false) {
  const s = await stat(path);
  if (s && (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile() || s.nlink !== 1)
    || s.uid !== process.getuid!() || (s.mode & 0o022))) {
    throw new Error(`refusing unsafe ${directory ? "directory" : "file"}: ${path} (must be owned by you, not a symlink, and not group/world writable)`);
  }
  return s;
}

async function ensureDirectory(path: string) {
  if (!await owned(path, true)) await mkdir(path, { mode: 0o755 });
}

async function previous(bin: string): Promise<string | null> {
  const target = join(bin, "parallels"), receipt = join(bin, RECEIPT);
  const executable = await owned(target), record = await owned(receipt);
  if (!executable && !record) return null;
  if (!executable || !record) throw new Error(`refusing incomplete or unowned installation at ${target}; inspect it manually`);
  const data = JSON.parse(await readFile(receipt, "utf8"));
  const hash = digest(await readFile(target));
  if (data.kind !== KIND || data.sha256 !== hash) throw new Error(`refusing to overwrite unrelated or modified executable: ${target}`);
  return hash;
}

/** Copy a locally built artifact, never execute an existing destination to identify it.
 * Hash receipt + exclusive lock provide fail-closed upgrades. Both files are staged
 * on the destination filesystem; binary replacement is a single atomic rename.
 * An interruption between the two renames deliberately requires manual inspection.
 */
export async function installBinary(source: string, home = homedir()): Promise<string> {
  if (process.platform === "win32") throw new Error("installation requires macOS or Linux (git and tmux)");
  const root = await realpath(home);
  await owned(root, true);
  await ensureDirectory(join(root, ".local"));
  const bin = join(root, ".local", "bin");
  await ensureDirectory(bin);
  const lock = join(bin, ".parallels-install.lock");
  // Never remove somebody else's lock, including a symlink or a stale lock.
  await mkdir(lock, { mode: 0o700 });
  try {
    const before = await previous(bin);
    const sourceStat = await owned(source);
    if (!sourceStat || !(sourceStat.mode & 0o111)) throw new Error(`not a compiled executable: ${source}`);
    const staged = join(lock, "parallels");
    await copyFile(source, staged, constants.COPYFILE_EXCL);
    await chmod(staged, 0o755);
    const sha256 = digest(await readFile(staged));
    await writeFile(join(lock, "receipt"), JSON.stringify({ kind: KIND, sha256 }) + "\n", { flag: "wx", mode: 0o600 });
    // Do not replace a destination edited while the copy was in progress.
    if (await previous(bin) !== before) throw new Error("installation changed during copy; refusing replacement");
    const target = join(bin, "parallels");
    await rename(staged, target);
    await rename(join(lock, "receipt"), join(bin, RECEIPT));
    return target;
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

async function main() {
  if (process.argv.length !== 2) throw new Error("usage: bun run install:local (installs to $HOME/.local/bin/parallels)");
  if (typeof Bun.isStandaloneExecutable !== "boolean") throw new Error("Bun 1.4.2 or newer is required to build parallels");
  const app = resolve(import.meta.dir, "..");
  const artifact = join(app, "dist", "parallels");
  await ensureDirectory(dirname(artifact));
  await owned(artifact);
  const build = Bun.spawn([process.execPath, "run", "build"], { cwd: app, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  if (await build.exited !== 0) throw new Error("build failed; installed executable was not changed");
  const target = await installBinary(artifact);
  console.log(`Installed ${target}\nAdd $HOME/.local/bin to PATH yourself if needed. No shell files or parallels state were changed.`);
}

if (import.meta.main) {
  try { await main(); }
  catch (error) {
    console.error(`install: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
