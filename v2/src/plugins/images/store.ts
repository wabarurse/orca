import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { sniffImage, validateImage } from "../../api";
import { errorCode, errorMessage, fail, ok, paths, type Result } from "../../config";

export type StoredImage = { id: string; file: string; bytes: number; at: string };

const NAME = /^(img-[a-f0-9]{16})\.(png|jpg|gif|webp)$/;

async function imageNames(dir: string): Promise<Result<string[]>> {
  try { return ok(await readdir(dir)); }
  catch (error) { return errorCode(error) === "ENOENT" ? ok([]) : fail(errorMessage(error)); }
}

function newestFirst(a: StoredImage, b: StoredImage): number {
  const time = b.at.localeCompare(a.at);
  return time !== 0 ? time : a.id.localeCompare(b.id);
}

export async function listImages(conversation: string): Promise<Result<StoredImage[]>> {
  const dir = paths.images(conversation);
  const names = await imageNames(dir);
  if (!names.ok) return names;
  const out: StoredImage[] = [];
  for (const name of names.data) {
    const id = NAME.exec(name)?.[1];
    if (id === undefined) continue;
    const file = join(dir, name);
    const info = await stat(file).catch(() => null);
    if (info === null || info.size === 0) continue;
    out.push({ id, file, bytes: info.size, at: info.mtime.toISOString() });
  }
  return ok(out.sort(newestFirst));
}

export async function dimensions(file: string): Promise<{ width: number; height: number } | null> {
  const bytes = await Bun.file(file).arrayBuffer().then(buffer => new Uint8Array(buffer), () => null);
  if (bytes === null) return null;
  const mime = sniffImage(bytes);
  if (mime === undefined) return null;
  const size = validateImage(bytes, mime);
  return size.ok ? size.data : null;
}

export function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const when = (iso: string): string => iso.slice(0, 16).replace("T", " ");
