import type { ImageRef } from "../../protocol";
import { dim } from "../components";

export function imageLines(attachments: readonly ImageRef[] = []): string[] {
  return attachments.filter(ref => /^[a-f0-9-]{36}$/.test(ref?.id ?? "")).map((ref, i) =>
    dim(`Image ${i + 1} · ${ref.id.slice(0, 8)} · /images to open`));
}
