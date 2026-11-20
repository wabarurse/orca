import type { ImageRef } from "../../protocol";
import type { ImageLine } from "./lines";

/** Images delivered to the user: one line each, shown in the turn's "+ N images" fold. */
export function imageLines(attachments: readonly ImageRef[] = []): ImageLine[] {
  return attachments.filter(ref => /^[a-f0-9-]{36}$/.test(ref?.id ?? "")).map((ref, i) => ({ image: `Image ${i + 1} · ${ref.id.slice(0, 8)}` }));
}
