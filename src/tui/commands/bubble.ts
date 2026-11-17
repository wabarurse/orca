// Which bubble a new conversation joins. Asked once, right after the conversation opens and before its first
// prompt: "New bubble" (the default, also what Esc leaves) changes nothing, since a bubble is created on its first
// write; any other row attaches the conversation to that bubble's memory, notebook and behavior.
import { bubbleMembers, joinBubble, listBubbles } from "../../core/data/bubbles";
import type { Choice } from "./model";

export interface BubbleHost {
  open(title: string, choices: Choice<string | null>[], pick: (bubble: string | null) => Promise<void>): void;
  note(text: string): void;
}
const HINT = "/rename <name> to rename";

/** The picker's rows: "New bubble" first and current, then every bubble by name. Empty when there is none to join. */
export async function bubbleChoices(): Promise<Choice<string | null>[]> {
  const bubbles = await listBubbles();
  if (!bubbles.length) return [];
  return [{ value: null, label: "New bubble", current: true }, ...bubbles.map(bubble => {
    const members = bubbleMembers(bubble.id).length;
    return { value: bubble.id, label: `${bubble.name} · ${members} conversation${members === 1 ? "" : "s"}` };
  })];
}

/** Settle a new conversation's bubble: join `bubble` when the caller already chose one, else ask when there is a choice. */
export async function chooseBubble(project: string, bubble: string | null, host: BubbleHost): Promise<void> {
  const join = async (id: string) => host.note(`joined bubble ${(await joinBubble(project, id)).name}`);
  if (bubble) return join(bubble);
  const choices = await bubbleChoices();
  if (!choices.length) return host.note(HINT);
  host.open("bubble for this conversation: shared memory, notebook and behavior", choices, async id => { if (id) await join(id); else host.note(HINT); });
}
