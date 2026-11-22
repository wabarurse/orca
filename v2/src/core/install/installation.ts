import { constants, type Stats } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { errorCode, errorMessage, fail, ok, parseJson, type Result } from "../../config";

export const BINARY = "orca2";
const RECEIPT = ".orca2-install.json";
const LOCK = ".orca2-install.lock";
const KIND = "orca2-local-install-v1";
const Receipt = z.object({ kind: z.string(), sha256: z.string() });
const digest = (bytes: Uint8Array): string => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

async function stat(path: string): Promise<Result<Stats | null>> {
  try { return ok(await lstat(path)); } catch (error) { return errorCode(error) === "ENOENT" ? ok(null) : fail(errorMessage(error)); }
}

export async function owned(path: string, directory: boolean): Promise<Result<Stats | null>> {
  const found = await stat(path);
  if (!found.ok || found.data === null) return found;
  const s = found.data;
  const shape = directory ? s.isDirectory() : s.isFile() && s.nlink === 1;
  if (s.isSymbolicLink() || !shape || s.uid !== process.getuid?.() || (s.mode & 0o022) !== 0) {
    return fail(`refusing unsafe ${directory ? "directory" : "file"}: ${path} (must be owned by you, not a symlink, and not group/world writable)`);
  }
  return found;
}

async function ensureDirectory(path: string): Promise<Result<null>> {
  const found = await owned(path, true);
  if (!found.ok) return found;
  if (found.data === null) await mkdir(path, { mode: 0o755 });
  return ok(null);
}

async function previous(bin: string): Promise<Result<string | null>> {
  const target = join(bin, BINARY), receipt = join(bin, RECEIPT);
  const executable = await owned(target, false), record = await owned(receipt, false);
  if (!executable.ok) return executable;
  if (!record.ok) return record;
  if (executable.data === null && record.data === null) return ok(null);
  if (executable.data === null || record.data === null) return fail(`refusing incomplete or unowned installation at ${target}; inspect it manually (a launcher script you wrote yourself counts: remove it first)`);
  const json = parseJson(await readFile(receipt, "utf8"));
  const data = json.ok ? Receipt.safeParse(json.data) : null;
  const hash = digest(await readFile(target));
  if (data === null || !data.success || data.data.kind !== KIND || data.data.sha256 !== hash) return fail(`refusing to overwrite unrelated or modified executable: ${target}`);
  return ok(hash);
}

export type Installation = { target: string; replace: (source: string) => Promise<Result<string>> };

export async function withInstallation<T>(home: string, requireExisting: boolean, body: (installation: Installation) => Promise<Result<T>>): Promise<Result<T>> {
  if (process.platform === "win32") return fail("installation requires macos or linux");
  const root = await realpath(home);
  const rootOwned = await owned(root, true);
  if (!rootOwned.ok) return rootOwned;
  for (const path of [join(root, ".local"), join(root, ".local", "bin")]) {
    if (requireExisting) {
      const found = await owned(path, true);
      if (!found.ok) return found;
      if (found.data === null) return fail(`missing installation: ${path}; install with bun run install:local first`);
    } else {
      const made = await ensureDirectory(path);
      if (!made.ok) return made;
    }
  }
  const bin = join(root, ".local", "bin"), target = join(bin, BINARY), lock = join(bin, LOCK);
  try { await mkdir(lock, { mode: 0o700 }); } catch (error) {
    if (errorCode(error) === "EEXIST") return fail(`installation/update lock already exists: ${lock}; wait for the other operation, or inspect a stale lock manually`);
    return fail(errorMessage(error));
  }
  try {
    const before = await previous(bin);
    if (!before.ok) return before;
    if (requireExisting && before.data === null) return fail(`missing installation: ${target}; install with bun run install:local first`);
    return await body({ target, replace: source => replaceBinary(source, bin, lock, before.data) });
  } finally {
    await rm(lock, { recursive: true, force: true }).catch((error: unknown) => { process.stderr.write(`install: inspect leftover lock ${lock}: ${errorMessage(error)}\n`); });
  }
}

async function replaceBinary(source: string, bin: string, lock: string, before: string | null): Promise<Result<string>> {
  const sourceStat = await owned(source, false);
  if (!sourceStat.ok) return sourceStat;
  if (sourceStat.data === null || (sourceStat.data.mode & 0o111) === 0) return fail(`not a compiled executable: ${source}`);
  const staged = join(lock, BINARY);
  await copyFile(source, staged, constants.COPYFILE_EXCL);
  await chmod(staged, 0o755);
  const sha256 = digest(await readFile(staged));
  await writeFile(join(lock, "receipt"), `${JSON.stringify({ kind: KIND, sha256 })}\n`, { flag: "wx", mode: 0o600 });
  const now = await previous(bin);
  if (!now.ok) return now;
  if (now.data !== before) return fail("installation changed during operation; refusing replacement");
  const receipt = join(bin, RECEIPT), target = join(bin, BINARY);
  if (before !== null) await copyFile(receipt, join(lock, "old-receipt"), constants.COPYFILE_EXCL);
  await rename(join(lock, "receipt"), receipt);
  try { await rename(staged, target); } catch (error) {
    if (before !== null) await rename(join(lock, "old-receipt"), receipt); else await rm(receipt);
    return fail(errorMessage(error));
  }
  return ok(target);
}

export async function prepareArtifact(app: string): Promise<Result<string>> {
  const artifact = join(app, "dist", BINARY);
  const made = await ensureDirectory(dirname(artifact));
  if (!made.ok) return made;
  const found = await owned(artifact, false);
  return found.ok ? ok(artifact) : found;
}
