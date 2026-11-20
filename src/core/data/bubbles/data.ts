// Plugin data: one fixed place an agent finds it, `$ORCA_DATA` (the conversation's `data/` folder). Inside it,
// `<plugin>/` is this conversation's, `bubble/` links to its bubble's `data/` and `global/` to the home's `data/`.
// Those two names are reserved. The links are refreshed whenever the folders are ensured, so joining another
// bubble moves `bubble/` with it; a conversation with no bubble has no `bubble/` link (none is created for this).
import { lstat, mkdir, readlink, rename, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../../../config";
import { bubbleDir, peekBubble, readBubble } from "./store";

/** Names inside `$ORCA_DATA` that no plugin may use (the plugin system to come checks them). */
export const RESERVED_DATA = ["bubble", "global"] as const;
const [BUBBLE, GLOBAL] = RESERVED_DATA;

const bubbleData = (id: string) => join(bubbleDir(id), "data");

/** The folders `read` may open plugin data from: the conversation's, its current bubble's and the global one. */
export function dataRoots(project: string): string[] {
  const bubble = peekBubble(project);
  return [paths.data(project), ...(bubble ? [bubbleData(bubble)] : []), paths.globalData];
}

/** Make the conversation's data folders and links current; returns the `$ORCA_DATA` path. */
export async function ensureDataDirs(project: string): Promise<string> {
  const dir = paths.data(project);
  await mkdir(dir, { recursive: true });
  await mkdir(paths.globalData, { recursive: true });
  await pointAt(join(dir, GLOBAL), paths.globalData);
  const id = peekBubble(project), bubble = id ? await readBubble(id) : null;
  if (bubble) {
    await mkdir(bubbleData(bubble.id), { recursive: true });
    await pointAt(join(dir, BUBBLE), bubbleData(bubble.id));
  } else await unlinkLink(join(dir, BUBBLE));
  return dir;
}

/** A symlink at `path` to `target`, replaced atomically when it points elsewhere. */
async function pointAt(path: string, target: string): Promise<void> {
  const current = await readlink(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`${path} is reserved for orca's data link`);
  });
  if (current === target) return;
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  await symlink(target, temp);
  await rename(temp, path).catch(async error => { await unlink(temp).catch(() => {}); throw error; });
}

async function unlinkLink(path: string): Promise<void> {
  const stat = await lstat(path).catch(() => null);
  if (stat?.isSymbolicLink()) await unlink(path).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
}
