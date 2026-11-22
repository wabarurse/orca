import { chmod, link, lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { errorCode, fail, ok, paths, type Result } from "../../config";
import { withStorageLock } from "../lock";
import { contents, MAX_FILE, revision } from "./contents";

export type Change = { text: string; report: Record<string, unknown> };

export async function mutate(path: string, expected: unknown, transform: (old: string) => Result<Change>, create: boolean): Promise<Result<string>> {
  const lock = join(paths.runtime, "file-locks", revision(path));
  return withStorageLock(lock, async (): Promise<Result<string>> => {
    const read = await contents(path).catch((error: unknown) => { if (create && errorCode(error) === "ENOENT") return null; throw error; });
    if (read !== null && !read.ok) return read;
    const old = read === null ? null : read.data;
    if (create && old !== null) return fail(`file exists (revision ${revision(old)}). To replace all of it, retry write with expected_revision "${revision(old)}"; to change part of it, use edit. Read it first if you have not seen its current content.`);
    const seen = old !== null ? revision(old) : null;
    if (!create && expected !== undefined && seen !== expected) return fail(`file changed: expected_revision does not match the current revision "${seen ?? "none"}"; nothing was changed. Check the current content before retrying.`);
    const change = transform(old?.toString("utf8") ?? "");
    if (!change.ok) return change;
    const { text: next, report } = change.data;
    if (Buffer.byteLength(next) > MAX_FILE) return fail("write exceeds 2 MiB");
    const staged = join(dirname(path), `.orca2-write-${crypto.randomUUID()}`);
    try {
      await writeFile(staged, next, { flag: "wx", mode: 0o600 });
      if (old !== null) {
        const s = await lstat(path);
        if (!s.isFile() || s.isSymbolicLink() || revision(await readFile(path)) !== seen) return fail("file changed during edit; no changes applied");
        await chmod(staged, s.mode & 0o777);
        await rename(staged, path);
      } else await link(staged, path);
    } finally { await unlink(staged).catch(() => {}); }
    return ok(JSON.stringify({ path, revision: revision(next), bytes: Buffer.byteLength(next), previous_revision: seen, ...report }));
  });
}
