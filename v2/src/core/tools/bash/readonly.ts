import { shell } from "./hints";

const READERS = new Set(["grep", "egrep", "fgrep", "rg", "cat", "head", "tail", "ls", "wc", "nl", "cut", "tr", "stat", "file", "du",
  "pwd", "which", "echo", "printf", "basename", "dirname", "realpath", "true", "test", "[", "jq", "diff", "cd", "column", "comm"]);
const GIT = /^git\s+(?:--no-pager\s+)?(?:status|diff|log|show|blame|ls-files|ls-tree|rev-parse|merge-base|grep|describe|shortlog|cat-file)(?:\s|$)/;
const SED_RANGE = /^[\d,$]+p(?:;[\d,$]+p)*$/;
const SED_QUOTED = /\bsed\s+-n\s+(['"])([\s\S]*?)\1/g;
const SED = /^sed\s+-n\s+(?:''|[\d,$]+p)(?:\s+[^\s-]\S*)*$/;
const WRITES: Record<string, RegExp> = {
  find: /\s-(?:delete|exec|execdir|ok|okdir|fprint\w*|fls)\b/,
  fd: /\s(?:-x|-X|--exec\S*)(?:\s|$)/,
  rg: /\s--pre(?:[\s=]|$)/,
  sort: /\s(?:-\w*o|--output)(?:[\s=]|$)/,
  git: /\s--output(?:[\s=]|$)/,
};

function reads(segment: string): boolean {
  const name = segment.split(/\s+/, 1)[0] ?? "";
  if (WRITES[name]?.test(segment) === true) return false;
  if (name === "git") return GIT.test(segment);
  if (name === "sed") return SED.test(segment);
  if (name === "uniq") return segment.split(/\s+/).slice(1).every(arg => arg.startsWith("-"));
  return READERS.has(name) || ["find", "fd", "sort"].includes(name);
}

export function readOnly(command: string): boolean {
  if (command.includes("$(") || command.includes("`")) return false;
  if (![...command.matchAll(SED_QUOTED)].every(m => SED_RANGE.test(m[2] ?? ""))) return false;
  const text = shell(command).replace(/\d?>&\d|[12&]?>\s*\/dev\/null/g, " ").replaceAll("&&", ";");
  if (/[<>`&()]|\$\(/.test(text)) return false;
  const segments = text.split(/;|\|\||\||\n/).map(s => s.trim()).filter(Boolean);
  return segments.length > 0 && segments.every(reads);
}
