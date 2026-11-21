// Which plugins are on: the config's default list, then each bubble's own on/off switches.
import { loadConfig } from "../../config";
import { readBubble } from "../bubbles";
import { readConversation } from "../conversations";

export async function enabledNames(conversation: string): Promise<string[]> {
  const config = await loadConfig();
  const bubbleId = (await readConversation(conversation))?.bubble ?? null;
  const bubble = bubbleId === null ? null : await readBubble(bubbleId);
  const on = new Set(config.plugins);
  for (const name of bubble?.plugins.on ?? []) on.add(name);
  for (const name of bubble?.plugins.off ?? []) on.delete(name);
  return [...on].sort();
}
