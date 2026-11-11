import type { Entry, ImageRef } from "../../protocol";

export interface DeliveredImage { ref: ImageRef; from: string; text: string; at: string }

/** Only attachments actually delivered to the user are eligible for the picker. */
export function deliveredImages(entries: readonly Entry[]): DeliveredImage[] {
  const images = new Map<string, DeliveredImage>();
  for (const entry of entries) {
    if (entry.type !== "replies") continue;
    for (const message of entry.messages) {
      for (const ref of message.attachments ?? []) {
        if (!ref || typeof ref.id !== "string" || !/^[a-f0-9-]{36}$/.test(ref.id)) continue;
        images.delete(ref.id);
        images.set(ref.id, { ref, from: message.from, text: message.text, at: entry.ts });
      }
    }
  }
  return [...images.values()].reverse();
}
