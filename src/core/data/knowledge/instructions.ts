import { createHash } from "node:crypto";
import { access, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { paths } from "../../../config";
import { selectedKnowledge, workingContext } from "./knowledge";

async function repositoryRoot(base: string): Promise<string> {
  for (let dir = base; ; dir = dirname(dir)) {
    if (await access(join(dir, ".git")).then(() => true, () => false)) return dir;
    if (dirname(dir) === dir) return base;
  }
}

/** Inspired by Codex's hierarchical AGENTS.md loading and Claude Code's scoped
 * instructions/lazy skills. This is an independent, bounded filesystem resolver.
 * https://github.com/openai/codex/blob/main/codex-rs/core/src/agents_md.rs
 * https://code.claude.com/docs/en/skills */
export async function repositoryInstructions(cwd: string, target = cwd, belowCwd = false): Promise<string> {
  const base = await realpath(cwd).catch(error => { if (["ENOENT", "ENOTDIR"].includes(error.code)) return undefined; throw error; });
  if (!base) return "";
  const root = await repositoryRoot(base);
  const selected = await realpath(resolve(target)).catch(error => { if (["ENOENT", "ENOTDIR"].includes(error.code)) return undefined; throw error; });
  if (!selected) return "";
  const rel = relative(root, selected);
  if (rel.startsWith("..") || rel.startsWith("/")) return "";
  const dirs = [root];
  for (const part of rel.split("/").filter(Boolean)) dirs.push(join(dirs.at(-1)!, part));
  const blocks: string[] = []; let remaining = 16000;
  for (const dir of dirs) {
    if (belowCwd && (dir === base || !relative(base, dir) || relative(base, dir).startsWith(".."))) continue;
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const file = join(dir, name);
      const data = await readFile(file, "utf8").catch(error => { if (["ENOENT", "ENOTDIR"].includes(error.code)) return undefined; throw error; });
      if (data === undefined) continue;
      const hash = createHash("sha256").update(data).digest("hex").slice(0, 12);
      const shown = data.slice(0, Math.max(0, remaining)); remaining -= shown.length;
      blocks.push(`Instructions: ${file} (${hash})\n${shown}${shown.length < data.length ? "\n[Instruction body continues: use read on this file before acting in its scope.]" : ""}`);
      if (name === "AGENTS.md") break; // Explicit compatibility: AGENTS wins over CLAUDE in the same directory.
    }
  }
  return blocks.join("\n\n");
}
interface SkillEntry { name: string; path: string; description: string }
export const SKILL_RESULT_LIMIT = 8;

export async function discoverSkills(cwd: string): Promise<SkillEntry[]> {
  const base = await realpath(cwd).catch(error => { if (["ENOENT", "ENOTDIR"].includes(error.code)) return undefined; throw error; });
  const roots: string[] = [];
  if (base) {
    const repo = await repositoryRoot(base);
    // Like Pi, discover repository skills from the working directory up to the Git root.
    // https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md
    for (let dir = base; ; dir = dirname(dir)) {
      roots.push(join(dir, ".agents", "skills"), join(dir, ".claude", "skills"));
      if (dir === repo) break;
    }
  }
  roots.push(join(paths.root, "skills"));

  const found = new Map<string, SkillEntry>();
  for (const root of roots) {
    const names: string[] = await readdir(root).catch(error => { if (["ENOENT", "ENOTDIR"].includes(error.code)) return []; throw error; });
    for (const name of names.sort()) {
      if (!/^[\w-]+$/.test(name) || found.has(name)) continue;
      const path = join(root, name, "SKILL.md");
      const text = await Bun.file(path).slice(0, 4096).text().catch(() => "");
      if (text) found.set(name, { name, path, description: text.match(/^description:[ \t]*(.+)$/m)?.[1]?.trim().slice(0, 160) || "Read SKILL.md for instructions" });
    }
  }
  return [...found.values()];
}

export async function agentContext(project: string, cwd: string, query: string): Promise<Record<string, string>> {
  const [instructions, skills, context, remembered] = await Promise.all([
    repositoryInstructions(cwd), discoverSkills(cwd), workingContext(project), selectedKnowledge(project, query),
  ]);
  return { instructions, skills: skills.length ? `Repository and personal skills (${skills.length}). Before inventing a workflow, use skill({search: "workflow keywords"}) for relevant skills or skill({name: "exact-name"}) to load one. Preview (${Math.min(skills.length, SKILL_RESULT_LIMIT)} of ${skills.length}): ${JSON.stringify(skills.slice(0, SKILL_RESULT_LIMIT).map(({ name, description }) => ({ name, description })))}` : "",
    knowledge: `Relevant knowledge (source-attributed context; current user instructions override): ${remembered}`,
    brief: `Shared working brief (reported facts require evidence; latest human corrections take precedence): ${JSON.stringify(context)}` };
}

/** Compatibility projection for callers that need one text artifact. */
export async function agentKnowledge(project: string, cwd: string, query: string): Promise<string> {
  return Object.values(await agentContext(project, cwd, query)).filter(Boolean).join("\n\n");
}
