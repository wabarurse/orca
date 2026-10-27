import { createHash } from "node:crypto";
// Data only: these files never name modules, handlers, commands, or role capabilities.
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { paths } from "../../config";

function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) || stat.uid !== process.getuid?.()) throw new Error(`unsafe definition directory: ${path}`);
}
/** Missing files follow current shipped defaults. Existing edits are never overwritten. */
export function definition(relative: string, shipped: string): string {
  if (!/^(prompts|tools)\/[a-z_-]+\.(md|json)$/.test(relative)) throw new Error("invalid definition name");
  privateDirectory(paths.root);
  privateDirectory(join(paths.root, "skills"));
  const file = join(paths.root, relative);
  privateDirectory(dirname(file));
  try { writeFileSync(file, shipped, { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o022) || stat.size > 128 * 1024) throw new Error(`unsafe definition: ${file}`);
    const content = readFileSync(fd, "utf8");
    // Provenance is a digest of the last shipped default, not a second user
    // definition. Only a byte-for-byte unedited default advances on upgrade.
    const provenance = join(paths.runtime, "definition-defaults");
    privateDirectory(paths.runtime);
    privateDirectory(provenance);
    const record = join(provenance, relative.replaceAll("/", "--") + ".sha256");
    const hash = (text: string) => createHash("sha256").update(text).digest("hex");
    let prior: string | undefined;
    try {
      const st = lstatSync(record);
      if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== process.getuid?.() || (st.mode & 0o022)) throw new Error(`unsafe provenance: ${record}`);
      prior = readFileSync(record, "utf8");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (content !== shipped && prior === hash(content)) {
      const next = `${file}.next-${process.pid}`;
      writeFileSync(next, shipped, { flag: "wx", mode: 0o600 });
      renameSync(next, file);
    }
    // Preserve prior baseline for edited files, allowing explicit reset to it.
    if (content === shipped || prior === hash(content)) writeFileSync(record, hash(shipped), { mode: 0o600 });
    return content === shipped || prior === hash(content) ? shipped : content;
  } finally { closeSync(fd); }
}
