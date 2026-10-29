import { paths } from "../../config";
import { blockRef, validateRefs } from "../data/images";
import type { ImageRef } from "../../protocol";
import { sessionId } from "../tmux";
import { afterContextBoundary, open } from "../data/transcripts";
import type { ToolContext } from "./registry";
export const attachmentSchema = { type: "array", maxItems: 4, items: { type: "string" }, description: "Explicit attachment_id UUIDs from images you received in this project/context. Omitted means no images. Sends actual image content, not filenames. Forward relevant images when delegating visual work/review." };
/** Possession of a guessed UUID is not permission: it must occur as a real image
 * block in the sender's own context epoch (not in arbitrary tool/user prose). */
export async function forwardImages(input: unknown, ctx: ToolContext): Promise<ImageRef[]> {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 4 || input.some(id => typeof id !== "string") || new Set(input).size !== input.length) throw new Error("attachments must be up to four distinct attachment_id values");
  const transcript = open(paths.transcript(ctx.project, sessionId(ctx.role, ctx.branch)));
  const allowed = new Map<string, ImageRef>();
  for (const entry of afterContextBoundary(transcript.history!())) {
    if (entry.type !== "message" || entry.message.role !== "user" || !Array.isArray(entry.message.content)) continue;
    // Prompt images, and images a tool (`read`) returned inside its tool_result.
    const images = entry.message.content.flatMap(block => block.type === "image" ? [block]
      : block.type === "tool_result" && Array.isArray(block.content) ? block.content.filter(item => item.type === "image") : []);
    for (const block of images) { const ref = blockRef(block); if (ref) allowed.set(ref.id, ref); }
  }
  const refs = input.map(id => { const ref = allowed.get(id); if (!ref) throw new Error(`image ${id} was not received in this agent's current context.`); return ref; });
  await validateRefs(ctx.project, refs);
  return refs;
}
