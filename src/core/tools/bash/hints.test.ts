import { expect, test } from "bun:test";
import { HINT_LIMIT, hintFor, limitedHints } from "./hints";

const EDIT = "hint: edit(path, old_text, new_text) changes a file in one call and needs no prior read.";

test("in-place rewrites of an existing file get the edit hint", () => {
  for (const command of [
    "sed -i 's/a/b/' src/x.ts",
    "sed -i '' -e 's/a/b/' src/x.ts",
    "sed -i.bak 's/a/b/' src/x.ts",
    "sed -E -i 's/a+/b/' src/x.ts",
    "sed -Ei 's/a+/b/' src/x.ts",
    "gsed --in-place 's/a/b/' x",
    "cd pkg && LC_ALL=C sed -i 's/a/b/' x",
    "grep -rl old src | xargs sed -i 's/old/new/g'",
    "find . -name '*.ts' -exec sed -i 's/a/b/' {} +",
    "perl -pi -e 's/a/b/' x.ts",
    "perl -i -pe 's/a/b/' x.ts",
    "perl -0pi -e 's/a\\nb/c/' x.ts",
    "perl -i.bak -pe 's/a/b/' x.ts",
    "python3 - <<'EOF'\nfrom pathlib import Path\np = Path('src/x.ts')\ns = p.read_text()\ns = s.replace('a', 'b')\np.write_text(s)\nEOF",
    "python - <<PY\nimport re\ns = open('x').read()\nopen('x', 'w').write(re.sub('a', 'b', s))\nPY",
    "python3 -c \"import pathlib; p = pathlib.Path('x'); p.write_text(p.read_text().replace('a', 'b'))\"",
    "git status && python3 - <<'PY'\nf = open('x'); s = f.read(); f.close()\nopen('x', 'w').write(s.replace('a', 'b'))\nPY",
  ]) expect([command, hintFor(command)]).toEqual([command, EDIT]);
});

test("reads, new files, redirections and patches get no hint", () => {
  for (const command of [
    "sed -n '1,200p' src/x.ts",
    "sed 's/a/b/' x > y",
    "sed -n -e '/-i/p' x",
    "cat x | sed -e 's/ -i / /'",
    "grep -rn \"sed -i\" src docs",
    "echo 'run sed -i to change it'",
    "git commit -m \"replace sed -i and perl -pi with edit\"",
    "cat > notes.md <<EOF\nsed -i 's/a/b/' x\nperl -pi -e 1 x\nEOF",
    "cat > new.py <<'EOF'\ns = open('x').read()\nopen('x', 'w').write(s.replace('a', 'b'))\nEOF",
    "cat > src/new.ts <<EOF\nexport const a = 1;\nEOF",
    "bun test > out.txt 2>&1",
    "git apply fix.patch",
    "git diff | git apply --check",
    "perl -ne 'print if /x/' file",
    "perl -MList::Util -e 'print 1'",
    "perl -Ilib script.pl",
    "perl -e 'print 1'",
    "python3 -c 'print(open(\"x\").read())'",
    "python3 - <<'EOF'\nimport json\nprint(json.load(open('x.json'))['a'].replace('a', 'b'))\nEOF",
    "python3 - <<'EOF'\nopen('report.txt', 'w').write('done')\nEOF",
    "python3 - <<'EOF'\nimport sys\ns = open('x').read().replace('a', 'b')\nsys.stdout.write(s)\nEOF",
    "python3 script.py",
    "rg 'write_text\\(' src && rg '\\.read\\(' src && rg '\\.replace\\(' src",
    "ls -i",
    "",
  ]) expect([command, hintFor(command)]).toEqual([command, undefined]);
});

test("a hint kind is shown at most three times per process", () => {
  const hint = limitedHints();
  expect(HINT_LIMIT).toBe(3);
  expect(hint("echo hi")).toBeUndefined();
  for (let i = 0; i < 3; i++) expect(hint("sed -i 's/a/b/' x")).toBe(EDIT);
  expect(hint("perl -pi -e 's/a/b/' x")).toBeUndefined();
  expect(hint("sed -i 's/a/b/' x")).toBeUndefined();
  expect(hintFor("sed -i 's/a/b/' x")).toBe(EDIT);
});

test("a long sleep gets the process wait hint; short pauses and quoted text do not", () => {
  const wait = (command: string) => hintFor(command)?.includes("process wait") ?? false;
  for (const command of ["sleep 240; gh pr checks 12", "cd repo && sleep 60; tail -5 run.log", "for i in $(seq 1 16); do sleep 30; gh pr checks 9; done", "(sleep 590)"])
    expect(wait(command)).toBe(true);
  for (const command of ["sleep 5; curl -s localhost:3000", "docker start redis; sleep 8; docker ps", "grep 'sleep 60' notes.md", "echo \"sleep 300\"", "cat > wait.sh <<'EOF2'\nsleep 600\nEOF2"])
    expect(wait(command)).toBe(false);
});
