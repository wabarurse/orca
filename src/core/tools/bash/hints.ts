// One-line nudges appended to a bash result when the command did by hand what a tool does in one
// call. Pure pattern checks: a hint never refuses or changes a command, and it must be conservative,
// since a wrong one costs tokens and trust.

interface Hint {
  /** The kind; each kind has its own display budget. */
  name: string;
  text: string;
  test(command: string): boolean;
}

/** Heredoc bodies and quoted strings are data, not commands: `grep "sed -i" notes.md` rewrites nothing. */
const HEREDOC = /(<<-?\s*(['"]?)([A-Za-z_]\w*)\2[^\n]*)\n[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/g;
const QUOTED = /'[^']*'|"(?:\\[\s\S]|[^"\\])*"/g;
const shell = (command: string) => command.replace(HEREDOC, "$1").replace(QUOTED, "''");

/** Where a command name starts: the line or a list/pipe/group operator, `xargs`, `-exec`, a shell keyword; then any `VAR=value` prefixes. */
const AT = String.raw`(?:^|[;&|(\n]|\bxargs\s+(?:-\S+\s+)*|-exec\s+|\b(?:then|do|else)\s)[ \t]*(?:\w+=\S*\s+)*`;
/** The options straight after the command name (quoted arguments are already emptied to ''). */
const FLAGS = String.raw`((?:\s+(?:-[\w.:=-]+|''))+)`;
const SED = new RegExp(`${AT}g?sed${FLAGS}`, "g"), PERL = new RegExp(`${AT}perl${FLAGS}`, "g");
const SED_IN_PLACE = /\s(?:-[A-Za-z]*i[\w.]*|--in-place(?:=\S+)?)(?=\s|$)/;
/** -i, -pi, -0pi, -i.bak; not -Mmodule, -Idir or -mmodule, which merely contain an i. */
const PERL_IN_PLACE = /\s-(?![MmI])[A-Za-z0-9]*i[\w.]*(?=\s|$)/;
const flagged = (text: string, command: RegExp, flag: RegExp) => [...text.matchAll(command)].some(m => flag.test(m[1]!));

/** A python -c or heredoc script that reads a file, substitutes in it and writes a file. */
const PYTHON = new RegExp(`${AT}python[0-9.]*\\s[^\\n]*(?:<<|-c\\s)`);
const PY_READ = /\.read\(|\.read_text\(|\.readlines\(/, PY_CHANGE = /\.replace\(|\bre\.sub\(|\.sub\(/;
const PY_WRITE = /(?<!sys\.stdout|sys\.stderr)\.write\(|\.write_text\(|\.writelines\(/;

/** A sleep long enough to be waiting on something else; short pauses (a server settling) are left alone. */
const SLEEP = new RegExp(`${AT}sleep\\s+(\\d+)(?=\\s|;|&|\\)|$)`, "g"), SLEEP_SECONDS = 20;

const HINTS: Hint[] = [
  {
    name: "edit",
    text: "hint: edit(path, old_text, new_text) changes a file in one call and needs no prior read.",
    test(command) {
      const text = shell(command);
      return flagged(text, SED, SED_IN_PLACE) || flagged(text, PERL, PERL_IN_PLACE)
        || (PYTHON.test(text) && PY_READ.test(command) && PY_CHANGE.test(command) && PY_WRITE.test(command));
    },
  },
  {
    name: "wait",
    text: "hint: process wait blocks until a background command finishes or a watched PR changes, in one call; start long commands with background=true instead of sleeping.",
    test: command => [...shell(command).matchAll(SLEEP)].some(m => Number(m[1]) >= SLEEP_SECONDS),
  },
  // Further kinds go here: a name, the line to show, and a pure test.
];

const match = (command: string) => HINTS.find(h => h.test(command));

/** The hint line for a command, or undefined. Pure. */
export function hintFor(command: string): string | undefined {
  return match(command)?.text;
}

export const HINT_LIMIT = 3;
/** `hintFor`, but each kind is shown at most `limit` times by the returned function. */
export function limitedHints(limit = HINT_LIMIT): (command: string) => string | undefined {
  const shown = new Map<string, number>();
  return command => {
    const found = match(command);
    if (!found) return undefined;
    const count = shown.get(found.name) ?? 0;
    if (count >= limit) return undefined;
    shown.set(found.name, count + 1);
    return found.text;
  };
}
/** The agent process's own budget (in memory: a new process starts over). */
export const hint = limitedHints();
