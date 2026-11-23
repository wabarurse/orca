import { homedir } from "node:os";
import { lstat, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage, paths } from "../config";
import { ARCHIVE_DAYS, listBubbles, listPages, memoryNodes, purgeNotebook, removeBubble } from "./bubbles";
import { listConversations, validId } from "./conversations";
import { daemonPid } from "./daemon/channel";
import { installedApp, PACKAGE, pruneBuildScratch, run, type Change } from "./install";
import { listRuns, live } from "./runner/runs";
import { archiveDue, purgeExpired } from "./retention";

export type CleanProgress = { step: (label: string, done: number, total: number) => void; end: () => void };
export const quietProgress: CleanProgress = { step: () => {}, end: () => {} };
export const OUTPUT_DAYS = 7;
const DAY_MS = 86_400_000;

export async function cleanStorage(apply: boolean, progress: CleanProgress = quietProgress): Promise<Change[]> {
  const verb = apply ? "cleaning" : "scanning";
  try { return await collect(apply, (phase, done, total) => { progress.step(`${verb} ${phase}`, done, total); }); } finally { progress.end(); }
}

async function collect(apply: boolean, step: (phase: string, done: number, total: number) => void): Promise<Change[]> {
  const changes: Change[] = [];
  const would = apply ? "removed" : "would remove";
  const conversations = await listConversations();
  const known = new Set(conversations.map(c => c.id));

  const folders = (await readdir(paths.conversations).catch((): string[] => [])).filter(name => validId(name) && !known.has(name));
  for (const [index, id] of folders.entries()) {
    step("conversation folders", index, folders.length);
    if (await daemonPid(id) !== null || (await listRuns(id)).some(live)) { changes.push({ path: paths.conversation(id), disposition: `kept: conversation folder ${id} has no record but something still runs in it` }); continue; }
    if (apply) await rm(paths.conversation(id), { recursive: true, force: true });
    changes.push({ path: paths.conversation(id), disposition: `${would}: conversation "${id}" folder left without its record` });
  }

  const trees = (await readdir(join(paths.root, "worktrees")).catch((): string[] => [])).filter(name => !known.has(name));
  for (const [index, id] of trees.entries()) {
    step("worktrees", index, trees.length);
    changes.push(...await orphanWorktrees(id, apply));
  }

  for (const [index, conversation] of conversations.entries()) {
    step("tool outputs", index, conversations.length);
    changes.push(...await oldOutputs(conversation.id, apply));
  }

  for (const [index, conversation] of conversations.entries()) {
    step("archived items", index, conversations.length);
    const now = Date.now();
    changes.push(...await archiveDue(conversation.id, now, apply));
    changes.push(...await purgeExpired(conversation.id, now, apply));
  }

  step("bubbles", 0, 1);
  const attached = new Set(conversations.flatMap(c => c.bubble === null ? [] : [c.bubble]));
  for (const bubble of await listBubbles()) {
    try {
      const empty = (await memoryNodes(bubble.id)).length === 0 && (await listPages(bubble.id)).length === 0;
      if (!attached.has(bubble.id) && empty) {
        if (apply) await removeBubble(bubble.id);
        changes.push({ path: paths.bubble(bubble.id), disposition: `${would}: bubble "${bubble.name}" is empty and has no conversation` });
        continue;
      }
      const expired = await purgeNotebook(bubble.id, Date.now(), ARCHIVE_DAYS, apply);
      if (!expired.ok) { changes.push({ path: paths.bubble(bubble.id), disposition: `kept: notebook of "${bubble.name}" could not be read (${expired.error})` }); continue; }
      for (const page of expired.data) changes.push({ path: join(paths.bubble(bubble.id), "notebook", "archive", `${page.id}.txt`), disposition: `${would}: notebook page "${page.title}" archived over ${ARCHIVE_DAYS} days ago` });
    } catch (error) { changes.push({ path: paths.bubble(bubble.id), disposition: `kept: inspection failed (${errorMessage(error)})` }); }
  }

  step("build scratch", 0, 1);
  changes.push(...await pruneBuildScratch(join(installedApp(homedir()), PACKAGE), apply));
  return changes;
}

async function orphanWorktrees(id: string, apply: boolean): Promise<Change[]> {
  const root = join(paths.root, "worktrees", id);
  const changes: Change[] = [];
  const entries = await readdir(root).catch((): string[] => []);
  const repositories = new Set<string>();
  let keptAny = false;
  for (const name of entries) {
    const tree = join(root, name);
    const status = await run(["git", "--no-optional-locks", "status", "--porcelain"], tree, process.env);
    if (status.code !== 0 || status.out.trim().length > 0) {
      keptAny = true;
      changes.push({ path: tree, disposition: `kept: worktree ${name} ${status.code !== 0 ? "is not a readable git checkout" : "has uncommitted changes"}` });
      continue;
    }
    const common = await run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], tree, process.env);
    if (common.code === 0) repositories.add(join(common.out.trim(), ".."));
    if (apply) await rm(tree, { recursive: true, force: true });
    changes.push({ path: tree, disposition: `${apply ? "removed" : "would remove"}: worktree ${name} of deleted conversation ${id}` });
  }
  if (apply) {
    for (const repository of repositories) await run(["git", "worktree", "prune"], repository, process.env);
    if (!keptAny) await rm(root, { recursive: true, force: true });
  }
  return changes;
}

async function oldOutputs(conversation: string, apply: boolean): Promise<Change[]> {
  const dir = join(paths.conversation(conversation), "tool-outputs");
  const changes: Change[] = [];
  const cutoff = Date.now() - OUTPUT_DAYS * DAY_MS;
  for (const name of await readdir(dir).catch((): string[] => [])) {
    const file = join(dir, name);
    const info = await lstat(file).catch(() => null);
    if (info === null || !info.isFile() || info.mtimeMs > cutoff) continue;
    if (apply) await rm(file, { force: true });
    changes.push({ path: file, disposition: `${apply ? "removed" : "would remove"}: tool output older than ${OUTPUT_DAYS} days` });
  }
  return changes;
}

export async function sizeOf(path: string): Promise<number> {
  const info = await lstat(path).catch(() => null);
  if (info === null) return 0;
  if (!info.isDirectory()) return info.size;
  const du = await run(["du", "-sk", path], paths.root, process.env);
  const kb = Number(du.out.trim().split(/\s+/)[0]);
  return du.code === 0 && Number.isFinite(kb) ? kb * 1024 : (await stat(path)).size;
}

