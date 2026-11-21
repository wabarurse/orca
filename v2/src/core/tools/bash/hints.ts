type Hint = {
  name: string;
  text: string;
  test: (command: string) => boolean;
};

const HEREDOC = /(<<-?\s*(['"]?)([A-Za-z_]\w*)\2[^\n]*)\n[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/g;
const QUOTED = /'[^']*'|"(?:\\[\s\S]|[^"\\])*"/g;
export const shell = (command: string) => command.replace(HEREDOC, "$1").replace(QUOTED, "''");

const AT = String.raw`(?:^|[;&|(\n]|\bxargs\s+(?:-\S+\s+)*|-exec\s+|\b(?:then|do|else)\s)[ \t]*(?:\w+=\S*\s+)*`;
const FLAGS = String.raw`((?:\s+(?:-[\w.:=-]+|''))+)`;
const SED = new RegExp(`${AT}g?sed${FLAGS}`, "g"), PERL = new RegExp(`${AT}perl${FLAGS}`, "g");
const SED_IN_PLACE = /\s(?:-[A-Za-z]*i[\w.]*|--in-place(?:=\S+)?)(?=\s|$)/;
const PERL_IN_PLACE = /\s-(?![MmI])[A-Za-z0-9]*i[\w.]*(?=\s|$)/;
const flagged = (text: string, command: RegExp, flag: RegExp) => [...text.matchAll(command)].some(m => flag.test(m[1] ?? ""));

const PYTHON = new RegExp(`${AT}python[0-9.]*\\s[^\\n]*(?:<<|-c\\s)`);
const PY_READ = /\.read\(|\.read_text\(|\.readlines\(/, PY_CHANGE = /\.replace\(|\bre\.sub\(|\.sub\(/;
const PY_WRITE = /(?<!sys\.stdout|sys\.stderr)\.write\(|\.write_text\(|\.writelines\(/;

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
];

const match = (command: string) => HINTS.find(h => h.test(command));

export function hintFor(command: string): string | undefined {
  return match(command)?.text;
}

export const HINT_LIMIT = 3;
export function limitedHints(limit = HINT_LIMIT): (command: string) => string | undefined {
  const shown = new Map<string, number>();
  return command => {
    const found = match(command);
    if (found === undefined) return undefined;
    const count = shown.get(found.name) ?? 0;
    if (count >= limit) return undefined;
    shown.set(found.name, count + 1);
    return found.text;
  };
}
export const hint = limitedHints();
