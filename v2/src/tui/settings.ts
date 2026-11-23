import { provider } from "../api";
import { accounts, type Account, type ProviderName } from "../api/auth";
import { modelCapabilities, providerFor } from "../api/model";
import { loadConfig, ok, fail, saveConfig, type Result } from "../config";
import { saveConversation, type Conversation } from "../core/conversations";
import { dim } from "./components";

export type Choice<T> = { value: T; label: string; current: boolean };

export const RECENT_MODELS = 6;

export function recentModels(ids: string[], current: string): string[] {
  const head = ids.slice(0, RECENT_MODELS);
  return ids.includes(current) && !head.includes(current) ? [...head, current] : head;
}

export async function selectedAccount(model: string): Promise<{ provider: ProviderName; profile: string }> {
  const config = await loadConfig();
  const name = providerFor(model);
  const configured = name === "anthropic" ? config.account : config.openaiAccount;
  return { provider: name, profile: configured.length > 0 ? configured : "default" };
}

export async function modelChoices(model: string): Promise<Result<Choice<string>[]>> {
  const account = await selectedAccount(model);
  const loaded = await provider(account.provider, { profile: account.profile });
  if (!loaded.ok) return loaded;
  try {
    const ids = await loaded.data.models();
    return ok(recentModels(ids, model).map(id => ({ value: id, label: `${id}  ${dim(account.provider)}`, current: id === model })));
  } catch (error) { return fail(`${account.provider}: ${error instanceof Error ? error.message : String(error)}`); }
}

export function effortChoices(model: string, effort: string | null): Choice<string>[] {
  const current = effort ?? "default";
  return ["default", ...modelCapabilities(model).effort].map(value => ({ value, label: value, current: value === current }));
}

export function fastChoices(fast: boolean): Choice<boolean>[] {
  return [{ value: false, label: "off", current: !fast }, { value: true, label: "on", current: fast }];
}

export async function accountChoices(model: string): Promise<Choice<Account>[]> {
  const selected = await selectedAccount(model);
  return (await accounts(selected)).filter(a => a.ok).map(a => ({ value: a, current: a.active, label: `${a.id.padEnd(22)} ${dim(a.source)}` }));
}

export async function setModel(conversation: Conversation, model: string): Promise<Result<Conversation>> {
  const effort = modelCapabilities(model).effort.some(e => e === conversation.effort) ? conversation.effort : null;
  const fast = conversation.fast && modelCapabilities(model).fast;
  const next = { ...conversation, model, effort, fast };
  await saveConversation(next);
  return ok(next);
}

export async function setEffort(conversation: Conversation, level: string): Promise<Result<Conversation>> {
  const model = conversation.model ?? (await loadConfig()).model;
  if (level !== "default" && !modelCapabilities(model).effort.some(e => e === level)) return fail(`effort ${level} is unsupported for ${model}`);
  const next = { ...conversation, effort: level === "default" ? null : level };
  await saveConversation(next);
  return ok(next);
}

export async function setFast(conversation: Conversation, on: boolean): Promise<Result<Conversation>> {
  const model = conversation.model ?? (await loadConfig()).model;
  if (on && !modelCapabilities(model).fast) return fail(`fast mode is unsupported for ${model}`);
  const next = { ...conversation, fast: on };
  await saveConversation(next);
  return ok(next);
}

export async function useAccount(conversation: Conversation, account: Account): Promise<Result<{ conversation: Conversation; note: string }>> {
  const model = conversation.model ?? (await loadConfig()).model;
  const profile = account.profile === "default" ? "" : account.profile;
  if (providerFor(model) === account.provider) {
    await saveConfig(account.provider === "anthropic" ? { account: profile } : { openaiAccount: profile });
    return ok({ conversation, note: `using ${account.id} from the next request` });
  }
  const loaded = await provider(account.provider, { profile: account.profile });
  if (!loaded.ok) return loaded;
  const offered = await loaded.data.models().catch((): string[] => []);
  const next = offered.at(0);
  if (next === undefined) return fail(`${account.provider} offers no models for ${account.id}; this chat keeps ${model}`);
  await saveConfig(account.provider === "anthropic" ? { account: profile } : { openaiAccount: profile });
  const moved = await setModel(conversation, next);
  if (!moved.ok) return moved;
  return ok({ conversation: moved.data, note: `using ${account.id}; the model changed from ${model} to ${next} (/model picks another)` });
}
