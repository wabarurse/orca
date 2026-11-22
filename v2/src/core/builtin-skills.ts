import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import orcaPlugin from "../../skills/orca-plugin/SKILL.md" with { type: "text" };
import { paths } from "../config";

const SKILLS: Record<string, string> = { "orca-plugin": orcaPlugin };

export const builtinSkillsDir = (): string => join(paths.runtime, "skills");

export async function ensureBuiltinSkills(): Promise<string[]> {
  const out: string[] = [];
  for (const [name, text] of Object.entries(SKILLS)) {
    const dir = join(builtinSkillsDir(), name);
    const file = Bun.file(join(dir, "SKILL.md"));
    if (!(await file.exists()) || await file.text() !== text) { await mkdir(dir, { recursive: true }); await Bun.write(file, text); }
    out.push(dir);
  }
  return out;
}
