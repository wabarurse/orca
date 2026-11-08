import { imageFile } from "../../core/data/images";
import { run } from "../../core/proc";
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

/** User-invoked only: no shell interpolation, browser URLs, or automatic popups. */
export async function openDeliveredImage(project: string, ref: ImageRef, open?: (path: string) => Promise<void>): Promise<string> {
  const path = await imageFile(project, ref);
  if (open) { await open(path); return `opened image ${ref.id.slice(0, 8)}`; }
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY) throw new Error(`image is on the remote machine: ${path}; open it on that machine or copy it locally to view`);
  const command = process.platform === "darwin" ? "/usr/bin/open" : process.platform === "linux" ? Bun.which("xdg-open") : undefined;
  if (!command) throw new Error(`no image viewer available; image saved at ${path}`);
  const result = await run([command, path], { cwd: "/", timeoutMs: 10_000 });
  if (!result || result.code !== 0) throw new Error(`could not open the image viewer; image saved at ${path}`);
  return `opened image ${ref.id.slice(0, 8)}`;
}
