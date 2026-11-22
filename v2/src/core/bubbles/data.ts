import { lstat, mkdir, readlink, rename, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import { fail, ok, paths, type Result } from "../../config";
import { readConversation } from "../conversations";

export const RESERVED_DATA = ["bubble", "global"];

async function pointLink(root: string, name: string, target: string | null): Promise<Result<null>> {
  const link = join(root, name);
  const current = await lstat(link).catch(() => null);
  if (current !== null && !current.isSymbolicLink()) return fail(`${link} is a real folder; $ORCA_DATA/${name} is reserved`);
  if (target === null) {
    if (current !== null) await unlink(link);
    return ok(null);
  }
  if (current !== null && await readlink(link) === target) return ok(null);
  const temp = `${link}.${crypto.randomUUID()}.tmp`;
  await symlink(target, temp);
  await rename(temp, link);
  return ok(null);
}

export async function ensureDataDirs(conversation: string): Promise<Result<string>> {
  const root = paths.data(conversation);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(paths.globalData, { recursive: true, mode: 0o700 });
  const bubble = (await readConversation(conversation))?.bubble ?? null;
  if (bubble !== null) await mkdir(paths.bubbleData(bubble), { recursive: true, mode: 0o700 });
  const links = [await pointLink(root, "global", paths.globalData), await pointLink(root, "bubble", bubble === null ? null : paths.bubbleData(bubble))];
  const problems = links.flatMap(link => link.ok ? [] : [link.error]);
  return problems.length === 0 ? ok(root) : fail(problems.join("; "));
}

export async function pluginData(conversation: string, plugin: string, scope: "conversation" | "bubble" | "global"): Promise<Result<string>> {
  if (RESERVED_DATA.includes(plugin)) return fail(`${plugin}: $ORCA_DATA/${plugin} is reserved`);
  const root = await ensureDataDirs(conversation);
  if (!root.ok && scope !== "conversation") return root;
  const base = paths.data(conversation);
  if (scope === "bubble" && ((await readConversation(conversation))?.bubble ?? null) === null) return fail(`${plugin}: this conversation has no bubble yet`);
  const dir = scope === "conversation" ? join(base, plugin) : join(base, scope, plugin);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return ok(dir);
}

export const DATA_SENTENCE = "Plugin data is under $ORCA_DATA: <plugin>/ for this conversation, bubble/<plugin>/ for its bubble, global/<plugin>/ for all; read it freely, change it only through the plugin's tools.";
