import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { SECRET_REASON, SECRET_SUGGESTION, secretPath } from "./secret";
import { expandPath, parseArgs, quote, SHELLS, type Args, type ShellCommand } from "./shell";

export type GuardInput = { tool: string; input: Record<string, unknown>; command: ShellCommand | null; root: string };
export type GuardRule = {
  id: string;
  group: "efficiency" | "security";
  test: (call: GuardInput) => boolean;
  reason: string;
  suggest: (call: GuardInput) => string;
};

const has = (args: Args, short: string, long: string[]): boolean => [...short].some(letter => args.short.has(letter)) || long.some(name => args.long.has(name));
const program = (call: GuardInput, names: string[]): ShellCommand | null => call.command !== null && names.includes(call.command.program) ? call.command : null;

const GIT_GLOBAL_TAKES = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);
type Git = { prefix: string[]; sub: string; args: string[] };
function git(command: ShellCommand | null): Git | null {
  if (command === null || command.program !== "git") return null;
  const prefix = ["git"];
  let i = 0;
  while (i < command.args.length) {
    const arg = command.args[i] ?? "";
    if (!arg.startsWith("-")) return { prefix, sub: arg, args: command.args.slice(i + 1) };
    const takes = GIT_GLOBAL_TAKES.has(arg);
    prefix.push(...command.args.slice(i, i + (takes ? 2 : 1)));
    i += takes ? 2 : 1;
  }
  return null;
}
const gitSub = (call: GuardInput, subs: string[]): Git | null => {
  const found = git(call.command);
  return found !== null && subs.includes(found.sub) ? found : null;
};
const pipedToHead = (call: GuardInput): boolean => call.command !== null && call.command.after[0] === "head";

const GREP_TAKES = "efmABCdDX";
const GREP_LONG = ["regexp", "file", "max-count", "after-context", "before-context", "context", "directories", "devices", "include", "exclude", "exclude-dir", "exclude-from", "label", "binary-files"];
const grepArgs = (command: ShellCommand): Args => parseArgs(command.args, GREP_TAKES, GREP_LONG);
const RG_FLAGS: Record<string, string> = { i: "-i", l: "-l", w: "-w", F: "-F", v: "-v", c: "-c", o: "-o", x: "-x", H: "-H", h: "-I", L: "--files-without-match", s: "-s", a: "-a" };

function ripgrep(command: ShellCommand): string {
  const args = grepArgs(command);
  const flags = ["-n", ...Object.entries(RG_FLAGS).filter(([letter]) => args.short.has(letter)).map(([, flag]) => flag)];
  if (args.long.has("ignore-case")) flags.push("-i");
  if (args.long.has("files-with-matches")) flags.push("-l");
  const globs = [...(args.long.get("include") ?? []).map(g => `-g ${quote(g)}`), ...[...(args.long.get("exclude") ?? []), ...(args.long.get("exclude-dir") ?? [])].map(g => `-g ${quote(`!${g}`)}`)];
  const explicit = [...(args.short.get("e") ?? []), ...(args.long.get("regexp") ?? [])];
  const positional = [...args.positional, ...args.dashed];
  const patterns = explicit.length > 0 ? explicit : positional.slice(0, 1);
  const paths = (explicit.length > 0 ? positional : positional.slice(1)).filter(p => p !== "." && p !== "./");
  const extended = args.short.has("E") || args.short.has("F") || command.program === "egrep" || command.program === "fgrep";
  const shown = patterns.map(p => quote(extended ? p : p.replaceAll("\\|", "|")));
  const pattern = shown.length === 1 ? shown : shown.map(p => `-e ${p}`);
  const built = ["rg", ...flags, ...globs, ...pattern, ...paths.map(quote)].join(" ");
  return `${built} (or git grep ${[...flags, ...pattern].join(" ")})`;
}

const EDITORS = new Set(["vim", "vi", "nvim", "nano", "emacs", "less", "more", "top", "htop"]);
function waitsForKeys(command: ShellCommand): boolean {
  if (!EDITORS.has(command.program)) return false;
  const args = parseArgs(command.args, "", []);
  if (command.program === "emacs") return !has(args, "", ["batch", "script"]) && !command.args.includes("-batch");
  if (["vim", "vi", "nvim"].includes(command.program)) return !args.long.has("headless") && !(args.short.has("e") && args.short.has("s"));
  if (command.program === "top") return !has(args, "bln", []);
  return true;
}

const REPLS = /^(?:python[0-9.]*|node|bun|irb|deno)$/;
function repl(command: ShellCommand): boolean {
  if (!REPLS.test(command.program) || command.stdin) return false;
  const args = parseArgs(command.args, command.program.startsWith("python") ? "cmWXQ" : "eprC", []);
  if (has(args, "cmepVvh", ["eval", "print", "version", "help"])) return false;
  const first = args.positional[0];
  if (first === undefined) return true;
  return (command.program === "bun" || command.program === "deno") && first === "repl";
}

function opensEditor(call: GuardInput): string | null {
  const command = call.command;
  if (command === null) return null;
  const editing = command.env.GIT_EDITOR !== undefined || command.env.EDITOR !== undefined;
  const commit = gitSub(call, ["commit"]);
  if (commit !== null && !editing && !has(parseArgs(commit.args, "mFCct", ["message", "file", "reuse-message", "reedit-message", "template", "fixup", "squash", "author", "date", "cleanup"]), "mFC", ["message", "file", "no-edit", "reuse-message", "fixup"]))
    return `git commit -m "<message>"`;
  const rebase = gitSub(call, ["rebase"]);
  if (rebase !== null && command.env.GIT_SEQUENCE_EDITOR === undefined && has(parseArgs(rebase.args, "xsX", ["exec", "strategy", "onto"]), "i", ["interactive"]))
    return "git rebase <base> without -i, or ask the user";
  const add = gitSub(call, ["add"]);
  if (add !== null && has(parseArgs(add.args, "", []), "pie", ["patch", "interactive", "edit"])) return "git add <file>";
  return null;
}

const LOG_LONG = ["max-count", "skip", "since", "after", "until", "before", "author", "committer", "grep"];
function unboundedLog(call: GuardInput): Git | null {
  const log = gitSub(call, ["log"]);
  if (log === null || pipedToHead(call)) return null;
  const args = parseArgs(log.args, "nSGL", LOG_LONG);
  if (has(args, "n#", ["max-count"]) || args.positional.some(p => p.includes(".."))) return null;
  return log;
}

const SUMMARIES = ["stat", "shortstat", "numstat", "name-only", "name-status", "dirstat", "summary", "quiet", "check", "no-patch", "raw"];
const summarized = (args: string[]): boolean => args.some(arg => arg === "-s" || SUMMARIES.some(name => arg === `--${name}` || arg.startsWith(`--${name}=`)));
function wholeDiff(call: GuardInput): Git | null {
  const diff = gitSub(call, ["diff", "show"]);
  const command = call.command;
  if (diff === null || command === null || pipedToHead(call) || summarized(diff.args)) return null;
  const args = parseArgs(diff.args, "UO", ["output", "src-prefix", "dst-prefix", "format", "pretty", "diff-filter", "unified"]);
  if (has(args, "s", SUMMARIES) || args.dashed.length > 0) return null;
  const cwd = command.cwd ?? call.root;
  const pathlike = (p: string): boolean => p.includes(":") || /[*?[]/.test(p) || (!p.includes("..") && existsSync(resolve(cwd, p)));
  return args.positional.some(pathlike) ? null : diff;
}

const ENV_DUMPS = ["env", "printenv", "set", "export", "declare", "typeset"];
function dumpsEnv(command: ShellCommand): boolean {
  if (!ENV_DUMPS.includes(command.program)) return false;
  const names = command.args.filter(a => !a.startsWith("-") && !a.startsWith("+"));
  if (command.program === "env") return true;
  if (command.program === "set") return command.args.length === 0;
  if (command.program === "declare" || command.program === "typeset") return names.length === 0 && command.args.some(a => a === "-p" || a === "-x" || a === "-px" || a === "-xp");
  return names.length === 0;
}

const READERS = new Set(["cat", "head", "tail", "less", "more", "sed", "grep", "egrep", "fgrep", "rg", "bat", "awk", "nl", "xxd", "od", "strings", "base64"]);
function readsSecret(call: GuardInput): boolean {
  const command = call.command;
  if (command === null) return false;
  if (command.reads.some(secretPath)) return true;
  if (!READERS.has(command.program)) return false;
  const searching = ["grep", "egrep", "fgrep", "rg"].includes(command.program);
  const args = searching ? parseArgs(command.args, command.program === "rg" ? "efmABCgtTMj" : GREP_TAKES, [...GREP_LONG, "glob", "type"])
    : command.program === "sed" || command.program === "awk" ? parseArgs(command.args, "efvF", ["expression", "file"]) : parseArgs(command.args, "nc", []);
  const scripted = has(args, "ef", ["regexp", "expression", "file"]);
  const operands = [...args.positional, ...args.dashed];
  const files = (searching || command.program === "sed" || command.program === "awk") && !scripted ? operands.slice(1) : operands;
  return files.some(secretPath);
}

function broadDelete(call: GuardInput): string | null {
  const command = program(call, ["rm"]);
  if (command === null) return null;
  const args = parseArgs(command.args, "", []);
  if (!has(args, "rR", ["recursive"])) return null;
  const within = (full: string): string | null => { const rel = relative(call.root, full); return rel.startsWith("..") || isAbsolute(rel) ? null : rel; };
  for (const target of [...args.positional, ...args.dashed]) {
    const expanded = expandPath(target, process.env);
    if (expanded === null) return target;
    const at = expanded.search(/[*?[]/);
    const slash = at < 0 ? -1 : expanded.lastIndexOf("/", at);
    const literal = at < 0 ? expanded : slash < 0 ? "." : slash === 0 ? "/" : expanded.slice(0, slash);
    if (!isAbsolute(literal) && command.cwd === null) return target;
    const rel = within(resolve(command.cwd ?? call.root, literal));
    if (rel === null) return target;
    const pattern = at < 0 ? "" : expanded.slice(slash + 1);
    if (at < 0 ? rel.length === 0 : rel.length === 0 && /^(?:\*|\.\*)\/?$/.test(pattern)) return target;
  }
  return null;
}

function destructiveGit(call: GuardInput): string | null {
  const found = git(call.command);
  if (found === null) return null;
  const args = parseArgs(found.args, "bBo", ["onto", "strategy", "source"]);
  const operands = [...args.positional, ...args.dashed];
  if (found.sub === "reset" && args.long.has("hard")) return "git reset --hard";
  if (found.sub === "clean" && has(args, "f", ["force"]) && !has(args, "n", ["dry-run"])) return "git clean -f";
  if (found.sub === "checkout" && operands.includes(".")) return "git checkout .";
  if (found.sub === "restore" && operands.includes(".") && !(has(args, "S", ["staged"]) && !has(args, "W", ["worktree"]))) return "git restore .";
  if (found.sub === "push" && (has(args, "f", ["force", "force-with-lease", "force-if-includes"]) || args.positional.some(p => p.startsWith("+")))) return "git push --force";
  if (found.sub === "branch" && (args.short.has("D") || (has(args, "d", ["delete"]) && has(args, "f", ["force"])))) return "git branch -D";
  return null;
}

const FETCHERS = ["curl", "wget"];
const pipesDownload = (command: ShellCommand): boolean => SHELLS.has(command.program) && (command.before.some(p => FETCHERS.includes(p)) || command.inner.some(p => FETCHERS.includes(p)));

export const GUARD: GuardRule[] = [
  {
    id: "env-dump", group: "security",
    test: call => call.command !== null && dumpsEnv(call.command),
    reason: "dumping the environment puts every secret in it into the transcript",
    suggest: () => "printenv NAME for the one variable you need, or ask the user",
  },
  {
    id: "secret-file", group: "security",
    test: readsSecret,
    reason: SECRET_REASON,
    suggest: () => SECRET_SUGGESTION,
  },
  {
    id: "broad-delete", group: "security",
    test: call => broadDelete(call) !== null,
    reason: "a recursive delete may only remove paths inside your working directory, never the directory itself, a bare *, the home or the repository root",
    suggest: () => "a scoped path inside your working directory (rm -rf ./build), or ask the user",
  },
  {
    id: "git-destructive", group: "security",
    test: call => destructiveGit(call) !== null,
    reason: "hard resets, cleans, force pushes and forced branch deletes throw away work that cannot be recovered",
    suggest: call => destructiveGit(call) === "git branch -D" ? "git branch -d (refuses unmerged work), or ask the user"
      : destructiveGit(call) === "git push --force" ? "a new branch and a normal push, or ask the user" : "git stash, or a new branch, or ask the user",
  },
  {
    id: "curl-pipe-shell", group: "security",
    test: call => call.command !== null && pipesDownload(call.command),
    reason: "piping a download into a shell runs code nobody has read",
    suggest: () => "ask the user to install it",
  },
  {
    id: "sudo", group: "security",
    test: call => call.command !== null && (["sudo", "doas"].includes(call.command.program) || call.command.wrappers.some(w => w === "sudo" || w === "doas")),
    reason: "sudo waits for a password nobody can type",
    suggest: () => "ask the user to run it",
  },
  {
    id: "recursive-grep", group: "efficiency",
    test: call => { const c = program(call, ["grep", "egrep", "fgrep", "rgrep"]); return c !== null && (c.program === "rgrep" || has(grepArgs(c), "rR", ["recursive", "dereference-recursive"]) || (grepArgs(c).long.get("directories") ?? grepArgs(c).short.get("d") ?? []).includes("recurse")); },
    reason: "recursive grep walks node_modules, build output and .git, and can take minutes",
    suggest: call => call.command === null ? "rg -n '<pattern>'" : ripgrep(call.command),
  },
  {
    id: "interactive", group: "efficiency",
    test: call => call.command !== null && waitsForKeys(call.command),
    reason: "editors, pagers and top wait for a keyboard nobody can type on",
    suggest: call => call.command?.program === "top" || call.command?.program === "htop" ? "ps aux | head -20 (or top -l 1 on macOS, top -b -n 1 on Linux)"
      : `sed -n '1,200p' <file> or cat <file> to read it, edit or write to change it`,
  },
  {
    id: "repl", group: "efficiency",
    test: call => call.command !== null && repl(call.command),
    reason: "an interpreter without a script waits for input nobody can type",
    suggest: call => call.command?.program.startsWith("python") === true ? `${call.command.program} -c '<code>' or a script file` : `${call.command?.program ?? "node"} -e '<code>' or a script file`,
  },
  {
    id: "git-editor", group: "efficiency",
    test: call => opensEditor(call) !== null,
    reason: "this git command opens an editor that waits for a keyboard",
    suggest: call => opensEditor(call) ?? "git commit -m \"<message>\"",
  },
  {
    id: "git-log-unbounded", group: "efficiency",
    test: call => unboundedLog(call) !== null,
    reason: "git log without a limit prints the whole history",
    suggest: call => {
      const log = unboundedLog(call);
      if (log === null) return "git log --oneline -n 20";
      const formatted = log.args.some(a => a === "--oneline" || a.startsWith("--pretty") || a.startsWith("--format"));
      return [...log.prefix, "log", ...(formatted ? [] : ["--oneline"]), "-n", "20", ...log.args].map(quote).join(" ");
    },
  },
  {
    id: "git-diff-whole", group: "efficiency",
    test: call => wholeDiff(call) !== null,
    reason: "a whole-repository diff with no path can flood the context",
    suggest: call => {
      const diff = wholeDiff(call);
      if (diff === null) return "git diff --stat, then git diff -- <file>";
      const base = [...diff.prefix, diff.sub, ...diff.args].map(quote).join(" ");
      return `${base} --stat first, then ${base} -- <file>`;
    },
  },
];


