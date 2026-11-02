// A persisted UUID is identity. Inode/birth time only detect directory replacement;
// st_dev is deliberately excluded because macOS can renumber devices after reboot.
import { linkSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { conversationPath } from "./conversation-storage";
interface Identity { id: string; fingerprint: string }
const uuid = /^[a-f0-9-]{36}$/;
export function conversationIdentity(root: string, name: string): Identity {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error("invalid conversation id");
  const directory = conversationPath(root, name), st = lstatSync(directory, { bigint: true });
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("unsafe conversation directory");
  const fingerprint = `${st.ino}:${st.birthtimeNs}`;
  const file = join(directory, ".identity.json");
  try {
    const value = readIdentity(file);
    return value;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const next: Identity = { id: crypto.randomUUID(), fingerprint }, temp = `${file}.${next.id}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(next), { flag: "wx", mode: 0o600 });
    try { linkSync(temp, file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally { unlinkSync(temp); }
  return readIdentity(file);
}
function readIdentity(file: string): Identity {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 2 || stat.uid !== process.getuid?.() || stat.size > 4096 || (stat.mode & 0o022) !== 0) throw new Error("unsafe conversation identity");
  const value = JSON.parse(readFileSync(file, "utf8"));
  if (!uuid.test(value.id) || !/^\d+:\d+$/.test(value.fingerprint)) throw new Error("invalid conversation identity");
  return value;
}
