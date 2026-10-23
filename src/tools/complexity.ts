import { command } from "../proc";
import { formatScores, SCORED_EXTENSIONS, scoreSource, type FunctionScore } from "../complexity";
import { loadConfig } from "../config";
import type { Tool } from "./index";

// Reviewer-only. Scores the JavaScript/TypeScript files the branch changed
// (or the ones named) and reports a table against the config thresholds.
export const complexity: Tool = {
  spec: {
    name: "complexity",
    description:
      "Cyclomatic and cognitive complexity per function for JavaScript/TypeScript. Use for changed JS/TS logic where relevant to risk, not automatically for every review or touched file. " +
      "Skip for pure wording/formatting or comment-only edits; semantic prompt/config changes and executable examples still need substantive review, even when this metric is inapplicable. " +
      "Prefer explicit `files` to bound analysis. With no files (or an empty array), selects branch-changed files against `base` (default: the default branch), plus tracked uncommitted changes. " +
      "Scores all functions in selected files, NOT just changed functions; base selects files, it does not compute metric deltas. Compare the actual diff/base before calling a score a regression. " +
      "Unchanged functions are baseline context, not new findings merely because their file was touched. Reports measured scores and flags over configured thresholds; report relevant changed functions with name, file and both numbers. " +
      "Unsupported languages, parse failures or no functions are not zero complexity or proof of safety. State limitations and skipped-check rationale briefly; no mandatory table when inapplicable.",
    input_schema: {
      type: "object",
      properties: {
        files: { type: "array", items: { type: "string" }, description: "Paths relative to the working directory; prefer relevant changed JS/TS logic. Every function in each selected file is scored." },
        base: { type: "string", description: "Git ref for changed-file selection when `files` is omitted/empty, not a baseline-score comparison." },
      },
    },
  },
  async run(input, ctx) {
    const config = await loadConfig();
    let files = Array.isArray(input.files) ? input.files.map(String) : [];
    if (!files.length) {
      const base = typeof input.base === "string" && input.base ? input.base : await defaultBranch(ctx.cwd, ctx.signal);
      const diff = await command(["git", "diff", "--name-only", `${base}...HEAD`], ctx.cwd, ctx.signal);
      const dirty = await command(["git", "diff", "--name-only", "HEAD"], ctx.cwd, ctx.signal);
      if (diff.code !== 0) return `error: git diff against ${base} failed: ${diff.err.trim()}`;
      files = [...new Set([...diff.out.split("\n"), ...dirty.out.split("\n")])].filter(Boolean);
    }
    files = files.filter((f) => SCORED_EXTENSIONS.test(f));
    if (!files.length) return "no javascript/typescript files to score";
    const rows: (FunctionScore & { file: string })[] = [];
    const errors: string[] = [];
    for (const file of files) {
      ctx.signal?.throwIfAborted();
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

async function defaultBranch(cwd: string, signal?: AbortSignal): Promise<string> {
  const head = await command(["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd, signal);
  if (head.code === 0) return head.out.trim();
  for (const name of ["main", "master"]) {
    if ((await command(["git", "rev-parse", "--verify", "--quiet", name], cwd, signal)).code === 0) return name;
  }
  return "HEAD~1";
}
