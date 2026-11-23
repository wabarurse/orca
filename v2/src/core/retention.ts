import { errorMessage } from "../config";
import { pluginData } from "./bubbles";
import { readConversation } from "./conversations";
import { put } from "./inbox";
import { availablePlugins, enabledNames } from "./plugins";
import type { BackgroundContext, Retention } from "./plugins/types";
import { archiveItems, forgetItems, shelfEntry, shelfKey } from "./shelf";
import { trustState } from "./trust";

export type BoundRetention = { plugin: string; retention: Retention; ctx: BackgroundContext };
export type RetentionChange = { path: string; disposition: string };

const DAY_MS = 86_400_000;
const olderThan = (at: string, days: number, now: number): boolean => {
  const time = Date.parse(at);
  return Number.isFinite(time) && now - time >= days * DAY_MS;
};

export async function retentionFor(conversation: string): Promise<BoundRetention[]> {
  const meta = await readConversation(conversation);
  if (meta === null) return [];
  const { plugins } = await availablePlugins(meta.directory, await trustState(meta.directory) === "trusted");
  const out: BoundRetention[] = [];
  for (const name of await enabledNames(conversation)) {
    const loaded = plugins.get(name);
    if (loaded === undefined) continue;
    const ctx: BackgroundContext = { plugin: name, conversation, directory: meta.directory, data: scope => pluginData(conversation, name, scope),
      notify: async text => { await put(conversation, "orchestrator", name, text, { images: [], delivery: "steer" }); } };
    for (const retention of loaded.plugin.retention) out.push({ plugin: name, retention, ctx });
  }
  return out;
}

export async function archiveDue(conversation: string, now: number, apply: boolean): Promise<RetentionChange[]> {
  const changes: RetentionChange[] = [];
  for (const { plugin, retention, ctx } of await retentionFor(conversation)) {
    const days = retention.archiveAfterDays;
    if (days === null) continue;
    const key = shelfKey(plugin, retention.tab);
    try {
      const entry = await shelfEntry(conversation, key);
      const due = (await retention.settled(ctx)).filter(item => entry.archived[item.id] === undefined && entry.restored[item.id] === undefined && olderThan(item.at, days, now));
      if (apply) await archiveItems(conversation, key, due.map(item => item.id), new Date(now).toISOString());
      for (const item of due) changes.push({ path: `${key}/${item.id}`, disposition: `${apply ? "archived" : "would archive"}: ${plugin} ${retention.tab} ${item.id}, settled over ${days} day${days === 1 ? "" : "s"} ago` });
    } catch (error) { changes.push({ path: key, disposition: `kept: ${plugin} ${retention.tab} could not be archived (${errorMessage(error)})` }); }
  }
  return changes;
}

export async function purgeExpired(conversation: string, now: number, apply: boolean): Promise<RetentionChange[]> {
  const changes: RetentionChange[] = [];
  for (const { plugin, retention, ctx } of await retentionFor(conversation)) {
    const key = shelfKey(plugin, retention.tab);
    try {
      const entry = await shelfEntry(conversation, key);
      const expired = Object.entries(entry.archived).filter(([, at]) => olderThan(at, retention.purgeAfterDays, now)).map(([id]) => id);
      if (expired.length === 0) continue;
      const located = await Promise.all(expired.map(async id => ({ id, path: await retention.locate(id, ctx).catch(() => null) })));
      if (apply) {
        await retention.purge(expired, ctx);
        await forgetItems(conversation, key, expired);
      }
      for (const { id, path } of located) changes.push({ path: path ?? `${key}/${id}`, disposition: `${apply ? "removed" : "would remove"}: archived ${plugin} ${retention.tab} ${id}, archived over ${retention.purgeAfterDays} days ago` });
    } catch (error) { changes.push({ path: key, disposition: `kept: archived ${plugin} ${retention.tab} items could not be removed (${errorMessage(error)})` }); }
  }
  return changes;
}
