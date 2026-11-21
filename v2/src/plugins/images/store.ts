// The conversation's images as the core image store keeps them (paths.images(conversation)/img-<hash>.<ext>), newest
// first. Read-only: images are saved by the core (Ctrl+V, `read`, MCP); this plugin only lists and shows them.
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { sniffImage, validateImage } from "../../api";
import { paths } from "../../config";

export type StoredImage = { id: string; file: string; bytes: number; at: string };

const NAME = /^(img-[a-f0-9]{16})\.(png|jpg|gif|webp)$/;

export async function listImages(conversation: string): Promise<StoredImage[]> {
  const dir = paths.images(conversation);
  const names = await readdir(dir).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return []; throw e; });
  const out: StoredImage[] = [];
  for (const name of names) {
    const match = NAME.exec(name);
    if (match === null) continue;
    const file = join(dir, name);
    const info = await stat(file).catch(() => null);
    if (info === null || info.size === 0) continue;
    out.push({ id: match[1]!, file, bytes: info.size, at: info.mtime.toISOString() });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
}

/** Width and height read from the file's header, or null when it cannot be read. */
export async function dimensions(file: string): Promise<{ width: number; height: number } | null> {
  try {
    const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
    const mime = sniffImage(bytes);
    return mime === undefined ? null : validateImage(bytes, mime);
  } catch { return null; }
}

export function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const when = (iso: string): string => iso.slice(0, 16).replace("T", " ");
