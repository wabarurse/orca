import { createHash } from "node:crypto";
import { access, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { paths } from "../config";
import { errorCode } from "./result";

export async function repositoryRoot(base: string): Promise<string> {
  for (let dir = base; ; dir = dirname(dir)) {
    if (await access(join(dir, ".git")).then(() => true, () => false)) return dir;
    if (dirname(dir) === dir) return base;
  }
}

const missing = (error: unknown): boolean => ["ENOENT", "ENOTDIR"].includes(errorCode(error) ?? "");

export async function repositoryInstructions(cwd: string, target: string, belowCwd: boolean): Promise<string> {
  const base = await realpath(cwd).catch((error: unknown) => { if (missing(error)) return null; throw error; });
  if (base === null) return "";
  const root = await repositoryRoot(base);
  const selected = await realpath(resolve(target)).catch((error: unknown) => { if (missing(error)) return null; throw error; });
  if (selected === null) return "";
  const rel = relative(root, selected);
  if (rel.startsWith("..") || rel.startsWith("/")) return "";
  const dirs = [root];
  for (const part of rel.split("/").filter(Boolean)) dirs.push(join(dirs.at(-1) ?? root, part));
  const blocks: string[] = [];
  let remaining = 16000;
  for (const dir of dirs) {
    if (belowCwd && (dir === base || relative(base, dir).length === 0 || relative(base, dir).startsWith(".."))) continue;
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const file = join(dir, name);
      const data = await readFile(file, "utf8").catch((error: unknown) => { if (missing(error)) return null; throw error; });
      if (data === null) continue;
      const hash = createHash("sha256").update(data).digest("hex").slice(0, 12);
      const shown = data.slice(0, Math.max(0, remaining));
      remaining -= shown.length;
      blocks.push(`Instructions: ${file} (${hash})\n${shown}${shown.length < data.length ? "\n[continues: read this file before acting in its scope]" : ""}`);
      if (name === "AGENTS.md") break;
    }
  }
  return blocks.join("\n\n");
}

export type SkillEntry = { name: string; path: string; description: string };
export const SKILL_RESULT_LIMIT = 8;

export async function discoverSkills(cwd: string, trusted: boolean, pluginRoots: string[]): Promise<SkillEntry[]> {
  const roots: string[] = [];
  if (trusted) {
    const base = await realpath(cwd).catch(() => null);
    if (base !== null) {
      const repo = await repositoryRoot(base);
      for (let dir = base; ; dir = dirname(dir)) {
        roots.push(join(dir, ".agents", "skills"), join(dir, ".claude", "skills"));
        if (dir === repo || dirname(dir) === dir) break;
      }
    }
  }
  const found = new Map<string, SkillEntry>();
  const add = async (name: string, path: string): Promise<void> => {
    if (!/^[\w-]+$/.test(name) || found.has(name)) return;
    const text = await Bun.file(path).slice(0, 4096).text().catch(() => "");
    if (text.length === 0) return;
    const description = text.match(/^description:[ \t]*(.+)$/m)?.[1]?.trim().slice(0, 160);
    found.set(name, { name, path, description: description !== undefined && description.length > 0 ? description : "Read SKILL.md for instructions" });
  };
  for (const root of roots) {
    const names = await readdir(root).catch((): string[] => []);
    for (const name of names.sort()) await add(name, join(root, name, "SKILL.md"));
  }
  for (const dir of pluginRoots) await add(dir.split("/").at(-1) ?? "", join(dir, "SKILL.md"));
  for (const name of (await readdir(paths.skills).catch((): string[] => [])).sort()) await add(name, join(paths.skills, name, "SKILL.md"));
  return [...found.values()];
}
