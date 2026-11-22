import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";

export type ShellCommand = {
  program: string;
  args: string[];
  env: Record<string, string>;
  wrappers: string[];
  cwd: string | null;
  stdin: boolean;
  reads: string[];
  before: string[];
  after: string[];
  inner: string[];
};

type Word = { text: string; subs: string[] };
type Token = { kind: "word"; word: Word } | { kind: "op"; op: string } | { kind: "redirect"; op: string } | { kind: "body"; text: string };
type Stage = { words: Word[]; reads: string[]; stdin: boolean; bodies: string[] };
type Pipeline = { stages: Stage[]; open: boolean; close: boolean };

export const HIDDEN = "\u0000";
const OPERATORS = ["&&", "||", ";;", "|&", ";", "|", "&", "(", ")"];
const REDIRECTS = ["<<<", "<<-", "&>>", "<<", ">>", "<>", ">|", ">&", "<&", "&>", "<", ">"];
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "time"]);
const CLOSERS = new Set(["fi", "done", "}", "esac"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const MAX_DEPTH = 4;

function balanced(text: string, start: number, open: string, close: string): number {
  let depth = 1;
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "'") { const end = text.indexOf("'", i + 1); i = end < 0 ? text.length : end + 1; continue; }
    if (c === "\"") {
      i++;
      while (i < text.length && text[i] !== "\"") i += text[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return i; }
    i++;
  }
  return text.length;
}

function lex(text: string): Token[] {
  const tokens: Token[] = [];
  let word: Word | null = null;
  const pendingBodies: { delimiter: string; strip: boolean }[] = [];
  let expectDelimiter: boolean | null = null;
  const add = (part: string): void => { word = word ?? { text: "", subs: [] }; word.text += part; };
  const sub = (inner: string): void => { word = word ?? { text: "", subs: [] }; word.text += HIDDEN; word.subs.push(inner); };
  const current = (): Word | null => word;
  const end = (): void => {
    if (word === null) return;
    if (expectDelimiter !== null) { pendingBodies.push({ delimiter: word.text, strip: expectDelimiter }); expectDelimiter = null; }
    else tokens.push({ kind: "word", word });
    word = null;
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i] ?? "";
    const rest = text.slice(i);
    if (rest.startsWith("\\\n")) { i += 2; continue; }
    if (c === "\n") {
      end();
      tokens.push({ kind: "op", op: ";" });
      i++;
      for (const body of pendingBodies.splice(0)) {
        const lines: string[] = [];
        while (i < text.length) {
          const stop = text.indexOf("\n", i);
          const line = text.slice(i, stop < 0 ? text.length : stop);
          i = stop < 0 ? text.length : stop + 1;
          if ((body.strip ? line.replace(/^\t+/, "") : line) === body.delimiter) break;
          lines.push(line);
        }
        tokens.push({ kind: "body", text: lines.join("\n") });
      }
      continue;
    }
    if (c === " " || c === "\t") { end(); i++; continue; }
    if (c === "#" && current() === null) { const stop = text.indexOf("\n", i); i = stop < 0 ? text.length : stop; continue; }
    if (c === "\\") { add(text[i + 1] ?? ""); i += 2; continue; }
    if (c === "'") {
      const stop = text.indexOf("'", i + 1);
      add(text.slice(i + 1, stop < 0 ? text.length : stop));
      i = stop < 0 ? text.length : stop + 1;
      continue;
    }
    if (c === "\"") {
      add("");
      i++;
      while (i < text.length && text[i] !== "\"") {
        const d = text[i] ?? "";
        if (d === "\\") { const next = text[i + 1] ?? ""; add("\"\\$`\n".includes(next) ? next : `\\${next}`); i += 2; continue; }
        if (text.startsWith("$(", i) && !text.startsWith("$((", i)) { const stop = balanced(text, i + 2, "(", ")"); sub(text.slice(i + 2, stop)); i = stop + 1; continue; }
        if (d === "`") { const stop = text.indexOf("`", i + 1); sub(text.slice(i + 1, stop < 0 ? text.length : stop)); i = stop < 0 ? text.length : stop + 1; continue; }
        add(d);
        i++;
      }
      i++;
      continue;
    }
    if (rest.startsWith("$((")) { const stop = balanced(text, i + 3, "(", ")"); add("0"); i = stop + 2; continue; }
    if (rest.startsWith("$(")) { const stop = balanced(text, i + 2, "(", ")"); sub(text.slice(i + 2, stop)); i = stop + 1; continue; }
    if (c === "`") { const stop = text.indexOf("`", i + 1); sub(text.slice(i + 1, stop < 0 ? text.length : stop)); i = stop < 0 ? text.length : stop + 1; continue; }
    if ((rest.startsWith("<(") || rest.startsWith(">(")) && current() === null) { const stop = balanced(text, i + 2, "(", ")"); sub(text.slice(i + 2, stop)); i = stop + 1; continue; }
    const redirect = REDIRECTS.find(r => rest.startsWith(r));
    if (redirect !== undefined) {
      const pending = current();
      if (pending !== null && /^\d+$/.test(pending.text)) word = null;
      end();
      if (redirect === "<<" || redirect === "<<-") expectDelimiter = redirect === "<<-";
      else tokens.push({ kind: "redirect", op: redirect });
      if (redirect === "<<" || redirect === "<<-") tokens.push({ kind: "redirect", op: "<<" });
      i += redirect.length;
      continue;
    }
    const op = OPERATORS.find(o => rest.startsWith(o));
    if (op !== undefined) { end(); tokens.push({ kind: "op", op }); i += op.length; continue; }
    add(c);
    i++;
  }
  end();
  return tokens;
}

function pipelines(tokens: Token[]): Pipeline[] {
  const out: Pipeline[] = [];
  let stages: Stage[] = [];
  let stage: Stage = { words: [], reads: [], stdin: false, bodies: [] };
  let open = false;
  let pendingRedirect: string | null = null;
  let lastBodyStage: Stage | null = null;
  const closeStage = (): void => { stages.push(stage); stage = { words: [], reads: [], stdin: false, bodies: [] }; };
  const closePipeline = (close: boolean): void => {
    closeStage();
    const kept = stages.filter(s => s.words.length > 0 || s.bodies.length > 0);
    if (kept.length > 0 || open || close) out.push({ stages: kept, open, close });
    stages = [];
    open = false;
  };
  for (const token of tokens) {
    if (token.kind === "body") { (lastBodyStage ?? stage).bodies.push(token.text); lastBodyStage = null; continue; }
    if (token.kind === "redirect") {
      if (token.op === "<<") { stage.stdin = true; lastBodyStage = stage; continue; }
      pendingRedirect = token.op;
      continue;
    }
    if (token.kind === "word") {
      if (pendingRedirect !== null) {
        if (pendingRedirect === "<" || pendingRedirect === "<>") stage.reads.push(token.word.text);
        if (pendingRedirect.startsWith("<")) stage.stdin = true;
        pendingRedirect = null;
        continue;
      }
      stage.words.push(token.word);
      continue;
    }
    pendingRedirect = null;
    if (token.op === "|" || token.op === "|&") { closeStage(); continue; }
    if (token.op === "(") { closePipeline(false); open = true; continue; }
    if (token.op === ")") { closePipeline(true); continue; }
    closePipeline(false);
  }
  closePipeline(false);
  return out;
}

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

type Unwrapped = { program: string; args: string[]; env: Record<string, string>; wrappers: string[] };

function skipOptions(words: string[], takes: Set<string>): string[] {
  let i = 0;
  while (i < words.length) {
    const w = words[i] ?? "";
    if (w === "--") return words.slice(i + 1);
    if (!w.startsWith("-") || w === "-") break;
    i += takes.has(w) ? 2 : 1;
  }
  return words.slice(i);
}

const WRAPPER_OPTIONS: Record<string, Set<string>> = {
  nohup: new Set(),
  command: new Set(),
  builtin: new Set(),
  exec: new Set(["-a"]),
  nice: new Set(["-n"]),
  time: new Set(),
  stdbuf: new Set(["-i", "-o", "-e"]),
  sudo: new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U"]),
  doas: new Set(["-u", "-C"]),
  xargs: new Set(["-I", "-n", "-P", "-L", "-d", "-E", "-s", "-a", "-J", "-R", "-S"]),
  timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
};

function unwrap(words: string[]): Unwrapped {
  const env: Record<string, string> = {};
  const wrappers: string[] = [];
  let rest = words;
  for (let guard = 0; guard < 16; guard++) {
    while (rest.length > 0 && ASSIGN.test(rest[0] ?? "")) {
      const w = rest[0] ?? "";
      const at = w.indexOf("=");
      env[w.slice(0, at)] = w.slice(at + 1);
      rest = rest.slice(1);
    }
    const first = rest[0];
    if (first === undefined) return { program: "", args: [], env, wrappers };
    const name = basename(first);
    if (KEYWORDS.has(name)) { rest = rest.slice(1); continue; }
    if (name === "env") {
      const after = skipOptions(rest.slice(1), new Set(["-u", "-C", "-S"]));
      const command = after.findIndex(w => !ASSIGN.test(w));
      if (command < 0) return { program: "env", args: rest.slice(1), env, wrappers };
      for (const w of after.slice(0, command)) { const at = w.indexOf("="); env[w.slice(0, at)] = w.slice(at + 1); }
      wrappers.push("env");
      rest = after.slice(command);
      continue;
    }
    const options = WRAPPER_OPTIONS[name];
    if (options !== undefined) {
      let after = skipOptions(rest.slice(1), options);
      if (name === "timeout" && after.length > 0) after = after.slice(1);
      if (after.length === 0) return { program: name, args: rest.slice(1), env, wrappers };
      wrappers.push(name);
      rest = after;
      continue;
    }
    return { program: name, args: rest.slice(1), env, wrappers };
  }
  return { program: basename(rest[0] ?? ""), args: rest.slice(1), env, wrappers };
}

export function expandPath(word: string, env: Record<string, string | undefined>): string | null {
  if (word.includes(HIDDEN)) return null;
  const home = env.HOME ?? homedir();
  let text = word === "~" ? home : word.startsWith("~/") ? home + word.slice(1) : word;
  let unknown = false;
  text = text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, braced: string | undefined, bare: string | undefined) => {
    const value = env[braced ?? bare ?? ""];
    if (value === undefined) { unknown = true; return ""; }
    return value;
  });
  return unknown || text.includes("$") ? null : text;
}

function enter(cwd: string | null, target: string | undefined, env: Record<string, string | undefined>): string | null {
  if (target === undefined || target === "~") return env.HOME ?? homedir();
  if (target === "-") return null;
  const expanded = expandPath(target, env);
  if (expanded === null) return null;
  if (isAbsolute(expanded)) return resolve(expanded);
  return cwd === null ? null : resolve(cwd, expanded);
}

function flatten(text: string, cwd: string | null, depth: number, out: ShellCommand[]): void {
  if (depth > MAX_DEPTH) return;
  const env = process.env;
  let here = cwd;
  const stack: (string | null)[] = [];
  for (const pipeline of pipelines(lex(text))) {
    if (pipeline.open) stack.push(here);
    const unwrapped = pipeline.stages.map(stage => unwrap(stage.words.map(w => w.text).filter(w => !CLOSERS.has(w) || stage.words.length > 1)));
    const names = unwrapped.map(u => u.program);
    pipeline.stages.forEach((stage, index) => {
      const u = unwrapped[index];
      if (u === undefined) return;
      const subs = stage.words.flatMap(w => w.subs);
      const nested: ShellCommand[] = [];
      for (const inner of subs) flatten(inner, here, depth + 1, nested);
      const command: ShellCommand = { program: u.program, args: u.args, env: u.env, wrappers: u.wrappers, cwd: here, stdin: index > 0 || stage.stdin,
        reads: stage.reads, before: names.slice(0, index), after: names.slice(index + 1), inner: nested.map(n => n.program) };
      if (u.program.length > 0 || stage.reads.length > 0) out.push(command);
      out.push(...nested);
      if (SHELLS.has(u.program) || u.program === "eval") {
        const flag = u.args.findIndex(a => /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
        const script = u.program === "eval" ? u.args.join(" ") : flag < 0 ? undefined : u.args[flag + 1];
        if (script !== undefined) flatten(script, here, depth + 1, out);
        else if (u.args.every(a => a.startsWith("-"))) for (const body of stage.bodies) flatten(body, here, depth + 1, out);
      }
      if (pipeline.stages.length === 1 && (u.program === "cd" || u.program === "pushd")) here = enter(here, u.args.find(a => !a.startsWith("-") || a === "-"), env);
    });
    if (pipeline.close) here = stack.pop() ?? here;
  }
}

export function commands(text: string, cwd: string): ShellCommand[] {
  const out: ShellCommand[] = [];
  flatten(text, cwd, 0, out);
  return out;
}

export type Args = { short: Map<string, string[]>; long: Map<string, string[]>; positional: string[]; dashed: string[] };

export function parseArgs(args: string[], takes: string, longTakes: string[]): Args {
  const short = new Map<string, string[]>();
  const long = new Map<string, string[]>();
  const positional: string[] = [];
  const dashed: string[] = [];
  const put = (map: Map<string, string[]>, key: string, value: string): void => { map.set(key, [...(map.get(key) ?? []), value]); };
  let i = 0;
  while (i < args.length) {
    const arg = args[i] ?? "";
    i++;
    if (arg === "--") { dashed.push(...args.slice(i)); break; }
    if (arg.startsWith("--")) {
      const at = arg.indexOf("=");
      const name = at < 0 ? arg.slice(2) : arg.slice(2, at);
      if (at >= 0) put(long, name, arg.slice(at + 1));
      else if (longTakes.includes(name)) { put(long, name, args[i] ?? ""); i++; }
      else put(long, name, "");
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") { positional.push(arg); continue; }
    const digits = /^-(\d+)$/.exec(arg);
    if (digits !== null) { put(short, "#", digits[1] ?? ""); continue; }
    for (let j = 1; j < arg.length; j++) {
      const letter = arg[j] ?? "";
      if (takes.includes(letter)) {
        const attached = arg.slice(j + 1);
        if (attached.length > 0) put(short, letter, attached);
        else { put(short, letter, args[i] ?? ""); i++; }
        break;
      }
      put(short, letter, "");
    }
  }
  return { short, long, positional, dashed };
}

export function quote(word: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

export { SHELLS };
