import { loadImage } from "../../core/data/images";
import { sniffImage, validateImage } from "../../providers";
import type { Entry, ImageRef } from "../../protocol";
import { previewBytes } from "./image-preview";

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

/** Return only validated project-owned bytes; no external viewer or local-path
 * assumptions. The terminal renders this on the viewer's machine, including SSH. */
export async function deliveredImageData(project: string, ref: ImageRef) {
  const bytes = await previewBytes(await loadImage(project, ref));
  const { width, height } = validateImage(bytes, sniffImage(bytes));
  return { data: bytes.toString("base64"), bytes: bytes.length, sourceWidth: width, sourceHeight: height };
}
