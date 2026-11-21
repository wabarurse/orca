import { lstat, mkdir, readlink, rename, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../../config";
import { readConversation } from "../conversations";

export const RESERVED_DATA = ["bubble", "global"] as const;

async function pointLink(link: string, target: string): Promise<void> {
  const current = await lstat(link).catch(() => null);
  if (current !== null && !current.isSymbolicLink()) throw new Error(`${link} is a real folder; $ORCA_DATA/${link.split("/").at(-1)} is reserved`);
  if (current !== null && await readlink(link) === target) return;
  const temp = `${link}.${crypto.randomUUID()}.tmp`;
  await symlink(target, temp);
  await rename(temp, link);
}

export async function ensureDataDirs(conversation: string): Promise<string> {
  const root = paths.data(conversation);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(paths.globalData, { recursive: true, mode: 0o700 });
  await pointLink(join(root, "global"), paths.globalData);
  const bubble = (await readConversation(conversation))?.bubble ?? null;
  const link = join(root, "bubble");
  if (bubble === null) {
    const current = await lstat(link).catch(() => null);
    if (current?.isSymbolicLink() === true) await unlink(link);
  } else {
    await mkdir(paths.bubbleData(bubble), { recursive: true, mode: 0o700 });
    await pointLink(link, paths.bubbleData(bubble));
  }
  return root;
}

export async function pluginData(conversation: string, plugin: string, scope: "conversation" | "bubble" | "global"): Promise<string> {
  const root = await ensureDataDirs(conversation);
  const dir = scope === "conversation" ? join(root, plugin) : join(root, scope, plugin);
  if (scope === "bubble" && ((await readConversation(conversation))?.bubble ?? null) === null) throw new Error(`${plugin}: this conversation has no bubble yet`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export const DATA_SENTENCE = "Plugin data is under $ORCA_DATA: <plugin>/ for this conversation, bubble/<plugin>/ for its bubble, global/<plugin>/ for all; read it freely, change it only through the plugin's tools.";
