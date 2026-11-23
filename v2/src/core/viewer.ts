import { join } from "node:path";
import { z } from "zod";
import { parseJson, paths } from "../config";
import { writeAtomic } from "./conversations";
import { pidAlive } from "./lock";

export type Viewer = { pid: number; rexSession: string | null; rexBlock: string | null };
const ViewerFile = z.object({ pid: z.number().int(), rexSession: z.string().nullable(), rexBlock: z.string().nullable() });
const file = (conversation: string): string => join(paths.conversation(conversation), "viewer.json");

export function viewerHere(env: Record<string, string | undefined>, pid: number): Viewer {
  const session = env.REX_SESSION, block = env.REX_BLOCK;
  return { pid, rexSession: session !== undefined && session.length > 0 ? session : null, rexBlock: block !== undefined && block.length > 0 ? block : null };
}

export async function saveViewer(conversation: string, viewer: Viewer): Promise<void> {
  await writeAtomic(file(conversation), JSON.stringify(viewer));
}

export async function readViewer(conversation: string): Promise<Viewer | null> {
  const f = Bun.file(file(conversation));
  if (!await f.exists()) return null;
  const json = parseJson(await f.text());
  const parsed = json.ok ? ViewerFile.safeParse(json.data) : null;
  return parsed !== null && parsed.success && pidAlive(parsed.data.pid) ? parsed.data : null;
}
