import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, rename, rm, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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

export async function owned(path: string, directory = false) {
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

export interface Installation {
  target: string;
  /** Replace while holding this installation's lock, after rechecking its receipt. */
  replace(source: string): Promise<string>;
}

/** One shared lock covers manual installation and the entire pull/deps/build/install
 * operation. Existing locks are never stolen, including after a crashed updater.
 */
export async function withInstallation<T>(home: string, requireExisting: boolean, body: (installation: Installation) => Promise<T>): Promise<T> {
  if (process.platform === "win32") throw new Error("installation requires macOS or Linux (git and tmux)");
  const root = await realpath(home);
  await owned(root, true);
  for (const path of [join(root, ".local"), join(root, ".local", "bin")]) {
    if (requireExisting) {
      if (!await owned(path, true)) throw new Error(`missing installation: ${path}; install with bun run install:local first`);
    } else await ensureDirectory(path);
  }
  const bin = join(root, ".local", "bin"), target = join(bin, "parallels");
  const lock = join(bin, ".parallels-install.lock");
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`installation/update lock already exists: ${lock}; wait for the other operation, or inspect a stale lock manually`);
    throw error;
  }
  try {
    const before = await previous(bin);
    if (requireExisting && !before) throw new Error(`missing installation: ${target}; install with bun run install:local first`);
    return await body({ target, replace: (source) => replaceBinary(source, bin, lock, before) });
  } finally {
    // Cleanup must not turn a successful final binary rename into a reported
    // installation failure. A leftover lock is safe: the next operation refuses.
    await rm(lock, { recursive: true, force: true }).catch(error => console.error(`install: inspect leftover lock ${lock}: ${error}`));
  }
}

async function replaceBinary(source: string, bin: string, lock: string, before: string | null): Promise<string> {
  const sourceStat = await owned(source);
  if (!sourceStat || !(sourceStat.mode & 0o111)) throw new Error(`not a compiled executable: ${source}`);
  const staged = join(lock, "parallels");
  await copyFile(source, staged, constants.COPYFILE_EXCL);
  await chmod(staged, 0o755);
  const sha256 = digest(await readFile(staged));
  await writeFile(join(lock, "receipt"), JSON.stringify({ kind: KIND, sha256 }) + "\n", { flag: "wx", mode: 0o600 });
  // Do not replace a destination edited while fetching/building/copying.
  if (await previous(bin) !== before) throw new Error("installation changed during operation; refusing replacement");
  const receipt = join(bin, RECEIPT), target = join(bin, "parallels");
  if (before) await copyFile(receipt, join(lock, "old-receipt"), constants.COPYFILE_EXCL);
  // Publish the receipt first, binary LAST. Any failed operation before the
  // final rename leaves the old executable intact. Restore metadata on failure;
  // abrupt interruption between renames remains fail-closed, not guessed ownership.
  await rename(join(lock, "receipt"), receipt);
  try { await rename(staged, target); }
  catch (error) {
    if (before) await rename(join(lock, "old-receipt"), receipt);
    else await rm(receipt);
    throw error;
  }
  return target;
}

/** Copy a locally built artifact, never execute an existing destination to identify it. */
export function installBinary(source: string, home = homedir()): Promise<string> {
  return withInstallation(home, false, installation => installation.replace(source));
}

export async function prepareArtifact(app: string): Promise<string> {
  const artifact = join(app, "dist", "parallels");
  await ensureDirectory(dirname(artifact));
  await owned(artifact);
  return artifact;
}
