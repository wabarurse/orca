import { $ } from "bun";
import { formatScores, SCORED_EXTENSIONS, scoreSource, type FunctionScore } from "../complexity";
import { loadConfig } from "../config";
import type { Tool } from "./index";

// Reviewer-only. Scores the JavaScript/TypeScript files the branch changed
// (or the ones named) and reports a table against the config thresholds.
export const complexity: Tool = {
  spec: {
    name: "complexity",
    description:
      "Cyclomatic and cognitive complexity per function for JavaScript/TypeScript files. With no `files`, scores every file " +
      "this branch changed against `base` (default: the default branch). Reports a table and which functions are over the thresholds.",
    input_schema: {
      type: "object",
      properties: {
        files: { type: "array", items: { type: "string" }, description: "Paths relative to the working directory." },
        base: { type: "string", description: "Git ref to diff against when `files` is omitted." },
      },
    },
  },
  async run(input, ctx) {
    const config = await loadConfig();
    let files = Array.isArray(input.files) ? input.files.map(String) : [];
    if (!files.length) {
      const base = typeof input.base === "string" && input.base ? input.base : await defaultBranch(ctx.cwd);
      const diff = await $`git -C ${ctx.cwd} diff --name-only ${base}...HEAD`.quiet().nothrow();
      const dirty = await $`git -C ${ctx.cwd} diff --name-only HEAD`.quiet().nothrow();
      if (diff.exitCode !== 0) return `error: git diff against ${base} failed: ${diff.stderr.toString().trim()}`;
      files = [...new Set([...diff.stdout.toString().split("\n"), ...dirty.stdout.toString().split("\n")])].filter(Boolean);
    }
    files = files.filter((f) => SCORED_EXTENSIONS.test(f));
    if (!files.length) return "no JavaScript/TypeScript files to score";
    const rows: (FunctionScore & { file: string })[] = [];
    const errors: string[] = [];
    for (const file of files) {
      const path = `${ctx.cwd}/${file}`;
      const blob = Bun.file(path);
      if (!(await blob.exists())) continue; // deleted on this branch
      try { for (const s of scoreSource(await blob.text(), file)) rows.push({ ...s, file }); }
      catch (err) { errors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`); }
    }
    const table = formatScores(rows, { cyclomatic: config.cyclomatic, cognitive: config.cognitive });
    return errors.length ? `${table}\n\ncould not parse:\n${errors.join("\n")}` : table;
  },
};

async function defaultBranch(cwd: string): Promise<string> {
  const head = await $`git -C ${cwd} symbolic-ref --short refs/remotes/origin/HEAD`.quiet().nothrow();
  if (head.exitCode === 0) return head.stdout.toString().trim();
  for (const name of ["main", "master"]) {
    if ((await $`git -C ${cwd} rev-parse --verify --quiet ${name}`.quiet().nothrow()).exitCode === 0) return name;
  }
  return "HEAD~1";
}
