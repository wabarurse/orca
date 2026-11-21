// Whether a command only reads, so the scheduler may overlap it with its read-only neighbours.
// The model was asked to declare this (`independent`) and almost never did, so the harness
// decides, as Claude Code does from each call's input. An allowlist, deliberately narrow: a
// command it does not recognise runs in order as before, which costs time, never correctness.

import { shell } from "./hints";

/** Programs that only read when given no output redirection. */
const READERS = new Set(["grep", "egrep", "fgrep", "rg", "cat", "head", "tail", "ls", "wc", "nl", "cut", "tr", "stat", "file", "du",
  "pwd", "which", "echo", "printf", "basename", "dirname", "realpath", "true", "test", "[", "jq", "diff", "cd", "column", "comm"]);
const GIT = /^git\s+(?:--no-pager\s+)?(?:status|diff|log|show|blame|ls-files|ls-tree|rev-parse|merge-base|grep|describe|shortlog|cat-file)(?:\s|$)/;
/** A print range and nothing else: `sed -n '10,40p'`. Any other script may write (`w file`) or edit. */
const SED_RANGE = /^[\d,$]+p(?:;[\d,$]+p)*$/;
const SED_QUOTED = /\bsed\s+-n\s+(['"])([\s\S]*?)\1/g;
const SED = /^sed\s+-n\s+(?:''|[\d,$]+p)(?:\s+[^\s-]\S*)*$/;
/** Options that make an otherwise read-only program write or run something. */
const WRITES: Record<string, RegExp> = {
  find: /\s-(?:delete|exec|execdir|ok|okdir|fprint\w*|fls)\b/,
  fd: /\s(?:-x|-X|--exec\S*)(?:\s|$)/,
  rg: /\s--pre(?:[\s=]|$)/,
  sort: /\s(?:-\w*o|--output)(?:[\s=]|$)/,
  git: /\s--output(?:[\s=]|$)/,
};

function reads(segment: string): boolean {
  const name = segment.split(/\s+/, 1)[0]!;
  if (WRITES[name]?.test(segment)) return false;
  if (name === "git") return GIT.test(segment);
  if (name === "sed") return SED.test(segment);
  // uniq's second file argument is an output file; in a pipe it has only options.
  if (name === "uniq") return segment.split(/\s+/).slice(1).every(arg => arg.startsWith("-"));
  return READERS.has(name) || ["find", "fd", "sort"].includes(name);
}

/** True only when every command in the line is a known reader and nothing is redirected to a
 * file, substituted, grouped or backgrounded. */
export function readOnly(command: string): boolean {
  // Substitution runs a command even inside double quotes, which the quote stripping below would hide.
  if (command.includes("$(") || command.includes("`")) return false;
  if (![...command.matchAll(SED_QUOTED)].every(m => SED_RANGE.test(m[2]!))) return false;
  // Quoted text and heredoc bodies are data. Folding stderr into stdout or discarding a stream writes no file.
  const text = shell(command).replace(/\d?>&\d|[12&]?>\s*\/dev\/null/g, " ").replaceAll("&&", ";");
  if (/[<>`&()]|\$\(/.test(text)) return false;
  const segments = text.split(/;|\|\||\||\n/).map(s => s.trim()).filter(Boolean);
  return segments.length > 0 && segments.every(reads);
}
