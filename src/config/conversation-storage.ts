// Where a conversation's artifacts live: one folder per conversation id under projects/.
import { join } from "node:path";
import { safeProjectDirectories } from "./layout-safety";

export function conversationPath(root: string, id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error("invalid conversation id");
  return join(root, "projects", id);
}
export const conversationIds = (root: string): string[] => safeProjectDirectories(root).sort();
