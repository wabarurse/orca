import type { Entry } from "../../protocol";
import type { Line } from "./lines";

interface ChatPage {
  lines: Line[]; chatClearedThrough?: string;
  md: { reset(): void }; calls: { clear(): void };
  orch: { entries?(): Entry[] };
  view: { lines: Line[]; calls: { clear(): void } } | null;
}
/** A local viewport boundary only. No transcript, inbox, cache or model mutation. */
export function clearChatView(page: ChatPage): void {
  if (page.view) { page.view.lines = []; page.view.calls.clear(); return; }
  page.chatClearedThrough = page.orch.entries?.().at(-1)?.uuid;
  page.lines = []; page.md.reset(); page.calls.clear();
}
/** Refreshes still reconcile receipts and context, but restore only new UI entries. */
export function visibleChatEntries(entries: Entry[], through?: string): Entry[] {
  if (!through) return entries;
  const index = entries.findIndex(entry => entry.uuid === through);
  return index < 0 ? entries : entries.slice(index + 1);
}
