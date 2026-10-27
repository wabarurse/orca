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
function readDefinition(file: string): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o022) || stat.size > 128 * 1024) throw new Error(`unsafe definition: ${file}`);
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}
function readProvenance(record: string): string | undefined {
  try {
    const st = lstatSync(record);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== process.getuid?.() || (st.mode & 0o022)) throw new Error(`unsafe provenance: ${record}`);
    return readFileSync(record, "utf8");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function reconcileDefault(file: string, relative: string, content: string, shipped: string): string {
  const provenance = join(paths.runtime, "definition-defaults");
  privateDirectory(paths.runtime);
  privateDirectory(provenance);
  const record = join(provenance, relative.replaceAll("/", "--") + ".sha256");
  const prior = readProvenance(record);
  // Preserve prior baseline for edits; only byte-identical defaults advance.
  const unedited = content === shipped || prior === hash(content);
  if (!unedited) return content;
  if (content !== shipped) {
    const next = `${file}.next-${process.pid}`;
    writeFileSync(next, shipped, { flag: "wx", mode: 0o600 });
    renameSync(next, file);
  }
  writeFileSync(record, hash(shipped), { mode: 0o600 });
  return shipped;
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
  return reconcileDefault(file, relative, readDefinition(file), shipped);
}
