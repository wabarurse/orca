import { createHash } from "node:crypto";
import { access, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { paths } from "../../../config";
import { selectedKnowledge, workingContext } from "./knowledge";

/** Inspired by Codex's hierarchical AGENTS.md loading and Claude Code's scoped
 * instructions/lazy skills. This is an independent, bounded filesystem resolver.
 * https://github.com/openai/codex/blob/main/codex-rs/core/src/agents_md.rs
 * https://code.claude.com/docs/en/skills */
export async function repositoryInstructions(cwd: string, target = cwd, belowCwd = false): Promise<string> {
  const base = await realpath(cwd).catch(error => { if (["ENOENT", "ENOTDIR"].includes(error.code)) return undefined; throw error; });
  if (!base) return "";
  let root = base;
  while (dirname(root) !== root) {
    if (await access(join(root, ".git")).then(() => true, () => false)) break;
    root = dirname(root);
  }
  if (dirname(root) === root) root = base;
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
export async function discoverSkills(cwd: string): Promise<{ name: string; path: string; description: string }[]> {
  const found: { name: string; path: string; description: string }[] = [];
  for (const root of [join(cwd, ".agents", "skills"), join(cwd, ".claude", "skills"), join(paths.root, "skills")]) {
    for (const name of (await readdir(root).catch(e => { if (e.code === "ENOENT") return []; throw e; })).sort()) {
      if (found.length >= 32 || !/^[\w-]+$/.test(name) || found.some(s => s.name === name)) continue;
      const path = join(root, name, "SKILL.md");
      const text = await Bun.file(path).slice(0, 4096).text().catch(() => "");
      if (text) found.push({ name, path, description: text.match(/^description:\s*(.+)$/m)?.[1]?.slice(0, 160) ?? "Read SKILL.md for instructions" });
    }
  }
  return found;
}
export async function agentKnowledge(project: string, cwd: string, query: string): Promise<string> {
  const [instructions, skills, context, remembered] = await Promise.all([
    repositoryInstructions(cwd), discoverSkills(cwd), workingContext(project), selectedKnowledge(project, query),
  ]);
  return [instructions, skills.length ? `Available skills (load with skill only when relevant): ${JSON.stringify(skills)}` : "",
    `Relevant knowledge (source-attributed context; current user instructions override): ${remembered}`,
    `Shared working brief (reported facts require evidence; latest human corrections take precedence): ${JSON.stringify(context)}`].filter(Boolean).join("\n\n");
}
